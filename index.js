require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const admin = require("firebase-admin");

/* =========================================================
   Feature Flags（你用這裡控制，一個一個開）
   ========================================================= */
const FEATURES = {
  ATTENDANCE: true,        // 員工按鍵打卡（早/晚 上下班）
  MAKEUP: true,            // 補打卡（員工申請 → 老闆審核）
  SUMMARY: true,           // 今日狀態 / 本月摘要（顯示：遲到/早退/加班）
  FULL_ATTENDANCE: true,   // 全勤判定（依你的規則）
  PAYROLL: true,           // 薪資試算（目前：底薪+崗位加給，不扣款；後面再加）
};

/* =========================================================
   LINE
   ========================================================= */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);
const app = express();

/* =========================================================
   Firebase
   ========================================================= */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});
const db = admin.firestore();

/* =========================================================
   Utils
   ========================================================= */
const reply = (token, msg) => client.replyMessage(token, msg);

const normalizeText = (raw = "") =>
  String(raw)
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width
    .replace(/\r/g, "")
    .trim();

const isoDate = (d = new Date()) => d.toISOString().slice(0, 10);

const yyyymm = (d = new Date()) => d.toISOString().slice(0, 7);

const parseTimeHM = (hm) => {
  // "10:00" -> minutes since midnight
  const [h, m] = String(hm).split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};

const minutesBetween = (aMs, bMs) => Math.round((bMs - aMs) / 60000);

const pad2 = (n) => String(n).padStart(2, "0");

function monthRangeUTC(yearMonth) {
  // yearMonth: "YYYY-MM"
  const [Y, M] = yearMonth.split("-").map((x) => parseInt(x, 10));
  const start = new Date(Date.UTC(Y, M - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(Y, M, 1, 0, 0, 0));
  return { start, end };
}

/* =========================================================
   Firestore helpers
   ========================================================= */
async function getEmployeeByUserId(userId) {
  const q = await db.collection("employees").where("userId", "==", userId).limit(1).get();
  if (q.empty) return null;
  const d = q.docs[0];
  return { empNo: d.id, ...d.data() };
}

async function getEmployeeByEmpNo(empNo) {
  const d = await db.collection("employees").doc(empNo).get();
  if (!d.exists) return null;
  return { empNo: d.id, ...d.data() };
}

async function getSession(userId) {
  const d = await db.collection("sessions").doc(userId).get();
  return d.exists ? d.data() : {};
}

async function setSession(userId, patch) {
  await db.collection("sessions").doc(userId).set(
    { ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

async function clearSession(userId) {
  await db.collection("sessions").doc(userId).delete().catch(() => {});
}

async function ensureAttendanceDoc(empNo, date) {
  const docId = `${empNo}_${date}`;
  const ref = db.collection("attendance").doc(docId);
  await ref.set(
    {
      empNo,
      date,
      shift: {
        morning: { checkIn: null, checkOut: null },
        night: { checkIn: null, checkOut: null },
      },
      // 統計欄位（顯示用，不影響薪資）
      stats: {
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        overtimeMinutes: 0,
        lateCount: 0, // 當日是否遲到(>0)
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return ref;
}

async function writeAttendanceStamp(empNo, date, shift, type, stampSource = "normal") {
  const ref = await ensureAttendanceDoc(empNo, date);
  await ref.update({
    [`shift.${shift}.${type}`]: admin.firestore.FieldValue.serverTimestamp(),
    source: stampSource, // "normal" | "makeup"
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/* =========================================================
   Schedule (排班) 讀取：可先不建，沒建就只記錄打卡
   collection: schedules/{empNo}_{YYYY-MM-DD}
   {
     empNo, date,
     morning: { start:"10:00", end:"14:30" } | null,
     night:   { start:"17:00", end:"21:30" } | null,
     note: "typhoon half-day" | ...
   }
   ========================================================= */
async function getSchedule(empNo, date) {
  const id = `${empNo}_${date}`;
  const d = await db.collection("schedules").doc(id).get();
  if (!d.exists) return null;
  return d.data();
}

/* =========================================================
   Stats compute (顯示用)
   - 規則：以排班時間為基準，計算遲到/早退/加班
   - 你說的「±1小時」是顯示用的判斷基準（不影響薪資）
   ========================================================= */
function computeShiftStats(planned, actualIn, actualOut) {
  // planned: {start:"HH:MM", end:"HH:MM"} or null
  // returns {late, early, overtime}
  if (!planned || !planned.start || !planned.end) return { late: 0, early: 0, overtime: 0 };

  const startMin = parseTimeHM(planned.start);
  const endMin = parseTimeHM(planned.end);
  if (startMin == null || endMin == null) return { late: 0, early: 0, overtime: 0 };

  const toMin = (ts) => {
    if (!ts) return null;
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.getHours() * 60 + d.getMinutes();
  };

  const inMin = toMin(actualIn);
  const outMin = toMin(actualOut);

  let late = 0, early = 0, overtime = 0;

  // 遲到：上班打卡 > 排定上班
  if (inMin != null && inMin > startMin) late = inMin - startMin;

  // 早退/加班：以排定下班為基準 ± 60 分鐘做「顯示分類」
  // - out 在 (end-60)~(end+60) 視為正常（顯示 0）
  // - out < end-60 → 早退（顯示 end- out）
  // - out > end+60 → 加班（顯示 out- end）
  if (outMin != null) {
    if (outMin < endMin - 60) early = endMin - outMin;
    else if (outMin > endMin + 60) overtime = outMin - endMin;
  }

  return { late, early, overtime };
}

async function recomputeDayStats(empNo, date) {
  // 只有在有 schedules 時才會算顯示統計；沒有 schedules 就不算
  const sched = await getSchedule(empNo, date);
  if (!sched) return;

  const attId = `${empNo}_${date}`;
  const attSnap = await db.collection("attendance").doc(attId).get();
  if (!attSnap.exists) return;

  const att = attSnap.data();
  const m = computeShiftStats(sched.morning, att.shift?.morning?.checkIn, att.shift?.morning?.checkOut);
  const n = computeShiftStats(sched.night, att.shift?.night?.checkIn, att.shift?.night?.checkOut);

  const lateMinutes = (m.late || 0) + (n.late || 0);
  const earlyLeaveMinutes = (m.early || 0) + (n.early || 0);
  const overtimeMinutes = (m.overtime || 0) + (n.overtime || 0);
  const lateCount = lateMinutes > 0 ? 1 : 0;

  await db.collection("attendance").doc(attId).set(
    {
      stats: {
        lateMinutes,
        earlyLeaveMinutes,
        overtimeMinutes,
        lateCount,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/* =========================================================
   Full attendance (全勤) 規則（你給的）
   - 當月遲到次數 > 4 → 破功
   - 或 遲到次數 <= 4 但遲到總分鐘 > 10 → 破功
   - 或 事假 > 0 → 破功（先用 leaves 集合；沒建就當 0）
   - 或 補打卡次數 > 3 → 破功（approved makeup 次數）
   ========================================================= */
async function countApprovedMakeups(empNo, yearMonth) {
  const { start, end } = monthRangeUTC(yearMonth);
  const q = await db
    .collection("makeupRequests")
    .where("empNo", "==", empNo)
    .where("status", "==", "approved")
    .where("createdAt", ">=", admin.firestore.Timestamp.fromDate(start))
    .where("createdAt", "<", admin.firestore.Timestamp.fromDate(end))
    .get();
  return q.size;
}

async function getLeaveDays(empNo, yearMonth) {
  // 可選集合：leaves/{autoId} {empNo,date,type:"personal"|... , minutes or days}
  // 你目前未做請假 → 先回 0
  // 之後要做我再幫你接
  return 0;
}

async function getMonthlyAttendanceStats(empNo, yearMonth) {
  const { start, end } = monthRangeUTC(yearMonth);
  // attendance docId: empNo_YYYY-MM-DD
  // 用 date 字串查很麻煩，所以用 updatedAt 或直接掃 empNo 前綴（此處用簡單做法：查 date 範圍，需在 attendance 存 Timestamp 才好）
  // 我們用 date 字串做前綴篩選：拿出該月所有天，逐日 get（少量員工先可行）
  const [Y, M] = yearMonth.split("-").map((x) => parseInt(x, 10));
  const daysInMonth = new Date(Date.UTC(Y, M, 0)).getUTCDate();

  let lateCountSum = 0;
  let lateMinutesSum = 0;
  let earlySum = 0;
  let overtimeSum = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${yearMonth}-${pad2(d)}`;
    const id = `${empNo}_${date}`;
    const snap = await db.collection("attendance").doc(id).get();
    if (!snap.exists) continue;
    const stats = snap.data().stats || {};
    lateCountSum += stats.lateCount ? 1 : 0;
    lateMinutesSum += stats.lateMinutes || 0;
    earlySum += stats.earlyLeaveMinutes || 0;
    overtimeSum += stats.overtimeMinutes || 0;
  }

  const makeupApproved = await countApprovedMakeups(empNo, yearMonth);
  const leaveDays = await getLeaveDays(empNo, yearMonth);

  return {
    lateCount: lateCountSum,
    lateMinutes: lateMinutesSum,
    earlyLeaveMinutes: earlySum,
    overtimeMinutes: overtimeSum,
    makeupApproved,
    leaveDays,
  };
}

function isFullAttendanceBroken(ruleInput) {
  const { lateCount, lateMinutes, leaveDays, makeupApproved } = ruleInput;

  if (lateCount > 4) return { broken: true, reason: "遲到次數超過4次" };
  if (lateCount <= 4 && lateMinutes > 10) return { broken: true, reason: "遲到總分鐘超過10分鐘" };
  if (leaveDays > 0) return { broken: true, reason: "本月有事假" };
  if (makeupApproved > 3) return { broken: true, reason: "補打卡核准次數超過3次" };
  return { broken: false, reason: "符合全勤" };
}

/* =========================================================
   Payroll (薪資) - 先做「不扣款版本」
   - 依你需求：底薪 + 崗位加給 = 月薪（不因本月天數變動）
   - 後續要扣遲到/早退/缺勤再加 rules
   ========================================================= */
function calcPayroll(employeeDoc) {
  const base = Number(employeeDoc.baseSalary || 0);
  const allowance = Number(employeeDoc.positionAllowance || 0);
  const gross = base + allowance;
  return { base, allowance, gross, deductions: 0, net: gross };
}

/* =========================================================
   UI builders (Quick Reply)
   ========================================================= */
function staffMenu(empNo) {
  return {
    type: "text",
    text: `👷 員工 ${empNo}\n請選擇：`,
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "打卡", text: "打卡" } },
        FEATURES.MAKEUP ? { type: "action", action: { type: "message", label: "補打卡", text: "補打卡" } } : null,
        FEATURES.SUMMARY ? { type: "action", action: { type: "message", label: "今日狀態", text: "今日狀態" } } : null,
        FEATURES.SUMMARY ? { type: "action", action: { type: "message", label: "本月摘要", text: "本月摘要" } } : null,
      ].filter(Boolean),
    },
  };
}

function punchMenu(empNo) {
  return {
    type: "text",
    text: `📍 打卡（${empNo}）\n請選擇：`,
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "早班上班", text: "早班上班" } },
        { type: "action", action: { type: "message", label: "早班下班", text: "早班下班" } },
        { type: "action", action: { type: "message", label: "晚班上班", text: "晚班上班" } },
        { type: "action", action: { type: "message", label: "晚班下班", text: "晚班下班" } },
        { type: "action", action: { type: "message", label: "回主選單", text: "主選單" } },
      ],
    },
  };
}

function adminMenu(empNo) {
  return {
    type: "text",
    text: `👑 老闆 ${empNo}\n請選擇：`,
    quickReply: {
      items: [
        FEATURES.MAKEUP ? { type: "action", action: { type: "message", label: "補打卡申請", text: "補打卡申請" } } : null,
        FEATURES.SUMMARY ? { type: "action", action: { type: "message", label: "本月摘要", text: "老闆_本月摘要" } } : null,
        FEATURES.PAYROLL ? { type: "action", action: { type: "message", label: "本月薪資試算", text: "本月薪資試算" } } : null,
        { type: "action", action: { type: "message", label: "回主選單", text: "主選單" } },
      ].filter(Boolean),
    },
  };
}

/* =========================================================
   Webhook
   ========================================================= */
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error("Webhook error", e);
    res.status(500).end();
  }
});

/* =========================================================
   Main handler
   ========================================================= */
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  // 先保守：只允許私聊（你之後要開群組我再幫你加）
  if (event.source.type !== "user") {
    return reply(event.replyToken, { type: "text", text: "⚠️ 請私聊官方帳操作" });
  }

  const userId = event.source.userId;
  const token = event.replyToken;
  const textRaw = event.message.text;
  const text = normalizeText(textRaw);

  const employee = await getEmployeeByUserId(userId);
  if (!employee) {
    return reply(token, { type: "text", text: "❌ 尚未註冊身分" });
  }

  // 共用：主選單
  if (text === "主選單" || text === "開始") {
    return reply(token, employee.role === "admin" ? adminMenu(employee.empNo) : staffMenu(employee.empNo));
  }

  /* =====================================================
     STAFF FLOW
     ===================================================== */
  if (employee.role === "staff") {
    if (text === "打卡" && FEATURES.ATTENDANCE) {
      return reply(token, punchMenu(employee.empNo));
    }

    // 打卡四顆（早/晚 上下班）
    if (FEATURES.ATTENDANCE) {
      const date = isoDate();
      if (text === "早班上班") {
        await writeAttendanceStamp(employee.empNo, date, "morning", "checkIn", "normal");
        await recomputeDayStats(employee.empNo, date).catch(() => {});
        return reply(token, { type: "text", text: "✅ 早班上班打卡完成\n（輸入「打卡」可繼續）" });
      }
      if (text === "早班下班") {
        await writeAttendanceStamp(employee.empNo, date, "morning", "checkOut", "normal");
        await recomputeDayStats(employee.empNo, date).catch(() => {});
        return reply(token, { type: "text", text: "✅ 早班下班打卡完成\n（輸入「打卡」可繼續）" });
      }
      if (text === "晚班上班") {
        await writeAttendanceStamp(employee.empNo, date, "night", "checkIn", "normal");
        await recomputeDayStats(employee.empNo, date).catch(() => {});
        return reply(token, { type: "text", text: "✅ 晚班上班打卡完成\n（輸入「打卡」可繼續）" });
      }
      if (text === "晚班下班") {
        await writeAttendanceStamp(employee.empNo, date, "night", "checkOut", "normal");
        await recomputeDayStats(employee.empNo, date).catch(() => {});
        return reply(token, { type: "text", text: "✅ 晚班下班打卡完成\n（輸入「打卡」可繼續）" });
      }
    }

    // 今日狀態
    if (FEATURES.SUMMARY && text === "今日狀態") {
      const date = isoDate();
      const id = `${employee.empNo}_${date}`;
      const attSnap = await db.collection("attendance").doc(id).get();
      if (!attSnap.exists) {
        return reply(token, { type: "text", text: `📅 今日 ${date}\n尚無打卡紀錄` });
      }
      const att = attSnap.data();
      const s = att.stats || {};
      const fmt = (ts) => (ts?.toDate ? ts.toDate().toTimeString().slice(0, 5) : "-");
      return reply(token, {
        type: "text",
        text:
          `📅 今日 ${date}\n` +
          `早班 上:${fmt(att.shift?.morning?.checkIn)} 下:${fmt(att.shift?.morning?.checkOut)}\n` +
          `晚班 上:${fmt(att.shift?.night?.checkIn)} 下:${fmt(att.shift?.night?.checkOut)}\n\n` +
          `顯示統計（不影響薪資）：\n` +
          `遲到：${s.lateMinutes || 0} 分\n` +
          `早退：${s.earlyLeaveMinutes || 0} 分\n` +
          `加班：${s.overtimeMinutes || 0} 分`
      });
    }

    // 本月摘要（含全勤判定）
    if (FEATURES.SUMMARY && text === "本月摘要") {
      const ym = yyyymm();
      const st = await getMonthlyAttendanceStats(employee.empNo, ym);
      let fullAttLine = "";
      if (FEATURES.FULL_ATTENDANCE) {
        const fa = isFullAttendanceBroken(st);
        fullAttLine = `\n\n全勤：${fa.broken ? "❌破功" : "✅OK"}（${fa.reason}）`;
      }
      return reply(token, {
        type: "text",
        text:
          `📊 本月摘要 ${ym}\n` +
          `遲到次數：${st.lateCount}\n` +
          `遲到分鐘：${st.lateMinutes}\n` +
          `早退分鐘：${st.earlyLeaveMinutes}\n` +
          `加班分鐘：${st.overtimeMinutes}\n` +
          `補打卡(核准)：${st.makeupApproved}\n` +
          `事假：${st.leaveDays}` +
          fullAttLine
      });
    }

    /* -------------------------
       MAKEUP: 員工申請流程
       ------------------------- */
    if (FEATURES.MAKEUP && text === "補打卡") {
      await clearSession(userId);
      return reply(token, {
        type: "text",
        text: "📌 請選擇補打卡班別",
        quickReply: {
          items: [
            { type: "action", action: { type: "message", label: "早班", text: "補打卡_早班" } },
            { type: "action", action: { type: "message", label: "晚班", text: "補打卡_晚班" } },
            { type: "action", action: { type: "message", label: "回主選單", text: "主選單" } },
          ],
        },
      });
    }

    if (FEATURES.MAKEUP && (text === "補打卡_早班" || text === "補打卡_晚班")) {
      await setSession(userId, {
        flow: "makeup",
        makeupShift: text === "補打卡_早班" ? "morning" : "night",
      });
      return reply(token, {
        type: "text",
        text: "請選擇補打卡類型",
        quickReply: {
          items: [
            { type: "action", action: { type: "message", label: "上班", text: "補打卡_上班" } },
            { type: "action", action: { type: "message", label: "下班", text: "補打卡_下班" } },
            { type: "action", action: { type: "message", label: "取消", text: "主選單" } },
          ],
        },
      });
    }

    if (FEATURES.MAKEUP && (text === "補打卡_上班" || text === "補打卡_下班")) {
      const s = await getSession(userId);
      if (s.flow !== "makeup" || !s.makeupShift) {
        await clearSession(userId);
        return reply(token, { type: "text", text: "流程已過期，請重新點「補打卡」" });
      }
      await setSession(userId, { makeupType: text === "補打卡_上班" ? "checkIn" : "checkOut" });
      return reply(token, { type: "text", text: "✏️ 請輸入補打卡原因（一句話即可）" });
    }

    // 收原因（僅在 session flow=makeup 時）
    if (FEATURES.MAKEUP) {
      const s = await getSession(userId);
      if (s.flow === "makeup" && s.makeupShift && s.makeupType) {
        // 使用原始 rawText 當原因（保留空白）
        const reason = String(textRaw || "").trim();
        if (!reason || reason.length < 1) {
          return reply(token, { type: "text", text: "原因不可空白，請再輸入一次" });
        }

        await db.collection("makeupRequests").add({
          empNo: employee.empNo,
          date: isoDate(),
          shift: s.makeupShift,
          type: s.makeupType,
          reason,
          status: "pending",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await clearSession(userId);
        return reply(token, { type: "text", text: "✅ 補打卡申請已送出，等待老闆確認" });
      }
    }

    // staff fallback
    return reply(token, staffMenu(employee.empNo));
  }

  /* =====================================================
     ADMIN FLOW
     ===================================================== */
  if (employee.role === "admin") {
    if (text === "老闆") {
      return reply(token, adminMenu(employee.empNo));
    }

    // 老闆本月摘要（可用來看整體指標；目前先看自己，之後加「選員工」）
    if (FEATURES.SUMMARY && text === "老闆_本月摘要") {
      const ym = yyyymm();
      const st = await getMonthlyAttendanceStats(employee.empNo, ym);
      let fullAttLine = "";
      if (FEATURES.FULL_ATTENDANCE) {
        const fa = isFullAttendanceBroken(st);
        fullAttLine = `\n\n全勤：${fa.broken ? "❌破功" : "✅OK"}（${fa.reason}）`;
      }
      return reply(token, {
        type: "text",
        text:
          `📊 老闆本人摘要 ${ym}\n` +
          `遲到次數：${st.lateCount}\n` +
          `遲到分鐘：${st.lateMinutes}\n` +
          `早退分鐘：${st.earlyLeaveMinutes}\n` +
          `加班分鐘：${st.overtimeMinutes}\n` +
          `補打卡(核准)：${st.makeupApproved}\n` +
          `事假：${st.leaveDays}` +
          fullAttLine
      });
    }

    // 薪資試算（先算自己；之後加「選員工/全員」）
    if (FEATURES.PAYROLL && text === "本月薪資試算") {
      const emp = await getEmployeeByEmpNo(employee.empNo);
      const p = calcPayroll(emp || employee);
      const ym = yyyymm();
      let fullAttLine = "";
      if (FEATURES.FULL_ATTENDANCE) {
        const st = await getMonthlyAttendanceStats(employee.empNo, ym);
        const fa = isFullAttendanceBroken(st);
        fullAttLine = `\n全勤：${fa.broken ? "❌破功" : "✅OK"}（${fa.reason}）`;
      }
      return reply(token, {
        type: "text",
        text:
          `💰 薪資試算 ${ym}\n` +
          `底薪：${p.base}\n` +
          `崗位加給：${p.allowance}\n` +
          `應發：${p.gross}\n` +
          `扣款：${p.deductions}\n` +
          `實發：${p.net}` +
          fullAttLine +
          `\n\n（目前薪資不因打卡變動；扣款規則之後再接）`,
      });
    }

    /* -------------------------
       MAKEUP: 老闆審核流程
       ------------------------- */
    if (FEATURES.MAKEUP && text === "補打卡申請") {
      // 拉最近 5 筆 pending
      const q = await db
        .collection("makeupRequests")
        .where("status", "==", "pending")
        .orderBy("createdAt", "desc")
        .limit(5)
        .get();

      if (q.empty) {
        return reply(token, { type: "text", text: "目前沒有補打卡申請" });
      }

      // 先顯示第一筆，並把 requestId 放 session
      const first = q.docs[0];
      const r = first.data();
      await setSession(userId, { flow: "review", reviewRequestId: first.id });

      const shiftName = r.shift === "morning" ? "早班" : "晚班";
      const typeName = r.type === "checkIn" ? "上班" : "下班";

      return reply(token, {
        type: "text",
        text:
          `📄 補打卡申請（1/${q.size}）\n` +
          `員工：${r.empNo}\n日期：${r.date}\n班別：${shiftName}\n類型：${typeName}\n原因：${r.reason}\n\n` +
          `按鍵處理：`,
        quickReply: {
          items: [
            { type: "action", action: { type: "message", label: "✅同意", text: "審核_同意" } },
            { type: "action", action: { type: "message", label: "❌拒絕", text: "審核_拒絕" } },
            { type: "action", action: { type: "message", label: "回主選單", text: "主選單" } },
          ],
        },
      });
    }

    if (FEATURES.MAKEUP && (text === "審核_同意" || text === "審核_拒絕")) {
      const s = await getSession(userId);
      if (s.flow !== "review" || !s.reviewRequestId) {
        await clearSession(userId);
        return reply(token, { type: "text", text: "❌ 找不到審核中的申請，請重新點「補打卡申請」" });
      }

      const reqRef = db.collection("makeupRequests").doc(s.reviewRequestId);
      const reqSnap = await reqRef.get();
      if (!reqSnap.exists) {
        await clearSession(userId);
        return reply(token, { type: "text", text: "❌ 申請不存在或已處理" });
      }

      const r = reqSnap.data();
      const approve = text === "審核_同意";

      if (approve) {
        // 老闆同意 → 寫回 attendance（補打卡）
        await writeAttendanceStamp(r.empNo, r.date, r.shift, r.type, "makeup");
        // 顯示統計（如果有 schedules）
        await recomputeDayStats(r.empNo, r.date).catch(() => {});

        await reqRef.update({
          status: "approved",
          reviewedBy: employee.empNo,
          reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await clearSession(userId);
        return reply(token, { type: "text", text: "✅ 已同意並補打卡完成" });
      } else {
        await reqRef.update({
          status: "rejected",
          reviewedBy: employee.empNo,
          reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await clearSession(userId);
        return reply(token, { type: "text", text: "❌ 已拒絕補打卡" });
      }
    }

    // admin fallback
    return reply(token, adminMenu(employee.empNo));
  }
}

/* =========================================================
   Server
   ========================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  console.log("🟢 FINAL FEATURE-FLAG INDEX READY");
});
