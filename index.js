require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const admin = require("firebase-admin");

/* ================= Feature Flags ================= */
const FEATURES = {
  ATTENDANCE: true,
  MAKEUP: true,
  SUMMARY: true,
  FULL_ATTENDANCE: true,
  PAYROLL: true,
};

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
const monthPrefix = () => today().slice(0, 7);

/* ================= Data Helpers ================= */
async function getEmployee(userId) {
  const q = await db.collection("employees").where("userId", "==", userId).limit(1).get();
  if (q.empty) return null;
  return { empNo: q.docs[0].id, ...q.docs[0].data() };
}

async function ensureAttendance(empNo, date) {
  const ref = db.collection("attendance").doc(`${empNo}_${date}`);
  await ref.set({
    empNo,
    date,
    shift: {
      morning: { checkIn: null, checkOut: null },
      night: { checkIn: null, checkOut: null },
    },
  }, { merge: true });
  return ref;
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
    return reply(event.replyToken, { type: "text", text: "請私聊官方帳操作" });
  }

  const text = event.message.text.trim();
  const userId = event.source.userId;
  const token = event.replyToken;

  const emp = await getEmployee(userId);
  if (!emp) return reply(token, { type: "text", text: "尚未註冊員工" });

  /* ================= 員工 ================= */
  if (emp.role === "staff") {

    /* --- 打卡 --- */
    if (FEATURES.ATTENDANCE && text === "打卡") {
      const ref = await ensureAttendance(emp.empNo, today());
      await ref.update({
        "shift.morning.checkIn": admin.firestore.FieldValue.serverTimestamp(),
      });
      return reply(token, { type: "text", text: "✅ 已完成打卡" });
    }

    /* --- 補打卡 --- */
    if (FEATURES.MAKEUP && text === "補打卡") {
      await db.collection("makeupRequests").add({
        empNo: emp.empNo,
        date: today(),
        reason: "員工申請補打卡",
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return reply(token, { type: "text", text: "📨 已送出補打卡申請" });
    }

    /* --- 本月摘要 --- */
    if (FEATURES.SUMMARY && text === "本月摘要") {
      const snap = await db.collection("attendance")
        .where("empNo", "==", emp.empNo)
        .where("date", ">=", `${monthPrefix()}-01`)
        .get();

      let days = 0;
      snap.forEach(() => days++);
      return reply(token, {
        type: "text",
        text: `📊 本月摘要\n出勤天數：${days} 天`,
      });
    }
  }

  /* ================= 老闆 ================= */
  if (emp.role === "admin") {

    /* --- 補打卡審核 --- */
    if (FEATURES.MAKEUP && text === "補打卡申請") {
      const q = await db.collection("makeupRequests")
        .where("status", "==", "pending")
        .limit(1).get();

      if (q.empty) {
        return reply(token, { type: "text", text: "目前沒有補打卡申請" });
      }

      const doc = q.docs[0];
      const r = doc.data();

      await ensureAttendance(r.empNo, r.date);
      await doc.ref.update({
        status: "approved",
        reviewedBy: emp.empNo,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return reply(token, {
        type: "text",
        text: `✅ 已同意 ${r.empNo} 補打卡`,
      });
    }

    /* --- 本月摘要 --- */
    if (FEATURES.SUMMARY && text === "本月摘要") {
      const snap = await db.collection("attendance")
        .where("date", ">=", `${monthPrefix()}-01`)
        .get();

      const count = {};
      snap.forEach(d => {
        count[d.data().empNo] = (count[d.data().empNo] || 0) + 1;
      });

      let msg = "📊 本月出勤摘要\n";
      for (const k in count) msg += `${k}：${count[k]} 天\n`;

      return reply(token, { type: "text", text: msg });
    }

    /* --- 薪資試算 --- */
    if (FEATURES.PAYROLL && text === "薪資試算") {
      return reply(token, {
        type: "text",
        text: "💰 薪資試算（試用）\n底薪 + 崗位加給\n⚠️ 尚未正式發薪",
      });
    }
  }

  return reply(token, { type: "text", text: "指令未識別" });
}

/* ================= Server ================= */
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Final Feature-Flag System Ready");
});
