require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const admin = require("firebase-admin");

/* ================= LINE ================= */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);
const app = express();

/* ================= Firebase ================= */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});
const db = admin.firestore();

/* ================= Utils ================= */
const reply = (token, msg) => client.replyMessage(token, msg);
const today = () => new Date().toISOString().slice(0, 10);

/* ================= Helpers ================= */
async function getEmployee(userId) {
  const q = await db
    .collection("employees")
    .where("userId", "==", userId)
    .limit(1)
    .get();
  if (q.empty) return null;
  return { empNo: q.docs[0].id, ...q.docs[0].data() };
}

async function ensureAttendance(empNo, date) {
  const ref = db.collection("attendance").doc(`${empNo}_${date}`);
  await ref.set(
    {
      empNo,
      date,
      shift: {
        morning: { checkIn: null, checkOut: null },
        night: { checkIn: null, checkOut: null },
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return ref;
}

async function punch(empNo, shift, type) {
  const ref = await ensureAttendance(empNo, today());
  await ref.update({
    [`shift.${shift}.${type}`]:
      admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* ================= Webhook ================= */
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

/* ================= Main ================= */
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  if (event.source.type !== "user") {
    return reply(event.replyToken, {
      type: "text",
      text: "⚠️ 請私聊官方帳操作",
    });
  }

  const userId = event.source.userId;
  const text = event.message.text.trim();
  const token = event.replyToken;

  const emp = await getEmployee(userId);
  if (!emp) {
    return reply(token, { type: "text", text: "❌ 尚未註冊員工身分" });
  }

  /* ========= 主選單 ========= */
  if (text === "打卡" || text === "開始") {
    return reply(token, {
      type: "text",
      text: `📍 打卡選單（${emp.empNo}）`,
      quickReply: {
        items: [
          { type: "action", action: { type: "message", label: "早班上班", text: "早班上班" } },
          { type: "action", action: { type: "message", label: "早班下班", text: "早班下班" } },
          { type: "action", action: { type: "message", label: "晚班上班", text: "晚班上班" } },
          { type: "action", action: { type: "message", label: "晚班下班", text: "晚班下班" } },
        ],
      },
    });
  }

  /* ========= 打卡動作 ========= */
  if (text === "早班上班") {
    await punch(emp.empNo, "morning", "checkIn");
    return reply(token, { type: "text", text: "✅ 早班上班打卡完成" });
  }

  if (text === "早班下班") {
    await punch(emp.empNo, "morning", "checkOut");
    return reply(token, { type: "text", text: "✅ 早班下班打卡完成" });
  }

  if (text === "晚班上班") {
    await punch(emp.empNo, "night", "checkIn");
    return reply(token, { type: "text", text: "✅ 晚班上班打卡完成" });
  }

  if (text === "晚班下班") {
    await punch(emp.empNo, "night", "checkOut");
    return reply(token, { type: "text", text: "✅ 晚班下班打卡完成" });
  }

  return reply(token, {
    type: "text",
    text: "請輸入「打卡」開啟打卡選單",
  });
}

/* ================= Server ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Baseline stable attendance system running");
});
