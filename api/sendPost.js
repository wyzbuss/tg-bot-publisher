const { writeFile, unlink } = require('fs/promises');
const { tmpdir } = require('os');
const { join } = require('path');
const https = require('https');
const fs = require('fs');
const FormData = require('form-data');

// 环境变量
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// 1. 获取帖子内容
function getPostContent() {
  return {
    images: [
      'https://picsum.photos/800/450?random=1',
      'https://picsum.photos/800/450?random=2'
    ],
    caption: '每日精选图片\n\n第一张图片：美丽的自然风光\n第二张图片：城市建筑景观\n\n#每日分享 #图片'
  };
}

// 2. 下载图片
async function downloadImage(url, maxRedirects = 3) {
  if (maxRedirects <= 0) throw new Error('超过最大重定向次数');
  
  const tmpFilePath = join(tmpdir(), 'temp-' + Date.now() + '.jpg');
  return new Promise(function(resolve, reject) {
    const request = https.get(url, { timeout: 5000 }, function(response) {
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
    });
    request.on('timeout', () => { request.destroy(); reject(new Error('下载超时')); });
    request.on('error', reject);
  });
}

// 3. 获取FileId
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
      
      const req = https.request({
        hostname: 'api.telegram.org',
        path: '/bot' + TELEGRAM_BOT_TOKEN + '/sendPhoto',
        method: 'POST',
        headers: headers,
        timeout: 5000
      }, function(res) {
        let data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
          try {
            const result = JSON.parse(data);
            if (!result.ok) { 
              reject(new Error('Telegram错误:' + (result.description || '未知错误'))); 
              return;
            }
            if (!result.result || !result.result.photo || !result.result.photo.length) {
              reject(new Error('未获取到有效的图片file_id'));
              return;
            }
            // 删除临时消息
            https.request({
              hostname: 'api.telegram.org',
              path: '/bot' + TELEGRAM_BOT_TOKEN + '/deleteMessage',
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              timeout: 5000
            }).end(JSON.stringify({
              chat_id: CHANNEL_ID,
              message_id: result.result.message_id
            }));
            resolve(result.result.photo[result.result.photo.length - 1].file_id);
          } catch (e) {
            reject(new Error('解析响应失败:' + e.message));
          }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('获取file_id超时')); });
      req.on('error', reject);
      formData.pipe(req);
    });
  });
}

// 4. 发送媒体组（修复核心错误：确保media参数正确生成）
async function sendMediaGroup(fileIds, caption) {
  // 验证fileIds是否有效
  if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
    throw new Error('无效的fileIds数组，无法生成media参数');
  }
  
  // 构建media数组（确保格式正确）
  const media = fileIds.map((fileId, index) => ({
    type: 'photo',
    media: fileId,
    // 只有第一个媒体添加标题
    caption: index === 0 ? caption : undefined,
    parse_mode: 'HTML'
  }));
  
  // 验证media数组
  if (!media || media.length === 0) {
    throw new Error('media参数生成失败，为空数组');
  }
  
  // 转换为JSON字符串（Telegram要求的格式）
  const mediaJson = JSON.stringify(media);
  
  return new Promise(function(resolve, reject) {
    const postData = JSON.stringify({
      chat_id: CHANNEL_ID,
      media: mediaJson  // 确保正确传递media参数
    });
    
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + TELEGRAM_BOT_TOKEN + '/sendMediaGroup',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 5000
    }, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          const result = JSON.parse(data);
          if (!result.ok) {
            reject(new Error('媒体组错误:' + (result.description || '未知错误')));
            return;
          }
          resolve(result);
        } catch (e) {
          reject(new Error('解析媒体组响应失败:' + e.message));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('发送媒体组超时')); });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// 主函数
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
    
    // 验证图片列表
    if (!content.images || !content.images.length) {
      throw new Error('未配置图片URL列表');
    }
    
    // 下载图片
    const paths = await Promise.all(content.images.map(async (url) => {
      const path = await downloadImage(url);
      tempFiles.push(path);
      return path;
    }));
    
    // 获取FileId
    const ids = await Promise.all(paths.map(path => getFileId(path)));
    
    // 验证fileIds
    if (ids.length < 1) {
      throw new Error('未获取到任何图片的file_id');
    }
    
    // 发送媒体组
    const result = await sendMediaGroup(ids, content.caption);
    
    res.status(200).json({ success: true, result: result });
  } catch (error) {
    console.error('执行错误:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    // 清理临时文件
    for (const path of tempFiles) {
      try { await unlink(path); } catch (e) { console.log('清理失败:', e.message); }
    }
  }
};

module.exports.config = { runtime: 'nodejs' };
    
