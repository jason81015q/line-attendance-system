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

function parseCommand(text) {
  const t = normalizeText(text);
  const parts = t.split(" ");
  return { raw: t, cmd: parts[0] || "", args: parts.slice(1) };
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
  // a - b in minutes
  return Math.round((a - b) / 60000);
}

// Q1= A：1分鐘就算遲到（所以不做寬限）
function calcLateMinutes(checkIn, shiftStart, dateStr) {
  if (!checkIn || !shiftStart) return 0;
  const start = toDateAt(dateStr, shiftStart);
  const diff = minutesDiff(checkIn, start);
  return diff > 0 ? diff : 0;
}

// ±60分鐘內顯示 0；純顯示
function calcOvertimeEarlyLeave(checkOut, shiftEnd, dateStr) {
  if (!checkOut || !shiftEnd) return { overtimeMinutes: 0, earlyLeaveMinutes: 0 };

  const end = toDateAt(dateStr, shiftEnd);

  // 避免跨日誤判：超過當天 23:59 一律視為 23:59
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

function getShiftKeyFromLabel(label) {
  // 早班/晚班 -> morning/evening
  if (label === "早班") return "morning";
  if (label === "晚班") return "evening";
  return null;
}

function shiftLabel(key) {
  return key === "morning" ? "早班" : key === "evening" ? "晚班" : key;
}

function getShiftFromSchedule(schedule, shiftKey) {
  if (!schedule || !schedule.shifts || !schedule.shifts[shiftKey]) return null;
  const s = schedule.shifts[shiftKey];
  if (s && s.enabled === false) return null;
  return s;
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

// ------------------- 核心：打卡（寫入 records.morning / records.evening） -------------------
async function applyPunch({ empNo, userId, dateStr, shiftKey, action, at, byAdmin, note, adminEmpNo }) {
  const attRef = db.collection("attendance").doc(attendanceDocId(empNo, dateStr));
  const attSnap = await attRef.get();
  const att = attSnap.exists ? attSnap.data() : {};

  const schedule = await getSchedule(empNo, dateStr);
  const shift = getShiftFromSchedule(schedule, shiftKey);

  // 如果沒排班，仍允許打卡（先記錄），但計算會是 0
  const pathBase = `records.${shiftKey}`;
  const cur = (att.records && att.records[shiftKey]) ? att.records[shiftKey] : {};

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

  // 同步班表到 attendance（方便查詢）
  if (shift) {
    updates[`${pathBase}.shiftStart`] = shift.start || null;
    updates[`${pathBase}.shiftEnd`] = shift.end || null;
  } else {
    // 沒班表就保留原本（不覆蓋），避免你先設過
  }

  // 計算（純顯示 / 遲到會進薪資：先存 lateMinutes，扣薪留到 Step 3）
  const shiftStart = shift ? shift.start : (cur.shiftStart || null);
  const shiftEnd = shift ? shift.end : (cur.shiftEnd || null);

  if (action === "checkIn") {
    const lateMinutes = calcLateMinutes(at, shiftStart, dateStr);
    updates[`${pathBase}.lateMinutes`] = lateMinutes;
  }

  if (action === "checkOut") {
    const { overtimeMinutes, earlyLeaveMinutes } = calcOvertimeEarlyLeave(at, shiftEnd, dateStr);
    updates[`${pathBase}.overtimeMinutes`] = overtimeMinutes;
    updates[`${pathBase}.earlyLeaveMinutes`] = earlyLeaveMinutes;
  }

  // 管理員操作紀錄（補打卡一定留下）
  if (byAdmin) {
    updates["adminEdits"] = admin.firestore.FieldValue.arrayUnion({
      shiftKey,
      type: action,
      setTo: at.toISOString(),
      before: cur && cur[action] ? safeToISO(cur[action]) : null,
      note: note || "",
      adminEmpNo: adminEmpNo || null,
      at: new Date().toISOString(),
    });
  }

  await attRef.set(updates, { merge: true });

  // 回傳一段訊息給呼叫者
  const afterSnap = await attRef.get();
  const after = afterSnap.data();
  const afterShift = after.records?.[shiftKey] || {};

  const lines = [];
  lines.push(`✅ ${shiftLabel(shiftKey)}${action === "checkIn" ? "上班" : "下班"}成功`);
  if (action === "checkIn") {
    lines.push(`遲到：${afterShift.lateMinutes || 0} 分鐘`);
  }
  if (action === "checkOut") {
    const ot = afterShift.overtimeMinutes || 0;
    const el = afterShift.earlyLeaveMinutes || 0;
    lines.push(`加班：${ot} 分鐘（純顯示）`);
    lines.push(`早退：${el} 分鐘（純顯示）`);
  }

  return { ok: true, msg: lines.join("\n") };
}

// ------------------- Pending（避免點錯班別：先確認再寫入） -------------------
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

// ------------------- 主要處理 -------------------
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return null;

  const userId = event.source.userId;
  const userMessage = normalizeText(event.message.text);
  const today = getTodayDate();
  const { cmd, args } = parseCommand(userMessage);

  // 找員工
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

  // 先處理 Pending：確認/取消
  if (cmd === "確認" || cmd === "取消") {
    const pending = await getPending(userId);
    if (!pending) return replyText(event.replyToken, "目前沒有待確認的操作");

    if (cmd === "取消") {
      await clearPending(userId);
      return replyText(event.replyToken, "✅ 已取消");
    }

    // 確認
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
          "👑 老闆模式（建議之後做成按鍵）",
          "新增員工 A002 小明",
          "設定早班 A001 2025-12-12 10:00 14:30",
          "設定晚班 A001 2025-12-12 17:00 21:30",
          "關閉早班 A001 2025-12-12（颱風半天用）",
          "關閉晚班 A001 2025-12-12（颱風半天用）",
          "查今日 A001（或 查今日 A001 2025-12-12）",
          "查月報 A001 2025-12",
          "補早上班 A001 2025-12-12 10:03 備註",
          "補早下班 A001 2025-12-12 14:31 備註",
          "補晚上班 A001 2025-12-12 17:00 備註",
          "補晚下班 A001 2025-12-12 21:28 備註",
          "視為正常 A001 2025-12-12 備註",
        ].join("\n")
      );
    }

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

    // 設定早班/晚班 <編號> <YYYY-MM-DD> <start> <end>
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

    // 關閉早班/晚班 <編號> <YYYY-MM-DD>
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

    // 查今日 <編號> [YYYY-MM-DD]
    if (cmd === "查今日") {
      const empNo = (args[0] || "").toUpperCase();
      const dateStr = args[1] || today;
      if (!empNo) return replyText(event.replyToken, "格式：查今日 A001（或 查今日 A001 2025-12-12）");
      if (!isValidDate(dateStr)) return replyText(event.replyToken, "日期格式錯誤，需 YYYY-MM-DD");

      const attDoc = await db.collection("attendance").doc(attendanceDocId(empNo, dateStr)).get();
      const sch = await getSchedule(empNo, dateStr);

      const lines = [];
      lines.push(`📋 ${empNo} ${dateStr}`);

      if (sch?.shifts?.morning?.enabled !== false && sch?.shifts?.morning) {
        lines.push(`早班：${sch.shifts.morning.start}~${sch.shifts.morning.end}`);
      } else if (sch?.shifts?.morning?.enabled === false) {
        lines.push("早班：關閉");
      }

      if (sch?.shifts?.evening?.enabled !== false && sch?.shifts?.evening) {
        lines.push(`晚班：${sch.shifts.evening.start}~${sch.shifts.evening.end}`);
      } else if (sch?.shifts?.evening?.enabled === false) {
        lines.push("晚班：關閉");
      }

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
      lines.push(`晚上上班：${e.checkIn ? formatTs(e.checkIn) : "—"}（遲到 ${e.lateMinutes || 0} 分）`);
      lines.push(`晚上下班：${e.checkOut ? formatTs(e.checkOut) : "—"}（加班 ${e.overtimeMinutes || 0} / 早退 ${e.earlyLeaveMinutes || 0}）`);

      if (d.adminDecision?.status === "normal") {
        lines.push("---");
        lines.push("老闆判定：✅ 視為正常");
        if (d.adminDecision.note) lines.push(`備註：${d.adminDecision.note}`);
      }

      return replyText(event.replyToken, lines.join("\n"));
    }

    // 查月報 <編號> <YYYY-MM>
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

      snaps.forEach((doc) => {
        days++;
        const d = doc.data();
        const m = d.records?.morning || {};
        const e = d.records?.evening || {};

        lateTotal += (m.lateMinutes || 0) + (e.lateMinutes || 0);
        otTotal += (m.overtimeMinutes || 0) + (e.overtimeMinutes || 0);
        elTotal += (m.earlyLeaveMinutes || 0) + (e.earlyLeaveMinutes || 0);
      });

      return replyText(
        event.replyToken,
        [
          `📅 ${empNo} ${monthStr} 月報`,
          `有資料天數：${days}`,
          `遲到總分鐘：${lateTotal}（會影響薪資：Step 3）`,
          `加班總分鐘：${otTotal}（純顯示）`,
          `早退總分鐘：${elTotal}（純顯示）`,
        ].join("\n")
      );
    }

    // 補早上班/補早下班/補晚上班/補晚下班 <編號> <YYYY-MM-DD> <HH:MM> [備註...]
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
        note,
        adminEmpNo: employee.empNo,
      });

      return replyText(event.replyToken, r.ok ? `✅ ${cmd} 完成\n${r.msg}` : `❌ ${r.msg}`);
    }

    // 視為正常 <編號> <YYYY-MM-DD> [備註...]
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

    return replyText(event.replyToken, "指令不完整或未知。輸入：老闆  查看指令表");
  }

  // ------------------- 員工模式（先用文字，之後改按鍵） -------------------
  // 點錯班別怎麼辦：一律先進 pending，回「確認/取消」才寫入
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

  // 今日（顯示早/晚兩班）
  if (cmd === "今日") {
    const attDoc = await db.collection("attendance").doc(attendanceDocId(employee.empNo, today)).get();
    const sch = await getSchedule(employee.empNo, today);

    const lines = [];
    lines.push(`📋 今日（${today}）`);

    if (sch?.shifts?.morning?.enabled !== false && sch?.shifts?.morning) {
      lines.push(`早班：${sch.shifts.morning.start}~${sch.shifts.morning.end}`);
    } else if (sch?.shifts?.morning?.enabled === false) {
      lines.push("早班：關閉");
    }

    if (sch?.shifts?.evening?.enabled !== false && sch?.shifts?.evening) {
      lines.push(`晚班：${sch.shifts.evening.start}~${sch.shifts.evening.end}`);
    } else if (sch?.shifts?.evening?.enabled === false) {
      lines.push("晚班：關閉");
    }

    if (!attDoc.exists) {
      lines.push("尚無打卡紀錄");
      lines.push("打卡指令：早班上班 / 早班下班 / 晚班上班 / 晚班下班");
      return replyText(event.replyToken, lines.join("\n"));
    }

    const d = attDoc.data();
    const m = d.records?.morning || {};
    const e = d.records?.evening || {};

    lines.push("---");
    lines.push(`早班上班：${m.checkIn ? formatTs(m.checkIn) : "—"}（遲到 ${m.lateMinutes || 0} 分）`);
    lines.push(`早班下班：${m.checkOut ? formatTs(m.checkOut) : "—"}（加班 ${m.overtimeMinutes || 0} / 早退 ${m.earlyLeaveMinutes || 0}）`);
    lines.push(`晚上上班：${e.checkIn ? formatTs(e.checkIn) : "—"}（遲到 ${e.lateMinutes || 0} 分）`);
    lines.push(`晚上下班：${e.checkOut ? formatTs(e.checkOut) : "—"}（加班 ${e.overtimeMinutes || 0} / 早退 ${e.earlyLeaveMinutes || 0}）`);

    if (d.adminDecision?.status === "normal") {
      lines.push("---");
      lines.push("老闆判定：✅ 視為正常");
    }

    return replyText(event.replyToken, lines.join("\n"));
  }

  // 本月（先統計遲到/加班/早退總分鐘）
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

    snaps.forEach((doc) => {
      days++;
      const d = doc.data();
      const m = d.records?.morning || {};
      const e = d.records?.evening || {};
      lateTotal += (m.lateMinutes || 0) + (e.lateMinutes || 0);
      otTotal += (m.overtimeMinutes || 0) + (e.overtimeMinutes || 0);
      elTotal += (m.earlyLeaveMinutes || 0) + (e.earlyLeaveMinutes || 0);
    });

    return replyText(
      event.replyToken,
      [
        `📅 本月（${monthStr}）`,
        `有資料天數：${days}`,
        `遲到總分鐘：${lateTotal}（會影響薪資：Step 3）`,
        `加班總分鐘：${otTotal}（純顯示）`,
        `早退總分鐘：${elTotal}（純顯示）`,
      ].join("\n")
    );
  }

  // 說明
  return replyText(
    event.replyToken,
    [
      "可用指令（之後改按鍵）：",
      "👉 早班上班 / 早班下班",
      "👉 晚班上班 / 晚班下班",
      "👉 今日",
      "👉 本月",
      isAdmin ? "👉 老闆" : "",
      "（防呆：打卡會先要求『確認/取消』）",
    ].filter(Boolean).join("\n")
  );
}

// ------------------- 啟動 Server -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
