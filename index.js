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

  const emp = await getEmployeeByUserId(userId);
  if (!emp) {
    return reply(event, "❌ 尚未綁定員工資料");
  }

  /* ===== staff：打卡 ===== */
  if (text === "上班" || text === "下班") {
    return reply(
      event,
      "請選擇班別：\n👉 早班\n👉 晚班"
    );
  }

  if (text === "早班" || text === "晚班") {
    return reply(
      event,
      "請選擇動作：\n👉 上班\n👉 下班"
    );
  }

  if (
    ["早班上班", "早班下班", "晚班上班", "晚班下班"].includes(text)
  ) {
    return handleAttendance(event, emp, text);
  }

  /* ===== staff：補打卡申請 ===== */
  if (text.startsWith("補打卡")) {
    // 格式：補打卡 2025-12-10 早班 上班 原因
    return handleMakeupRequest(event, emp, text);
  }

  /* ===== approver：核准 / 拒絕 ===== */
  if (text.startsWith("MAKEUP|")) {
    return handleMakeupDecision(event, text);
  }

  return reply(event, "❓ 指令不正確");
}

/* ================== 工具函式 ================== */

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

/* ================== 打卡 ================== */

async function handleAttendance(event, emp, text) {
  const [shiftText, actionText] = text.split("");
  const shiftKey = shiftText === "早" ? "morning" : "night";
  const actionKey = actionText === "上" ? "checkIn" : "checkOut";

  const today = new Date().toISOString().slice(0, 10);
  const docId = `${emp.empKey}_${today}`;

  const ref = db.collection("attendance").doc(docId);
  const snap = await ref.get();

  const data = snap.exists
    ? snap.data()
    : {
        empKey: emp.empKey,
        date: today,
        shift: {
          morning: { checkIn: null, checkOut: null },
          night: { checkIn: null, checkOut: null },
        },
      };

  if (data.shift[shiftKey][actionKey]) {
    return reply(event, "⚠️ 此打卡已存在");
  }

  data.shift[shiftKey][actionKey] =
    admin.firestore.FieldValue.serverTimestamp();

  await ref.set(data, { merge: true });
  return reply(event, "✅ 打卡成功");
}

/* ================== 補打卡申請 ================== */

async function handleMakeupRequest(event, emp, text) {
  const parts = text.split(" ");
  if (parts.length < 5) {
    return reply(
      event,
      "❌ 格式錯誤\n補打卡 YYYY-MM-DD 早班/晚班 上班/下班 原因"
    );
  }

  const [, date, shiftText, actionText, ...reasonArr] = parts;
  const shiftKey = shiftText === "早班" ? "morning" : "night";
  const actionKey = actionText === "上班" ? "checkIn" : "checkOut";

  const reason = reasonArr.join(" ");

  const reqRef = await db.collection("makeupRequests").add({
    empKey: emp.empKey,
    requesterUserId: emp.userId,
    date,
    shiftKey,
    actionKey,
    reason,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await notifyApprovers(reqRef.id, emp, date, shiftText, actionText, reason);
  return reply(event, "📨 已送出補打卡申請");
}

/* ================== 推播給核准者 ================== */

async function notifyApprovers(
  requestId,
  emp,
  date,
  shiftText,
  actionText,
  reason
) {
  const snap = await db
    .collection("employees")
    .where("canApprove", "==", true)
    .get();

  const message = {
    type: "text",
    text:
      `📌 補打卡申請\n` +
      `員工：${emp.displayName}\n` +
      `日期：${date}\n` +
      `班別：${shiftText}\n` +
      `動作：${actionText}\n` +
      `原因：${reason}\n\n` +
      `👉 同意：MAKEUP|APPROVE|${requestId}\n` +
      `👉 拒絕：MAKEUP|REJECT|${requestId}`,
  };

  for (const doc of snap.docs) {
    const uid = doc.data().userId;
    if (uid) await client.pushMessage(uid, message);
  }
}

/* ================== 核准 / 拒絕（含防自我核准） ================== */

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

      /* 🔒 防自我核准 */
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
