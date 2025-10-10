const https = require('https');
const fs = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const FormData = require('form-data');

// 环境变量
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// 步骤1：从真实URL下载有效图片
async function downloadRealImage(url) {
  const tempFilePath = join(tmpdir(), `real-image-${Date.now()}.jpg`);
  
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`下载图片失败，状态码: ${res.statusCode}`));
        return;
      }
      
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
    }).on('error', (err) => {
      reject(new Error(`下载请求错误: ${err.message}`));
    });
  });
}

// 步骤2：上传真实图片获取有效file_id
async function uploadRealImage() {
  // 使用真实有效的图片URL（确保是可访问的JPG/PNG）
  const imageUrl = 'https://picsum.photos/800/450?random=' + Math.random();
  const tempPath = await downloadRealImage(imageUrl);
  
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
          fs.unlink(tempPath, () => {}); // 清理临时文件
          
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

// 步骤3：使用有效file_id发送媒体组
async function sendValidMediaGroup() {
  const fileId1 = await uploadRealImage();
  const fileId2 = await uploadRealImage();
  
  const media = [
    { type: 'photo', media: fileId1, caption: '测试媒体组', parse_mode: 'HTML' },
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
    const result = await sendValidMediaGroup();
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
    
