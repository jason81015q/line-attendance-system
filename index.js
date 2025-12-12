require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const admin = require("firebase-admin");

// ------------------- LINE Bot 設定 -------------------
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();
// ❗ webhook 前不能用 express.json()

// ------------------- Firebase 初始化 -------------------
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

// ------------------- 工具函式 -------------------
function getTodayDate() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.toISOString().split("T")[0]; // YYYY-MM-DD
}

function normalizeText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function parseCommand(text) {
  const t = normalizeText(text);
  const parts = t.split(" ");
  return { raw: t, cmd: parts[0] || "", args: parts.slice(1) };
}

function isValidDate(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function isValidMonth(monthStr) {
  return /^\d{4}-\d{2}$/.test(monthStr);
}

function isValidTime(timeStr) {
  if (!/^\d{2}:\d{2}$/.test(timeStr)) return false;
  const [h, m] = timeStr.split(":").map((x) => Number(x));
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function replyText(replyToken, text) {
  return client.replyMessage(replyToken, { type: "text", text });
}

function formatTs(ts) {
  try {
    if (!ts) return "—";
    if (typeof ts === "string") return ts;
    if (ts.toDate) return ts.toDate().toLocaleString("zh-TW");
    if (ts instanceof Date) return ts.toLocaleString("zh-TW");
    return String(ts);
  } catch {
    return String(ts);
  }
}

function safeToISO(ts) {
  try {
    if (!ts) return null;
    if (typeof ts === "string") return ts;
    if (ts.toDate) return ts.toDate().toISOString();
    if (ts instanceof Date) return ts.toISOString();
    return null;
  } catch {
    return null;
  }
}

function attendanceDocId(empNo, dateStr) {
  return `${empNo}_${dateStr}`;
}

function scheduleDocId(empNo, dateStr) {
  return `${empNo}_${dateStr}`;
}

function pendingDocId(userId) {
  return userId; // pendingActions/{userId}
}

function toDateAt(dateStr, timeStr) {
  const [hh, mm] = timeStr.split(":").map(Number);
  const dt = new Date(dateStr);
  dt.setHours(hh, mm, 0, 0);
  return dt;
}

function minutesDiff(a, b) {
  return Math.round((a - b) / 60000);
}

function shiftLabel(key) {
  if (key === "morning") return "早班";
  if (key === "evening") return "晚班";
  return key;
}

function parseShiftLabel(text) {
  if (text === "早班") return "morning";
  if (text === "晚班") return "evening";
  return null;
}

function parsePunchAction(text) {
  if (text === "上班") return "checkIn";
  if (text === "下班") return "checkOut";
  return null;
}

// Q1：1 分鐘就算遲到
function calcLateMinutes(checkIn, shiftStart, dateStr) {
  if (!checkIn || !shiftStart) return 0;
  const start = toDateAt(dateStr, shiftStart);
  const diff = minutesDiff(checkIn, start);
  return diff > 0 ? diff : 0;
}

// ±60 分鐘內顯示 0；純顯示（不影響薪資）
function calcOvertimeEarlyLeave(checkOut, shiftEnd, dateStr) {
  if (!checkOut || !shiftEnd) return { overtimeMinutes: 0, earlyLeaveMinutes: 0 };

  const end = toDateAt(dateStr, shiftEnd);

  // 防跨日誤判：超過當天 23:59 以 23:59 計（避免 21:30~隔天10:00 被誤算加班）
  const endOfDay = new Date(dateStr);
  endOfDay.setHours(23, 59, 59, 999);

  const effectiveCheckOut = checkOut > endOfDay ? endOfDay : checkOut;
  const diff = minutesDiff(effectiveCheckOut, end);

  if (Math.abs(diff) <= 60) return { overtimeMinutes: 0, earlyLeaveMinutes: 0 };
  if (diff > 60) return { overtimeMinutes: diff, earlyLeaveMinutes: 0 };
  return { overtimeMinutes: 0, earlyLeaveMinutes: Math.abs(diff) };
}

// ------------------- Firestore 查詢 -------------------
async function getEmployeeByUserId(userId) {
  const snap = await db.collection("employees").where("userId", "==", userId).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { empNo: doc.id, ...doc.data() };
}

async function getEmployeeByEmpNo(empNo) {
  const doc = await db.collection("employees").doc(empNo).get();
  if (!doc.exists) return null;
  return { empNo: doc.id, ...doc.data() };
}

async function getSchedule(empNo, dateStr) {
  const doc = await db.collection("schedules").doc(scheduleDocId(empNo, dateStr)).get();
  return doc.exists ? doc.data() : null;
}

function getShiftFromSchedule(schedule, shiftKey) {
  const s = schedule?.shifts?.[shiftKey];
  if (!s) return null;
  if (s.enabled === false) return null; // 颱風半天：關閉某班
  return s;
}

// ------------------- Pending（防點錯：先確認再寫入） -------------------
async function setPending(userId, payload) {
  await db.collection("pendingActions").doc(pendingDocId(userId)).set({
    ...payload,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function getPending(userId) {
  const doc = await db.collection("pendingActions").doc(pendingDocId(userId)).get();
  return doc.exists ? doc.data() : null;
}

async function clearPending(userId) {
  await db.collection("pendingActions").doc(pendingDocId(userId)).delete().catch(() => {});
}

// ------------------- 補打卡申請 -------------------
async function createMakeupRequest(payload) {
  const ref = await db.collection("makeupRequests").add({
    ...payload,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

// ------------------- 核心：打卡寫入（早/晚分開） -------------------
async function applyPunch({
  empNo,
  userId,
  dateStr,
  shiftKey,
  action, // checkIn / checkOut
  at, // Date
  byAdmin, // boolean
  note, // string
  adminEmpNo, // string
}) {
  const attRef = db.collection("attendance").doc(attendanceDocId(empNo, dateStr));
  const attSnap = await attRef.get();
  const att = attSnap.exists ? attSnap.data() : {};

  const schedule = await getSchedule(empNo, dateStr);
  const shift = getShiftFromSchedule(schedule, shiftKey);

  const cur = att.records?.[shiftKey] || {};
  const pathBase = `records.${shiftKey}`;

  // 規則：員工下班必須先有上班（管理員補打卡可略過）
  if (action === "checkIn" && cur.checkIn) {
    return { ok: false, msg: `${shiftLabel(shiftKey)}今天已上班打卡過了` };
  }
  if (action === "checkOut") {
    if (!cur.checkIn && !byAdmin) {
      return { ok: false, msg: `❌ ${shiftLabel(shiftKey)}尚未上班打卡，無法下班` };
    }
    if (cur.checkOut) {
      return { ok: false, msg: `${shiftLabel(shiftKey)}今天已下班打卡過了` };
    }
  }

  const updates = {
    empNo,
    userId: userId || null,
    date: dateStr,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  updates[`${pathBase}.${action}`] = at;

  // 帶入班表（若有）
  if (shift) {
    updates[`${pathBase}.shiftStart`] = shift.start || null;
    updates[`${pathBase}.shiftEnd`] = shift.end || null;
  }

  // 取計算用的 start/end（優先當天班表，其次用已存在的欄位）
  const shiftStart = shift?.start || cur.shiftStart || null;
  const shiftEnd = shift?.end || cur.shiftEnd || null;

  // 遲到：會影響薪資（Step 3 用），此處只記錄分鐘
  if (action === "checkIn") {
    const lateMinutes = calcLateMinutes(at, shiftStart, dateStr);
    updates[`${pathBase}.lateMinutes`] = lateMinutes;
  }

  // 加班/早退：純顯示
  if (action === "checkOut") {
    const { overtimeMinutes, earlyLeaveMinutes } = calcOvertimeEarlyLeave(at, shiftEnd, dateStr);
    updates[`${pathBase}.overtimeMinutes`] = overtimeMinutes;
    updates[`${pathBase}.earlyLeaveMinutes`] = earlyLeaveMinutes;
  }

  // 老闆操作紀錄（核准補打卡會走這裡，計入補打卡次數）
  if (byAdmin) {
    updates["adminEdits"] = admin.firestore.FieldValue.arrayUnion({
      source: "admin",
      shiftKey,
      type: action,
      setTo: at.toISOString(),
      before: cur?.[action] ? safeToISO(cur[action]) : null,
      note: note || "",
      adminEmpNo: adminEmpNo || null,
      at: new Date().toISOString(),
    });
  }

  await attRef.set(updates, { merge: true });

  // 回傳資訊
  const afterSnap = await attRef.get();
  const after = afterSnap.data();
  const afterShift = after.records?.[shiftKey] || {};

  const lines = [];
  lines.push(`✅ ${shiftLabel(shiftKey)}${action === "checkIn" ? "上班" : "下班"}成功`);

  if (action === "checkIn") {
    lines.push(`遲到：${afterShift.lateMinutes || 0} 分鐘`);
  } else {
    lines.push(`加班：${afterShift.overtimeMinutes || 0} 分鐘（純顯示）`);
    lines.push(`早退：${afterShift.earlyLeaveMinutes || 0} 分鐘（純顯示）`);
  }

  return { ok: true, msg: lines.join("\n") };
}

// ------------------- Webhook -------------------
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("❌ Webhook Error:", err);
    res.status(500).end();
  }
});

// ------------------- 主要處理 -------------------
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return null;

  const userId = event.source.userId;
  const userMessage = normalizeText(event.message.text);
  const today = getTodayDate();
  const { cmd, args } = parseCommand(userMessage);

  // 先找員工
  const employee = await getEmployeeByUserId(userId);

  // 未註冊：允許「註冊 A001」
  if (!employee) {
    if (cmd === "註冊") {
      const empNo = (args[0] || "").toUpperCase();
      if (!empNo) return replyText(event.replyToken, "請輸入：註冊 A001");

      const target = await getEmployeeByEmpNo(empNo);
      if (!target) {
        return replyText(event.replyToken, `找不到員工編號 ${empNo}\n請老闆先建立：新增員工 ${empNo} 姓名`);
      }
      if (target.userId && target.userId !== userId) {
        return replyText(event.replyToken, `此員工編號 ${empNo} 已被其他帳號綁定，請老闆處理`);
      }

      await db.collection("employees").doc(empNo).set(
        { userId, active: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );

      return replyText(event.replyToken, `✅ 註冊完成，你的員工編號：${empNo}`);
    }

    return replyText(event.replyToken, "你尚未註冊。\n請輸入：註冊 A001\n（A001 向老闆取得）");
  }

  const isAdmin = employee.role === "admin";

  // ------------------- Pending：確認/取消（員工打卡防呆） -------------------
  if (cmd === "確認" || cmd === "取消") {
    const pending = await getPending(userId);
    if (!pending) return replyText(event.replyToken, "目前沒有待確認的操作");

    if (cmd === "取消") {
      await clearPending(userId);
      return replyText(event.replyToken, "✅ 已取消");
    }

    // 確認：才真正打卡
    await clearPending(userId);
    const { empNo, dateStr, shiftKey, action } = pending;
    const at = new Date();

    const r = await applyPunch({
      empNo,
      userId,
      dateStr,
      shiftKey,
      action,
      at,
      byAdmin: false,
    });

    return replyText(event.replyToken, r.msg);
  }

  // ------------------- 老闆模式 -------------------
  if (isAdmin) {
    if (cmd === "老闆" || cmd === "admin") {
      return replyText(
        event.replyToken,
        [
          "👑 老闆模式（文字測試用，之後可改按鍵）",
          "新增員工 A002 小明",
          "設定早班 A001 2025-12-12 10:00 14:30",
          "設定晚班 A001 2025-12-12 17:00 21:30",
          "關閉早班 A001 2025-12-12（颱風半天）",
          "關閉晚班 A001 2025-12-12（颱風半天）",
          "查今日 A001（或 查今日 A001 2025-12-12）",
          "查月報 A001 2025-12",
          "補早上班 A001 2025-12-12 10:03 備註",
          "補早下班 A001 2025-12-12 14:31 備註",
          "補晚上班 A001 2025-12-12 17:00 備註",
          "補晚下班 A001 2025-12-12 21:28 備註",
          "補打卡列表",
          "核准補打卡 <ID>",
          "駁回補打卡 <ID> 原因",
          "視為正常 A001 2025-12-12 備註",
        ].join("\n")
      );
    }

    // 新增員工
    if (cmd === "新增員工") {
      const empNo = (args[0] || "").toUpperCase();
      const name = args.slice(1).join(" ").trim() || "";
      if (!empNo) return replyText(event.replyToken, "格式：新增員工 A002 小明");

      const ref = db.collection("employees").doc(empNo);
      const snap = await ref.get();
      if (snap.exists) return replyText(event.replyToken, `⚠️ ${empNo} 已存在`);

      await ref.set({
        empNo,
        name,
        role: "staff",
        active: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return replyText(event.replyToken, `✅ 已新增員工：${empNo}${name ? " " + name : ""}\n員工需輸入：註冊 ${empNo}`);
    }

    // 設定早班/晚班
    if (cmd === "設定早班" || cmd === "設定晚班") {
      const shiftKey = cmd === "設定早班" ? "morning" : "evening";
      const empNo = (args[0] || "").toUpperCase();
      const dateStr = args[1] || "";
      const start = args[2] || "";
      const end = args[3] || "";

      if (!empNo || !dateStr || !start || !end) {
        return replyText(event.replyToken, `格式：${cmd} A001 2025-12-12 10:00 14:30`);
      }
      if (!isValidDate(dateStr)) return replyText(event.replyToken, "日期格式錯誤，需 YYYY-MM-DD");
      if (!isValidTime(start) || !isValidTime(end)) return replyText(event.replyToken, "時間格式錯誤，需 HH:MM");
      const emp = await getEmployeeByEmpNo(empNo);
      if (!emp) return replyText(event.replyToken, `找不到員工：${empNo}`);

      const ref = db.collection("schedules").doc(scheduleDocId(empNo, dateStr));
      await ref.set(
        {
          empNo,
          date: dateStr,
          shifts: {
            [shiftKey]: { start, end, enabled: true },
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return replyText(event.replyToken, `✅ 已設定${shiftLabel(shiftKey)}：${empNo} ${dateStr} ${start}~${end}`);
    }

    // 關閉早班/晚班（颱風半天）
    if (cmd === "關閉早班" || cmd === "關閉晚班") {
      const shiftKey = cmd === "關閉早班" ? "morning" : "evening";
      const empNo = (args[0] || "").toUpperCase();
      const dateStr = args[1] || "";

      if (!empNo || !dateStr) return replyText(event.replyToken, `格式：${cmd} A001 2025-12-12`);
      if (!isValidDate(dateStr)) return replyText(event.replyToken, "日期格式錯誤，需 YYYY-MM-DD");

      const ref = db.collection("schedules").doc(scheduleDocId(empNo, dateStr));
      await ref.set(
        {
          empNo,
          date: dateStr,
          shifts: {
            [shiftKey]: { enabled: false },
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return replyText(event.replyToken, `✅ 已關閉${shiftLabel(shiftKey)}：${empNo} ${dateStr}`);
    }

    // 查今日
    if (cmd === "查今日") {
      const empNo = (args[0] || "").toUpperCase();
      const dateStr = args[1] || today;
      if (!empNo) return replyText(event.replyToken, "格式：查今日 A001（或 查今日 A001 2025-12-12）");
      if (!isValidDate(dateStr)) return replyText(event.replyToken, "日期格式錯誤，需 YYYY-MM-DD");

      const attDoc = await db.collection("attendance").doc(attendanceDocId(empNo, dateStr)).get();
      const sch = await getSchedule(empNo, dateStr);

      const lines = [];
      lines.push(`📋 ${empNo} ${dateStr}`);

      const mSch = sch?.shifts?.morning;
      const eSch = sch?.shifts?.evening;

      lines.push(mSch ? (mSch.enabled === false ? "早班：關閉" : `早班：${mSch.start}~${mSch.end}`) : "早班：未設定");
      lines.push(eSch ? (eSch.enabled === false ? "晚班：關閉" : `晚班：${eSch.start}~${eSch.end}`) : "晚班：未設定");

      if (!attDoc.exists) {
        lines.push("尚無打卡紀錄");
        return replyText(event.replyToken, lines.join("\n"));
      }

      const d = attDoc.data();
      const m = d.records?.morning || {};
      const e = d.records?.evening || {};

      lines.push("---");
      lines.push(`早班上班：${m.checkIn ? formatTs(m.checkIn) : "—"}（遲到 ${m.lateMinutes || 0} 分）`);
      lines.push(`早班下班：${m.checkOut ? formatTs(m.checkOut) : "—"}（加班 ${m.overtimeMinutes || 0} / 早退 ${m.earlyLeaveMinutes || 0}）`);
      lines.push(`晚班上班：${e.checkIn ? formatTs(e.checkIn) : "—"}（遲到 ${e.lateMinutes || 0} 分）`);
      lines.push(`晚班下班：${e.checkOut ? formatTs(e.checkOut) : "—"}（加班 ${e.overtimeMinutes || 0} / 早退 ${e.earlyLeaveMinutes || 0}）`);

      if (d.adminDecision?.status === "normal") {
        lines.push("---");
        lines.push("老闆判定：✅ 視為正常");
        if (d.adminDecision.note) lines.push(`備註：${d.adminDecision.note}`);
      }

      const editsCount = Array.isArray(d.adminEdits) ? d.adminEdits.length : 0;
      if (editsCount > 0) lines.push(`補打卡紀錄：${editsCount} 筆`);

      return replyText(event.replyToken, lines.join("\n"));
    }

    // 查月報（遲到/加班/早退統計）
    if (cmd === "查月報") {
      const empNo = (args[0] || "").toUpperCase();
      const monthStr = args[1] || "";
      if (!empNo || !monthStr) return replyText(event.replyToken, "格式：查月報 A001 2025-12");
      if (!isValidMonth(monthStr)) return replyText(event.replyToken, "月份格式錯誤，需 YYYY-MM");

      const startDate = `${monthStr}-01`;
      const endDate = `${monthStr}-31`;

      const snaps = await db
        .collection("attendance")
        .where("empNo", "==", empNo)
        .where("date", ">=", startDate)
        .where("date", "<=", endDate)
        .get();

      let days = 0;
      let lateTotal = 0;
      let otTotal = 0;
      let elTotal = 0;
      let makeupCount = 0;

      snaps.forEach((doc) => {
        days++;
        const d = doc.data();
        const m = d.records?.morning || {};
        const e = d.records?.evening || {};

        lateTotal += (m.lateMinutes || 0) + (e.lateMinutes || 0);
        otTotal += (m.overtimeMinutes || 0) + (e.overtimeMinutes || 0);
        elTotal += (m.earlyLeaveMinutes || 0) + (e.earlyLeaveMinutes || 0);
        makeupCount += Array.isArray(d.adminEdits) ? d.adminEdits.length : 0;
      });

      return replyText(
        event.replyToken,
        [
          `📅 ${empNo} ${monthStr} 月報`,
          `有資料天數：${days}`,
          `遲到總分鐘：${lateTotal}（會影響薪資：Step 3）`,
          `加班總分鐘：${otTotal}（純顯示）`,
          `早退總分鐘：${elTotal}（純顯示）`,
          `補打卡次數：${makeupCount}（超過 3 次全勤破功）`,
        ].join("\n")
      );
    }

    // 老闆補打卡（直接補）
    const adminPunchMap = {
      補早上班: { shiftKey: "morning", action: "checkIn" },
      補早下班: { shiftKey: "morning", action: "checkOut" },
      補晚上班: { shiftKey: "evening", action: "checkIn" },
      補晚下班: { shiftKey: "evening", action: "checkOut" },
    };

    if (adminPunchMap[cmd]) {
      const { shiftKey, action } = adminPunchMap[cmd];
      const empNo = (args[0] || "").toUpperCase();
      const dateStr = args[1] || "";
      const timeStr = args[2] || "";
      const note = args.slice(3).join(" ").trim() || "";

      if (!empNo || !dateStr || !timeStr) {
        return replyText(event.replyToken, `格式：${cmd} A001 2025-12-12 10:03 備註`);
      }
      if (!isValidDate(dateStr)) return replyText(event.replyToken, "日期格式錯誤，需 YYYY-MM-DD");
      if (!isValidTime(timeStr)) return replyText(event.replyToken, "時間格式錯誤，需 HH:MM");

      const emp = await getEmployeeByEmpNo(empNo);
      if (!emp) return replyText(event.replyToken, `找不到員工：${empNo}`);

      const at = toDateAt(dateStr, timeStr);

      const r = await applyPunch({
        empNo,
        userId: emp.userId || null,
        dateStr,
        shiftKey,
        action,
        at,
        byAdmin: true,
        note: note || "老闆補打卡",
        adminEmpNo: employee.empNo,
      });

      return replyText(event.replyToken, r.ok ? `✅ ${cmd} 完成\n${r.msg}` : `❌ ${r.msg}`);
    }

    // 視為正常（不會清掉遲到/補打卡次數，只是判定當日）
    if (cmd === "視為正常") {
      const empNo = (args[0] || "").toUpperCase();
      const dateStr = args[1] || "";
      const note = args.slice(2).join(" ").trim() || "";

      if (!empNo || !dateStr) return replyText(event.replyToken, "格式：視為正常 A001 2025-12-12 備註");
      if (!isValidDate(dateStr)) return replyText(event.replyToken, "日期格式錯誤，需 YYYY-MM-DD");

      await db.collection("attendance").doc(attendanceDocId(empNo, dateStr)).set(
        {
          empNo,
          date: dateStr,
          adminDecision: {
            status: "normal",
            note,
            adminEmpNo: employee.empNo,
            at: new Date().toISOString(),
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return replyText(event.replyToken, `✅ 已標記視為正常：${empNo} ${dateStr}${note ? "\n備註：" + note : ""}`);
    }

    // ------------------- 補打卡申請審核（列表/核准/駁回） -------------------
    if (cmd === "補打卡列表") {
      // 為避免 Firestore 需要複合索引：不 orderBy，抓 pending 後在記憶體排序
      const snap = await db.collection("makeupRequests").where("status", "==", "pending").get();

      if (snap.empty) {
        return replyText(event.replyToken, "目前沒有待審核的補打卡申請");
      }

      const items = snap.docs.map((doc) => {
        const d = doc.data();
        return {
          id: doc.id,
          ...d,
          createdAtMs: d.createdAt?.toDate ? d.createdAt.toDate().getTime() : 0,
        };
      });

      items.sort((a, b) => a.createdAtMs - b.createdAtMs);

      const lines = ["📋 待審核補打卡："];
      for (const it of items.slice(0, 20)) {
        lines.push(
          [
            `ID: ${it.id}`,
            `${it.empNo} ${it.date} ${shiftLabel(it.shiftKey)} ${it.action === "checkIn" ? "上班" : "下班"}`,
            `原因：${it.reason}`,
          ].join("\n")
        );
      }
      if (items.length > 20) lines.push(`（共 ${items.length} 筆，先顯示前 20 筆）`);

      return replyText(event.replyToken, lines.join("\n\n"));
    }

    if (cmd === "核准補打卡") {
      const requestId = args[0];
      if (!requestId) return replyText(event.replyToken, "格式：核准補打卡 <ID>");

      const ref = db.collection("makeupRequests").doc(requestId);
      const snap = await ref.get();
      if (!snap.exists) return replyText(event.replyToken, "找不到此補打卡申請");

      const req = snap.data();
      if (req.status !== "pending") return replyText(event.replyToken, "此申請已處理過");

      // 核准：寫入 attendance（走 applyPunch → 記 adminEdits → 計入補打卡次數）
      const at = new Date();
      const r = await applyPunch({
        empNo: req.empNo,
        userId: req.userId || null,
        dateStr: req.date,
        shiftKey: req.shiftKey,
        action: req.action,
        at,
        byAdmin: true,
        note: `核准補打卡申請(${requestId})：${req.reason}`,
        adminEmpNo: employee.empNo,
      });

      if (!r.ok) {
        // 不把申請改狀態，讓你能再處理
        return replyText(event.replyToken, `❌ 核准失敗：${r.msg}`);
      }

      await ref.set(
        {
          status: "approved",
          reviewedBy: employee.empNo,
          reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return replyText(event.replyToken, `✅ 已核准補打卡（${requestId}）\n${r.msg}`);
    }

    if (cmd === "駁回補打卡") {
      const requestId = args[0];
      const note = args.slice(1).join(" ").trim();
      if (!requestId || !note) return replyText(event.replyToken, "格式：駁回補打卡 <ID> 原因");

      const ref = db.collection("makeupRequests").doc(requestId);
      const snap = await ref.get();
      if (!snap.exists) return replyText(event.replyToken, "找不到此補打卡申請");

      const req = snap.data();
      if (req.status !== "pending") return replyText(event.replyToken, "此申請已處理過");

      await ref.set(
        {
          status: "rejected",
          reviewedBy: employee.empNo,
          reviewNote: note,
          reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return replyText(event.replyToken, `❌ 已駁回補打卡（${requestId}）`);
    }

    return replyText(event.replyToken, "指令不完整或未知。輸入：老闆  查看指令表");
  }

  // ------------------- 員工模式 -------------------

  // 申請補打卡 早班 上班 原因...
  if (cmd === "申請補打卡") {
    const shiftKey = parseShiftLabel(args[0]);
    const action = parsePunchAction(args[1]);
    const reason = args.slice(2).join(" ").trim();

    if (!shiftKey || !action || !reason) {
      return replyText(event.replyToken, "格式：申請補打卡 早班 上班 忘記打卡");
    }

    const requestId = await createMakeupRequest({
      empNo: employee.empNo,
      userId,
      date: today,
      shiftKey,
      action,
      reason,
    });

    return replyText(event.replyToken, `✅ 已送出補打卡申請\n編號：${requestId}\n等待老闆確認`);
  }

  // 員工打卡（先 pending 防呆）
  const staffPunchMap = {
    早班上班: { shiftKey: "morning", action: "checkIn" },
    早班下班: { shiftKey: "morning", action: "checkOut" },
    晚班上班: { shiftKey: "evening", action: "checkIn" },
    晚班下班: { shiftKey: "evening", action: "checkOut" },
  };

  if (staffPunchMap[cmd]) {
    const { shiftKey, action } = staffPunchMap[cmd];
    await setPending(userId, {
      empNo: employee.empNo,
      dateStr: today,
      shiftKey,
      action,
    });

    return replyText(
      event.replyToken,
      `⚠️ 請確認：你要打【${shiftLabel(shiftKey)}】的【${action === "checkIn" ? "上班" : "下班"}】嗎？\n回覆：確認 / 取消`
    );
  }

  // 今日
  if (cmd === "今日") {
    const attDoc = await db.collection("attendance").doc(attendanceDocId(employee.empNo, today)).get();
    const sch = await getSchedule(employee.empNo, today);

    const lines = [];
    lines.push(`📋 今日（${today}）`);

    const mSch = sch?.shifts?.morning;
    const eSch = sch?.shifts?.evening;

    lines.push(mSch ? (mSch.enabled === false ? "早班：關閉" : `早班：${mSch.start}~${mSch.end}`) : "早班：未設定");
    lines.push(eSch ? (eSch.enabled === false ? "晚班：關閉" : `晚班：${eSch.start}~${eSch.end}`) : "晚班：未設定");

    if (!attDoc.exists) {
      lines.push("尚無打卡紀錄");
      lines.push("打卡：早班上班 / 早班下班 / 晚班上班 / 晚班下班（會先要求確認）");
      lines.push("補打卡：申請補打卡 早班 上班 原因");
      return replyText(event.replyToken, lines.join("\n"));
    }

    const d = attDoc.data();
    const m = d.records?.morning || {};
    const e = d.records?.evening || {};

    lines.push("---");
    lines.push(`早班上班：${m.checkIn ? formatTs(m.checkIn) : "—"}（遲到 ${m.lateMinutes || 0} 分）`);
    lines.push(`早班下班：${m.checkOut ? formatTs(m.checkOut) : "—"}（加班 ${m.overtimeMinutes || 0} / 早退 ${m.earlyLeaveMinutes || 0}）`);
    lines.push(`晚班上班：${e.checkIn ? formatTs(e.checkIn) : "—"}（遲到 ${e.lateMinutes || 0} 分）`);
    lines.push(`晚班下班：${e.checkOut ? formatTs(e.checkOut) : "—"}（加班 ${e.overtimeMinutes || 0} / 早退 ${e.earlyLeaveMinutes || 0}）`);

    if (d.adminDecision?.status === "normal") {
      lines.push("---");
      lines.push("老闆判定：✅ 視為正常");
    }

    const editsCount = Array.isArray(d.adminEdits) ? d.adminEdits.length : 0;
    if (editsCount > 0) lines.push(`補打卡紀錄：${editsCount} 筆（影響全勤）`);

    return replyText(event.replyToken, lines.join("\n"));
  }

  // 本月（粗統計）
  if (cmd === "本月") {
    const monthStr = today.slice(0, 7);
    const startDate = `${monthStr}-01`;
    const endDate = `${monthStr}-31`;

    const snaps = await db
      .collection("attendance")
      .where("empNo", "==", employee.empNo)
      .where("date", ">=", startDate)
      .where("date", "<=", endDate)
      .get();

    let days = 0;
    let lateTotal = 0;
    let otTotal = 0;
    let elTotal = 0;
    let makeupCount = 0;

    snaps.forEach((doc) => {
      days++;
      const d = doc.data();
      const m = d.records?.morning || {};
      const e = d.records?.evening || {};
      lateTotal += (m.lateMinutes || 0) + (e.lateMinutes || 0);
      otTotal += (m.overtimeMinutes || 0) + (e.overtimeMinutes || 0);
      elTotal += (m.earlyLeaveMinutes || 0) + (e.earlyLeaveMinutes || 0);
      makeupCount += Array.isArray(d.adminEdits) ? d.adminEdits.length : 0;
    });

    return replyText(
      event.replyToken,
      [
        `📅 本月（${monthStr}）`,
        `有資料天數：${days}`,
        `遲到總分鐘：${lateTotal}（影響薪資）`,
        `加班總分鐘：${otTotal}（純顯示）`,
        `早退總分鐘：${elTotal}（純顯示）`,
        `補打卡次數：${makeupCount}（超過 3 次全勤破功）`,
      ].join("\n")
    );
  }

  // 說明
  return replyText(
    event.replyToken,
    [
      "可用指令（之後可做按鍵）：",
      "👉 早班上班 / 早班下班",
      "👉 晚班上班 / 晚班下班",
      "👉 今日",
      "👉 本月",
      "👉 申請補打卡 早班 上班 原因",
      "（打卡會先要求：確認 / 取消）",
      isAdmin ? "👉 老闆" : "",
    ]
      .filter(Boolean)
      .join("\n")
  );
}

// ------------------- 啟動 Server -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
