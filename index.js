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

/* ================= 設定：工程師 userId（硬鎖） ================= */
// ⚠️ 這裡一定要是 Render log 印出的 REAL userId
const ENGINEER_USER_ID = "U76d79bf56f77fdb1c5b9e00a735d3a26";

/* ================= Utils ================= */
const reply = (token, text) =>
  client.replyMessage(token, { type: "text", text });

const normalizeText = (raw = "") =>
  raw
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "")
    .normalize("NFKC");

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
     ① 工程師「最硬強制模式」
     👉 不查 Firestore
     👉 不看 employee
     👉 不看 role
     👉 只看 userId + 指令
     ===================================================== */
  if (userId === ENGINEER_USER_ID) {
    if (text === "工程師模式") {
      return reply(
        token,
        [
          "🧑‍💻 工程師強制模式（HARD OVERRIDE）",
          "",
          "這一版已完全繞過：",
          "- 老闆 / 員工",
          "- Firestore 權限",
          "- 身分判斷",
          "",
          "可用指令：",
          "工程師模式",
          "工程師測試",
        ].join("\n")
      );
    }

    if (text === "工程師測試") {
      return reply(token, "✅ 工程師指令 100% 生效");
    }

    // 🔥 工程師 userId → 不論輸入什麼，都不往下跑
    return reply(token, "🧑‍💻 工程師硬鎖模式中");
  }

  /* =====================================================
     ② 一般流程（現在一定不會影響工程師）
     ===================================================== */
  const snap = await db
    .collection("employees")
    .where("userId", "==", userId)
    .limit(1)
    .get();

  if (snap.empty) {
    return reply(token, "尚未註冊身分");
  }

  const emp = { empNo: snap.docs[0].id, ...snap.docs[0].data() };

  if (emp.role === "admin") {
    if (text === "老闆") {
      return reply(token, "👑 老闆模式（正常）");
    }
    return reply(token, "老闆指令不正確，輸入：老闆");
  }

  if (text === "今日") {
    return reply(token, `📋 今日出勤\n員工：${emp.empNo}`);
  }

  return reply(token, "員工指令不正確");
}

/* ================= Server ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  console.log("🔥 ENGINEER ABSOLUTE HARD MODE");
});
