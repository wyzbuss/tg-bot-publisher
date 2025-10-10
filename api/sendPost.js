const https = require('https');
const fs = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const FormData = require('form-data');

// 环境变量
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// 步骤1：下载图片（支持重定向）
async function downloadImageWithRedirects(url, maxRedirects = 3) {
  // 限制最大重定向次数，防止循环重定向
  if (maxRedirects <= 0) {
    throw new Error('超过最大重定向次数');
  }

  const tempFilePath = join(tmpdir(), `image-${Date.now()}.jpg`);
  
  return new Promise((resolve, reject) => {
    const request = https.get(url, (res) => {
      // 处理重定向
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location;
        if (!redirectUrl) {
          reject(new Error('重定向但未提供目标URL'));
          return;
        }
        
        // 释放当前连接资源
        res.resume();
        // 跟随重定向，减少剩余重定向次数
        downloadImageWithRedirects(redirectUrl, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
        return;
      }
      
      // 处理正常响应
      if (res.statusCode !== 200) {
        reject(new Error(`下载图片失败，状态码: ${res.statusCode}`));
        return;
      }
      
      // 保存图片到临时文件
      const fileStream = fs.createWriteStream(tempFilePath);
      res.pipe(fileStream);
      
      fileStream.on('finish', () => {
        fileStream.close(() => {
          resolve(tempFilePath);
        });
      });
      
      fileStream.on('error', (err) => {
        fs.unlink(tempFilePath, () => {});
        reject(new Error(`文件写入错误: ${err.message}`));
      });
    });
    
    request.on('error', (err) => {
      reject(new Error(`下载请求错误: ${err.message}`));
    });
  });
}

// 步骤2：上传图片获取file_id
async function uploadImage() {
  // 使用会重定向的图片URL测试
  const imageUrl = 'https://picsum.photos/800/450?random=' + Math.random();
  const tempPath = await downloadImageWithRedirects(imageUrl);
  
  const formData = new FormData();
  formData.append('chat_id', CHANNEL_ID);
  formData.append('photo', fs.createReadStream(tempPath));
  
  return new Promise((resolve, reject) => {
    formData.getLength((err, length) => {
      if (err) { 
        fs.unlink(tempPath, () => {});
        reject(new Error(`表单错误: ${err.message}`));
        return;
      }
      
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
        method: 'POST',
        headers: { ...formData.getHeaders(), 'Content-Length': length }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          fs.unlink(tempPath, () => {});
          
          try {
            const result = JSON.parse(data);
            if (result.ok && result.result.photo && result.result.photo.length) {
              const fileId = result.result.photo[result.result.photo.length - 1].file_id;
              
              // 删除临时消息
              https.request({
                hostname: 'api.telegram.org',
                path: `/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              }).end(JSON.stringify({
                chat_id: CHANNEL_ID,
                message_id: result.result.message_id
              }));
              
              resolve(fileId);
            } else {
              reject(new Error(`上传图片失败: ${result.description || data}`));
            }
          } catch (e) {
            reject(new Error(`解析响应失败: ${e.message}`));
          }
        });
      });
      
      req.on('error', (err) => {
        fs.unlink(tempPath, () => {});
        reject(new Error(`上传请求错误: ${err.message}`));
      });
      
      formData.pipe(req);
    });
  });
}

// 步骤3：发送媒体组
async function sendMediaGroup() {
  const fileId1 = await uploadImage();
  const fileId2 = await uploadImage();
  
  const media = [
    { type: 'photo', media: fileId1, caption: '成功处理重定向', parse_mode: 'HTML' },
    { type: 'photo', media: fileId2 }
  ];
  
  const postData = JSON.stringify({
    chat_id: CHANNEL_ID,
    media: JSON.stringify(media)
  });
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) resolve(result);
          else reject(new Error(`媒体组错误: ${result.description || data}`));
        } catch (e) {
          reject(new Error(`解析错误: ${e.message}`));
        }
      });
    });
    
    req.on('error', (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

// 主函数
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  
  if (!TELEGRAM_BOT_TOKEN || !CHANNEL_ID) {
    return res.status(500).json({ error: '缺少环境变量' });
  }
  
  try {
    const result = await sendMediaGroup();
    res.status(200).json({ success: true, result: result });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      debug: { channelId: CHANNEL_ID, tokenSet: !!TELEGRAM_BOT_TOKEN }
    });
  }
};

module.exports.config = { runtime: 'nodejs' };
    
