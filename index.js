require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const admin = require("firebase-admin");

// ================= LINE 設定 =================
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

// ⚠️ 一定要在 middleware 前
app.use(express.json());

// ================= Firebase 初始化 =================
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

// ================= Webhook =================
app.post("/webhook", line.middleware(config), async (req, res) => {
  console.log("📩 收到 LINE Webhook：");
  console.log(JSON.stringify(req.body.events, null, 2));

  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("❌ Webhook Error:", err);
    res.status(500).end();
  }
});

// ================= 處理訊息 =================
async function handleEvent(event) {
  // 只處理文字訊息
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  const userId = event.source.userId;

  console.log("👤 userId:", userId);
  console.log("💬 message:", text);

  // ===== 查詢員工資料 =====
  const employeeSnap = await db
    .collection("employees")
    .where("userId", "==", userId)
    .limit(1)
    .get();

  if (employeeSnap.empty) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ 尚未綁定員工資料，請聯絡管理員",
    });
  }

  const employee = employeeSnap.docs[0].data();
  const employeeId = employee.employeeId || "UNKNOWN";

  // ===== 打卡 =====
  if (text === "打卡") {
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    await db.collection("attendance").add({
      userId,
      employeeId,
      timestamp,
      type: "check-in",
    });

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        `✅ 打卡成功\n` +
        `員工編號：${employeeId}\n` +
        `時間：${new Date().toLocaleString("zh-TW")}`,
    });
  }

  // ===== 其他訊息 =====
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `你說的是：「${text}」\n目前只支援「打卡」`,
  });
}

// ================= 啟動伺服器 =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
