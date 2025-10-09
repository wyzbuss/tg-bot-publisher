import axios from 'axios';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import https from 'https';

// Telegram Bot API 配置
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// 图片URL和描述 - 可以根据需要修改或从其他地方获取
const getPostContent = () => {
  // 这里可以替换为实际的图片URL和描述
  // 示例：从数组中随机选择，或从API获取
  return {
    images: [
      'https://picsum.photos/800/600?random=1', // 第一张图片URL
      'https://picsum.photos/800/600?random=2'  // 第二张图片URL
    ],
    caption: `每日精选图片\n\n第一张图片：美丽的自然风光\n第二张图片：城市建筑景观\n\n#每日分享 #图片`
  };
};

// 下载图片到临时文件
const downloadImage = async (url) => {
  try {
    const tmpFilePath = join(tmpdir(), `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.jpg`);
    
    return new Promise((resolve, reject) => {
      https.get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`下载图片失败，状态码: ${response.statusCode}`));
          return;
        }
        
        const file = fs.createWriteStream(tmpFilePath);
        response.pipe(file);
        
        file.on('finish', () => {
          file.close(() => {
            resolve(tmpFilePath);
          });
        });
        
        file.on('error', (err) => {
          unlink(tmpFilePath).catch(() => {}); // 清理文件
          reject(err);
        });
      }).on('error', (err) => {
        reject(err);
      });
    });
  } catch (error) {
    console.error('下载图片出错:', error);
    throw error;
  }
};

// 上传图片到Telegram并获取file_id
const uploadImage = async (filePath) => {
  try {
    const formData = new FormData();
    formData.append('chat_id', CHANNEL_ID);
    formData.append('photo', fs.createReadStream(filePath));
    
    const response = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
      formData,
      {
        headers: formData.getHeaders()
      }
    );
    
    if (!response.data.ok) {
      throw new Error(`Telegram API 错误: ${JSON.stringify(response.data)}`);
    }
    
    return response.data.result.photo[response.data.result.photo.length - 1].file_id;
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
      // 只有第一个媒体可以有标题
      caption: index === 0 ? caption : undefined,
      parse_mode: 'HTML'
    }));
    
    const response = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
      {
        chat_id: CHANNEL_ID,
        media: JSON.stringify(media)
      }
    );
    
    if (!response.data.ok) {
      throw new Error(`发送媒体组失败: ${JSON.stringify(response.data)}`);
    }
    
    return response.data;
  } catch (error) {
    console.error('发送媒体组出错:', error);
    throw error;
  }
};

// 主函数
export default async function handler(req, res) {
  // 检查请求方法
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ message: '只允许POST和GET请求' });
  }
  
  // 检查必要的环境变量
  if (!TELEGRAM_BOT_TOKEN || !CHANNEL_ID) {
    return res.status(500).json({ message: '缺少必要的环境变量配置' });
  }
  
  let tempFiles = [];
  
  try {
    // 获取帖子内容
    const postContent = getPostContent();
    
    // 下载图片
    const filePaths = await Promise.all(
      postContent.images.map(async (url) => {
        const filePath = await downloadImage(url);
        tempFiles.push(filePath);
        return filePath;
      })
    );
    
    // 上传图片到Telegram获取file_id
    const fileIds = await Promise.all(
      filePaths.map(filePath => uploadImage(filePath))
    );
    
    // 发送媒体组
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

// 为了使Vercel Edge Functions正常工作，需要添加这个
export const config = {
  runtime: 'nodejs18.x',
};
