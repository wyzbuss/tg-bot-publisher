const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');
const moment = require('moment');

// -------------------------- 配置信息（需替换为你的仓库） --------------------------
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TARGET_REPO = 'liyupi/awesome-websites'; // 临时用的目标仓库，可替换
const TARGET_FILE_PATH = 'README.md';
const MY_REPO = 'wyzbuss/tg-bot-publisher'; // 替换为你的仓库
const DATA_DIR = 'data/websites';
const CONFIG_FILE_PATH = 'data/config.json';

// -------------------------- 初始化GitHub客户端 --------------------------
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// -------------------------- 工具函数 --------------------------
// 1. 获取当前月度文件名（如2025-10.json）
function getCurrentMonthFile() {
  return `${moment().format('YYYY-MM')}.json`;
}

// 2. 从我的仓库拉取文件
async function fetchFileFromMyRepo(filePath) {
  try {
    const response = await octokit.repos.getContent({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path: filePath,
      mediaType: { format: 'raw' },
    });
    return response.data ? JSON.parse(response.data) : null;
  } catch (e) {
    return e.status === 404 ? null : Promise.reject(e);
  }
}

// 3. 全量去重（检查所有月度文件）
async function isWebsiteDuplicated(newUrl) {
  try {
    const response = await octokit.repos.getContent({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path: DATA_DIR,
    });
    for (const file of response.data) {
      if (file.type !== 'file' || !file.name.endsWith('.json')) continue;
      const content = await fetchFileFromMyRepo(`${DATA_DIR}/${file.name}`);
      if (content?.some(item => item.url === newUrl)) return true;
    }
    return false;
  } catch (e) {
    return e.status === 404 ? false : Promise.reject(e);
  }
}

// 4. 从目标仓库抓取网站（解析README）
async function fetchWebsitesFromTargetRepo() {
  try {
    const response = await octokit.repos.getContent({
      owner: TARGET_REPO.split('/')[0],
      repo: TARGET_REPO.split('/')[1],
      path: TARGET_FILE_PATH,
      mediaType: { format: 'raw' },
    });
    const regex = /- \[(.*?)\]\((https?:\/\/.*?)\) - (.*?)(\n|$)/g;
    const sites = [];
    let match;
    while ((match = regex.exec(response.data)) !== null) {
      const [, name, url, desc] = match;
      if (name && url && desc) sites.push({
        id: `github_${Date.now()}_${Math.random().toString(36).slice(-4)}`,
        name: name.trim(),
        url: url.trim(),
        description: desc.trim(),
        tags: ['tool', 'github'],
        status: 'pending',
        screenshotFileIds: [],
        createdAt: moment().toISOString(),
        publishedAt: null,
        month: getCurrentMonthFile().replace('.json', ''),
      });
    }
    return sites;
  } catch (e) {
    return Promise.reject(e);
  }
}

// 5. 写入月度文件
async function writeToMonthFile(newSites) {
  const file = getCurrentMonthFile();
  const path = `${DATA_DIR}/${file}`;
  let content = await fetchFileFromMyRepo(path) || [];
  
  const unique = newSites.filter(site => 
    !content.some(item => item.url === site.url)
  );
  if (unique.length === 0) return [];
  
  content = [...content, ...unique];
  await octokit.repos.createOrUpdateFileContents({
    owner: MY_REPO.split('/')[0],
    repo: MY_REPO.split('/')[1],
    path,
    message: `Add ${unique.length} new sites to ${file}`,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    sha: (await fetchFileFromMyRepo(path)) ? (await octokit.repos.getContent({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path,
    })).data.sha : undefined,
  });
  return unique;
}

// 6. 更新配置文件
async function updateConfigFile() {
  const file = getCurrentMonthFile();
  let config = await fetchFileFromMyRepo(CONFIG_FILE_PATH) || {
    currentPendingFile: file,
    lastPublishedId: null,
    totalPublished: 0,
    lastFetchTime: moment().toISOString(),
  };
  config.currentPendingFile = file;
  config.lastFetchTime = moment().toISOString();
  
  await octokit.repos.createOrUpdateFileContents({
    owner: MY_REPO.split('/')[0],
    repo: MY_REPO.split('/')[1],
    path: CONFIG_FILE_PATH,
    message: 'Update config.json',
    content: Buffer.from(JSON.stringify(config, null, 2)).toString('base64'),
    sha: config ? (await octokit.repos.getContent({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path: CONFIG_FILE_PATH,
    })).data.sha : undefined,
  });
}

// -------------------------- 主函数 --------------------------
async function main() {
  try {
    const rawSites = await fetchWebsitesFromTargetRepo();
    const uniqueSites = [];
    for (const site of rawSites) {
      if (!await isWebsiteDuplicated(site.url)) uniqueSites.push(site);
    }
    if (uniqueSites.length === 0) return console.log('No new sites');
    
    await writeToMonthFile(uniqueSites);
    await updateConfigFile();
    console.log(`Success! Added ${uniqueSites.length} new sites`);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

main();
