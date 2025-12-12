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
const reply = (token, message) =>
  client.replyMessage(token, message);

const normalizeText = (raw = "") =>
  raw
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "")
    .normalize("NFKC");

const todayStr = () =>
  new Date().toISOString().slice(0, 10);

/* ================= Helpers ================= */
async function getEmployeeByUserId(userId) {
  const q = await db
    .collection("employees")
    .where("userId", "==", userId)
    .limit(1)
    .get();

  if (q.empty) return null;
  const d = q.docs[0];
  return { empNo: d.id, ...d.data() };
}

async function writeAttendance(empNo, shift, type) {
  const date = todayStr();
  const docId = `${empNo}_${date}`;
  const ref = db.collection("attendance").doc(docId);

  const fieldPath = `shift.${shift}.${type}`;

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

  await ref.update({
    [fieldPath]: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* ================= Webhook ================= */
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error("Webhook error", e);
    res.status(500).end();
  }
});

/* ================= Main ================= */
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  // 👉 員工打卡「建議只私聊」，先保守
  if (event.source.type !== "user") {
    return reply(event.replyToken, {
      type: "text",
      text: "⚠️ 打卡請私聊官方帳進行",
    });
  }

  const userId = event.source.userId;
  const token = event.replyToken;
  const text = normalizeText(event.message.text);

  const employee = await getEmployeeByUserId(userId);
  if (!employee) {
    return reply(token, {
      type: "text",
      text: "❌ 尚未註冊員工身分",
    });
  }

  /* ================= Quick Reply 主選單 ================= */
  if (text === "打卡" || text === "開始") {
    return reply(token, {
      type: "text",
      text: `👷 員工 ${employee.empNo}\n請選擇打卡項目：`,
      quickReply: {
        items: [
          { type: "action", action: { type: "message", label: "早班上班", text: "早班上班" } },
          { type: "action", action: { type: "message", label: "早班下班", text: "早班下班" } },
          { type: "action", action: { type: "message", label: "晚班上班", text: "晚班上班" } },
          { type: "action", action: { type: "message", label: "晚班下班", text: "晚班下班" } },
          { type: "action", action: { type: "message", label: "今日狀態", text: "今日狀態" } },
        ],
      },
    });
  }

  /* ================= 打卡行為 ================= */
  if (text === "早班上班") {
    await writeAttendance(employee.empNo, "morning", "checkIn");
    return reply(token, { type: "text", text: "✅ 早班上班打卡完成" });
  }

  if (text === "早班下班") {
    await writeAttendance(employee.empNo, "morning", "checkOut");
    return reply(token, { type: "text", text: "✅ 早班下班打卡完成" });
  }

  if (text === "晚班上班") {
    await writeAttendance(employee.empNo, "night", "checkIn");
    return reply(token, { type: "text", text: "✅ 晚班上班打卡完成" });
  }

  if (text === "晚班下班") {
    await writeAttendance(employee.empNo, "night", "checkOut");
    return reply(token, { type: "text", text: "✅ 晚班下班打卡完成" });
  }

  if (text === "今日狀態") {
    return reply(token, {
      type: "text",
      text: `📅 今日 ${todayStr()}\n狀態已記錄（詳情下一步補）`,
    });
  }

  /* ================= fallback ================= */
  return reply(token, {
    type: "text",
    text: "請點選按鍵操作\n輸入「打卡」開始",
  });
}

/* ================= Server ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  console.log("🟢 EMPLOYEE QUICK CHECK-IN READY");
});
