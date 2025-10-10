const { Octokit } = require('@octokit/rest');
const puppeteer = require('puppeteer-core');
const moment = require('moment');

// 环境变量配置
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const MY_REPO = 'wyzbuss/tg-bot-publisher';
const BRANCH = 'preview';

// 初始化GitHub客户端
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// 主函数 - Vercel云函数入口
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  
  // 验证环境变量
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID || !GITHUB_TOKEN) {
    return res.status(500).json({
      success: false,
      error: '缺少环境变量',
      debug: {
        token: !!TELEGRAM_BOT_TOKEN,
        channelId: !!TELEGRAM_CHANNEL_ID,
        githubToken: !!GITHUB_TOKEN
      }
    });
  }

  try {
    // 1. 获取待发布网站
    const { site, monthFilePath } = await getPendingWebsite();
    if (!site) {
      return res.status(200).json({
        success: true,
        message: '无待发布网站'
      });
    }

    // 2. 识别链接类型并获取元数据
    const linkType = getLinkType(site.url);
    const meta = linkType === 'github' 
      ? await getGithubRepoMeta(site.url) 
      : { title: site.name, description: site.description, url: site.url };

    // 3. 自动截图
    const screenshots = await takeScreenshots(site.url, linkType);

    // 4. 发送到Telegram
    await sendToTelegram(meta, screenshots, linkType);

    // 5. 更新网站状态为已发布
    await updateSiteStatus(site, monthFilePath);

    // 6. 更新配置文件
    await updateConfigFile();

    res.status(200).json({
      success: true,
      published: meta.title,
      url: meta.url
    });
  } catch (error) {
    console.error('发布失败:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

// 链接类型识别
function getLinkType(url) {
  const githubRegex = /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)(#.*)?$/;
  return githubRegex.test(url) ? 'github' : 'normal';
}

// 获取GitHub仓库元数据
async function getGithubRepoMeta(url) {
  try {
    const match = url.match(/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) throw new Error('无效的GitHub链接');

    const [, owner, repo] = match;
    const response = await octokit.repos.get({ owner, repo });
    const { stargazers_count: stars, description, language, html_url } = response.data;

    return {
      title: `${owner}/${repo}`,
      description: description || 'GitHub开源仓库',
      stars: stars ? `${stars.toLocaleString()} ⭐` : '未知',
      language: language || '未知',
      url: html_url
    };
  } catch (error) {
    console.warn('GitHub元数据获取失败，使用基础信息:', error.message);
    return {
      title: url.split('/').slice(-2).join('/'),
      description: 'GitHub开源仓库',
      url: url
    };
  }
}

// 差异化截图
async function takeScreenshots(url, linkType) {
  const browser = await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ],
    executablePath: process.env.CHROME_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    headless: 'new',
    timeout: 30000
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setDefaultNavigationTimeout(30000);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // GitHub仓库截图策略
    if (linkType === 'github') {
      // 截图1：仓库首页
      const screenshot1 = await page.screenshot({ encoding: 'base64' });
      
      // 滚动到README区域截图
      await page.evaluate(() => {
        const readme = document.querySelector('#readme');
        if (readme) readme.scrollIntoView({ behavior: 'smooth' });
      });
      await page.waitForTimeout(1000);
      const screenshot2 = await page.screenshot({ encoding: 'base64' });
      
      return [screenshot1, screenshot2];
    }

    // 普通网站截图策略
    // 尝试跳过登录页
    await page.evaluate(() => {
      const skipTexts = ['游客', '跳过', '取消', '稍后', '关闭'];
      skipTexts.forEach(text => {
        const buttons = document.querySelectorAll(`button:contains('${text}'), a:contains('${text}')`);
        buttons.forEach(btn => btn.click());
      });
    });
    await page.waitForTimeout(2000);

    // 截图1：网站首页
    const screenshot1 = await page.screenshot({ encoding: 'base64' });
    
    // 滚动到内容区域截图
    await page.evaluate(() => {
      const contentAreas = ['main', '#content', '.container', '.main-content'];
      contentAreas.forEach(selector => {
        const el = document.querySelector(selector);
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      });
    });
    await page.waitForTimeout(1000);
    const screenshot2 = await page.screenshot({ encoding: 'base64' });
    
    return [screenshot1, screenshot2];
  } catch (error) {
    console.error('截图失败:', error.message);
    // 提供默认图片（需自行准备并替换为你的图片URL）
    const defaultScreenshot = await fetch('https://picsum.photos/1280/720?random=1')
      .then(res => res.buffer())
      .then(buf => buf.toString('base64'));
    return [defaultScreenshot, defaultScreenshot];
  } finally {
    await browser.close();
  }
}

// 发送到Telegram
async function sendToTelegram(meta, screenshots, linkType) {
  // 上传截图获取file_id
  const fileIds = [];
  for (const screenshot of screenshots) {
    const formData = new FormData();
    formData.append('chat_id', TELEGRAM_CHANNEL_ID);
    formData.append('photo', Buffer.from(screenshot, 'base64'), 'screenshot.png');
    
    const uploadResponse = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
      { method: 'POST', body: formData }
    );
    
    const result = await uploadResponse.json();
    if (!result.ok) throw new Error(`上传截图失败: ${result.description}`);
    fileIds.push(result.result.photo[0].file_id);
  }

  // 生成文案
  let caption;
  if (linkType === 'github') {
    caption = `**🔧 ${meta.title}**\n` +
             `${meta.stars} | ${meta.language}\n\n` +
             `${meta.description}\n\n` +
             `[访问仓库](${meta.url})\n\n` +
             `#GitHub #开源 #${meta.language || '工具'}`;
  } else {
    caption = `**🌟 ${meta.title}**\n\n` +
             `${meta.description}\n\n` +
             `[立即访问](${meta.url})\n\n` +
             `#实用工具 #网站推荐`;
  }

  // 发送媒体组
  const mediaGroupResponse = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHANNEL_ID,
        media: [
          { type: 'photo', media: fileIds[0], caption: caption, parse_mode: 'Markdown' },
          { type: 'photo', media: fileIds[1] }
        ]
      })
    }
  );

  const mediaResult = await mediaGroupResponse.json();
  if (!mediaResult.ok) throw new Error(`发送失败: ${mediaResult.description}`);
}

// 获取待发布网站
async function getPendingWebsite() {
  // 读取配置文件获取当前待发布文件
  const config = await fetchFileFromRepo('data/config.json') || {
    currentPendingFile: moment().format('YYYY-MM') + '.json'
  };
  
  const monthFilePath = `data/websites/${config.currentPendingFile}`;
  const websites = await fetchFileFromRepo(monthFilePath) || [];
  
  // 查找第一个待发布网站
  const pendingSite = websites.find(site => site.status === 'pending');
  
  return { site: pendingSite, monthFilePath };
}

// 从仓库读取文件
async function fetchFileFromRepo(filePath) {
  try {
    const response = await octokit.repos.getContent({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path: filePath,
      ref: BRANCH,
      mediaType: { format: 'raw' }
    });
    return response.data ? JSON.parse(response.data) : null;
  } catch (error) {
    if (error.status === 404) return null;
    throw new Error(`读取文件失败: ${filePath} - ${error.message}`);
  }
}

// 更新网站状态为已发布
async function updateSiteStatus(site, monthFilePath) {
  const websites = await fetchFileFromRepo(monthFilePath) || [];
  const updatedWebsites = websites.map(s => 
    s.id === site.id 
      ? { ...s, status: 'published', publishedAt: moment().toISOString() }
      : s
  );

  // 获取当前文件SHA
  const fileInfo = await octokit.repos.getContent({
    owner: MY_REPO.split('/')[0],
    repo: MY_REPO.split('/')[1],
    path: monthFilePath,
    ref: BRANCH
  });

  // 提交更新
  await octokit.repos.createOrUpdateFileContents({
    owner: MY_REPO.split('/')[0],
    repo: MY_REPO.split('/')[1],
    path: monthFilePath,
    message: `Mark ${site.id} as published`,
    content: Buffer.from(JSON.stringify(updatedWebsites, null, 2)).toString('base64'),
    branch: BRANCH,
    sha: fileInfo.data.sha
  });
}

// 更新配置文件
async function updateConfigFile() {
  const config = await fetchFileFromRepo('data/config.json') || {
    currentPendingFile: moment().format('YYYY-MM') + '.json',
    totalPublished: 0
  };

  // 统计已发布数量
  const monthFiles = await octokit.repos.getContent({
    owner: MY_REPO.split('/')[0],
    repo: MY_REPO.split('/')[1],
    path: 'data/websites',
    ref: BRANCH
  });

  let totalPublished = 0;
  for (const file of monthFiles.data) {
    if (file.type === 'file' && file.name.endsWith('.json')) {
      const sites = await fetchFileFromRepo(`data/websites/${file.name}`) || [];
      totalPublished += sites.filter(s => s.status === 'published').length;
    }
  }

  config.totalPublished = totalPublished;
  config.lastPublishedAt = moment().toISOString();

  // 提交配置更新
  const configFileInfo = await octokit.repos.getContent({
    owner: MY_REPO.split('/')[0],
    repo: MY_REPO.split('/')[1],
    path: 'data/config.json',
    ref: BRANCH
  });

  await octokit.repos.createOrUpdateFileContents({
    owner: MY_REPO.split('/')[0],
    repo: MY_REPO.split('/')[1],
    path: 'data/config.json',
    message: 'Update published stats',
    content: Buffer.from(JSON.stringify(config, null, 2)).toString('base64'),
    branch: BRANCH,
    sha: configFileInfo.data.sha
  });
}

// 配置Vercel运行时
module.exports.config = {
  runtime: 'nodejs',
  regions: ['iad1'], // 选择离你近的区域
  memory: 1024, // 截图需要较多内存，设置为1GB
  maxDuration: 60 // 最大运行时间60秒
};
