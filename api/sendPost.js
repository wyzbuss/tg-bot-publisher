// api/sendPost.js（仅修复语法，保留原有核心逻辑）
const { writeFile, unlink } = require('fs/promises');
const { tmpdir } = require('os');
const { join } = require('path');
const https = require('https');
const fs = require('fs');
const FormData = require('form-data');

// 环境变量（和你之前配置一致）
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// 1. 获取帖子内容（保留你之前的图片和文案）
function getPostContent() {
  return {
    images: [
      'https://picsum.photos/800/450?random=1', // 宽高比16:9，利于横向排布
      'https://picsum.photos/800/450?random=2'
    ],
    caption: '每日精选图片\n\n第一张图片：美丽的自然风光\n第二张图片：城市建筑景观\n\n#每日分享 #图片'
  };
}

// 2. 下载图片（保留重定向处理，修复括号）
async function downloadImage(url, maxRedirects = 3) {
  if (maxRedirects <= 0) throw new Error('超过最大重定向次数');
  
  const tmpFilePath = join(tmpdir(), 'temp-' + Date.now() + '.jpg');
  return new Promise(function(resolve, reject) {
    https.get(url, function(response) {
      // 处理301/302重定向
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (!redirectUrl) { reject(new Error('无重定向URL')); return; }
        response.resume();
        downloadImage(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }
      // 正常下载
      if (response.statusCode !== 200) { reject(new Error('状态码:' + response.statusCode)); return; }
      const file = fs.createWriteStream(tmpFilePath);
      response.pipe(file);
      file.on('finish', function() { file.close(function() { resolve(tmpFilePath); }); });
      file.on('error', function(err) { unlink(tmpFilePath).catch(() => {}); reject(err); });
    }).on('error', reject);
  });
}

// 3. 获取FileId（保留临时删除，修复语法）
async function getFileId(filePath) {
  const formData = new FormData();
  formData.append('chat_id', CHANNEL_ID);
  formData.append('photo', fs.createReadStream(filePath));
  formData.append('disable_notification', 'true');
  
  return new Promise(function(resolve, reject) {
    formData.getLength(function(err, length) {
      if (err) { reject(err); return; }
      const headers = formData.getHeaders();
      headers['Content-Length'] = length;
      
      https.request({
        hostname: 'api.telegram.org',
        path: '/bot' + TELEGRAM_BOT_TOKEN + '/sendPhoto',
        method: 'POST',
        headers: headers
      }, function(res) {
        let data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
          const result = JSON.parse(data);
          if (!result.ok) { reject(new Error('Telegram错误:' + result.description)); return; }
          // 删除临时消息
          https.request({
            hostname: 'api.telegram.org',
            path: '/bot' + TELEGRAM_BOT_TOKEN + '/deleteMessage',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          }).end(JSON.stringify({
            chat_id: CHANNEL_ID,
            message_id: result.result.message_id
          }));
          resolve(result.result.photo[result.result.photo.length - 1].file_id);
        });
      }).on('error', reject).end(formData);
    });
  });
}

// 4. 发送媒体组（保留你要的“只发一次+横向”）
async function sendMediaGroup(fileIds, caption) {
  const media = JSON.stringify([
    { type: 'photo', media: fileIds[0], caption: caption, parse_mode: 'HTML' },
    { type: 'photo', media: fileIds[1] }
  ]);
  return new Promise(function(resolve, reject) {
    https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + TELEGRAM_BOT_TOKEN + '/sendMediaGroup',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(media)
      }
    }, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        const result = JSON.parse(data);
        result.ok ? resolve(result) : reject(new Error('媒体组错误:' + result.description));
      });
    }).on('error', reject).end(media);
  });
}

// 主函数（和你之前成功时的逻辑一致）
module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ message: '只允许POST/GET' });
  }
  if (!TELEGRAM_BOT_TOKEN || !CHANNEL_ID) {
    return res.status(500).json({ message: '缺环境变量' });
  }

  let tempFiles = [];
  try {
    const content = getPostContent();
    // 下载图片
    const paths = await Promise.all(content.images.map(async (url) => {
      const path = await downloadImage(url);
      tempFiles.push(path);
      return path;
    }));
    // 获取FileId
    const ids = await Promise.all(paths.map(path => getFileId(path)));
    // 发送媒体组（只发这一次）
    const result = await sendMediaGroup(ids, content.caption);
    
    res.status(200).json({ success: true, result: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    // 清理临时文件
    for (const path of tempFiles) {
      try { await unlink(path); } catch (e) { console.log('清理失败:', e.message); }
    }
  }
};

// 运行时配置（固定）
module.exports.config = { runtime: 'nodejs' };
