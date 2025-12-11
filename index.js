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
app.use(express.json());

// ------------------- Firebase 初始化 -------------------
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
  })
});

const db = admin.firestore();

// ------------------- Webhook -------------------
app.post("/webhook", line.middleware(config), async (req, res) => {

  // ★★★★★ 用來偵錯 Webhook 是否收到事件 ★★★★★
  console.log("💬 收到 LINE Webhook：", JSON.stringify(req.body.events, null, 2));

  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (err) {
    console.error("❌ Webhook Error:", err);
    res.status(500).end();
  }
});

// ------------------- 處理 LINE 訊息事件 -------------------
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userMessage = event.message.text.trim();
  const userId = event.source.userId;

  // 取得 Firebase employeeId (先查 employees 集合)
  let employeeId = "UNKNOWN";

  const employeeSnap = await db.collection("employees").where("userId", "==", userId).get();
  if (!employeeSnap.empty) {
    employeeId = employeeSnap.docs[0].data().employeeId;
  }

  // 若訊息是「打卡」
  if (userMessage === "打卡") {
    const timestamp = new Date();

    // 寫入 Firebase attendance 集合
    await db.collection("attendance").add({
      userId,
      employeeId,
      timestamp,
      type: "check-in"
    });

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `✅ 已成功打卡！\n員工編號：${employeeId}\n時間：${timestamp.toLocaleString("zh-TW")}`
    });
  }

  // 其他訊息回應
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `你說：「${userMessage}」\n（目前只有「打卡」功能喔）`
  });
}

// ------------------- Render 用的伺服器啟動 -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
