const { Octokit } = require('@octokit/rest');
const puppeteer = require('puppeteer-core');
const moment = require('moment');
const FormData = require('form-data'); // 确保FormData依赖正确引入

// 环境变量配置
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const MY_REPO = 'wyzbuss/tg-bot-publisher';
const BRANCH = 'preview';

// 初始化GitHub客户端
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// 文件缓存：减少重复API调用，提升效率
const fileCache = new Map();

// 主函数 - Vercel云函数入口
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  
  // 验证环境变量是否齐全
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
    console.log('=== 开始获取待发布网站 ===');
    const { site, monthFilePath } = await getPendingWebsite();
    
    if (!site) {
      console.log('未找到待发布网站，流程结束');
      return res.status(200).json({
        success: true,
        message: '无待发布网站',
        debug: {
          monthFilePath: monthFilePath,
          currentTime: moment().utcOffset(8).format('YYYY-MM-DD HH:mm:ss')
        }
      });
    }
    console.log(`找到待发布网站：${site.name}（ID：${site.id}）`);

    // 2. 识别链接类型并获取元数据
    console.log(`=== 处理链接：${site.url} ===`);
    const linkType = getLinkType(site.url);
    const meta = linkType === 'github' 
      ? await getGithubRepoMeta(site.url) 
      : { title: site.name, description: site.description || '实用工具网站', url: site.url };
    console.log(`链接类型：${linkType}，元数据：${JSON.stringify(meta, null, 2)}`);

    // 3. 自动截图（差异化处理GitHub/普通网站）
    console.log('=== 开始截图 ===');
    const screenshots = await takeScreenshots(site.url, linkType);
    console.log('截图完成，准备上传到Telegram');

    // 4. 发送到Telegram频道
    console.log('=== 发送到Telegram频道 ===');
    await sendToTelegram(meta, screenshots, linkType);
    console.log(`成功发送到频道：${TELEGRAM_CHANNEL_ID}`);

    // 5. 更新网站状态为“已发布”
    console.log('=== 更新网站状态 ===');
    await updateSiteStatus(site, monthFilePath);
    console.log(`网站状态更新完成：${site.id} → published`);

    // 6. 更新配置文件（统计已发布数量）
    console.log('=== 更新配置文件 ===');
    await updateConfigFile();
    console.log('配置文件更新完成');

    // 返回成功结果
    res.status(200).json({
      success: true,
      message: '发布成功',
      published: {
        title: meta.title,
        url: meta.url,
        publishTime: moment().utcOffset(8).format('YYYY-MM-DD HH:mm:ss')
      }
    });
  } catch (error) {
    console.error('=== 发布流程失败 ===', error);
    res.status(500).json({
      success: false,
      error: error.message,
      debug: {
        timestamp: moment().utcOffset(8).format('YYYY-MM-DD HH:mm:ss'),
        stack: process.env.NODE_ENV === 'development' ? error.stack : '开发环境可查看完整堆栈'
      }
    });
  }
};

// -------------------------- 工具函数 --------------------------

/**
 * 1. 识别链接类型（GitHub仓库/普通网站）
 * @param {string} url - 待识别的链接
 * @returns {string} - 'github' 或 'normal'
 */
function getLinkType(url) {
  const githubRegex = /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)(#.*)?$/;
  return githubRegex.test(url) ? 'github' : 'normal';
}

/**
 * 2. 获取GitHub仓库元数据（星数、语言、描述）
 * @param {string} url - GitHub仓库链接
 * @returns {object} - 仓库元数据
 */
async function getGithubRepoMeta(url) {
  try {
    // 从链接中提取owner和repo名称（兼容带#readme的链接）
    const match = url.match(/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) throw new Error('无效的GitHub链接格式');

    const [, owner, repo] = match;
    console.log(`获取GitHub仓库元数据：${owner}/${repo}`);
    const response = await octokit.repos.get({ owner, repo });
    const { stargazers_count: stars, description, language, html_url } = response.data;

    return {
      title: `${owner}/${repo}`,
      description: description || 'GitHub开源仓库，包含丰富的工具和资源',
      stars: stars ? `${stars.toLocaleString()} ⭐` : '未知星数',
      language: language || '未知开发语言',
      url: html_url
    };
  } catch (error) {
    console.warn('GitHub元数据获取失败，使用基础信息:', error.message);
    // 降级处理：从URL提取仓库名，避免流程中断
    const repoName = url.split('/').slice(-2).join('/').replace('#readme', '');
    return {
      title: repoName,
      description: 'GitHub开源仓库，提供实用工具和资源',
      url: url
    };
  }
}

/**
 * 3. 差异化截图（GitHub仓库优先截README，普通网站跳过登录）
 * @param {string} url - 待截图链接
 * @param {string} linkType - 链接类型（github/normal）
 * @returns {string[]} - 2张截图的Base64编码
 */
async function takeScreenshots(url, linkType) {
  let browser;
  try {
    // Puppeteer配置（适配Vercel无服务器环境）
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // 解决内存不足问题
        '--disable-gpu',
        '--remote-debugging-port=9222' // 提升稳定性
      ],
      executablePath: process.env.CHROME_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
      headless: 'new', // 最新无头模式，资源占用更低
      timeout: 40000 // 延长超时时间，应对慢加载网站
    });

    const page = await browser.newPage();
    // 模拟正常浏览器环境，避免被识别为爬虫
    await page.setViewport({ width: 1280, height: 720 });
    await page.setDefaultNavigationTimeout(40000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36');

    console.log(`访问链接：${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 40000 });

    // GitHub仓库截图策略
    if (linkType === 'github') {
      // 截图1：仓库首页（含星数、描述栏）
      const screenshot1 = await page.screenshot({ encoding: 'base64' });
      
      // 滚动到README区域（容错：没找到#readme则滚动到页面中间）
      await page.evaluate(() => {
        const readme = document.querySelector('#readme');
        if (readme) {
          readme.scrollIntoView({ behavior: 'smooth' });
        } else {
          window.scrollTo(0, document.body.scrollHeight / 2);
        }
      });
      await page.waitForTimeout(1500); // 等待滚动和渲染完成
      const screenshot2 = await page.screenshot({ encoding: 'base64' });
      
      return [screenshot1, screenshot2];
    }

    // 普通网站截图策略
    if (linkType === 'normal') {
      // 尝试跳过登录/弹窗（兼容中英文按钮）
      await page.evaluate(() => {
        const skipTexts = ['游客', '跳过', '取消', '稍后', '关闭', 'Guest', 'Skip', 'Cancel', 'Close'];
        skipTexts.forEach(text => {
          const buttons = document.querySelectorAll(
            `button:contains('${text}'), a:contains('${text}'), .btn:contains('${text}')`
          );
          buttons.forEach(btn => {
            if (!btn.disabled && btn.offsetParent !== null) btn.click();
          });
        });
      });
      await page.waitForTimeout(2000); // 等待弹窗关闭

      // 截图1：网站首页
      const screenshot1 = await page.screenshot({ encoding: 'base64' });
      
      // 滚动到核心内容区域（优先main、content等标签）
      await page.evaluate(() => {
        const contentAreas = ['main', '#content', '.container', '.main-content', '.content'];
        for (const selector of contentAreas) {
          const el = document.querySelector(selector);
          if (el && el.offsetHeight > 300) { // 确保区域有足够内容
            el.scrollIntoView({ behavior: 'smooth' });
            break;
          }
        }
      });
      await page.waitForTimeout(1500);
      const screenshot2 = await page.screenshot({ encoding: 'base64' });
      
      return [screenshot1, screenshot2];
    }
  } catch (error) {
    console.error('截图失败:', error.message);
    // 降级：使用默认图片（避免发送空截图）
    try {
      console.log('使用默认截图替代');
      const defaultRes = await fetch('https://picsum.photos/1280/720?random=1');
      const defaultBuf = await defaultRes.buffer();
      const defaultBase64 = defaultBuf.toString('base64');
      return [defaultBase64, defaultBase64];
    } catch (defaultErr) {
      console.error('默认截图获取失败:', defaultErr.message);
      return ['', '']; // 极端情况：返回空字符串，Telegram会忽略
    }
  } finally {
    if (browser) await browser.close();
    console.log('浏览器已关闭');
  }
}

/**
 * 4. 发送截图和文案到Telegram频道
 * @param {object} meta - 链接元数据
 * @param {string[]} screenshots - 截图Base64列表
 * @param {string} linkType - 链接类型
 */
async function sendToTelegram(meta, screenshots, linkType) {
  // 过滤空截图，避免上传失败
  const validScreenshots = screenshots.filter(s => s);
  if (validScreenshots.length === 0) {
    throw new Error('无有效截图可上传');
  }

  // 第一步：上传截图，获取Telegram的file_id
  const fileIds = [];
  for (let i = 0; i < validScreenshots.length; i++) {
    console.log(`上传第${i+1}张截图`);
    const formData = new FormData();
    formData.append('chat_id', TELEGRAM_CHANNEL_ID);
    // 转换Base64为Buffer，兼容FormData上传格式
    const imgBuffer = Buffer.from(validScreenshots[i], 'base64');
    formData.append('photo', imgBuffer, `screenshot-${i+1}.png`);

    // 发送上传请求（使用FormData自带的headers，确保Content-Type正确）
    const uploadResponse = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
      {
        method: 'POST',
        body: formData,
        headers: formData.getHeaders()
      }
    );

    const result = await uploadResponse.json();
    if (!result.ok) {
      throw new Error(`上传截图失败（${i+1}）: ${result.description || '未知错误'}`);
    }
    fileIds.push(result.result.photo[0].file_id);
    console.log(`第${i+1}张截图上传完成，file_id: ${fileIds[i]}`);
  }

  // 第二步：生成Markdown文案（转义特殊字符，避免格式错误）
  const escapeMarkdown = (text) => text.replace(/[*_\\\[\]()~`>#+\-=|{}.!]/g, '\\$&');
  let caption;

  if (linkType === 'github') {
    caption = `**🔧 ${escapeMarkdown(meta.title)}**\n` +
             `${escapeMarkdown(meta.stars || '')} | ${escapeMarkdown(meta.language || '')}\n\n` +
             `${escapeMarkdown(meta.description || '')}\n\n` +
             `[访问仓库](${meta.url})\n\n` +
             `#GitHub #开源 #${escapeMarkdown(meta.language || '工具')}`;
  } else {
    caption = `**🌟 ${escapeMarkdown(meta.title)}**\n\n` +
             `${escapeMarkdown(meta.description || '')}\n\n` +
             `[立即访问](${meta.url})\n\n` +
             `#实用工具 #网站推荐`;
  }

  // 第三步：发送媒体组（Telegram支持最多10张图，此处用2张）
  console.log('发送媒体组到Telegram');
  const media = fileIds.map((id, index) => ({
    type: 'photo',
    media: id,
    caption: index === 0 ? caption : undefined, // 仅第一张图带文案
    parse_mode: 'MarkdownV2' // 使用MarkdownV2确保格式兼容
  }));

  const mediaGroupResponse = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHANNEL_ID,
        media: media,
        disable_notification: false // 开启通知，用户能及时看到
      })
    }
  );

  const mediaResult = await mediaGroupResponse.json();
  if (!mediaResult.ok) {
    throw new Error(`发送媒体组失败: ${mediaResult.description || '未知错误'}`);
  }
}

/**
 * 5. 获取待发布网站（时区适配+状态容错）
 * @returns {object} - { site: 待发布网站, monthFilePath: 月度文件路径 }
 */
async function getPendingWebsite() {
  // 读取配置文件（兼容config.json不存在的情况）
  console.log('读取配置文件：data/config.json');
  const config = await fetchFileFromRepo('data/config.json') || {};
  
  // 时区适配：强制东八区（北京时间），避免UTC时区导致的月份偏差
  const currentMonth = moment().utcOffset(8).format('YYYY-MM');
  // 优先使用配置文件中的待发布文件，无则用当前月度文件
  const targetMonthFile = config.currentPendingFile || `${currentMonth}.json`;
  const monthFilePath = `data/websites/${targetMonthFile}`;
  
  console.log(`待发布文件路径：${monthFilePath}`);
  console.log(`当前时间（东八区）：${moment().utcOffset(8).format('YYYY-MM-DD HH:mm:ss')}`);

  // 读取月度文件中的所有网站
  const websites = await fetchFileFromRepo(monthFilePath) || [];
  console.log(`读取到网站总数：${websites.length} 个`);

  // 容错筛选：忽略status的空格和大小写，只保留pending状态
  const pendingSites = websites.filter(site => 
    site?.status?.trim().toLowerCase() === 'pending'
  );
  console.log(`找到待发布网站数量：${pendingSites.length} 个`);

  // 按创建时间排序，选择最早的一个（避免重复发布）
  const pendingSite = pendingSites.sort((a, b) => 
    new Date(a.createdAt) - new Date(b.createdAt)
  )[0];
   // 返回结果（无论是否找到，都返回路径，方便调试）
  return { site: pendingSite, monthFilePath };
}
/**
 * 6. 从仓库读取文件（带缓存+容错）
 * @param {string} filePath - 文件路径（如 data/websites/2025-10.json）
 * @returns {object[]|object|null} - 文件内容（JSON解析后）
 */
async function fetchFileFromRepo(filePath) {
  // 先查缓存，避免重复API调用
  if (fileCache.has(filePath)) {
    console.log(`[缓存] 读取文件：${filePath}`);
    return fileCache.get(filePath);
  }

  try {
    console.log(`[API] 读取文件：${filePath}`);
    const response = await octokit.repos.getContent({
      owner: MY_REPO.split('/')[0], // 仓库所有者（wyzbuss）
      repo: MY_REPO.split('/')[1],  // 仓库名（tg-bot-publisher）
      path: filePath,
      ref: BRANCH,                  // 分支（preview）
      mediaType: { format: 'raw' }, // 直接获取原始内容，避免base64解码
    });

    // 处理空数据（若文件存在但内容为空）
    if (!response.data) {
      console.log(`文件 ${filePath} 内容为空`);
      fileCache.set(filePath, []);
      return [];
    }

    // 解析JSON（容错：避免JSON格式错误导致整个流程中断）
    let data;
    try {
      data = JSON.parse(response.data);
    } catch (parseErr) {
      console.error(`解析文件 ${filePath} 失败（JSON格式错误）:`, parseErr.message);
      data = []; // 格式错误时返回空数组，确保后续流程不崩溃
    }

    // 存入缓存，后续复用
    fileCache.set(filePath, data);
    return data;
  } catch (error) {
    // 404表示文件不存在，返回null（非致命错误）
    if (error.status === 404) {
      console.log(`文件 ${filePath} 不存在`);
      fileCache.set(filePath, null);
      return null;
    }
    // 其他错误（如API限额、权限问题），抛出错误中断流程
    throw new Error(`读取文件失败: ${filePath} - ${error.message}`);
  }
}

/**
 * 7. 更新网站状态为“已发布”（修改JSON文件并提交到GitHub）
 * @param {object} site - 待更新状态的网站
 * @param {string} monthFilePath - 月度文件路径
 */
async function updateSiteStatus(site, monthFilePath) {
  // 1. 重新读取最新的月度文件（避免缓存过期）
  const websites = await fetchFileFromRepo(monthFilePath) || [];
  // 2. 更新目标网站的状态和发布时间
  const updatedWebsites = websites.map(item => 
    item.id === site.id 
      ? { 
          ...item, 
          status: 'published', // 标记为已发布
          publishedAt: moment().utcOffset(8).toISOString(), // 东八区时间
          publishTime: moment().utcOffset(8).format('YYYY-MM-DD HH:mm:ss') // 友好格式（可选）
        }
      : item
  );

  // 3. 获取文件的SHA值（GitHub要求，用于确认修改的是最新版本）
  let fileInfo;
  try {
    fileInfo = await octokit.repos.getContent({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path: monthFilePath,
      ref: BRANCH
    });
  } catch (getErr) {
    throw new Error(`获取文件SHA失败: ${getErr.message}`);
  }

  // 4. 将更新后的内容转为Base64（GitHub API要求）
  const contentBase64 = Buffer.from(
    JSON.stringify(updatedWebsites, null, 2) // 格式化JSON，便于阅读
  ).toString('base64');

  // 5. 提交修改到GitHub
  try {
    await octokit.repos.createOrUpdateFileContents({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path: monthFilePath,
      message: `Mark site ${site.id} as published`, // 提交信息
      content: contentBase64,
      branch: BRANCH,
      sha: fileInfo.data.sha, // 必须传最新的SHA，否则会冲突
      committer: {
        name: 'Telegram Publisher Bot', // 提交者名称（可自定义）
        email: 'bot@example.com' // 提交者邮箱（可自定义，无需真实）
      }
    });
    console.log(`成功更新网站状态：${site.id} → published`);
  } catch (commitErr) {
    throw new Error(`提交修改失败: ${commitErr.message}`);
  }
}

/**
 * 8. 更新配置文件（统计已发布数量、记录最后发布时间）
 */
async function updateConfigFile() {
  const configPath = 'data/config.json';
  // 1. 读取当前配置
  const currentConfig = await fetchFileFromRepo(configPath) || {
    currentPendingFile: moment().utcOffset(8).format('YYYY-MM') + '.json',
    totalPublished: 0,
    lastPublishedAt: null
  };

  // 2. 统计已发布网站总数（仅统计当前月度文件，减少API调用）
  const currentMonthFile = moment().utcOffset(8).format('YYYY-MM') + '.json';
  const currentMonthSites = await fetchFileFromRepo(`data/websites/${currentMonthFile}`) || [];
  const publishedCount = currentMonthSites.filter(site => 
    site.status === 'published'
  ).length;

  // 3. 更新配置内容
  const updatedConfig = {
    ...currentConfig,
    totalPublished: publishedCount, // 当前月度已发布数量
    lastPublishedAt: moment().utcOffset(8).toISOString(), // 最后发布时间（ISO格式）
    lastPublishTime: moment().utcOffset(8).format('YYYY-MM-DD HH:mm:ss'), // 友好格式
    currentPendingFile: currentMonthFile // 确保待发布文件是当前月度
  };

  // 4. 获取配置文件的SHA值
  let configFileInfo;
  try {
    configFileInfo = await octokit.repos.getContent({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path: configPath,
      ref: BRANCH
    });
  } catch (getErr) {
    // 若配置文件不存在，直接创建（SHA为空）
    configFileInfo = { data: { sha: '' } };
  }

  // 5. 提交配置更新
  try {
    await octokit.repos.createOrUpdateFileContents({
      owner: MY_REPO.split('/')[0],
      repo: MY_REPO.split('/')[1],
      path: configPath,
      message: 'Update published stats and config',
      content: Buffer.from(JSON.stringify(updatedConfig, null, 2)).toString('base64'),
      branch: BRANCH,
      sha: configFileInfo.data.sha || undefined, // 不存在时不传SHA
      committer: {
        name: 'Telegram Publisher Bot',
        email: 'bot@example.com'
      }
    });
    console.log('配置文件更新完成');
  } catch (commitErr) {
    console.warn('配置文件更新失败（不影响核心发布流程）:', commitErr.message);
    // 配置更新失败不中断主流程，避免因统计问题导致发布失败
  }
}

// Vercel运行时配置（确保截图有足够内存和时间）
module.exports.config = {
  runtime: 'nodejs',
  regions: ['iad1'], // 选择离你最近的区域（如亚太选 hkg1）
  memory: 1024,      // 截图需要1GB内存（避免内存不足崩溃）
  maxDuration: 60    // 最大运行时间60秒（应对慢加载网站）
};
