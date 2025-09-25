const {
    readFileSync
} = require('fs');
const {
    XMLParser
} = require("fast-xml-parser");

async function main(event) {
    // 从环境变量中获取敏感信息，保证安全
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    // 检查环境变量是否都已设置
    if (!BOT_TOKEN || !CHANNEL_ID || !GEMINI_API_KEY) {
        console.error("错误：请在环境变量中设置所有必要的密钥。");
        return {
            statusCode: 500,
            body: JSON.stringify({
                message: "环境变量未设置"
            })
        };
    }

    try {
        // 步骤1: 从 RSS Feed 动态获取网站信息
        // 链接聚合类网站的 RSS Feed 列表，确保内容源源不断
        const rssFeeds = [
            'https://www.smzdm.com/jingxuan/rss/', // 什么值得买 - 购物优惠与生活方式
            'https://www.ithome.com/rss/', // IT之家 - 综合数码科技
            'https://www.chiphell.com/rss.xml', // Chiphell - 硬件数码社区
            'https://www.gamersky.com/rss.html', // 游民星空 - 游戏资讯
            'https://sspai.com/feed', // 少数派 - 效率与科技
            'https://www.gcores.com/rss', // 机核网 - 游戏文化
            'https://www.ifanr.com/feed', // 爱范儿 - 新潮科技
            'https://www.feng.com/feed/' // 威锋网 - 苹果产品社区
        ];

        // 随机选择一个 RSS Feed
        const selectedFeed = rssFeeds[Math.floor(Math.random() * rssFeeds.length)];
        console.log(`正在从以下 RSS Feed 获取内容: ${selectedFeed}`);

        let rssResponse;
        try {
            rssResponse = await fetch(selectedFeed);
            if (!rssResponse.ok) {
                throw new Error(`无法获取 RSS Feed: HTTP 状态码 ${rssResponse.status}`);
            }
        } catch (fetchError) {
            console.error(`RSS Feed 请求失败: ${fetchError.message}`);
            throw new Error(`RSS Feed 请求失败，请检查网络或URL。`);
        }
        
        const xmlText = await rssResponse.text();

        // 使用 fast-xml-parser 解析 XML
        const parser = new XMLParser();
        let rssData;
        try {
            rssData = parser.parse(xmlText);
        } catch (parseError) {
            console.error(`XML 解析失败: ${parseError.message}`);
            throw new Error(`XML 解析失败，RSS Feed 格式可能不正确。`);
        }
        
        // 随机选择一篇文章
        const articles = rssData.rss.channel.item || rssData.feed.entry; // 兼容不同格式
        if (!articles || articles.length === 0) {
            throw new Error("RSS Feed 中没有找到文章。");
        }
        const article = Array.isArray(articles) ? articles[Math.floor(Math.random() * articles.length)] : articles;

        const website = {
            url: article.link || article.id,
            source: rssData.rss.channel.title || rssData.feed.title,
            title: article.title,
            content: article.description || article['content:encoded'] || ''
        };
        console.log("成功获取到一篇文章:", website.title);

        // 步骤2: 使用AI生成标题和描述
        const llmPayload = {
            contents: [{
                parts: [{
                    text: `请为以下网页内容生成一个简洁的中文标题和一段吸引人的中文描述。内容来源是：${website.source}。请以JSON格式返回，包含"title"和"description"字段。内容：${website.content.substring(0, 3000)}`
                }]
            }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        "title": {
                            "type": "STRING"
                        },
                        "description": {
                            "type": "STRING"
                        }
                    },
                    "propertyOrdering": ["title", "description"]
                }
            }
        };

        let llmResponse;
        try {
            llmResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(llmPayload)
            });
            if (!llmResponse.ok) {
                console.error(`LLM API 错误: 状态码 ${llmResponse.status} - ${await llmResponse.text()}`);
                throw new Error(`LLM API 调用失败。`);
            }
        } catch (fetchError) {
            console.error(`LLM API 请求失败: ${fetchError.message}`);
            throw new Error(`LLM API 调用失败，请检查密钥是否正确。`);
        }
        
        const llmResult = await llmResponse.json();
        const contentJson = JSON.parse(llmResult.candidates[0].content.parts[0].text);
        const title = contentJson.title;
        const description = contentJson.description;
        console.log("AI成功生成标题和描述。");

        // 步骤3: 使用AI生成图片
        const imgPayload = {
            instances: {
                prompt: `A beautiful and futuristic digital art of a computer screen, with vibrant colors. The style should be modern and clean.`
            },
            parameters: {
                "sampleCount": 2
            }
        };

        let imgResponse;
        try {
            imgResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${GEMINI_API_KEY}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(imgPayload)
            });
            if (!imgResponse.ok) {
                console.error(`Imagen API 错误: 状态码 ${imgResponse.status} - ${await imgResponse.text()}`);
                throw new Error(`Imagen API 调用失败。`);
            }
        } catch (fetchError) {
            console.error(`Imagen API 请求失败: ${fetchError.message}`);
            throw new Error(`Imagen API 调用失败，请检查密钥是否正确。`);
        }
        
        const imgResult = await imgResponse.json();
        console.log("AI成功生成两张图片。");

        // 步骤4: 整合富文本并发送到Telegram
        const mediaGroupPayload = {
            chat_id: CHANNEL_ID,
            media: [{
                type: 'photo',
                media: `data:image/png;base64,${imgResult.predictions[0].bytesBase64Encoded}`
            }, {
                type: 'photo',
                media: `data:image/png;base64,${imgResult.predictions[1].bytesBase64Encoded}`
            }]
        };
        console.log("正在发送媒体组到Telegram...");

        let mediaResponse;
        try {
            mediaResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`, {
                method: 'POST',
                body: JSON.stringify(mediaGroupPayload),
                headers: {
                    'Content-Type': 'application/json'
                },
            });
            if (!mediaResponse.ok) {
                console.error(`Telegram API 错误: 状态码 ${mediaResponse.status} - ${await mediaResponse.text()}`);
                throw new Error(`Telegram API 调用失败。`);
            }
        } catch (fetchError) {
            console.error(`Telegram API 请求失败: ${fetchError.message}`);
            throw new Error(`Telegram API 调用失败，请检查Bot Token和Channel ID。`);
        }
        
        const mediaResult = await mediaResponse.json();

        const messageId = mediaResult.result[0].message_id;
        const messageText = `**${title}**\n\n${description}\n\n**[查看网站](${website.url})**`;

        const telegramTextPayload = {
            chat_id: CHANNEL_ID,
            text: messageText,
            parse_mode: 'Markdown',
            reply_to_message_id: messageId,
        };
        console.log("正在发送富文本消息到Telegram...");

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            body: JSON.stringify(telegramTextPayload),
            headers: {
                'Content-Type': 'application/json'
            },
        });

        console.log("帖子发布成功！");
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "帖子发布成功！"
            })
        };

    } catch (error) {
        console.error("发生错误:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                message: `处理失败: ${error.message}`
            })
        };
    }
}
module.exports = { main };
