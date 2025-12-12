require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");

const app = express();

/**
 * 關鍵：保留 raw body，避免 SignatureValidationFailed
 */
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// LINE Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

// 健康檢查（用瀏覽器開網址會看到 OK）
app.get("/", (req, res) => {
  res.send("OK");
});

// Webhook（只做一件事：回話）
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    console.log("💬 Webhook events:", JSON.stringify(req.body.events, null, 2));

    for (const event of req.body.events || []) {
      if (event.type === "message" && event.message.type === "text") {
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `收到你的訊息：${event.message.text}`,
        });
      }
    }

    res.status(200).end();
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).end();
  }
});

// 啟動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
