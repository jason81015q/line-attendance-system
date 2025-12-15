require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const admin = require("firebase-admin");

/* =========================
   LINE Bot config
========================= */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);
const app = express();

/* =========================
   Firebase init
========================= */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});
const db = admin.firestore();

/* =========================
   Feature flags (可選)
========================= */
const FEATURES = {
  ENABLE_ADVANCE: false, // 借支：你目前說 staff 只要打卡/補打卡，所以先關掉
};

/* =========================
   Helpers
========================= */
function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatYMD(d = new Date()) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function ymdToMonthKey(ymd) {
  // "2025-12-03" -> "2025-12"
  return ymd.slice(0, 7);
}

function attendanceDocId(empKey, ymd) {
  return `${empKey}_${ymd}`;
}

function shiftKeyFromLabel(label) {
  return label === "早" ? "morning" : label === "晚" ? "night" : null;
}

function actionKeyFromLabel(label) {
  return label === "上班" ? "checkIn" : label === "下班" ? "checkOut" : null;
}

function isValidYMD(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map((x) => Number(x));
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function parseDateInputToYMD(dateText) {
  // 支援 "YYYY-MM-DD" 或 "MM/DD"（預設今年）
  dateText = (dateText || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return dateText;
  const m = dateText.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const now = new Date();
    const y = now.getFullYear();
    const mm = pad2(Number(m[1]));
    const dd = pad2(Number(m[2]));
    return `${y}-${mm}-${dd}`;
  }
  return null;
}

function nowTs() {
  return admin.firestore.Timestamp.now();
}

function quickReply(items) {
  return {
    items: items.map((action) => ({ type: "action", action })),
  };
}

function postbackAction(label, data) {
  return { type: "postback", label, data, displayText: label };
}

function messageAction(label, text) {
  return { type: "message", label, text };
}

function flexApprovalCard({ title, fields, approveData, rejectData }) {
  return {
    type: "flex",
    altText: title,
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: title, weight: "bold", size: "lg", wrap: true },
          {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: fields.map((f) => ({
              type: "box",
              layout: "baseline",
              contents: [
                { type: "text", text: f.k, size: "sm", color: "#666666", flex: 3, wrap: true },
                { type: "text", text: f.v ?? "-", size: "sm", flex: 7, wrap: true },
              ],
            })),
          },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            action: { type: "postback", label: "同意", data: approveData, displayText: "同意" },
          },
          {
            type: "button",
            style: "secondary",
            action: { type: "postback", label: "拒絕", data: rejectData, displayText: "拒絕" },
          },
        ],
      },
    },
  };
}

async function getEmployeeByUserId(userId) {
  const snap = await db.collection("employees").where("userId", "==", userId).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { empKey: doc.id, ...doc.data() };
}

async function getApproverUserIds() {
  const snap = await db.collection("employees").where("canApprove", "==", true).get();
  const ids = [];
  snap.forEach((d) => {
    const data = d.data();
    if (data.userId && typeof data.userId === "string") ids.push(data.userId);
  });
  return Array.from(new Set(ids));
}

async function pushToApprovers(message) {
  const approverIds = await getApproverUserIds();
  await Promise.all(
    approverIds.map(async (uid) => {
      try {
        await client.pushMessage(uid, message);
      } catch (e) {
        console.error("❌ push fail", uid, e?.message || e);
      }
    })
  );
}

/* =========================
   Webhook
========================= */
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("❌ Webhook Error:", err);
    res.status(500).end();
  }
});

app.get("/", (req, res) => res.send("OK"));

/* =========================
   Event router
========================= */
async function handleEvent(event) {
  if (event.type === "message" && event.message.type === "text") return onText(event);
  if (event.type === "postback") return onPostback(event);
  return null;
}

/* =========================
   STAFF UI (極簡)
   - 打卡：上班/下班 -> 早/晚
   - 補打卡：指定日期申請制（可用 YYYY-MM-DD 或 12/10）
========================= */
async function replyClockMainMenu(replyToken) {
  return client.replyMessage(replyToken, {
    type: "text",
    text: "請選擇打卡類型：",
    quickReply: quickReply([
      postbackAction("上班", "CLK_STEP1|IN"),
      postbackAction("下班", "CLK_STEP1|OUT"),
    ]),
  });
}

async function replyClockShiftMenu(replyToken, inOut) {
  const label = inOut === "IN" ? "上班" : "下班";
  return client.replyMessage(replyToken, {
    type: "text",
    text: `請選擇班別（${label}）：`,
    quickReply: quickReply([
      postbackAction("早班", `CLK_STEP2|${inOut}|早`),
      postbackAction("晚班", `CLK_STEP2|${inOut}|晚`),
    ]),
  });
}

async function writeAttendanceOnce({ empKey, ymd, shiftLabel, inOut }) {
  const shiftKey = shiftKeyFromLabel(shiftLabel);
  const actionKey = inOut === "IN" ? "checkIn" : "checkOut";
  if (!shiftKey) throw new Error("BAD_SHIFT");

  const ref = db.collection("attendance").doc(attendanceDocId(empKey, ymd));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const base = snap.exists
      ? snap.data()
      : {
          date: ymd,
          empKey,
          shift: {
            morning: { checkIn: null, checkOut: null },
            night: { checkIn: null, checkOut: null },
          },
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

    // 確保結構存在
    base.shift = base.shift || {
      morning: { checkIn: null, checkOut: null },
      night: { checkIn: null, checkOut: null },
    };
    base.shift[shiftKey] = base.shift[shiftKey] || { checkIn: null, checkOut: null };

    if (base.shift[shiftKey][actionKey]) {
      throw new Error("ALREADY");
    }

    base.shift[shiftKey][actionKey] = nowTs();
    base.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    tx.set(ref, base, { merge: true });
  });
}

/* =========================
   補打卡（申請制）
   格式：補打卡 YYYY-MM-DD 早|晚 上班|下班 原因
         補打卡 12/10 早 上班 忘記打卡
========================= */
async function parseMakeupText(text) {
  // 補打卡 <date> <早|晚> <上班|下班> <reason...>
  const m = text.match(/^補打卡\s+(\S+)\s+(早|晚)\s+(上班|下班)\s+(.+)$/);
  if (!m) return null;

  const rawDate = m[1];
  const shiftLabel = m[2];
  const actLabel = m[3];
  const reason = m[4].trim();

  const ymd = parseDateInputToYMD(rawDate);
  if (!ymd || !isValidYMD(ymd)) return { error: "BAD_DATE" };

  const shiftKey = shiftKeyFromLabel(shiftLabel);
  const actionKey = actionKeyFromLabel(actLabel);
  if (!shiftKey || !actionKey) return { error: "BAD_SLOT" };

  // 不可未來
  const today = formatYMD(new Date());
  if (ymd > today) return { error: "FUTURE_DATE" };

  return { ymd, shiftLabel, shiftKey, actLabel, actionKey, reason };
}

async function slotAlreadyHasRecord(empKey, ymd, shiftKey, actionKey) {
  // 1) attendance already has record
  const attRef = db.collection("attendance").doc(attendanceDocId(empKey, ymd));
  const attSnap = await attRef.get();
  const attVal = attSnap.exists ? attSnap.data()?.shift?.[shiftKey]?.[actionKey] : null;
  if (attVal) return true;

  // 2) approved makeup already exists
  const q = await db
    .collection("makeupRequests")
    .where("empKey", "==", empKey)
    .where("date", "==", ymd)
    .where("shiftKey", "==", shiftKey)
    .where("actionKey", "==", actionKey)
    .where("status", "in", ["pending", "approved"])
    .limit(1)
    .get();
  return !q.empty;
}

async function createMakeupRequestAndNotify({ emp, ymd, shiftLabel, shiftKey, actLabel, actionKey, reason }) {
  // 防呆：已有紀錄就不建立申請
  const exists = await slotAlreadyHasRecord(emp.empKey, ymd, shiftKey, actionKey);
  if (exists) {
    return {
      type: "text",
      text: `⚠️ ${ymd} ${shiftLabel}班 ${actLabel} 已有紀錄或已有申請中/已核准\n不需要再補打卡。`,
    };
  }

  const reqRef = await db.collection("makeupRequests").add({
    empKey: emp.empKey,
    requesterUserId: emp.userId,
    date: ymd,
    shiftLabel,
    shiftKey,
    actLabel,
    actionKey,
    reason,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 推播給所有 canApprove（你之前反映沒收到，這裡是主動 push）
  const card = flexApprovalCard({
    title: "📝 補打卡申請",
    fields: [
      { k: "員工", v: emp.empKey },
      { k: "日期", v: ymd },
      { k: "項目", v: `${shiftLabel}班 ${actLabel}` },
      { k: "原因", v: reason },
      { k: "申請ID", v: reqRef.id },
    ],
    approveData: `MKP_DECIDE|APPROVE|${reqRef.id}`,
    rejectData: `MKP_DECIDE|REJECT|${reqRef.id}`,
  });
  await pushToApprovers(card);

  return { type: "text", text: `✅ 已送出補打卡申請（${reqRef.id}）\n等待核准者處理。` };
}

/* =========================
   管理層：制度性例外（不做 UI）
   指令：
   - 設定颱風 YYYY-MM-DD 半天|全天
   - 設定店休 YYYY-MM-DD 半天|全天
========================= */
async function handleWorkExceptionCommand(emp, text) {
  // 權限：只有 canApprove 才能設
  if (!emp?.canApprove) return null;

  const m = text.match(/^(設定颱風|設定店休)\s+(\S+)\s+(半天|全天)$/);
  if (!m) return null;

  const kind = m[1] === "設定颱風" ? "typhoon" : "store-close";
  const rawDate = m[2];
  const unit = m[3];

  const ymd = parseDateInputToYMD(rawDate);
  if (!ymd || !isValidYMD(ymd)) {
    return { type: "text", text: "❌ 日期格式錯誤，請用：設定颱風 2025-12-03 半天" };
  }

  const paidMinutes = unit === "半天" ? 270 : 540; // 你固定 540 分鐘/日
  const monthKey = ymdToMonthKey(ymd);

  const ref = db.collection("workExceptions").doc(monthKey);
  const fieldPath = ymd; // 用日期做欄位 key
  await ref.set(
    {
      [fieldPath]: {
        type: `${kind}-${unit === "半天" ? "half" : "full"}`,
        paidMinutes,
        scope: "all",
        note: kind === "typhoon" ? "颱風" : "店休",
        setBy: emp.empKey,
        setAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { type: "text", text: `✅ 已設定 ${ymd} 為「${m[1].replace("設定", "")}${unit}」（${paidMinutes} 分鐘）` };
}

/* =========================
   Approver：核准/拒絕 補打卡
========================= */
async function handleMakeupDecision(event, data) {
  const userId = event.source.userId;
  const approver = await getEmployeeByUserId(userId);
  if (!approver?.canApprove) {
    return client.replyMessage(event.replyToken, { type: "text", text: "❌ 你沒有核准權限。" });
  }

  const parts = data.split("|"); // MKP_DECIDE|APPROVE|requestId
  const action = parts[1];
  const requestId = parts[2];
  const reqRef = db.collection("makeupRequests").doc(requestId);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(reqRef);
      if (!snap.exists) throw new Error("NOT_FOUND");
      const req = snap.data();
      if (req.status !== "pending") throw new Error("ALREADY_DONE");

      if (action === "REJECT") {
        tx.update(reqRef, {
          status: "rejected",
          reviewedBy: approver.empKey,
          reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return;
      }

      // APPROVE：不回寫「真實打卡時間」，但可在 attendance 對應格做標記（不破壞架構）
      const attRef = db.collection("attendance").doc(attendanceDocId(req.empKey, req.date));
      const attSnap = await tx.get(attRef);

      const base = attSnap.exists
        ? attSnap.data()
        : {
            date: req.date,
            empKey: req.empKey,
            shift: {
              morning: { checkIn: null, checkOut: null },
              night: { checkIn: null, checkOut: null },
            },
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          };

      base.shift = base.shift || {
        morning: { checkIn: null, checkOut: null },
        night: { checkIn: null, checkOut: null },
      };
      base.shift[req.shiftKey] = base.shift[req.shiftKey] || { checkIn: null, checkOut: null };

      // 若原本無值，才補一個 timestamp（代表已核准補登）
      if (!base.shift[req.shiftKey][req.actionKey]) {
        base.shift[req.shiftKey][req.actionKey] = nowTs();
      }

      // 另外加 meta（不破壞你既有 shift 結構）
      base.makeupMeta = base.makeupMeta || {};
      const metaKey = `${req.date}|${req.shiftKey}|${req.actionKey}`;
      base.makeupMeta[metaKey] = {
        approved: true,
        requestId,
        approvedBy: approver.empKey,
      };

      base.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      tx.set(attRef, base, { merge: true });

      tx.update(reqRef, {
        status: "approved",
        reviewedBy: approver.empKey,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return client.replyMessage(event.replyToken, { type: "text", text: "✅ 已核准補打卡" });
  } catch (err) {
    if (String(err?.message || "").includes("ALREADY_DONE")) {
      return client.replyMessage(event.replyToken, { type: "text", text: "⚠️ 此申請已被其他人處理" });
    }
    console.error("❌ makeup decision error", err);
    return client.replyMessage(event.replyToken, { type: "text", text: "❌ 處理失敗，請稍後再試" });
  }
}

/* =========================
   Postback handler
========================= */
async function onPostback(event) {
  const data = event.postback.data || "";
  const userId = event.source.userId;
  const emp = await getEmployeeByUserId(userId);

  if (!emp) {
    return client.replyMessage(event.replyToken, { type: "text", text: "你尚未註冊/綁定，請找管理者處理。" });
  }

  // 打卡：第一層
  if (data === "CLK_STEP1|IN") return replyClockShiftMenu(event.replyToken, "IN");
  if (data === "CLK_STEP1|OUT") return replyClockShiftMenu(event.replyToken, "OUT");

  // 打卡：第二層（寫入）
  if (data.startsWith("CLK_STEP2|")) {
    const parts = data.split("|"); // CLK_STEP2|IN|早
    const inOut = parts[1];
    const shiftLabel = parts[2];
    const today = formatYMD(new Date());

    try {
      await writeAttendanceOnce({ empKey: emp.empKey, ymd: today, shiftLabel, inOut });
      const actionLabel = inOut === "IN" ? "上班" : "下班";
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: `✅ ${today} ${shiftLabel}班 ${actionLabel} 打卡成功`,
      });
    } catch (e) {
      if (String(e?.message || "").includes("ALREADY")) {
        const actionLabel = inOut === "IN" ? "上班" : "下班";
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: `⚠️ ${today} ${shiftLabel}班 ${actionLabel} 已打過卡`,
        });
      }
      console.error("❌ clock error", e);
      return client.replyMessage(event.replyToken, { type: "text", text: "❌ 打卡失敗，請稍後再試。" });
    }
  }

  // 補打卡核准/拒絕
  if (data.startsWith("MKP_DECIDE|")) return handleMakeupDecision(event, data);

  return client.replyMessage(event.replyToken, { type: "text", text: "未識別的操作。" });
}

/* =========================
   Text handler
========================= */
async function onText(event) {
  const userId = event.source.userId;
  const text = (event.message.text || "").trim();
  const emp = await getEmployeeByUserId(userId);

  if (!emp) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "你尚未綁定員工資料（employees）。\n請由管理者在 Firestore 設定你的 userId。",
    });
  }

  // 管理層：設定颱風/店休（不做 UI）
  const exceptionMsg = await handleWorkExceptionCommand(emp, text);
  if (exceptionMsg) return client.replyMessage(event.replyToken, exceptionMsg);

  // staff：打卡（可由 Rich Menu 直接送出「打卡」）
  if (text === "打卡") return replyClockMainMenu(event.replyToken);

  // staff：如果 Rich Menu 想做兩顆鍵「上班」「下班」，也支援
  if (text === "上班") return replyClockShiftMenu(event.replyToken, "IN");
  if (text === "下班") return replyClockShiftMenu(event.replyToken, "OUT");

  // staff：補打卡（申請）
  if (text === "補打卡") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "請用格式：\n" +
        "補打卡 YYYY-MM-DD 早|晚 上班|下班 原因\n" +
        "例如：補打卡 2025-12-10 早 上班 忘記打卡\n" +
        "也可用：補打卡 12/10 早 上班 忘記打卡",
    });
  }

  // staff：補打卡（完整格式）
  if (text.startsWith("補打卡")) {
    const parsed = await parseMakeupText(text);
    if (!parsed) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "❌ 格式錯誤\n" +
          "請用：補打卡 YYYY-MM-DD 早|晚 上班|下班 原因\n" +
          "例如：補打卡 2025-12-10 早 上班 忘記打卡",
      });
    }
    if (parsed.error === "BAD_DATE") {
      return client.replyMessage(event.replyToken, { type: "text", text: "❌ 日期格式錯誤，請用 2025-12-10 或 12/10" });
    }
    if (parsed.error === "FUTURE_DATE") {
      return client.replyMessage(event.replyToken, { type: "text", text: "❌ 不可申請未來日期的補打卡" });
    }

    const msg = await createMakeupRequestAndNotify({
      emp,
      ymd: parsed.ymd,
      shiftLabel: parsed.shiftLabel,
      shiftKey: parsed.shiftKey,
      actLabel: parsed.actLabel,
      actionKey: parsed.actionKey,
      reason: parsed.reason,
    });
    return client.replyMessage(event.replyToken, msg);
  }

  // 借支（目前先關）
  if (text.startsWith("借支")) {
    if (!FEATURES.ENABLE_ADVANCE) {
      return client.replyMessage(event.replyToken, { type: "text", text: "（借支功能尚未啟用）" });
    }
  }

  // 預設提示（極簡）
  return client.replyMessage(event.replyToken, {
    type: "text",
    text:
      "可用指令：\n" +
      "1) 打卡（或直接點 Rich Menu 上班/下班）\n" +
      "2) 補打卡（申請制）\n" +
      "管理層指令：設定颱風/設定店休 YYYY-MM-DD 半天|全天",
  });
}

/* =========================
   Start server
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
