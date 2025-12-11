require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');

// ---------- 初始化 LINE Bot ----------
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();
app.use(express.json());

// ---------- 初始化 Firebase（使用 Render 的環境變數） ----------
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});

const db = admin.firestore();

// ---------- Webhook ----------
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('❌ Webhook Error:', err);
      res.status(500).end();
    });
});

// ---------- 處理訊息事件 ----------
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const userText = event.message.text;
  const userId = event.source.userId;

  if (userText === '打卡') {
    // 寫入 Firestore
    await db.collection('attendance').add({
      userId: userId,
      timestamp: admin.firestore.Timestamp.now(),
      type: 'check-in',
    });

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '打卡成功！已記錄到系統中。',
    });
  }

  // 其他文字就回覆原話
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `你說：「${userText}」`,
  });
}

// ---------- 啟動伺服器 ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
