const { writeFile, unlink } = require('fs/promises');
const { tmpdir } = require('os');
const { join } = require('path');
const https = require('https');
const fs = require('fs');
const FormData = require('form-data');

// 环境变量
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// 获取帖子内容
function getPostContent() {
  return {
    images: [
      'https://picsum.photos/800/600?random=1',
      'https://picsum.photos/800/600?random=2'
    ],
    caption: '每日精选图片\n\n第一张图片：美丽的自然风光\n第二张图片：城市建筑景观\n\n#每日分享 #图片'
  };
}

// 下载图片
async function downloadImage(url, maxRedirects) {
  maxRedirects = maxRedirects || 3;
  if (maxRedirects <= 0) {
    throw new Error('超过最大重定向次数');
  }

  try {
    const tmpFilePath = join(tmpdir(), 'temp-' + Date.now() + '.jpg');
    
    return new Promise(function(resolve, reject) {
      const request = https.get(url, function(response) {
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (!redirectUrl) {
            reject(new Error('重定向但未提供目标URL'));
            return;
          }
          
          response.resume();
          downloadImage(redirectUrl, maxRedirects - 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        
        if (response.statusCode !== 200) {
          reject(new Error('下载图片失败，状态码: ' + response.statusCode));
          return;
        }
        
        const file = fs.createWriteStream(tmpFilePath);
        response.pipe(file);
        
        file.on('finish', function() {
          file.close(function() {
            resolve(tmpFilePath);
          });
        });
        
        file.on('error', function(err) {
          unlink(tmpFilePath).catch(function() {});
          reject(err);
        });
      });
      
      request.on('error', reject);
    });
  } catch (error) {
    console.error('下载图片出错:', error);
    throw error;
  }
}

// 获取图片file_id
async function getFileId(filePath) {
  try {
    const formData = new FormData();
    formData.append('chat_id', CHANNEL_ID);
    formData.append('photo', fs.createReadStream(filePath));
    formData.append('disable_notification', 'true');
    
    return new Promise(function(resolve, reject) {
      formData.getLength(function(err, length) {
        if (err) {
          reject(err);
          return;
        }

        const headers = formData.getHeaders();
        headers['Content-Length'] = length;
        
        const options = {
          method: 'POST',
          headers: headers
        };

        const req = https.request(
          'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendPhoto',
          options,
          function(res) {
            let responseData = '';
            
            res.on('data', function(chunk) {
              responseData += chunk;
            });
            
            res.on('end', function() {
              try {
                const data = JSON.parse(responseData);
                if (!data.ok) {
                  reject(new Error('Telegram API 错误: ' + JSON.stringify(data)));
                  return;
                }
                
                // 删除临时消息
                const deleteOptions = {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' }
                };
                
                const deleteReq = https.request(
                  'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/deleteMessage',
                  deleteOptions,
                  function(deleteRes) {
                    deleteRes.resume();
                  }
                );
                
                deleteReq.on('error', function(deleteErr) {
                  console.error('删除临时图片失败:', deleteErr);
                });
                
                deleteReq.end(JSON.stringify({
                  chat_id: CHANNEL_ID,
                  message_id: data.result.message_id
                }));
                
                resolve(data.result.photo[data.result.photo.length - 1].file_id);
              } catch (e) {
                reject(new Error('解析响应失败: ' + e.message));
              }
            }
          }
        );
        
        req.on('error', reject);
        formData.pipe(req);
      });
    });
  } catch (error) {
    console.error('获取file_id出错:', error);
    throw error;
  }
}

// 发送媒体组
async function sendMediaGroup(fileIds, caption) {
  try {
    const media = [];
    for (let i = 0; i < fileIds.length; i++) {
      media.push({
        type: 'photo',
        media: fileIds[i],
        caption: i === 0 ? caption : undefined,
        parse_mode: 'HTML'
      });
    }
    
    return new Promise(function(resolve, reject) {
      const data = JSON.stringify({
        chat_id: CHANNEL_ID,
        media: JSON.stringify(media),
        disable_notification: 'false'
      });
      
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
          let responseData = '';
          
          res.on('data', function(chunk) {
            responseData += chunk;
          });
          
          res.on('end', function() {
            try {
              const result = JSON.parse(responseData);
              if (!result.ok) {
                reject(new Error('发送媒体组失败: ' + JSON.stringify(result)));
                return;
              }
              resolve(result);
            } catch (e) {
              reject(new Error('解析媒体组响应失败: ' + e.message));
            }
          }
        }
      );
      
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  } catch (error) {
    console.error('发送媒体组出错:', error);
    throw error;
  }
}

// 主处理函数
module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ message: '只允许POST和GET请求' });
  }
  
  if (!TELEGRAM_BOT_TOKEN || !CHANNEL_ID) {
    return res.status(500).json({ message: '缺少必要的环境变量配置' });
  }
  
  let tempFiles = [];
  
  try {
    const postContent = getPostContent();
    const filePaths = [];
    for (let i = 0; i < postContent.images.length; i++) {
      const filePath = await downloadImage(postContent.images[i]);
      tempFiles.push(filePath);
      filePaths.push(filePath);
    }
    
    const fileIds = [];
    for (let i = 0; i < filePaths.length; i++) {
      const fileId = await getFileId(filePaths[i]);
      fileIds.push(fileId);
    }
    
    const result = await sendMediaGroup(fileIds, postContent.caption);
    
    res.status(200).json({ 
      success: true, 
      message: '帖子发送成功',
      result 
    });
  } catch (error) {
    console.error('发送帖子时出错:', error);
    res.status(500).json({ 
      success: false, 
      message: '发送帖子失败',
      error: error.message 
    });
  } finally {
    for (let i = 0; i < tempFiles.length; i++) {
      try {
        await unlink(tempFiles[i]);
      } catch (cleanupError) {
        console.error('清理临时文件 ' + tempFiles[i] + ' 失败:', cleanupError);
      }
    }
  }
};

module.exports.config = { runtime: 'nodejs' };
    
