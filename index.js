require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const admin = require("firebase-admin");

/* ================= 基本設定 ================= */

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const app = express();
const client = new line.Client(config);

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

/* ================= 工具 ================= */

const reply = (event, text) =>
  client.replyMessage(event.replyToken, { type: "text", text });

const toBool = (v) =>
  v === true || (typeof v === "string" && v.toLowerCase() === "true");

const todayISO = () => {
  const d = new Date();
  return d.toISOString().slice(0, 10);
};

async function getEmployee(userId) {
  const snap = await db
    .collection("employees")
    .where("userId", "==", userId)
    .limit(1)
    .get();
  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data();
  return {
    empKey: doc.id,
    ...data,
    canApprove: toBool(data.canApprove),
    role: data.role || "staff",
  };
}

async function linkMenu(userId, menuId) {
  if (menuId) await client.linkRichMenuToUser(userId, menuId);
}

/* ================= Webhook ================= */

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

/* ================= 主流程 ================= */

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  const userId = event.source.userId;

  /* -------- 註冊 -------- */
  if (text.startsWith("註冊")) {
    const empKey = text.replace("註冊", "").trim();
    const ref = db.collection("employees").doc(empKey);
    const snap = await ref.get();

    if (!snap.exists) return reply(event, "❌ 員工編號不存在");
    if (snap.data().userId)
      return reply(event, "⚠️ 此編號已被綁定");

    await ref.update({
      userId,
      boundAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const emp = await getEmployee(userId);

    if (emp.role === "admin") {
      await linkMenu(userId, process.env.ADMIN_RICHMENU_ID);
    } else if (emp.canApprove) {
      await linkMenu(userId, process.env.HYBRID_RICHMENU_ID);
    } else {
      await linkMenu(userId, process.env.STAFF_RICHMENU_ID);
    }

    return reply(event, "✅ 註冊成功，已套用對應操作介面");
  }

  const emp = await getEmployee(userId);
  if (!emp)
    return reply(event, "❌ 尚未註冊，請輸入：註冊 A001");

  /* -------- Rich Menu Codes -------- */

  if (text === "CLOCK") {
    return reply(
      event,
      "請輸入：\n早班上班 / 早班下班 / 晚班上班 / 晚班下班"
    );
  }

  if (
    ["早班上班", "早班下班", "晚班上班", "晚班下班"].includes(text)
  ) {
    return handleClock(event, emp, text);
  }

  if (text === "MAKEUP_APPLY") {
    return reply(
      event,
      "請輸入：\n補打卡 YYYY-MM-DD 早班/晚班 上班/下班 原因"
    );
  }

  if (text.startsWith("補打卡 ")) {
    return handleMakeupApply(event, emp, text);
  }

  if (text === "MAKEUP_ADMIN") {
    if (!emp.canApprove) return reply(event, "❌ 無核准權限");
    return reply(
      event,
      "系統會在有申請時主動通知你\n請點通知內的核准指令"
    );
  }

  if (text.startsWith("MAKEUP|")) {
    return handleMakeupDecision(event, emp, text);
  }

  if (text === "SET_EXCEPTION") {
    if (!emp.canApprove) return reply(event, "❌ 無權限");
    return reply(
      event,
      "請輸入：\n例外 YYYY-MM-DD 類型\n例：例外 2025-12-31 颱風半天"
    );
  }

  if (text.startsWith("例外 ")) {
    return handleException(event, emp, text);
  }

  return reply(event, "❓ 無法識別的指令");
}

/* ================= 打卡 ================= */

async function handleClock(event, emp, text) {
  const shift = text.startsWith("早班") ? "morning" : "night";
  const action = text.endsWith("上班") ? "checkIn" : "checkOut";
  const date = todayISO();
  const docId = `${emp.empKey}_${date}`;
  const ref = db.collection("attendance").doc(docId);

  const snap = await ref.get();
  const base =
    snap.exists
      ? snap.data()
      : {
          empKey: emp.empKey,
          date,
          shift: {
            morning: { checkIn: null, checkOut: null },
            night: { checkIn: null, checkOut: null },
          },
        };

  if (base.shift[shift][action])
    return reply(event, "⚠️ 已打過卡");

  base.shift[shift][action] =
    admin.firestore.FieldValue.serverTimestamp();

  await ref.set(base, { merge: true });
  return reply(event, "✅ 打卡成功");
}

/* ================= 補打卡 ================= */

async function handleMakeupApply(event, emp, text) {
  const [, date, shiftText, actText, ...rest] = text.split(" ");
  const reason = rest.join(" ");

  const shift =
    shiftText === "早班" ? "morning" : shiftText === "晚班" ? "night" : null;
  const action =
    actText === "上班" ? "checkIn" : actText === "下班" ? "checkOut" : null;

  if (!shift || !action || !reason)
    return reply(event, "❌ 格式錯誤");

  const ref = await db.collection("makeupRequests").add({
    empKey: emp.empKey,
    requesterUserId: emp.userId,
    date,
    shift,
    action,
    reason,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await notifyApprovers(emp, date, shiftText, actText, reason, ref.id);
  return reply(event, "📨 已送出補打卡申請");
}

async function notifyApprovers(emp, date, shift, action, reason, id) {
  const snap = await db
    .collection("employees")
    .where("canApprove", "==", true)
    .get();

  for (const doc of snap.docs) {
    const u = doc.data().userId;
    if (!u) continue;

    await client.pushMessage(u, {
      type: "text",
      text:
        `📌 補打卡申請\n員工：${emp.empKey}\n日期：${date}\n班別：${shift}\n動作：${action}\n原因：${reason}\n\n` +
        `同意：MAKEUP|APPROVE|${id}\n拒絕：MAKEUP|REJECT|${id}`,
    });
  }
}

async function handleMakeupDecision(event, emp, text) {
  if (!emp.canApprove) return reply(event, "❌ 無權限");

  const [, action, id] = text.split("|");
  const ref = db.collection("makeupRequests").doc(id);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw "NOT_FOUND";
      const req = snap.data();
      if (req.status !== "pending") throw "DONE";
      if (req.requesterUserId === emp.userId) throw "SELF";

      tx.update(ref, {
        status: action === "APPROVE" ? "approved" : "rejected",
        reviewedBy: emp.empKey,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return reply(event, "✅ 已處理");
  } catch {
    return reply(event, "❌ 無法處理此申請");
  }
}

/* ================= 例外 ================= */

async function handleException(event, emp, text) {
  if (!emp.canApprove) return reply(event, "❌ 無權限");

  const [, date, ...rest] = text.split(" ");
  const type = rest.join(" ");
  const id = `${date}_${type}`;

  const ref = db.collection("workExceptions").doc(id);
  if ((await ref.get()).exists)
    return reply(event, "⚠️ 已設定過");

  await ref.set({
    date,
    type,
    createdBy: emp.empKey,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return reply(event, "✅ 已設定例外");
}

/* ================= Server ================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
