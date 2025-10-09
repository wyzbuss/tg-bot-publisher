import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import https from 'https';
import fs from 'fs';
import FormData from 'form-data'; // 仅保留这个第三方库

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
    caption: `每日精选图片\n\n第一张图片：美丽的自然风光\n第二张图片：城市建筑景观\n\n#每日分享 #图片`
  };
};

// 下载图片到临时文件
const downloadImage = async (url) => {
  try {
    const tmpFilePath = join(tmpdir(), `temp-${Date.now()}.jpg`);
    
    return new Promise((resolve, reject) => {
      https.get(url, (response) => {
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
      }).on('error', reject);
    });
  } catch (error) {
    console.error('下载图片出错:', error);
    throw error;
  }
};

// 使用Node.js内置https模块发送POST请求（替代axios）
const httpsPost = (url, data, headers = {}) => {
  return new Promise((resolve, reject) => {
    const options = {
      method: 'POST',
      headers: { ...headers }
    };

    const req = https.request(url, options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseData));
        } catch (e) {
          resolve(responseData); // 非JSON响应直接返回
        }
      });
    });
    
    req.on('error', reject);
    
    // 发送数据
    if (data) {
      req.write(data);
    }
    
    req.end();
  });
};

// 上传图片到Telegram并获取file_id
const uploadImage = async (filePath) => {
  try {
    const formData = new FormData();
    formData.append('chat_id', CHANNEL_ID);
    formData.append('photo', fs.createReadStream(filePath));
    
    // 获取form-data的边界和长度
    const headers = formData.getHeaders();
    headers['Content-Length'] = formData.getLengthSync();
    
    const response = await httpsPost(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
      formData,
      headers
    );
    
    if (!response.ok) {
      throw new Error(`Telegram API 错误: ${JSON.stringify(response)}`);
    }
    
    return response.result.photo[response.result.photo.length - 1].file_id;
  } catch (error) {
    console.error('上传图片出错:', error);
    throw error;
  }
};

// 发送媒体组
const sendMediaGroup = async (fileIds, caption) => {
  try {
    const media = fileIds.map((fileId, index) => ({
      type: 'photo',
      media: fileId,
      caption: index === 0 ? caption : undefined,
      parse_mode: 'HTML'
    }));
    
    const response = await httpsPost(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
      JSON.stringify({
        chat_id: CHANNEL_ID,
        media: JSON.stringify(media)
      }),
      { 'Content-Type': 'application/json' }
    );
    
    if (!response.ok) {
      throw new Error(`发送媒体组失败: ${JSON.stringify(response)}`);
    }
    
    return response.data;
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
    const filePaths = await Promise.all(
      postContent.images.map(async (url) => {
        const filePath = await downloadImage(url);
        tempFiles.push(filePath);
        return filePath;
      })
    );
    
    const fileIds = await Promise.all(
      filePaths.map(filePath => uploadImage(filePath))
    );
    
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
  runtime: 'nodejs',
};
    
