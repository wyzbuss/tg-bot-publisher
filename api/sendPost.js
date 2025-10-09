const { writeFile, unlink } = require('fs/promises');
const { tmpdir } = require('os');
const { join } = require('path');
const https = require('https');
const fs = require('fs');
const FormData = require('form-data');

// 环境变量
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// 下载图片
async function downloadImage(url) {
  const tmpFilePath = join(tmpdir(), 'temp-' + Date.now() + '.jpg');
  return new Promise(function(resolve, reject) {
    const request = https.get(url, function(response) {
      if (response.statusCode === 200) {
        const file = fs.createWriteStream(tmpFilePath);
        response.pipe(file);
        file.on('finish', function() {
          file.close(function() { resolve(tmpFilePath); });
        });
      } else {
        reject(new Error('下载失败: ' + response.statusCode));
      }
    });
    request.on('error', reject);
  });
}

// 获取file_id
async function getFileId(filePath) {
  return new Promise(function(resolve, reject) {
    const formData = new FormData();
    formData.append('chat_id', CHANNEL_ID);
    formData.append('photo', fs.createReadStream(filePath));
    
    formData.getLength(function(err, length) {
      if (err) { reject(err); return; }
      
      const options = {
        method: 'POST',
        headers: Object.assign(formData.getHeaders(), { 'Content-Length': length })
      };

      const req = https.request(
        'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendPhoto',
        options,
        function(res) {
          let data = '';
          res.on('data', function(chunk) { data += chunk; });
          res.on('end', function() {
            const result = JSON.parse(data);
            if (result.ok) {
              // 删除临时消息
              const deleteReq = https.request({
                hostname: 'api.telegram.org',
                path: '/bot' + TELEGRAM_BOT_TOKEN + '/deleteMessage',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              });
              deleteReq.write(JSON.stringify({
                chat_id: CHANNEL_ID,
                message_id: result.result.message_id
              }));
              deleteReq.end();
              
              resolve(result.result.photo[0].file_id);
            } else {
              reject(new Error('Telegram错误: ' + JSON.stringify(result)));
            }
          });
        }
      );
      formData.pipe(req);
      req.on('error', reject);
    });
  });
}

// 发送媒体组
async function sendMediaGroup(fileIds) {
  return new Promise(function(resolve, reject) {
    const media = JSON.stringify([
      { type: 'photo', media: fileIds[0], caption: '精选图片' },
      { type: 'photo', media: fileIds[1] }
    ]);
    
    const data = JSON.stringify({ chat_id: CHANNEL_ID, media: media });
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(
      'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMediaGroup',
      options,
      function(res) {
        let response = '';
        res.on('data', function(chunk) { response += chunk; });
        res.on('end', function() {
          const result = JSON.parse(response);
          if (result.ok) resolve(result);
          else reject(new Error('发送失败: ' + JSON.stringify(result)));
        });
      }
    );
    req.write(data);
    req.end();
    req.on('error', reject);
  });
}

// 主函数
module.exports = async function handler(req, res) {
  try {
    // 简单图片URL
    const urls = [
      'https://picsum.photos/800/600?random=1',
      'https://picsum.photos/800/600?random=2'
    ];
    
    // 下载图片
    const paths = [await downloadImage(urls[0]), await downloadImage(urls[1])];
    
    // 获取file_id
    const ids = [await getFileId(paths[0]), await getFileId(paths[1])];
    
    // 发送媒体组
    const result = await sendMediaGroup(ids);
    
    // 清理文件
    await unlink(paths[0]);
    await unlink(paths[1]);
    
    res.status(200).json({ success: true, result: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports.config = { runtime: 'nodejs' };
    
