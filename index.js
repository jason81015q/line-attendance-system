require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const admin = require("firebase-admin");

/* ================== 基本設定 ================== */

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const app = express();
const client = new line.Client(config);

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

/* ================== Webhook ================== */

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).end();
  }
});

/* ================== 主事件處理 ================== */

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  const userId = event.source.userId;

  /* ===== 註冊（綁定員工編號）===== */
  if (text.startsWith("註冊")) {
    return handleRegister(event, text);
  }

  const emp = await getEmployeeByUserId(userId);
  if (!emp) {
    return reply(event, "❌ 尚未綁定員工資料，請先輸入：註冊 A001");
  }

  /* ===== 設定供餐（admin only）===== */
  if (text.startsWith("設定供餐")) {
    return handleCompanyMealSetting(event, emp, text);
  }

  /* ===== 補打卡核准 / 拒絕 ===== */
  if (text.startsWith("MAKEUP|")) {
    return handleMakeupDecision(event, text);
  }

  /* 其他功能你現有的都還在 */
  return reply(event, "❓ 指令不正確");
}

/* ================== 工具 ================== */

async function getEmployeeByUserId(userId) {
  const snap = await db
    .collection("employees")
    .where("userId", "==", userId)
    .limit(1)
    .get();

  if (snap.empty) return null;
  return { empKey: snap.docs[0].id, ...snap.docs[0].data() };
}

function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text,
  });
}

/* ================== 註冊（綁定 Axxx） ================== */

async function handleRegister(event, text) {
  const empKey = text.replace("註冊", "").trim();
  const userId = event.source.userId;

  if (!empKey) {
    return reply(event, "❌ 請輸入：註冊 A001");
  }

  const ref = db.collection("employees").doc(empKey);
  const snap = await ref.get();

  if (!snap.exists) {
    return reply(event, "❌ 員工編號不存在，請確認");
  }

  if (snap.data().userId) {
    return reply(event, "⚠️ 此員工編號已被綁定");
  }

  await ref.update({
    userId,
    boundAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return reply(
    event,
    `✅ 已成功綁定 ${snap.data().displayName || empKey}`
  );
}

/* ================== 設定供餐（防重複） ================== */

async function handleCompanyMealSetting(event, emp, text) {
  if (!emp.canApprove) {
    return reply(event, "❌ 你沒有權限");
  }

  // 格式：設定供餐 2025-12-10 早班
  const parts = text.split(" ");
  if (parts.length !== 3) {
    return reply(event, "❌ 格式錯誤\n設定供餐 YYYY-MM-DD 早班/晚班");
  }

  const [, date, shiftText] = parts;
  const shift =
    shiftText === "早班"
      ? "morning"
      : shiftText === "晚班"
      ? "night"
      : null;

  if (!shift) {
    return reply(event, "❌ 班別必須是 早班 或 晚班");
  }

  const docId = `company_meal_${date}_${shift}`;
  const ref = db.collection("workExceptions").doc(docId);

  const snap = await ref.get();
  if (snap.exists) {
    return reply(event, `⚠️ ${date} ${shiftText} 已設定供餐`);
  }

  await ref.set({
    type: "company_meal",
    date,
    shift,
    createdBy: emp.empKey,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return reply(event, `✅ 已設定 ${date} ${shiftText} 供餐（不給餐補）`);
}

/* ================== 補打卡核准（防自我核准） ================== */

async function handleMakeupDecision(event, text) {
  const [, action, requestId] = text.split("|");
  const userId = event.source.userId;

  const approver = await getEmployeeByUserId(userId);
  if (!approver?.canApprove) {
    return reply(event, "❌ 你沒有核准權限");
  }

  const ref = db.collection("makeupRequests").doc(requestId);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("NOT_FOUND");

      const req = snap.data();
      if (req.status !== "pending") throw new Error("ALREADY_HANDLED");

      if (req.requesterUserId === userId) {
        throw new Error("SELF_APPROVAL");
      }

      tx.update(ref, {
        status: action === "APPROVE" ? "approved" : "rejected",
        reviewedBy: approver.empKey,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return reply(
      event,
      action === "APPROVE" ? "✅ 已核准補打卡" : "❌ 已拒絕補打卡"
    );
  } catch (err) {
    if (err.message === "SELF_APPROVAL") {
      return reply(event, "❌ 不可核准自己提出的申請");
    }
    if (err.message === "ALREADY_HANDLED") {
      return reply(event, "⚠️ 此申請已處理");
    }
    console.error(err);
    return reply(event, "❌ 處理失敗");
  }
}

/* ================== Server ================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
