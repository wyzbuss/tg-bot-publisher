const { Octokit } = require('@octokit/rest');
const moment = require('moment');

// 配置
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TARGET_REPO = 'sindresorhus/awesome';
const TARGET_FILE_PATH = 'readme.md';
const MY_REPO = 'wyzbuss/tg-bot-publisher';
const DATA_DIR = 'data/websites';
const CONFIG_FILE_PATH = 'data/config.json';
const BRANCH = 'preview';

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// 1. 获取当前月度文件名
function getCurrentMonthFile() {
  return `${moment().format('YYYY-MM')}.json`;
}

// 2. 从preview分支拉取文件（增强JSON解析容错）
async function fetchFileFromMyRepo(filePath) {
  try {
    const response = await octokit.repos.getContent({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path: filePath,
      ref: BRANCH,
      mediaType: { format: 'raw' },
    });

    // 处理空文件
    if (!response.data || response.data.trim() === '') {
      console.log(`文件为空: ${filePath}，返回空数组`);
      return [];
    }

    // 容错解析JSON
    try {
      return JSON.parse(response.data);
    } catch (parseError) {
      console.error(`JSON解析失败(${filePath})，返回空数组:`, parseError.message);
      return []; // 解析失败时返回空数组，避免脚本崩溃
    }
  } catch (e) {
    if (e.status === 404) {
      console.log(`文件不存在: ${filePath}，返回空数组`);
      return [];
    }
    throw new Error(`拉取文件失败(${filePath}): ${e.message}`);
  }
}

// 3. 全量去重（使用容错后的文件读取）
async function isWebsiteDuplicated(newUrl) {
  try {
    const response = await octokit.repos.getContent({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path: DATA_DIR,
      ref: BRANCH,
    });

    for (const file of response.data) {
      if (file.type !== 'file' || !file.name.endsWith('.json')) continue;
      
      // 使用容错后的读取函数
      const content = await fetchFileFromMyRepo(`${DATA_DIR}/${file.name}`);
      
      // 确保content是数组再进行判断
      if (Array.isArray(content) && content.some(item => item?.url === newUrl)) {
        console.log(`发现重复URL: ${newUrl}`);
        return true;
      }
    }
    return false;
  } catch (e) {
    if (e.status === 404) {
      console.log(`目录不存在: ${DATA_DIR}，默认无重复`);
      return false;
    }
    throw new Error(`全量去重失败: ${e.message}`);
  }
}

// 4. 从目标仓库抓取网站
async function fetchWebsitesFromTargetRepo() {
  try {
    console.log(`开始抓取目标仓库: ${TARGET_REPO}/${TARGET_FILE_PATH}`);
    const response = await octokit.repos.getContent({
      owner: TARGET_REPO.split('/')[0],
      repo: TARGET_REPO.split('/')[1],
      path: TARGET_FILE_PATH,
      mediaType: { format: 'raw' },
    });

    // 适配格式：- [名称](链接)
    const regex = /- \[(.*?)\]\((https?:\/\/[^)]+)\)/g;
    const sites = [];
    let match;

    while ((match = regex.exec(response.data)) !== null) {
      const [, name, url] = match;
      if (name && url) {
        sites.push({
          id: `github_${Date.now()}_${Math.random().toString(36).slice(-4)}`,
          name: name.trim(),
          url: url.trim(),
          description: `精选工具网站：${name.trim()}`,
          tags: ['awesome', 'tool'],
          status: 'pending',
          screenshotFileIds: [],
          createdAt: moment().toISOString(),
          publishedAt: null,
          month: getCurrentMonthFile().replace('.json', ''),
        });
      }
    }

    console.log(`从目标仓库抓取到${sites.length}个网站`);
    return sites;
  } catch (e) {
    console.error(`目标仓库访问错误: 状态码=${e.status}, 消息=${e.message}`);
    throw new Error(`抓取目标仓库失败: ${e.message}`);
  }
}

// 5. 写入月度文件
async function writeToMonthFile(newSites) {
  const fileName = getCurrentMonthFile();
  const filePath = `${DATA_DIR}/${fileName}`;
  let fileContent = await fetchFileFromMyRepo(filePath); // 已容错，确保是数组

  // 过滤重复项
  const uniqueSites = newSites.filter(site => 
    !fileContent.some(item => item?.url === site.url)
  );

  if (uniqueSites.length === 0) {
    console.log(`无新网站可添加到${fileName}`);
    return [];
  }

  // 合并新网站
  fileContent = [...fileContent, ...uniqueSites];

  // 获取文件SHA（用于更新）
  let sha;
  try {
    const fileInfo = await octokit.repos.getContent({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path: filePath,
      ref: BRANCH,
    });
    sha = fileInfo.data.sha;
  } catch (e) {
    if (e.status !== 404) throw e; // 忽略404（文件不存在）
  }

  // 提交更新
  await octokit.repos.createOrUpdateFileContents({
    owner: MY_REPO.split('/')[0],
    repo: MY_REPO.split('/')[1],
    path: filePath,
    message: `Add ${uniqueSites.length} new sites to ${fileName}`,
    content: Buffer.from(JSON.stringify(fileContent, null, 2)).toString('base64'),
    branch: BRANCH,
    sha: sha,
  });

  console.log(`成功写入${uniqueSites.length}个网站到${filePath}`);
  return uniqueSites;
}

// 6. 更新配置文件
async function updateConfigFile() {
  const currentFile = getCurrentMonthFile();
  let config = await fetchFileFromMyRepo(CONFIG_FILE_PATH);

  // 初始化配置（如果是空数组或解析失败）
  if (!config || typeof config !== 'object') {
    config = {
      currentPendingFile: currentFile,
      lastPublishedId: null,
      totalPublished: 0,
      lastFetchTime: moment().toISOString(),
    };
  }

  // 更新配置
  config.currentPendingFile = currentFile;
  config.lastFetchTime = moment().toISOString();

  // 获取SHA
  let sha;
  try {
    const fileInfo = await octokit.repos.getContent({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path: CONFIG_FILE_PATH,
      ref: BRANCH,
    });
    sha = fileInfo.data.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  // 提交配置
  await octokit.repos.createOrUpdateFileContents({
    owner: MY_REPO.split('/')[0],
    repo: MY_REPO.split('/')[1],
    path: CONFIG_FILE_PATH,
    message: 'Update config.json',
    content: Buffer.from(JSON.stringify(config, null, 2)).toString('base64'),
    branch: BRANCH,
    sha: sha,
  });

  console.log('配置文件更新成功');
}

// 主函数
async function main() {
  try {
    console.log(`开始执行抓取脚本（分支：${BRANCH}）`);

    const rawSites = await fetchWebsitesFromTargetRepo();
    if (rawSites.length === 0) {
      console.log('未抓取到任何网站，脚本结束');
      return;
    }

    const uniqueSites = [];
    for (const site of rawSites) {
      const isDuplicate = await isWebsiteDuplicated(site.url);
      if (!isDuplicate) uniqueSites.push(site);
    }
    console.log(`全量去重后剩余${uniqueSites.length}个网站`);

    if (uniqueSites.length === 0) {
      console.log('无新网站可添加，脚本结束');
      return;
    }

    await writeToMonthFile(uniqueSites);
    await updateConfigFile();

    console.log('抓取脚本执行成功！');
  } catch (error) {
    console.error('抓取脚本执行失败:', error.message);
    process.exit(1);
  }
}

main();
