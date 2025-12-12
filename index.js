require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const admin = require("firebase-admin");

// ------------------- LINE Bot 設定 -------------------
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

// ❌ 不要在 webhook 前用 express.json()

// ------------------- Firebase 初始化 -------------------
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

// ------------------- Webhook -------------------
app.post(
  "/webhook",
  line.middleware(config),
  async (req, res) => {
    console.log("📩 收到 LINE Webhook");

    try {
      await Promise.all(req.body.events.map(handleEvent));
      res.status(200).end();
    } catch (err) {
      console.error("❌ Webhook Error:", err);
      res.status(500).end();
    }
  }
);

// ------------------- 處理 LINE 訊息 -------------------
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return null;

  const userMessage = event.message.text.trim();
  const userId = event.source.userId;

  if (userMessage === "打卡") {
    await db.collection("attendance").add({
      userId,
      timestamp: new Date(),
      type: "check-in",
    });

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "✅ 打卡成功",
    });
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `收到你的訊息：${userMessage}`,
  });
}

// ------------------- 啟動 Server -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
