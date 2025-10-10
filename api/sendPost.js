const { unlink } = require('fs/promises');
const { tmpdir } = require('os');
const { join } = require('path');
const https = require('https');
const fs = require('fs');
const FormData = require('form-data');

// 环境变量
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// 调试用：存储中间结果，用于响应输出
const debug = {
  step: '开始',
  images: [],
  filePaths: [],
  fileIds: [],
  media: null
};

// 1. 获取帖子内容
function getPostContent() {
  const content = {
    images: [
      'https://picsum.photos/800/450?random=1',
      'https://picsum.photos/800/450?random=2'
    ],
    caption: '每日精选图片\n\n#每日分享 #图片'
  };
  debug.images = content.images;
  debug.step = '已获取图片URL';
  return content;
}

// 2. 下载图片
async function downloadImage(url) {
  debug.step = `正在下载: ${url}`;
  const tmpFilePath = join(tmpdir(), 'temp-' + Date.now() + '.jpg');
  
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 5000 }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        debug.step = `重定向到: ${redirectUrl}`;
        response.resume();
        downloadImage(redirectUrl).then(resolve).catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`下载失败，状态码: ${response.statusCode}`));
        return;
      }
      
      const file = fs.createWriteStream(tmpFilePath);
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          debug.filePaths.push(tmpFilePath);
          debug.step = `下载完成: ${tmpFilePath}`;
          resolve(tmpFilePath);
        });
      });
    });
    
    request.on('timeout', () => reject(new Error('下载超时')));
    request.on('error', (err) => reject(new Error(`下载错误: ${err.message}`)));
  });
}

// 3. 获取FileId
async function getFileId(filePath) {
  debug.step = `正在获取file_id: ${filePath}`;
  const formData = new FormData();
  formData.append('chat_id', CHANNEL_ID);
  formData.append('photo', fs.createReadStream(filePath));
  formData.append('disable_notification', 'true');
  
  return new Promise((resolve, reject) => {
    formData.getLength((err, length) => {
      if (err) { reject(new Error(`表单错误: ${err.message}`)); return; }
      
      const headers = formData.getHeaders();
      headers['Content-Length'] = length;
      
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
        method: 'POST',
        headers: headers,
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (!result.ok) {
              reject(new Error(`Telegram错误: ${result.description || data}`));
              return;
            }
            const fileId = result.result.photo[result.result.photo.length - 1].file_id;
            debug.fileIds.push(fileId);
            debug.step = `获取file_id成功: ${fileId}`;
            resolve(fileId);
          } catch (e) {
            reject(new Error(`解析错误: ${e.message}, 响应: ${data}`));
          }
        });
      });
      
      req.on('timeout', () => reject(new Error('获取file_id超时')));
      req.on('error', (err) => reject(new Error(`请求错误: ${err.message}`)));
      formData.pipe(req);
    });
  });
}

// 4. 发送媒体组
async function sendMediaGroup(fileIds, caption) {
  debug.step = '开始构建media参数';
  debug.fileIds = fileIds; // 记录最终的fileIds
  
  // 构建media数组
  const media = fileIds.map((fileId, index) => ({
    type: 'photo',
    media: fileId,
    caption: index === 0 ? caption : undefined,
    parse_mode: 'HTML'
  }));
  debug.media = media; // 记录构建的media数组
  
  const mediaJson = JSON.stringify(media);
  const postData = JSON.stringify({ chat_id: CHANNEL_ID, media: mediaJson });
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (!result.ok) {
            reject(new Error(`媒体组错误: ${result.description || data}`));
            return;
          }
          resolve(result);
        } catch (e) {
          reject(new Error(`解析响应错误: ${e.message}, 响应: ${data}`));
        }
      });
    });
    
    req.on('timeout', () => reject(new Error('发送超时')));
    req.on('error', (err) => reject(new Error(`发送错误: ${err.message}`)));
    req.write(postData);
    req.end();
  });
}

// 主函数：在响应中包含调试信息
module.exports = async function handler(req, res) {
  try {
    const content = getPostContent();
    
    // 下载图片
    const paths = await Promise.all(
      content.images.map(url => downloadImage(url))
    );
    
    // 获取fileIds
    const ids = await Promise.all(
      paths.map(path => getFileId(path))
    );
    
    // 发送媒体组
    const result = await sendMediaGroup(ids, content.caption);
    
    res.status(200).json({
      success: true,
      result: result,
      debug: debug // 成功时也返回调试信息
    });
  } catch (error) {
    // 错误时返回详细调试信息
    res.status(500).json({
      success: false,
      error: error.message,
      debug: debug // 包含到错误发生时的所有步骤数据
    });
  } finally {
    // 清理临时文件
    for (const path of debug.filePaths) {
      try { await unlink(path); } catch (e) {}
    }
  }
};

module.exports.config = { runtime: 'nodejs' };
    
