require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const admin = require("firebase-admin");

/* ================= 制度常數 ================= */
const STANDARD_DAILY_MINUTES = 540; // 270+270
const MONTHLY_DIVISOR_DAYS = 30;
const EARLY_OT_THRESHOLD_MINUTES = 60; // ±1小時才算早退/加班（顯示用）

/* ================= Feature Flags ================= */
const FEATURES = {
  ATTENDANCE: true,
  MAKEUP: true,
  SUMMARY: true,
  PAYROLL: true,
  SELF_REGISTER_BY_CODE: true, // 你要的：註冊 A00X 綁 userId
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
const todayStr = () => new Date().toISOString().slice(0, 10);
const monthPrefix = () => todayStr().slice(0, 7);

function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate(); // Firestore Timestamp
  if (v instanceof Date) return v;
  return null;
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function parseHHMM(s) {
  // "10:00" -> {h:10, m:0}
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}
function minutesDiff(a, b) {
  // a - b in minutes
  return Math.round((a.getTime() - b.getTime()) / 60000);
}
function atDateTime(dateStr, hhmm) {
  const t = parseHHMM(hhmm);
  if (!t) return null;
  // 用當地時間（台北）概念即可；雲端是 UTC，但我們只拿差值，且同一天差值穩定
  const d = new Date(`${dateStr}T${pad2(t.h)}:${pad2(t.m)}:00`);
  return d;
}

/* ================= Data Access ================= */
async function getEmployeeByUserId(userId) {
  const q = await db
    .collection("employees")
    .where("userId", "==", userId)
    .limit(1)
    .get();
  if (q.empty) return null;
  return { empNo: q.docs[0].id, ...q.docs[0].data() };
}

async function employeeUserIdAlreadyBound(userId) {
  const q = await db.collection("employees").where("userId", "==", userId).limit(1).get();
  return !q.empty;
}

async function getEmployeeByEmpNo(empNo) {
  const ref = db.collection("employees").doc(empNo);
  const snap = await ref.get();
  if (!snap.exists) return null;
  return { empNo, ...snap.data(), _ref: ref };
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

async function punch(empNo, date, shift, type, source = "normal") {
  const ref = await ensureAttendance(empNo, date);
  await ref.update({
    [`shift.${shift}.${type}`]: admin.firestore.FieldValue.serverTimestamp(),
    source,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* =============== schedules & calendarDays（可選） =============== */
async function getSchedule(empNo, date) {
  // schedules/{empNo}_{YYYY-MM-DD}
  const ref = db.collection("schedules").doc(`${empNo}_${date}`);
  const snap = await ref.get();
  return snap.exists ? snap.data() : null;
}

async function getCalendarDay(date) {
  // calendarDays/{YYYY-MM-DD} : {type: open|closed|typhoon_closed|typhoon_half}
  const ref = db.collection("calendarDays").doc(date);
  const snap = await ref.get();
  return snap.exists ? snap.data() : { type: "open" };
}

/* ================= sessions（只用在補打卡流程） ================= */
async function setSession(userId, data) {
  await db.collection("sessions").doc(userId).set(data, { merge: true });
}
async function getSession(userId) {
  const snap = await db.collection("sessions").doc(userId).get();
  return snap.exists ? snap.data() : null;
}
async function clearSession(userId) {
  await db.collection("sessions").doc(userId).delete().catch(() => {});
}

/* ================= Attendance Stats (late/early/ot) ================= */
function calcShiftStats(dateStr, shiftData, scheduleShift) {
  // shiftData: {checkIn, checkOut} timestamps
  // scheduleShift: {start:"10:00", end:"14:30"} or null
  if (!scheduleShift?.start || !scheduleShift?.end) {
    return { late: 0, early: 0, ot: 0, hasSchedule: false };
  }

  const start = atDateTime(dateStr, scheduleShift.start);
  const end = atDateTime(dateStr, scheduleShift.end);
  if (!start || !end) return { late: 0, early: 0, ot: 0, hasSchedule: false };

  const inAt = toDate(shiftData?.checkIn);
  const outAt = toDate(shiftData?.checkOut);

  let late = 0, early = 0, ot = 0;

  if (inAt) {
    const d = minutesDiff(inAt, start);
    if (d > 0) late = d;
  }
  if (outAt) {
    const d = minutesDiff(outAt, end);
    if (d > EARLY_OT_THRESHOLD_MINUTES) ot = d;
    if (d < -EARLY_OT_THRESHOLD_MINUTES) early = -d;
  }

  return { late, early, ot, hasSchedule: true };
}

async function calcMonthMetrics(empNo, monthYYYYMM) {
  // 讀本月 attendance
  const attSnap = await db
    .collection("attendance")
    .where("empNo", "==", empNo)
    .where("date", ">=", `${monthYYYYMM}-01`)
    .where("date", "<=", `${monthYYYYMM}-31`)
    .get();

  // 讀本月已核准補打卡數
  const makeupSnap = await db
    .collection("makeupRequests")
    .where("empNo", "==", empNo)
    .where("status", "==", "approved")
    .where("date", ">=", `${monthYYYYMM}-01`)
    .where("date", "<=", `${monthYYYYMM}-31`)
    .get();

  let records = 0;
  let lateMinutes = 0;
  let lateCount = 0;
  let earlyMinutes = 0;
  let overtimeMinutes = 0;
  let missingScheduleDays = 0;

  for (const doc of attSnap.docs) {
    const a = doc.data();
    const date = a.date;
    const cal = await getCalendarDay(date);
    if (cal?.type === "closed" || cal?.type === "typhoon_closed") {
      // 店休 / 停業：不算應出勤日，也不影響全勤；但 attendance 若存在仍不必扣分
      continue;
    }

    records += 1;

    const sched = await getSchedule(empNo, date);
    if (!sched) {
      // 沒排班：不算遲到/早退/加班（避免算錯）
      missingScheduleDays += 1;
      continue;
    }

    const m = calcShiftStats(date, a.shift?.morning, sched.morning);
    const n = calcShiftStats(date, a.shift?.night, sched.night);

    const dayLate = m.late + n.late;
    const dayEarly = m.early + n.early;
    const dayOT = m.ot + n.ot;

    if ((m.hasSchedule || n.hasSchedule) && dayLate > 0) lateCount += 1;
    lateMinutes += dayLate;
    earlyMinutes += dayEarly;
    overtimeMinutes += dayOT;
  }

  const makeupApprovedCount = makeupSnap.size;

  // 全勤破功條件（你定義）
  const brokeByLate =
    lateCount > 4 || (lateCount <= 4 && lateMinutes > 10);
  const brokeByMakeup = makeupApprovedCount > 3;

  // 目前沒有請假資料表 leaves，所以先視為 0（之後接 leaves 再納入）
  const personalLeaveCount = 0;
  const brokeByLeave = personalLeaveCount > 0;

  const fullAttendanceBroken = brokeByLate || brokeByMakeup || brokeByLeave;

  // 遲到扣薪分鐘（觸發才扣、扣全部遲到分鐘）
  const lateDeductMinutes = brokeByLate ? lateMinutes : 0;

  return {
    records,
    lateMinutes,
    lateCount,
    earlyMinutes,
    overtimeMinutes,
    makeupApprovedCount,
    missingScheduleDays,
    fullAttendanceBroken,
    lateDeductMinutes,
  };
}

/* ================= Quick Reply Menus ================= */
function staffMenu(empNo) {
  return {
    type: "text",
    text: `📍 選單（${empNo}）`,
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "打卡", text: "打卡" } },
        { type: "action", action: { type: "message", label: "補打卡", text: "補打卡" } },
        { type: "action", action: { type: "message", label: "本月摘要", text: "本月摘要" } },
      ],
    },
  };
}
function adminMenu(empNo) {
  return {
    type: "text",
    text: `👑 老闆選單（${empNo}）`,
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "補打卡申請", text: "補打卡申請" } },
        { type: "action", action: { type: "message", label: "本月摘要", text: "本月摘要" } },
        { type: "action", action: { type: "message", label: "薪資試算", text: "薪資試算" } },
      ],
    },
  };
}

/* ================= Webhook ================= */
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error("❌ webhook batch error:", e);
    res.status(500).end();
  }
});

/* ================= Main Handler (Hardened) ================= */
async function handleEvent(event) {
  // 每個 event 自己 catch：避免「整個 webhook 無回應」
  try {
    if (event.type !== "message" || event.message.type !== "text") return;
    if (event.source.type !== "user") {
      return reply(event.replyToken, { type: "text", text: "⚠️ 請私聊官方帳操作" });
    }

    const userId = event.source.userId;
    const text = event.message.text.trim();
    const token = event.replyToken;

    /* ====== 自助編號註冊（未註冊者也能用） ====== */
    // 格式：註冊 A006
    if (FEATURES.SELF_REGISTER_BY_CODE && /^註冊\s+A\d{3}$/i.test(text)) {
      const empNo = text.replace(/\s+/g, "").toUpperCase().replace("註冊", "");
      // userId 是否已綁過任何人
      if (await employeeUserIdAlreadyBound(userId)) {
        const already = await getEmployeeByUserId(userId);
        return reply(token, { type: "text", text: `你已註冊為 ${already.empNo}，請輸入「打卡」` });
      }
      // 目標編號是否存在
      const target = await getEmployeeByEmpNo(empNo);
      if (!target) {
        return reply(token, { type: "text", text: "❌ 員工編號不存在，請確認" });
      }
      // 防呆：admin 編號不允許自助綁定（避免有人亂綁 A001）
      if ((target.role || "").toLowerCase() === "admin") {
        return reply(token, { type: "text", text: "❌ 此編號需由管理員後台綁定" });
      }
      // 防呆：編號已被綁
      if (target.userId) {
        return reply(token, { type: "text", text: "❌ 此編號已被註冊，請洽管理員" });
      }

      await target._ref.update({
        userId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return reply(token, {
        type: "text",
        text: `✅ 註冊成功：${empNo}\n請輸入「打卡」開始使用`,
      });
    }

    /* ====== 先找 employee（已註冊者） ====== */
    const emp = await getEmployeeByUserId(userId);
    if (!emp) {
      return reply(token, {
        type: "text",
        text: "你尚未註冊。\n請輸入：註冊 A00X\n例如：註冊 A006",
      });
    }

    /* ====== 選單 ====== */
    if (text === "選單") {
      return reply(token, emp.role === "admin" ? adminMenu(emp.empNo) : staffMenu(emp.empNo));
    }

    /* ================= 打卡（基準 UX 固定） ================= */
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

    if (text === "早班上班") {
      await punch(emp.empNo, todayStr(), "morning", "checkIn", "normal");
      return reply(token, { type: "text", text: "✅ 早班上班打卡完成" });
    }
    if (text === "早班下班") {
      await punch(emp.empNo, todayStr(), "morning", "checkOut", "normal");
      return reply(token, { type: "text", text: "✅ 早班下班打卡完成" });
    }
    if (text === "晚班上班") {
      await punch(emp.empNo, todayStr(), "night", "checkIn", "normal");
      return reply(token, { type: "text", text: "✅ 晚班上班打卡完成" });
    }
    if (text === "晚班下班") {
      await punch(emp.empNo, todayStr(), "night", "checkOut", "normal");
      return reply(token, { type: "text", text: "✅ 晚班下班打卡完成" });
    }

    /* ================= 補打卡（員工申請） ================= */
    if (FEATURES.MAKEUP && emp.role === "staff" && text === "補打卡") {
      await setSession(userId, { flow: "makeup", step: "pickShift" });
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

    if (FEATURES.MAKEUP && emp.role === "staff" && session?.flow === "makeup") {
      if (session.step === "pickShift" && (text === "補_早班" || text === "補_晚班")) {
        await setSession(userId, {
          flow: "makeup",
          step: "pickType",
          shift: text === "補_早班" ? "morning" : "night",
        });
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

      if (session.step === "pickType" && (text === "補_上班" || text === "補_下班")) {
        await setSession(userId, {
          ...session,
          step: "reason",
          type: text === "補_上班" ? "checkIn" : "checkOut",
        });
        return reply(token, { type: "text", text: "請輸入補打卡原因" });
      }

      if (session.step === "reason") {
        await db.collection("makeupRequests").add({
          empNo: emp.empNo,
          date: todayStr(),
          shift: session.shift,
          type: session.type,
          reason: text,
          status: "pending",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        await clearSession(userId);
        return reply(token, { type: "text", text: "📨 補打卡申請已送出，等待老闆核准" });
      }
    }

    /* ================= 補打卡（老闆核准） ================= */
    if (FEATURES.MAKEUP && emp.role === "admin" && text === "補打卡申請") {
      // 不用 orderBy，避免 Firestore index 直接炸
      const q = await db.collection("makeupRequests")
        .where("status", "==", "pending")
        .limit(1)
        .get();

      if (q.empty) {
        return reply(token, { type: "text", text: "目前沒有補打卡申請" });
      }

      const doc = q.docs[0];
      const r = doc.data();

      await punch(r.empNo, r.date, r.shift, r.type, "makeup");
      await doc.ref.update({
        status: "approved",
        reviewedBy: emp.empNo,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return reply(token, { type: "text", text: `✅ 已核准 ${r.empNo} 補打卡（${r.date}）` });
    }

    /* ================= 本月摘要（顯示用） ================= */
    if (FEATURES.SUMMARY && text === "本月摘要") {
      const m = await calcMonthMetrics(emp.empNo, monthPrefix());

      const scheduleHint =
        m.missingScheduleDays > 0
          ? `\n⚠️ 有 ${m.missingScheduleDays} 筆缺排班，遲到/早退/加班未計入`
          : "";

      return reply(token, {
        type: "text",
        text:
          `📊 本月摘要（${emp.empNo}）\n` +
          `出勤筆數：${m.records}\n` +
          `遲到次數：${m.lateCount}\n` +
          `遲到分鐘：${m.lateMinutes}\n` +
          `早退分鐘：${m.earlyMinutes}\n` +
          `加班分鐘：${m.overtimeMinutes}\n` +
          `核准補打卡：${m.makeupApprovedCount} 次\n` +
          `全勤狀態：${m.fullAttendanceBroken ? "破功" : "✅ 未破功"}` +
          scheduleHint,
      });
    }

    /* ================= 薪資試算（制度版） ================= */
    if (FEATURES.PAYROLL && text === "薪資試算") {
      const monthlySalary = (emp.baseSalary || 0) + (emp.positionAllowance || 0);
      const perMinute = monthlySalary / MONTHLY_DIVISOR_DAYS / STANDARD_DAILY_MINUTES;

      const m = await calcMonthMetrics(emp.empNo, monthPrefix());
      const lateDeductAmount = Math.round(m.lateDeductMinutes * perMinute);

      const payable = monthlySalary - lateDeductAmount;

      return reply(token, {
        type: "text",
        text:
          `💰 薪資試算（${emp.empNo}）\n` +
          `月薪：${monthlySalary}\n` +
          `基準：30天、每日540分鐘\n` +
          `遲到次數：${m.lateCount}\n` +
          `遲到總分鐘：${m.lateMinutes}\n` +
          `遲到扣薪分鐘：${m.lateDeductMinutes}\n` +
          `遲到扣薪：${lateDeductAmount}\n` +
          `應發：${payable}\n\n` +
          `備註：遲到扣薪門檻＝(次數>4) 或 (次數<=4且總分鐘>10)，觸發後扣「全部遲到分鐘」`,
      });
    }

    /* ================= fallback ================= */
    if (text === "老闆" && emp.role === "admin") {
      return reply(token, adminMenu(emp.empNo));
    }
    if (text === "員工" && emp.role === "staff") {
      return reply(token, staffMenu(emp.empNo));
    }

    return reply(token, { type: "text", text: "請輸入「打卡」或「選單」" });

  } catch (err) {
    console.error("❌ handleEvent error:", err);
    // 重要：發生錯誤也要回覆，避免「完全沒回應」
    try {
      return reply(event.replyToken, {
        type: "text",
        text: "⚠️ 系統剛剛發生錯誤，請再試一次。如果一直出現請通知工程師。",
      });
    } catch (_) {}
  }
}

/* ================= Server ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 FINAL hardened system running on port", PORT);
});
