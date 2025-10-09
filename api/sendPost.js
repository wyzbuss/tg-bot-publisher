import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import https from 'https';
import fs from 'fs';
import FormData from 'form-data';

// Telegram Bot API 配置
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// 图片URL和描述 - 请替换为你的实际内容
const getPostContent = () => {
  return {
    images: [
      'https://picsum.photos/800/600?random=1',
      'https://picsum.photos/800/600?random=2'
    ],
    caption: '每日精选图片\n\n第一张图片：美丽的自然风光\n第二张图片：城市建筑景观\n\n#每日分享 #图片'
  };
};

// 下载图片到临时文件（支持重定向）
const downloadImage = async (url, maxRedirects = 3) => {
  if (maxRedirects <= 0) {
    throw new Error('超过最大重定向次数');
  }

  try {
    const tmpFilePath = join(tmpdir(), `temp-${Date.now()}.jpg`);
    
    return new Promise((resolve, reject) => {
      const request = https.get(url, (response) => {
        // 处理重定向
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
        
        // 处理正常响应
        if (response.statusCode !== 200) {
          reject(new Error(`下载图片失败，状态码: ${response.statusCode}`));
          return;
        }
        
        const file = fs.createWriteStream(tmpFilePath);
        response.pipe(file);
        
        file.on('finish', () => {
          file.close(() => resolve(tmpFilePath));
        });
        
        file.on('error', (err) => {
          unlink(tmpFilePath).catch(() => {});
          reject(err);
        });
      });
      
      request.on('error', reject);
    });
  } catch (error) {
    console.error('下载图片出错:', error);
    throw error;
  }
};

// 获取图片的file_id（仅上传不发送）
const getFileId = async (filePath) => {
  try {
    const formData = new FormData();
    formData.append('chat_id', CHANNEL_ID);
    formData.append('photo', fs.createReadStream(filePath));
    formData.append('disable_notification', 'true'); // 静默上传，不通知用户
    
    return new Promise((resolve, reject) => {
      formData.getLength((err, length) => {
        if (err) {
          reject(err);
          return;
        }

        const options = {
          method: 'POST',
          headers: {
            ...formData.getHeaders(),
            'Content-Length': length
          }
        };

        const req = https.request(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
          options,
          (res) => {
            let responseData = '';
            
            res.on('data', (chunk) => {
              responseData += chunk;
            });
            
            res.on('end', () => {
              try {
                const data = JSON.parse(responseData);
                if (!data.ok) {
                  reject(new Error(`Telegram API 错误: ${JSON.stringify(data)}`));
                  return;
                }
                
                // 上传成功后立即删除这张临时发送的图片
                https.request(
                  `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                  },
                  (deleteRes) => deleteRes.resume()
                )
                .on('error', (deleteErr) => console.error('删除临时图片失败:', deleteErr))
                .end(JSON.stringify({
                  chat_id: CHANNEL_ID,
                  message_id: data.result.message_id
                }));
                
                resolve(data.result.photo[data.result.photo.length - 1].file_id);
              } catch (e) {
                reject(new Error(`解析响应失败: ${e.message}`));
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
};

// 发送媒体组（主要展示方式）
const sendMediaGroup = async (fileIds, caption) => {
  try {
    // 构建媒体组
    const media = fileIds.map((fileId, index) => ({
      type: 'photo',
      media: fileId,
      // 只有第一个媒体添加标题
      caption: index === 0 ? caption : undefined,
      parse_mode: 'HTML'
    }));
    
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        chat_id: CHANNEL_ID,
        media: JSON.stringify(media),
        disable_notification: 'false' // 这个是正式发送，需要通知
      });
      
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const req = https.request(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
        options,
        (res) => {
          let responseData = '';
          
          res.on('data', (chunk) => {
            responseData += chunk;
          });
          
          res.on('end', () => {
            try {
              const result = JSON.parse(responseData);
              if (!result.ok) {
                reject(new Error(`发送媒体组失败: ${JSON.stringify(result)}`));
                return;
              }
              resolve(result);
            } catch (e) {
              reject(new Error(`解析媒体组响应失败: ${e.message}`));
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
};

// 主函数
export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ message: '只允许POST和GET请求' });
  }
  
  if (!TELEGRAM_BOT_TOKEN || !CHANNEL_ID) {
    return res.status(500).json({ message: '缺少必要的环境变量配置' });
  }
  
  let tempFiles = [];
  
  try {
    const postContent = getPostContent();
    
    // 下载图片
    const filePaths = await Promise.all(
      postContent.images.map(async (url) => {
        const filePath = await downloadImage(url);
        tempFiles.push(filePath);
        return filePath;
      })
    );
    
    // 获取file_id（临时上传后立即删除）
    const fileIds = await Promise.all(
      filePaths.map(filePath => getFileId(filePath))
    );
    
    // 只发送媒体组，不单独发送图片
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
    // 清理临时文件
    for (const file of tempFiles) {
      try {
        await unlink(file);
      } catch (cleanupError) {
        console.error(`清理临时文件 ${file} 失败:`, cleanupError);
      }
    }
  }
}

export const config = {
  runtime: 'nodejs'
};
    
