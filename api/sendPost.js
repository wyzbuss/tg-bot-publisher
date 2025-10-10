const https = require('https');
const fs = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const FormData = require('form-data');

// 环境变量
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

// 1. 下载图片（支持重定向，确保能获取图片）
async function downloadImage(url, maxRedirects = 3) {
  if (maxRedirects <= 0) throw new Error('超过最大重定向次数');

  const tempFilePath = join(tmpdir(), `img-${Date.now()}.jpg`);
  
  return new Promise((resolve, reject) => {
    const request = https.get(url, (res) => {
      // 处理重定向
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location;
        if (!redirectUrl) { reject(new Error('无重定向URL')); return; }
        res.resume();
        downloadImage(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }
      
      // 验证有效响应
      if (res.statusCode !== 200) { 
        reject(new Error(`下载失败，状态码: ${res.statusCode}`)); 
        return;
      }
      
      // 保存图片到临时文件
      const fileStream = fs.createWriteStream(tempFilePath);
      res.pipe(fileStream);
      
      fileStream.on('finish', () => {
        fileStream.close(() => resolve(tempFilePath));
      });
      
      fileStream.on('error', (err) => {
        fs.unlink(tempFilePath, () => {});
        reject(new Error(`文件写入错误: ${err.message}`));
      });
    });
    
    request.on('error', (err) => reject(new Error(`下载请求错误: ${err.message}`)));
  });
}

// 2. 获取file_id（上传后立即删除临时消息，不单独保留图片）
async function getFileId(tempFilePath) {
  const formData = new FormData();
  formData.append('chat_id', CHANNEL_ID);
  formData.append('photo', fs.createReadStream(tempFilePath));
  formData.append('disable_notification', 'true'); // 静默上传，不通知成员
  
  return new Promise((resolve, reject) => {
    formData.getLength((err, length) => {
      if (err) { 
        fs.unlink(tempFilePath, () => {});
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
          fs.unlink(tempFilePath, () => {}); // 无论成功失败都清理临时文件
          
          try {
            const result = JSON.parse(data);
            if (!result.ok || !result.result?.photo?.length) {
              reject(new Error(`获取file_id失败: ${result.description || data}`));
              return;
            }
            
            // 立即删除临时上传的图片（核心：不保留单独发送的图片）
            https.request({
              hostname: 'api.telegram.org',
              path: `/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`,
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            }).end(JSON.stringify({
              chat_id: CHANNEL_ID,
              message_id: result.result.message_id
            }));
            
            // 获取最高分辨率的file_id
            resolve(result.result.photo[result.result.photo.length - 1].file_id);
          } catch (e) {
            reject(new Error(`解析响应失败: ${e.message}`));
          }
        });
      });
      
      req.on('error', (err) => reject(new Error(`上传请求错误: ${err.message}`)));
      formData.pipe(req);
    });
  });
}

// 3. 发送媒体组（横向排布关键：使用宽屏图片比例）
async function sendMediaGroup(fileIds, caption) {
  // 构建媒体组参数（横向排布依赖图片本身宽高比16:9）
  const media = fileIds.map((fileId, index) => ({
    type: 'photo',
    media: fileId,
    // 只有第一张图片带标题
    caption: index === 0 ? caption : undefined,
    parse_mode: 'HTML'
  }));
  
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
    
    req.on('error', (err) => reject(new Error(`发送请求错误: ${err.message}`)));
    req.write(postData);
    req.end();
  });
}

// 4. 主函数：整合流程
module.exports = async function handler(req, res) {
  // 防缓存设置
  res.setHeader('Cache-Control', 'no-store, no-cache');
  
  // 环境变量检查
  if (!TELEGRAM_BOT_TOKEN || !CHANNEL_ID) {
    return res.status(500).json({ error: '缺少环境变量' });
  }
  
  // 临时文件记录（确保最终能清理）
  const tempFiles = [];
  
  try {
    // 自定义内容（这里替换成你的图片和文案）
    const postContent = {
      // 关键：使用16:9宽屏比例图片（800x450）确保横向排布
      images: [
        'https://picsum.photos/800/450?random=1', // 宽高比16:9
        'https://picsum.photos/800/450?random=2'  // 宽高比16:9
      ],
      caption: '每日精选横向排布图片\n\n第一张：自然风景\n第二张：城市建筑\n\n#横向排布 #精选'
    };
    
    // 下载所有图片
    const imagePaths = await Promise.all(
      postContent.images.map(async (url) => {
        const path = await downloadImage(url);
        tempFiles.push(path);
        return path;
      })
    );
    
    // 获取所有file_id（上传后自动删除临时图片）
    const fileIds = await Promise.all(
      imagePaths.map(path => getFileId(path))
    );
    
    // 只发送媒体组（不单独保留任何图片）
    const result = await sendMediaGroup(fileIds, postContent.caption);
    
    res.status(200).json({ success: true, result: result });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      debug: { channelId: CHANNEL_ID, tokenSet: !!TELEGRAM_BOT_TOKEN }
    });
  } finally {
    // 确保所有临时文件被清理
    for (const path of tempFiles) {
      try { await fs.promises.unlink(path); } catch (e) {}
    }
  }
};

module.exports.config = { runtime: 'nodejs' };
    
