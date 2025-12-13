/************************************************************
 * LINE Attendance System – FINAL PRODUCTION VERSION
 * Authoritative Rules Applied (540 mins / day, salary /30)
 ************************************************************/

require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const admin = require("firebase-admin");

/* ================= 系統常數（制度核心） ================= */
const STANDARD_DAILY_MINUTES = 540; // 270 + 270
const MONTHLY_DIVISOR_DAYS = 30;

/* ================= Feature Flags ================= */
const FEATURES = {
  ATTENDANCE: true,
  MAKEUP: true,
  SUMMARY: true,
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
const thisMonth = () => today().slice(0, 7);

/* ================= Employee ================= */
async function getEmployee(userId) {
  const q = await db
    .collection("employees")
    .where("userId", "==", userId)
    .limit(1)
    .get();
  if (q.empty) return null;
  return { empNo: q.docs[0].id, ...q.docs[0].data() };
}

/* ================= Attendance ================= */
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
      stats: {
        lateMinutes: 0,
        earlyMinutes: 0,
        overtimeMinutes: 0,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return ref;
}

async function punch(empNo, shift, type, source = "normal") {
  const ref = await ensureAttendance(empNo, today());
  await ref.update({
    [`shift.${shift}.${type}`]:
      admin.firestore.FieldValue.serverTimestamp(),
    source,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* ================= Session（僅補打卡用） ================= */
async function setSession(userId, data) {
  await db.collection("sessions").doc(userId).set(data, { merge: true });
}
async function getSession(userId) {
  const d = await db.collection("sessions").doc(userId).get();
  return d.exists ? d.data() : null;
}
async function clearSession(userId) {
  await db.collection("sessions").doc(userId).delete().catch(() => {});
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

  /* ================= 打卡（基準 UX，不可退化） ================= */
  if (FEATURES.ATTENDANCE && (text === "打卡" || text === "開始")) {
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

  if (text === "早班上班") return punch(emp.empNo, "morning", "checkIn").then(() => reply(token, { type: "text", text: "✅ 早班上班打卡完成" }));
  if (text === "早班下班") return punch(emp.empNo, "morning", "checkOut").then(() => reply(token, { type: "text", text: "✅ 早班下班打卡完成" }));
  if (text === "晚班上班") return punch(emp.empNo, "night", "checkIn").then(() => reply(token, { type: "text", text: "✅ 晚班上班打卡完成" }));
  if (text === "晚班下班") return punch(emp.empNo, "night", "checkOut").then(() => reply(token, { type: "text", text: "✅ 晚班下班打卡完成" }));

  /* ================= 補打卡（員工） ================= */
  if (FEATURES.MAKEUP && emp.role === "staff" && text === "補打卡") {
    await setSession(userId, { flow: "makeup" });
    return reply(token, {
      type: "text",
      text: "請選擇補打卡班別",
      quickReply: {
        items: [
          { type: "action", action: { type: "message", label: "早班", text: "補_早班" } },
          { type: "action", action: { type: "message", label: "晚班", text: "補_晚班" } },
        ],
      },
    });
  }

  const session = await getSession(userId);

  if (session?.flow === "makeup" && text === "補_早班") {
    await setSession(userId, { ...session, shift: "morning" });
    return reply(token, {
      type: "text",
      text: "請選擇補打卡類型",
      quickReply: {
        items: [
          { type: "action", action: { type: "message", label: "上班", text: "補_上班" } },
          { type: "action", action: { type: "message", label: "下班", text: "補_下班" } },
        ],
      },
    });
  }

  if (session?.flow === "makeup" && text === "補_晚班") {
    await setSession(userId, { ...session, shift: "night" });
    return reply(token, {
      type: "text",
      text: "請選擇補打卡類型",
      quickReply: {
        items: [
          { type: "action", action: { type: "message", label: "上班", text: "補_上班" } },
          { type: "action", action: { type: "message", label: "下班", text: "補_下班" } },
        ],
      },
    });
  }

  if (session?.flow === "makeup" && (text === "補_上班" || text === "補_下班")) {
    await setSession(userId, {
      ...session,
      type: text === "補_上班" ? "checkIn" : "checkOut",
    });
    return reply(token, { type: "text", text: "請輸入補打卡原因" });
  }

  if (session?.flow === "makeup" && session.shift && session.type) {
    await db.collection("makeupRequests").add({
      empNo: emp.empNo,
      date: today(),
      shift: session.shift,
      type: session.type,
      reason: text,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await clearSession(userId);
    return reply(token, { type: "text", text: "📨 補打卡申請已送出，等待老闆核准" });
  }

  /* ================= 補打卡（老闆） ================= */
  if (FEATURES.MAKEUP && emp.role === "admin" && text === "補打卡申請") {
    const q = await db
      .collection("makeupRequests")
      .where("status", "==", "pending")
      .orderBy("createdAt")
      .limit(1)
      .get();

    if (q.empty) {
      return reply(token, { type: "text", text: "目前沒有補打卡申請" });
    }

    const doc = q.docs[0];
    const r = doc.data();

    await punch(r.empNo, r.shift, r.type, "makeup");
    await doc.ref.update({
      status: "approved",
      reviewedBy: emp.empNo,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return reply(token, { type: "text", text: `✅ 已核准 ${r.empNo} 補打卡` });
  }

  /* ================= 本月摘要（顯示） ================= */
  if (FEATURES.SUMMARY && text === "本月摘要") {
    const q = await db
      .collection("attendance")
      .where("empNo", "==", emp.empNo)
      .where("date", ">=", `${thisMonth()}-01`)
      .get();

    let late = 0;
    q.forEach(d => late += d.data().stats?.lateMinutes || 0);

    return reply(token, {
      type: "text",
      text: `📊 本月摘要\n出勤筆數：${q.size}\n遲到分鐘（顯示）：${late}`,
    });
  }

  /* ================= 薪資試算 ================= */
  if (FEATURES.PAYROLL && text === "薪資試算") {
    const monthlySalary = (emp.baseSalary || 0) + (emp.positionAllowance || 0);
    const perMinute = monthlySalary / MONTHLY_DIVISOR_DAYS / STANDARD_DAILY_MINUTES;

    return reply(token, {
      type: "text",
      text:
        `💰 薪資試算（制度版）\n` +
        `月薪：${monthlySalary}\n` +
        `日薪計算基準：30 天\n` +
        `每分鐘薪資：約 ${perMinute.toFixed(2)}`,
    });
  }

  return reply(token, { type: "text", text: "請輸入「打卡」或使用選單" });
}

/* ================= Server ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 FINAL production attendance system running");
});
