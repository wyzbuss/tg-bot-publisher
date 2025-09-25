const {
    readFileSync
} = require('fs');
const {
    XMLParser
} = require("fast-xml-parser");
const {
    parse
} = require('node-html-parser');

async function main(event) {
    // 从环境变量中获取敏感信息，保证安全
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

    // 检查环境变量是否都已设置
    if (!BOT_TOKEN || !CHANNEL_ID) {
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
        const rssFeeds = [
            'https://www.smzdm.com/jingxuan/rss/',
            'https://www.ithome.com/rss/',
            'https://www.chiphell.com/rss.xml',
            'https://www.gamersky.com/rss.html',
            'https://sspai.com/feed',
            'https://www.gcores.com/rss',
            'https://www.ifanr.com/feed',
            'https://www.feng.com/feed/'
        ];

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
        const parser = new XMLParser();
        let rssData;
        try {
            rssData = parser.parse(xmlText);
            console.log("XML 解析成功。");
        } catch (parseError) {
            console.error(`XML 解析失败: ${parseError.message}`);
            throw new Error(`XML 解析失败，RSS Feed 格式可能不正确。`);
        }
        
        const articles = rssData.rss?.channel?.item || rssData.feed?.entry;
        if (!articles || articles.length === 0) {
            throw new Error("RSS Feed 中没有找到文章。");
        }
        const article = Array.isArray(articles) ? articles[Math.floor(Math.random() * articles.length)] : articles;
        
        const websiteUrl = article.link || article.id;
        console.log("成功获取到一篇文章，正在获取网站信息:", websiteUrl);

        // 步骤2: 访问网站并获取元数据
        let websiteTitle = article.title;
        let websiteDescription = article.description || '';
        
        try {
            const htmlResponse = await fetch(websiteUrl);
            const htmlText = await htmlResponse.text();
            const root = parse(htmlText);
            
            const titleTag = root.querySelector('title');
            if (titleTag && titleTag.text) {
                websiteTitle = titleTag.text;
            }

            const descriptionMeta = root.querySelector('meta[name="description"]');
            if (descriptionMeta && descriptionMeta.attributes.content) {
                websiteDescription = descriptionMeta.attributes.content;
            }
        } catch (error) {
            console.error("无法获取网站元数据，使用RSS源数据作为备用。");
        }
        console.log("成功获取网站元数据。");

        // 步骤3: 使用免费服务生成图片URL
        const screenshotUrl1 = `https://s.shots.so/embed?url=${encodeURIComponent(websiteUrl)}&width=1280&height=720`;
        const screenshotUrl2 = `https://s.shots.so/embed?url=${encodeURIComponent(websiteUrl)}&width=1280&height=720`;

        console.log("已生成截图URL。");

        // 步骤4: 整合富文本并发送到Telegram
        const mediaGroupPayload = {
            chat_id: CHANNEL_ID,
            media: [{
                type: 'photo',
                media: screenshotUrl1,
            }, {
                type: 'photo',
                media: screenshotUrl2,
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

        const messageText = `**${websiteTitle}**\n\n${websiteDescription}\n\n**[查看网站](${websiteUrl})**`;

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
module.exports = main;
