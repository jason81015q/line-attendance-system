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
  // YYYY-MM-DD
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function isValidMonth(monthStr) {
  // YYYY-MM
  return /^\d{4}-\d{2}$/.test(monthStr);
}

function isValidTime(timeStr) {
  // HH:MM 00-23 00-59
  if (!/^\d{2}:\d{2}$/.test(timeStr)) return false;
  const [h, m] = timeStr.split(":").map((x) => Number(x));
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function parseCommand(text) {
  // 支援「指令 參數1 參數2...」
  const t = normalizeText(text);
  const parts = t.split(" ");
  return { raw: t, cmd: parts[0] || "", args: parts.slice(1) };
}

// 依 userId 找到員工（employees 的 docId 是 A001 這種編號）
async function getEmployeeByUserId(userId) {
  const snap = await db
    .collection("employees")
    .where("userId", "==", userId)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];
  return { empNo: doc.id, ...doc.data() };
}

async function getEmployeeByEmpNo(empNo) {
  const doc = await db.collection("employees").doc(empNo).get();
  if (!doc.exists) return null;
  return { empNo: doc.id, ...doc.data() };
}

function attendanceDocId(empNo, dateStr) {
  return `${empNo}_${dateStr}`;
}

// 取某日排班（預留結構：schedules/{empNo}_{YYYY-MM-DD}）
async function getSchedule(empNo, dateStr) {
  const docId = `${empNo}_${dateStr}`;
  const snap = await db.collection("schedules").doc(docId).get();
  return snap.exists ? snap.data() : null;
}

// 回覆快捷
function replyText(replyToken, text) {
  return client.replyMessage(replyToken, { type: "text", text });
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

  // 先找員工資料（你現在是 employees/A001 裡有 userId）
  const employee = await getEmployeeByUserId(userId);

  // ------------------- 未註冊流程（員工自助綁定） -------------------
  // 讓新人自己輸入：註冊 A001（把 LINE userId 綁到 employees/A001）
  //（掃碼註冊你之後要做也行，但此版先用文字綁定）
  if (!employee) {
    if (cmd === "註冊") {
      const empNo = (args[0] || "").toUpperCase();
      if (!empNo) return replyText(event.replyToken, "請輸入：註冊 A001");

      const target = await getEmployeeByEmpNo(empNo);
      if (!target) {
        return replyText(
          event.replyToken,
          `找不到員工編號 ${empNo}\n請請老闆先建立員工資料：新增員工 ${empNo} 姓名`
        );
      }
      if (target.userId && target.userId !== userId) {
        return replyText(
          event.replyToken,
          `此員工編號 ${empNo} 已被其他帳號綁定，請老闆處理`
        );
      }

      await db.collection("employees").doc(empNo).set(
        {
          userId,
          active: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return replyText(event.replyToken, `✅ 註冊完成，你的員工編號：${empNo}`);
    }

    return replyText(
      event.replyToken,
      "你尚未註冊。\n請輸入：註冊 A001\n（A001 請向老闆取得）"
    );
  }

  // ------------------- 角色判斷（老闆模式） -------------------
  // 你可以在 Firestore employees/{empNo}.role 設 admin
  const isAdmin = employee.role === "admin";

  // ------------------- 老闆模式指令 -------------------
  if (isAdmin) {
    if (cmd === "老闆" || cmd === "admin") {
      return replyText(
        event.replyToken,
        [
          "👑 老闆模式指令：",
          "1) 新增員工 A002 小明",
          "2) 設定班表 A001 2025-12-12 14:30 21:30",
          "3) 查今日 A001（不給日期 = 今天）",
          "4) 查月報 A001 2025-12",
          "5) 補上班 A001 2025-12-12 14:32 備註",
          "6) 補下班 A001 2025-12-12 21:28 備註",
          "7) 視為正常 A001 2025-12-12 備註",
        ].join("\n")
      );
    }

    // 新增員工 <編號> <姓名(可省略)>
    if (cmd === "新增員工") {
      const empNo = (args[0] || "").toUpperCase();
      const name = args.slice(1).join(" ").trim() || "";
      if (!empNo) return replyText(event.replyToken, "格式：新增員工 A002 小明");

      const ref = db.collection("employees").doc(empNo);
      const snap = await ref.get();
      if (snap.exists) {
        return replyText(event.replyToken, `⚠️ ${empNo} 已存在`);
      }

      await ref.set({
        empNo,
        name,
        role: "staff",
        active: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return replyText(
        event.replyToken,
        `✅ 已新增員工：${empNo}${name ? " " + name : ""}\n（員工本人需輸入：註冊 ${empNo}）`
      );
    }

    // 設定班表 <編號> <YYYY-MM-DD> <HH:MM> <HH:MM>
    if (cmd === "設定班表") {
      const empNo = (args[0] || "").toUpperCase();
      const dateStr = args[1] || "";
      const start = args[2] || "";
      const end = args[3] || "";

      if (!empNo || !dateStr || !start || !end) {
        return replyText(
          event.replyToken,
          "格式：設定班表 A001 2025-12-12 14:30 21:30"
        );
      }
      if (!isValidDate(dateStr)) return replyText(event.replyToken, "日期格式錯誤，需 YYYY-MM-DD");
      if (!isValidTime(start) || !isValidTime(end))
        return replyText(event.replyToken, "時間格式錯誤，需 HH:MM");

      const emp = await getEmployeeByEmpNo(empNo);
      if (!emp) return replyText(event.replyToken, `找不到員工：${empNo}`);

      const docId = `${empNo}_${dateStr}`;
      await db.collection("schedules").doc(docId).set({
        empNo,
        date: dateStr,
        shiftStart: start,
        shiftEnd: end,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return replyText(
        event.replyToken,
        `✅ 已設定班表：${empNo} ${dateStr} ${start}~${end}`
      );
    }

    // 查今日 <編號> [YYYY-MM-DD]
    if (cmd === "查今日") {
      const empNo = (args[0] || "").toUpperCase();
      const dateStr = args[1] || today;
      if (!empNo) return replyText(event.replyToken, "格式：查今日 A001（或 查今日 A001 2025-12-12）");
      if (!isValidDate(dateStr)) return replyText(event.replyToken, "日期格式錯誤，需 YYYY-MM-DD");

      const doc = await db.collection("attendance").doc(attendanceDocId(empNo, dateStr)).get();
      const sch = await getSchedule(empNo, dateStr);

      if (!doc.exists) {
        return replyText(
          event.replyToken,
          `📋 ${empNo} ${dateStr}\n尚無打卡紀錄` + (sch ? `\n班表：${sch.shiftStart}~${sch.shiftEnd}` : "")
        );
      }

      const d = doc.data();
      const lines = [];
      lines.push(`📋 ${empNo} ${dateStr}`);
      if (sch) lines.push(`班表：${sch.shiftStart}~${sch.shiftEnd}`);
      lines.push(`上班：${d.checkIn ? formatTs(d.checkIn) : "—"}`);
      lines.push(`下班：${d.checkOut ? formatTs(d.checkOut) : "—"}`);
      if (d.adminDecision) {
        const ad = d.adminDecision;
        lines.push(`老闆判定：${ad.status || "—"}`);
        if (ad.note) lines.push(`備註：${ad.note}`);
      }
      if (d.adminEdits && Array.isArray(d.adminEdits) && d.adminEdits.length) {
        lines.push(`補打卡紀錄：${d.adminEdits.length} 筆`);
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

      let worked = 0;
      let missingCheckIn = 0;
      let missingCheckOut = 0;
      let adminNormal = 0;

      snaps.forEach((doc) => {
        const d = doc.data();
        const hasIn = !!d.checkIn;
        const hasOut = !!d.checkOut;
        if (hasIn || hasOut) worked++;
        if (!hasIn) missingCheckIn++;
        if (!hasOut) missingCheckOut++;
        if (d.adminDecision && d.adminDecision.status === "normal") adminNormal++;
      });

      return replyText(
        event.replyToken,
        [
          `📅 ${empNo} ${monthStr} 月報`,
          `有紀錄天數：${worked}`,
          `缺上班卡天數：${missingCheckIn}`,
          `缺下班卡天數：${missingCheckOut}`,
          `老闆視為正常天數：${adminNormal}`,
          "（加班/早退統計：下一步會接排班規則做『純顯示』）",
        ].join("\n")
      );
    }

    // 補上班/補下班 <編號> <YYYY-MM-DD> <HH:MM> [備註...]
    if (cmd === "補上班" || cmd === "補下班") {
      const type = cmd === "補上班" ? "checkIn" : "checkOut";
      const empNo = (args[0] || "").toUpperCase();
      const dateStr = args[1] || "";
      const timeStr = args[2] || "";
      const note = args.slice(3).join(" ").trim() || "";

      if (!empNo || !dateStr || !timeStr) {
        return replyText(
          event.replyToken,
          `格式：${cmd} A001 2025-12-12 14:32 備註`
        );
      }
      if (!isValidDate(dateStr)) return replyText(event.replyToken, "日期格式錯誤，需 YYYY-MM-DD");
      if (!isValidTime(timeStr)) return replyText(event.replyToken, "時間格式錯誤，需 HH:MM");

      const emp = await getEmployeeByEmpNo(empNo);
      if (!emp) return replyText(event.replyToken, `找不到員工：${empNo}`);

      const [hh, mm] = timeStr.split(":").map((x) => Number(x));
      const dt = new Date(dateStr);
      dt.setHours(hh, mm, 0, 0);

      const docId = attendanceDocId(empNo, dateStr);
      const ref = db.collection("attendance").doc(docId);
      const snap = await ref.get();
      const before = snap.exists ? snap.data()[type] : null;

      await ref.set(
        {
          empNo,
          userId: emp.userId || null,
          date: dateStr,
          [type]: dt,
          adminEdits: admin.firestore.FieldValue.arrayUnion({
            type,
            setTo: dt.toISOString(),
            before: before ? safeToISO(before) : null,
            note,
            adminEmpNo: employee.empNo,
            at: new Date().toISOString(),
          }),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return replyText(
        event.replyToken,
        `✅ 已${cmd}：${empNo} ${dateStr} ${timeStr}${note ? "\n備註：" + note : ""}`
      );
    }

    // 視為正常 <編號> <YYYY-MM-DD> [備註...]
    if (cmd === "視為正常") {
      const empNo = (args[0] || "").toUpperCase();
      const dateStr = args[1] || "";
      const note = args.slice(2).join(" ").trim() || "";

      if (!empNo || !dateStr) {
        return replyText(event.replyToken, "格式：視為正常 A001 2025-12-12 備註");
      }
      if (!isValidDate(dateStr)) return replyText(event.replyToken, "日期格式錯誤，需 YYYY-MM-DD");

      const docId = attendanceDocId(empNo, dateStr);
      await db.collection("attendance").doc(docId).set(
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

      return replyText(
        event.replyToken,
        `✅ 已標記視為正常：${empNo} ${dateStr}${note ? "\n備註：" + note : ""}`
      );
    }

    // 老闆沒匹配到指令
    //（不回覆也行，但我保留一個提示）
    return replyText(event.replyToken, "指令不完整或未知。輸入：老闆  查看指令表");
  }

  // ------------------- 員工模式指令 -------------------
  // 上班/下班：只記錄實際時間，補打卡不在員工端做
  if (cmd === "上班") {
    const docId = attendanceDocId(employee.empNo, today);
    const ref = db.collection("attendance").doc(docId);
    const snap = await ref.get();

    if (snap.exists && snap.data().checkIn) {
      return replyText(event.replyToken, "⚠️ 今天已經上班打卡過了");
    }

    // 同步帶入排班（純存，不做薪資）
    const sch = await getSchedule(employee.empNo, today);

    await ref.set(
      {
        empNo: employee.empNo,
        userId,
        date: today,
        checkIn: new Date(),
        shiftStart: sch?.shiftStart || null,
        shiftEnd: sch?.shiftEnd || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return replyText(event.replyToken, `🟢 上班打卡成功（${employee.empNo}）`);
  }

  if (cmd === "下班") {
    const docId = attendanceDocId(employee.empNo, today);
    const ref = db.collection("attendance").doc(docId);
    const snap = await ref.get();

    if (!snap.exists || !snap.data().checkIn) {
      return replyText(event.replyToken, "❌ 你今天尚未上班打卡，無法下班");
    }
    if (snap.data().checkOut) {
      return replyText(event.replyToken, "⚠️ 今天已經下班打卡過了");
    }

    await ref.set(
      {
        checkOut: new Date(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return replyText(event.replyToken, `🔴 下班打卡成功（${employee.empNo}）`);
  }

  // 今日：看自己今天狀態
  if (cmd === "今日") {
    const docId = attendanceDocId(employee.empNo, today);
    const doc = await db.collection("attendance").doc(docId).get();
    const sch = await getSchedule(employee.empNo, today);

    if (!doc.exists) {
      return replyText(
        event.replyToken,
        `📋 今日（${today}）\n尚無打卡紀錄` + (sch ? `\n班表：${sch.shiftStart}~${sch.shiftEnd}` : "")
      );
    }

    const d = doc.data();
    const lines = [];
    lines.push(`📋 今日（${today}）`);
    if (sch) lines.push(`班表：${sch.shiftStart}~${sch.shiftEnd}`);
    lines.push(`上班：${d.checkIn ? formatTs(d.checkIn) : "—"}`);
    lines.push(`下班：${d.checkOut ? formatTs(d.checkOut) : "—"}`);

    if (d.adminDecision?.status === "normal") {
      lines.push("老闆判定：✅ 視為正常");
    }

    // 加班/早退（純顯示）下一步你要我再接計算；這裡先保留欄位展示
    if (typeof d.overtimeMinutes === "number" || typeof d.earlyLeaveMinutes === "number") {
      lines.push(`加班：${d.overtimeMinutes || 0} 分鐘`);
      lines.push(`早退：${d.earlyLeaveMinutes || 0} 分鐘`);
    } else {
      lines.push("加班/早退：尚未計算（下一步接排班規則）");
    }

    return replyText(event.replyToken, lines.join("\n"));
  }

  // 本月：先給簡易統計（詳細下一步接排班計算）
  if (cmd === "本月") {
    const monthStr = today.slice(0, 7); // YYYY-MM
    const startDate = `${monthStr}-01`;
    const endDate = `${monthStr}-31`;

    const snaps = await db
      .collection("attendance")
      .where("empNo", "==", employee.empNo)
      .where("date", ">=", startDate)
      .where("date", "<=", endDate)
      .get();

    let days = 0;
    let missingIn = 0;
    let missingOut = 0;

    snaps.forEach((doc) => {
      const d = doc.data();
      days++;
      if (!d.checkIn) missingIn++;
      if (!d.checkOut) missingOut++;
    });

    return replyText(
      event.replyToken,
      [
        `📅 本月出勤（${monthStr}）`,
        `有紀錄天數：${days}`,
        `缺上班卡天數：${missingIn}`,
        `缺下班卡天數：${missingOut}`,
        "加班/早退總計：下一步接排班計算（純顯示、不影響薪資）",
      ].join("\n")
    );
  }

  // 指令說明
  return replyText(
    event.replyToken,
    [
      "可用指令：",
      "👉 上班",
      "👉 下班",
      "👉 今日",
      "👉 本月",
      isAdmin ? "👉 老闆（查看老闆指令）" : "",
    ].filter(Boolean).join("\n")
  );
}

// ------------------- Timestamp 顯示工具 -------------------
function formatTs(ts) {
  // ts 可能是 Date / Firestore Timestamp / string
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

// ------------------- 啟動 Server -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
