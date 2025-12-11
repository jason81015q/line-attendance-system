require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const fs = require('fs');

// ---------- 初始化 LINE Bot ----------
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();
app.use(express.json());

// ---------- 初始化 Firebase ----------
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  })
});

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
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

// ---------- 處理事件 ----------
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const userText = event.message.text.trim();
  const userId = event.source.userId;  // LINE 使用者 ID

  // 取得員工資料（用 LINE userId 對應 employeeId）
  const employeeSnapshot = await db.collection('employees').doc(userId).get();
  const hasMapping = employeeSnapshot.exists;

  if (!hasMapping) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "⚠️ 你還未綁定員工編號，無法打卡。請輸入「綁定 A001」"
    });
  }

  const employeeId = employeeSnapshot.data().employeeId;

  // ----- 打卡 -----
  if (userText === "打卡") {
    const now = admin.firestore.Timestamp.now();

    await db.collection("attendance").add({
      employeeId: employeeId,
      timestamp: now,
      type: "check-in"
    });

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `🟢 打卡成功！\n員工：${employeeId}\n時間：${new Date().toLocaleString()}`
    });
  }

  // ----- 綁定員工 -----
  if (userText.startsWith("綁定")) {
    const parts = userText.split(" ");
    if (parts.length !== 2) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "格式錯誤，請輸入：綁定 A001"
      });
    }

    const empId = parts[1].trim();

    // 檢查該員工是否存在
    const empSnap = await db.collection("employees").doc(empId).get();
    if (!empSnap.exists) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "查無此員工編號，請確認是否正確。"
      });
    }

    // 寫入對應資料
    await db.collection("employees").doc(userId).set({
      employeeId: empId
    });

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: `綁定成功！你的員工編號為：${empId}`
    });
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `你說：「${userText}」`
  });
}

// ---------- 啟動伺服器 ----------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
