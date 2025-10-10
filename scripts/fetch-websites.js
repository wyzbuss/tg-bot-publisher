const { Octokit } = require('@octokit/rest');
const moment = require('moment');

// 配置更新：更换为更稳定的目标仓库
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TARGET_REPO = 'sindresorhus/awesome'; // 全球顶级Awesome仓库，稳定可靠
const TARGET_FILE_PATH = 'readme.md'; // 注意是小写readme.md
const MY_REPO = 'wyzbuss/tg-bot-publisher';
const DATA_DIR = 'data/websites';
const CONFIG_FILE_PATH = 'data/config.json';
const BRANCH = 'preview';

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// 1. 获取当前月度文件名
function getCurrentMonthFile() {
  return `${moment().format('YYYY-MM')}.json`;
}

// 2. 从preview分支拉取文件
async function fetchFileFromMyRepo(filePath) {
  try {
    const response = await octokit.repos.getContent({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path: filePath,
      ref: BRANCH,
      mediaType: { format: 'raw' },
    });
    return response.data ? JSON.parse(response.data) : null;
  } catch (e) {
    if (e.status === 404) {
      console.log(`文件不存在: ${filePath}`);
      return null;
    }
    throw new Error(`拉取文件失败(${filePath}): ${e.message}`);
  }
}

// 3. 全量去重
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
      const content = await fetchFileFromMyRepo(`${DATA_DIR}/${file.name}`);
      if (content?.some(item => item.url === newUrl)) {
        console.log(`重复URL: ${newUrl}`);
        return true;
      }
    }
    return false;
  } catch (e) {
    if (e.status === 404) {
      console.log(`目录不存在: ${DATA_DIR}`);
      return false;
    }
    throw new Error(`全量去重失败: ${e.message}`);
  }
}

// 4. 从目标仓库抓取网站（适配新仓库格式）
async function fetchWebsitesFromTargetRepo() {
  try {
    console.log(`开始抓取目标仓库: ${TARGET_REPO}/${TARGET_FILE_PATH}`);
    const response = await octokit.repos.getContent({
      owner: TARGET_REPO.split('/')[0],
      repo: TARGET_REPO.split('/')[1],
      path: TARGET_FILE_PATH,
      mediaType: { format: 'raw' },
    });

    // 适配sindresorhus/awesome的格式：- [名称](链接)
    const regex = /- \[(.*?)\]\((https?:\/\/[^)]+)\)/g;
    const sites = [];
    let match;

    while ((match = regex.exec(response.data)) !== null) {
      const [, name, url] = match;
      if (name && url) {
        // 简单描述生成（实际可根据需要优化）
        const description = `精选工具网站：${name}`;
        sites.push({
          id: `github_${Date.now()}_${Math.random().toString(36).slice(-4)}`,
          name: name.trim(),
          url: url.trim(),
          description: description.trim(),
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
    // 详细错误信息输出
    console.error(`目标仓库访问错误详情: 状态码=${e.status}, 消息=${e.message}`);
    throw new Error(`抓取目标仓库失败（可能仓库不存在或路径错误）: ${e.message}`);
  }
}

// 5. 写入月度文件
async function writeToMonthFile(newSites) {
  const fileName = getCurrentMonthFile();
  const filePath = `${DATA_DIR}/${fileName}`;
  let fileContent = await fetchFileFromMyRepo(filePath) || [];

  const uniqueSites = newSites.filter(site => 
    !fileContent.some(item => item.url === site.url)
  );

  if (uniqueSites.length === 0) {
    console.log(`无新网站可添加到${fileName}`);
    return [];
  }

  fileContent = [...fileContent, ...uniqueSites];
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
    if (e.status !== 404) throw e;
  }

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
  let config = await fetchFileFromMyRepo(CONFIG_FILE_PATH) || {
    currentPendingFile: currentFile,
    lastPublishedId: null,
    totalPublished: 0,
    lastFetchTime: moment().toISOString(),
  };

  config.currentPendingFile = currentFile;
  config.lastFetchTime = moment().toISOString();

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
