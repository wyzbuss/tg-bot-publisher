const { unlink } = require('fs/promises');
const { tmpdir } = require('os');
const { join } = require('path');
const https = require('https');
const fs = require('fs');
const FormData = require('form-data');

// 环境变量
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// 1. 获取帖子内容
function getPostContent() {
  const content = {
    images: [
      'https://picsum.photos/800/450?random=1',
      'https://picsum.photos/800/450?random=2'
    ],
    caption: '每日精选图片\n\n#每日分享 #图片'
  };
  console.log('生成帖子内容:', JSON.stringify(content, null, 2));
  return content;
}

// 2. 下载图片
async function downloadImage(url, maxRedirects = 3) {
  console.log(`开始下载图片: ${url} (剩余重定向次数: ${maxRedirects})`);
  if (maxRedirects <= 0) throw new Error('超过最大重定向次数');
  
  const tmpFilePath = join(tmpdir(), 'temp-' + Date.now() + '.jpg');
  return new Promise(function(resolve, reject) {
    const request = https.get(url, { timeout: 5000 }, function(response) {
      console.log(`下载响应状态码: ${response.statusCode}`);
      
      // 处理重定向
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        console.log(`重定向到: ${redirectUrl}`);
        if (!redirectUrl) { reject(new Error('无重定向URL')); return; }
        response.resume();
        downloadImage(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }
      
      // 正常下载
      if (response.statusCode !== 200) { 
        reject(new Error(`下载失败，状态码: ${response.statusCode}`)); 
        return;
      }
      
      const file = fs.createWriteStream(tmpFilePath);
      response.pipe(file);
      file.on('finish', function() {
        file.close(function() { 
          console.log(`图片下载完成: ${tmpFilePath}`);
          resolve(tmpFilePath); 
        });
      });
      file.on('error', function(err) { 
        unlink(tmpFilePath).catch(() => {});
        reject(new Error(`文件写入错误: ${err.message}`)); 
      });
    });
    
    request.on('timeout', () => { 
      request.destroy(); 
      reject(new Error('下载超时（5秒）')); 
    });
    request.on('error', (err) => reject(new Error(`下载请求错误: ${err.message}`)));
  });
}

// 3. 获取FileId
async function getFileId(filePath) {
  console.log(`开始获取file_id: ${filePath}`);
  const formData = new FormData();
  formData.append('chat_id', CHANNEL_ID);
  formData.append('photo', fs.createReadStream(filePath));
  formData.append('disable_notification', 'true');
  
  return new Promise(function(resolve, reject) {
    formData.getLength(function(err, length) {
      if (err) { 
        reject(new Error(`获取表单长度错误: ${err.message}`)); 
        return;
      }
      
      const headers = formData.getHeaders();
      headers['Content-Length'] = length;
      console.log('发送图片的请求头:', JSON.stringify(headers, null, 2));
      
      const req = https.request({
        hostname: 'api.telegram.org',
        path: '/bot' + TELEGRAM_BOT_TOKEN + '/sendPhoto',
        method: 'POST',
        headers: headers,
        timeout: 5000
      }, function(res) {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', function() {
          console.log('获取file_id的响应:', data);
          try {
            const result = JSON.parse(data);
            if (!result.ok) { 
              reject(new Error(`Telegram错误: ${result.description || '未知错误'}`)); 
              return;
            }
            if (!result.result || !result.result.photo || !result.result.photo.length) {
              reject(new Error('Telegram返回的响应中没有有效的photo数据'));
              return;
            }
            const fileId = result.result.photo[result.result.photo.length - 1].file_id;
            console.log(`成功获取file_id: ${fileId}`);
            
            // 删除临时消息
            https.request({
              hostname: 'api.telegram.org',
              path: '/bot' + TELEGRAM_BOT_TOKEN + '/deleteMessage',
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              timeout: 5000
            }).end(JSON.stringify({
              chat_id: CHANNEL_ID,
              message_id: result.result.message_id
            }));
            
            resolve(fileId);
          } catch (e) {
            reject(new Error(`解析响应失败: ${e.message}，原始响应: ${data}`));
          }
        });
      });
      
      req.on('timeout', () => { 
        req.destroy(); 
        reject(new Error('获取file_id超时（5秒）')); 
      });
      req.on('error', (err) => reject(new Error(`获取file_id请求错误: ${err.message}`)));
      formData.pipe(req);
    });
  });
}

// 4. 发送媒体组（重点强化调试）
async function sendMediaGroup(fileIds, caption) {
  // 详细日志：输出传入的fileIds
  console.log('准备发送媒体组，fileIds:', JSON.stringify(fileIds, null, 2));
  
  // 严格验证fileIds
  if (!fileIds) throw new Error('fileIds参数未定义');
  if (!Array.isArray(fileIds)) throw new Error('fileIds不是数组');
  if (fileIds.length === 0) throw new Error('fileIds数组为空');
  if (fileIds.some(id => !id || typeof id !== 'string')) throw new Error('fileIds中包含无效的ID');
  
  // 构建media数组
  const media = fileIds.map((fileId, index) => ({
    type: 'photo',
    media: fileId,
    caption: index === 0 ? caption : undefined,
    parse_mode: 'HTML'
  }));
  
  // 输出构建的media数组
  console.log('构建的media数组:', JSON.stringify(media, null, 2));
  
  // 转换为JSON字符串
  const mediaJson = JSON.stringify(media);
  console.log('序列化后的media参数:', mediaJson);
  
  // 构建最终发送的数据
  const postData = JSON.stringify({
    chat_id: CHANNEL_ID,
    media: mediaJson
  });
  console.log('发送到Telegram的数据:', postData);
  
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + TELEGRAM_BOT_TOKEN + '/sendMediaGroup',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 5000
    }, function(res) {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', function() {
        console.log('媒体组发送响应:', data);
        try {
          const result = JSON.parse(data);
          if (!result.ok) {
            reject(new Error(`媒体组错误: ${result.description || '未知错误'}`));
            return;
          }
          resolve(result);
        } catch (e) {
          reject(new Error(`解析媒体组响应失败: ${e.message}，原始响应: ${data}`));
        }
      });
    });
    
    req.on('timeout', () => { 
      req.destroy(); 
      reject(new Error('发送媒体组超时（5秒）')); 
    });
    req.on('error', (err) => reject(new Error(`媒体组请求错误: ${err.message}`)));
    req.write(postData);
    req.end();
  });
}

// 主函数
module.exports = async function handler(req, res) {
  console.log('收到请求，方法:', req.method);
  
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ message: '只允许POST/GET' });
  }
  
  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(500).json({ message: '缺少环境变量: TELEGRAM_BOT_TOKEN' });
  }
  if (!CHANNEL_ID) {
    return res.status(500).json({ message: '缺少环境变量: TELEGRAM_CHANNEL_ID' });
  }
  
  let tempFiles = [];
  try {
    const content = getPostContent();
    
    // 下载图片
    const paths = await Promise.all(content.images.map(async (url, i) => {
      console.log(`开始处理第${i+1}张图片: ${url}`);
      const path = await downloadImage(url);
      tempFiles.push(path);
      return path;
    }));
    
    // 获取FileId
    const ids = await Promise.all(paths.map(async (path, i) => {
      console.log(`开始处理第${i+1}张图片的file_id`);
      return await getFileId(path);
    }));
    
    // 发送媒体组
    console.log('准备发送媒体组...');
    const result = await sendMediaGroup(ids, content.caption);
    
    res.status(200).json({ success: true, result: result });
  } catch (error) {
    console.error('执行错误:', error.stack || error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    // 清理临时文件
    for (const path of tempFiles) {
      try { 
        await unlink(path);
        console.log(`已清理临时文件: ${path}`);
      } catch (e) { 
        console.log(`清理临时文件失败: ${e.message}`); 
      }
    }
  }
};

module.exports.config = { runtime: 'nodejs' };
    
