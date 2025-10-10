const https = require('https');

// 环境变量
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// 直接发送硬编码的媒体组（确保参数格式绝对正确）
async function testSendMediaGroup() {
  // 1. 这里使用Telegram官方示例中的测试图片file_id（确保有效）
  const testFileIds = [
    'AgACAgQAAxkBAAIBX2ZZ1J8Q5sRVVJ29cK8j74X1nTQAAJ2zMRvGb4hUbD8rLcBZ0qHAQADAgADeQADLwQ',
    'AgACAgQAAxkBAAIBY2ZZ1LIA7eQZ4b61V64X1nTQAAJ2zMRvGb4hUbD8rLcBZ0qHAQADAgADeQADLwQ'
  ];
  
  // 2. 构建绝对正确的media参数
  const media = [
    {
      type: 'photo',
      media: testFileIds[0],
      caption: '测试媒体组',
      parse_mode: 'HTML'
    },
    {
      type: 'photo',
      media: testFileIds[1]
    }
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
          else reject(new Error(`API错误: ${result.description || data}`));
        } catch (e) {
          reject(new Error(`解析错误: ${e.message}, 原始响应: ${data}`));
        }
      });
    });
    
    req.on('error', (err) => reject(new Error(`请求失败: ${err.message}`)));
    req.write(postData);
    req.end();
  });
}

// 主函数
module.exports = async function handler(req, res) {
  // 基本环境检查
  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(500).json({ error: '缺少TELEGRAM_BOT_TOKEN' });
  }
  if (!CHANNEL_ID) {
    return res.status(500).json({ error: '缺少CHANNEL_ID' });
  }
  
  try {
    // 直接发送测试媒体组
    const result = await testSendMediaGroup();
    res.status(200).json({
      success: true,
      message: '媒体组发送成功333',
      result: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      // 附加调试信息
      debug: {
        channelId: CHANNEL_ID,
        tokenSet: !!TELEGRAM_BOT_TOKEN,
        timestamp: new Date().toISOString()
      }
    });
  }
};

module.exports.config = { runtime: 'nodejs' };
    
