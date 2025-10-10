const https = require('https');
const fs = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const FormData = require('form-data');

// 环境变量
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// 步骤1：先上传一张测试图片，获取有效的file_id（属于你的机器人）
async function uploadTestImage() {
  // 使用临时文件（内容是简单的图片二进制数据）
  const tempFilePath = join(tmpdir(), 'test-image.jpg');
  fs.writeFileSync(tempFilePath, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46])); // 最小JPEG头
  
  const formData = new FormData();
  formData.append('chat_id', CHANNEL_ID);
  formData.append('photo', fs.createReadStream(tempFilePath));
  
  return new Promise((resolve, reject) => {
    formData.getLength((err, length) => {
      if (err) { reject(err); return; }
      
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
        method: 'POST',
        headers: { ...formData.getHeaders(), 'Content-Length': length }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          fs.unlinkSync(tempFilePath); // 清理临时文件
          try {
            const result = JSON.parse(data);
            if (result.ok && result.result.photo && result.result.photo.length) {
              // 获取有效的file_id
              const fileId = result.result.photo[result.result.photo.length - 1].file_id;
              console.log('获取到有效file_id:', fileId);
              
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
      
      req.on('error', (err) => reject(err));
      formData.pipe(req);
    });
  });
}

// 步骤2：使用自己的有效file_id发送媒体组
async function sendValidMediaGroup() {
  // 先上传图片获取有效file_id（确保属于当前机器人）
  const fileId1 = await uploadTestImage();
  const fileId2 = await uploadTestImage(); // 再获取一个
  
  // 构建媒体组（使用自己的file_id）
  const media = [
    { type: 'photo', media: fileId1, caption: '测试媒体组（有效file_id）', parse_mode: 'HTML' },
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
    
