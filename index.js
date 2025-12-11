require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

// Webhook 入口
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('❌ Webhook Error:', err);
      res.status(500).end();
    });
});

// 處理每個事件
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const userText = event.message.text;
  let replyText;

  if (userText === '打卡') {
    replyText = '✅ 收到你的打卡（目前只是測試回覆）';
  } else if (userText === 'hi' || userText === '嗨') {
    replyText = '嗨～這是威廉泰爾打卡系統 Bot（測試版）';
  } else {
    replyText = `你說：「${userText}」`;
  }

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyText,
  });
}

// 啟動伺服器
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
