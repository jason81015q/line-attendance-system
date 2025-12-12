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
const reply = (token, text) =>
  client.replyMessage(token, { type: "text", text });

const normalizeText = (raw = "") =>
  raw
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "")
    .normalize("NFKC");

/* ================= DB helpers ================= */
async function isEngineer(userId) {
  const d = await db.collection("systemAdmins").doc(userId).get();
  return d.exists && d.data().canImpersonate === true;
}

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

  const userId = event.source.userId;
  const token = event.replyToken;
  const text = normalizeText(event.message.text);

  console.log("🔥 REAL userId =", userId);
  console.log("📝 TEXT =", text);

  /* =====================================================
     ① 工程師 HARD OVERRIDE（無條件 return）
     ===================================================== */
  const engineer = await isEngineer(userId);
  if (engineer) {
    if (text === "工程師模式") {
      return reply(
        token,
        [
          "🧑‍💻 工程師模式（系統）",
          "",
          "模擬員工 A003",
          "模擬老闆 A001",
          "目前身分",
          "退出模擬",
        ].join("\n")
      );
    }

    if (text === "目前身分") {
      return reply(token, "🧑‍💻 目前身分：工程師本體");
    }

    if (text.startsWith("模擬員工")) {
      return reply(token, "🧪 已進入模擬員工模式（stub）");
    }

    if (text.startsWith("模擬老闆")) {
      return reply(token, "🧪 已進入模擬老闆模式（stub）");
    }

    if (text === "退出模擬") {
      return reply(token, "✅ 已退出模擬，回到工程師本體");
    }

    // 🔥 關鍵：工程師身分 → 永遠不往下跑
    return reply(
      token,
      "🧑‍💻 工程師模式中，請使用工程師指令"
    );
  }

  /* =====================================================
     ② 一般員工 / 老闆流程
     ===================================================== */
  const employee = await getEmployeeByUserId(userId);
  if (!employee) {
    return reply(token, "尚未註冊身分");
  }

  /* ---------------- 老闆 ---------------- */
  if (employee.role === "admin") {
    if (text === "老闆") {
      return reply(
        token,
        [
          "👑 老闆模式",
          "",
          "新增員工 A002 小明",
          "設定早班 A001 2025-12-12 10:00 14:30",
          "設定晚班 A001 2025-12-12 17:00 21:30",
          "補打卡列表",
        ].join("\n")
      );
    }
    return reply(token, "老闆指令不正確，輸入：老闆");
  }

  /* ---------------- 員工 ---------------- */
  if (text === "今日") {
    return reply(token, `📋 今日出勤\n員工：${employee.empNo}`);
  }

  return reply(
    token,
    [
      "員工指令：",
      "今日",
      "早班上班 / 早班下班",
      "晚班上班 / 晚班下班",
    ].join("\n")
  );
}

/* ================= Server ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  console.log("🔥 ENGINEER HARD OVERRIDE FINAL");
});
