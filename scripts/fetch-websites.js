const { Octokit } = require('@octokit/rest');
const moment = require('moment');

// 配置（确认正确）
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TARGET_REPO = 'liyupi/awesome-websites'; // 目标仓库
const TARGET_FILE_PATH = 'README.md';
const MY_REPO = 'wyzbuss/tg-bot-publisher'; // 你的仓库
const DATA_DIR = 'data/websites'; // 已手动创建的目录
const CONFIG_FILE_PATH = 'data/config.json'; // 已手动创建的文件
const BRANCH = 'preview'; // 强制指定分支

// 初始化GitHub客户端
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// 1. 获取当前月度文件名
function getCurrentMonthFile() {
  return `${moment().format('YYYY-MM')}.json`;
}

// 2. 从preview分支拉取文件（核心修复：强制指定分支）
async function fetchFileFromMyRepo(filePath) {
  try {
    const response = await octokit.repos.getContent({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path: filePath,
      ref: BRANCH, // 明确指定preview分支
      mediaType: { format: 'raw' },
    });
    return response.data ? JSON.parse(response.data) : null;
  } catch (e) {
    // 仅在404时返回null，其他错误抛出
    if (e.status === 404) {
      console.log(`文件不存在（可能是首次运行）: ${filePath}`);
      return null;
    }
    throw new Error(`拉取文件失败(${filePath}): ${e.message}`);
  }
}

// 3. 全量去重（检查preview分支的所有月度文件）
async function isWebsiteDuplicated(newUrl) {
  try {
    const response = await octokit.repos.getContent({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path: DATA_DIR,
      ref: BRANCH, // 明确指定分支
    });

    for (const file of response.data) {
      if (file.type !== 'file' || !file.name.endsWith('.json')) continue;
      const content = await fetchFileFromMyRepo(`${DATA_DIR}/${file.name}`);
      if (content?.some(item => item.url === newUrl)) {
        console.log(`发现重复URL: ${newUrl}`);
        return true;
      }
    }
    return false;
  } catch (e) {
    if (e.status === 404) {
      console.log(`目录不存在（首次运行）: ${DATA_DIR}`);
      return false;
    }
    throw new Error(`全量去重失败: ${e.message}`);
  }
}

// 4. 从目标仓库抓取网站（适配格式）
async function fetchWebsitesFromTargetRepo() {
  try {
    const response = await octokit.repos.getContent({
      owner: TARGET_REPO.split('/')[0],
      repo: TARGET_REPO.split('/')[1],
      path: TARGET_FILE_PATH,
      mediaType: { format: 'raw' },
    });

    // 适配liyupi/awesome-websites的格式：- [名称](链接)：描述
    const regex = /- \[(.*?)\]\((https?:\/\/.*?)\)：(.*?)(\n|$)/g;
    const sites = [];
    let match;

    while ((match = regex.exec(response.data)) !== null) {
      const [, name, url, description] = match;
      if (name && url && description) {
        sites.push({
          id: `github_${Date.now()}_${Math.random().toString(36).slice(-4)}`,
          name: name.trim(),
          url: url.trim(),
          description: description.trim(),
          tags: ['tool', 'github'],
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
    throw new Error(`抓取目标仓库失败: ${e.message}`);
  }
}

// 5. 写入月度文件（提交到preview分支）
async function writeToMonthFile(newSites) {
  const fileName = getCurrentMonthFile();
  const filePath = `${DATA_DIR}/${fileName}`;
  let fileContent = await fetchFileFromMyRepo(filePath) || [];

  // 过滤当前文件中的重复项
  const uniqueSites = newSites.filter(site => 
    !fileContent.some(item => item.url === site.url)
  );

  if (uniqueSites.length === 0) {
    console.log(`月度文件${fileName}中无新网站可添加`);
    return [];
  }

  // 合并新网站
  fileContent = [...fileContent, ...uniqueSites];

  // 获取当前文件的SHA（用于提交时避免冲突）
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
    if (e.status !== 404) throw e; // 只有404时忽略（文件不存在）
  }

  // 提交到preview分支
  await octokit.repos.createOrUpdateFileContents({
    owner: MY_REPO.split('/')[0],
    repo: MY_REPO.split('/')[1],
    path: filePath,
    message: `Add ${uniqueSites.length} new sites to ${fileName}`,
    content: Buffer.from(JSON.stringify(fileContent, null, 2)).toString('base64'),
    branch: BRANCH, // 强制提交到preview分支
    sha: sha, // 用于更新现有文件
  });

  console.log(`成功写入${uniqueSites.length}个网站到${filePath}`);
  return uniqueSites;
}

// 6. 更新配置文件（提交到preview分支）
async function updateConfigFile() {
  const currentFile = getCurrentMonthFile();
  let config = await fetchFileFromMyRepo(CONFIG_FILE_PATH) || {
    currentPendingFile: currentFile,
    lastPublishedId: null,
    totalPublished: 0,
    lastFetchTime: moment().toISOString(),
  };

  // 更新配置
  config.currentPendingFile = currentFile;
  config.lastFetchTime = moment().toISOString();

  // 获取当前配置文件的SHA
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

  // 提交到preview分支
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

    // 步骤1：抓取目标仓库网站
    const rawSites = await fetchWebsitesFromTargetRepo();
    if (rawSites.length === 0) {
      console.log('未抓取到任何网站，脚本结束');
      return;
    }

    // 步骤2：全量去重
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

    // 步骤3：写入月度文件
    await writeToMonthFile(uniqueSites);

    // 步骤4：更新配置文件
    await updateConfigFile();

    console.log('抓取脚本执行成功！');
  } catch (error) {
    console.error('抓取脚本执行失败:', error.message);
    process.exit(1);
  }
}

main();
