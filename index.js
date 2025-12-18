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

/* ================= Rich Menu ID ================= */

const RM_ENTRY = process.env.RICH_MENU_ENTRY;
const RM_STAFF = process.env.RICH_MENU_STAFF;
const RM_APPROVER = process.env.RICH_MENU_APPROVER;
const RM_ADMIN = process.env.RICH_MENU_ADMIN;

/* ================= 工具 ================= */

const reply = (event, msg) =>
  client.replyMessage(event.replyToken, msg);

const todayISO = () => new Date().toISOString().slice(0, 10);

function qr(text) {
  return { type: "action", action: { type: "message", label: text, text } };
}

/* ================= Firebase ================= */

async function getEmployee(userId) {
  const snap = await db
    .collection("employees")
    .where("userId", "==", userId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { empKey: doc.id, ...doc.data() };
}

/* ================= Rich Menu 分流 ================= */

async function applyRichMenuByRole(userId, emp) {
  let richMenuId = RM_STAFF;

  if (emp.role === "admin") {
    richMenuId = RM_ADMIN;
  } else if (emp.role === "staff" && emp.canApprove === "true") {
    richMenuId = RM_APPROVER;
  }

  await client.linkRichMenuToUser(userId, richMenuId);
}

/* ================= 權限 ================= */

function canApproveMakeup(emp) {
  return emp.role === "admin" || emp.canApprove === "true";
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

  /* ===== 註冊流程（一定要在最前面） ===== */
  if (text.startsWith("註冊")) {
    const empKey = text.replace("註冊", "").trim();
    const ref = db.collection("employees").doc(empKey);
    const snap = await ref.get();

    if (!snap.exists) {
      return reply(event, {
        type: "text",
        text: "❌ 查無此員工代號，請確認後再試",
      });
    }

    const data = snap.data();
    if (data.userId) {
      return reply(event, {
        type: "text",
        text: "⚠️ 此代號已被註冊，請聯絡管理員",
      });
    }

    await ref.update({
      userId,
      boundAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await applyRichMenuByRole(userId, { empKey, ...data });

    return reply(event, {
      type: "text",
      text: `✅ 註冊完成，歡迎 ${data.displayName}`,
    });
  }

  /* ===== 查員工 ===== */

  const emp = await getEmployee(userId);

  if (!emp) {
    if (RM_ENTRY) {
      await client.linkRichMenuToUser(userId, RM_ENTRY);
    }
    return reply(event, {
      type: "text",
      text: "❌ 尚未註冊\n請輸入：註冊 A001",
    });
  }

  await applyRichMenuByRole(userId, emp);

  /* ================= 打卡 ================= */

  if (text === "CLOCK") {
    return reply(event, {
      type: "text",
      text: "請選擇打卡類型",
      quickReply: {
        items: [
          qr("早班上班"),
          qr("早班下班"),
          qr("晚班上班"),
          qr("晚班下班"),
        ],
      },
    });
  }

  if (["早班上班", "早班下班", "晚班上班", "晚班下班"].includes(text)) {
    return handleClock(event, emp, text);
  }

  /* ================= 補打卡 ================= */

  if (text === "MAKEUP_APPLY") return startMakeupFlow(event);

  if (text.startsWith("MAKEUP_DATE|")) return selectMakeupDate(event, text);
  if (text.startsWith("MAKEUP_SHIFT|")) return selectMakeupShift(event, text);
  if (text.startsWith("MAKEUP_ACTION|")) return selectMakeupAction(event, text);
  if (text.startsWith("MAKEUP_REASON|")) return submitMakeup(event, emp, text);

  /* ================= 核准 ================= */

  if (text.startsWith("MAKEUP|")) return handleMakeupDecision(event, emp, text);

  return null;
}

/* ================= 打卡 ================= */

async function handleClock(event, emp, text) {
  const map = {
    "早班上班": ["morning", "checkIn"],
    "早班下班": ["morning", "checkOut"],
    "晚班上班": ["night", "checkIn"],
    "晚班下班": ["night", "checkOut"],
  };

  const [shift, action] = map[text];
  const date = todayISO();

  await db
    .collection("attendance")
    .doc(`${emp.empKey}_${date}`)
    .set(
      {
        empKey: emp.empKey,
        date,
        shift: {
          [shift]: {
            [action]: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
      },
      { merge: true }
    );

  return reply(event, { type: "text", text: "✅ 打卡成功" });
}

/* ================= 補打卡流程 ================= */

async function startMakeupFlow(event) {
  const dates = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  return reply(event, {
    type: "text",
    text: "請選擇要補打卡的日期",
    quickReply: { items: dates.map((d) => qr(`MAKEUP_DATE|${d}`)) },
  });
}

async function selectMakeupDate(event, text) {
  const date = text.split("|")[1];
  return reply(event, {
    type: "text",
    text: `補打卡日期：${date}`,
    quickReply: {
      items: [
        qr(`MAKEUP_SHIFT|${date}|morning`),
        qr(`MAKEUP_SHIFT|${date}|night`),
      ],
    },
  });
}

async function selectMakeupShift(event, text) {
  const [, date, shift] = text.split("|");
  return reply(event, {
    type: "text",
    text: "請選擇動作",
    quickReply: {
      items: [
        qr(`MAKEUP_ACTION|${date}|${shift}|checkIn`),
        qr(`MAKEUP_ACTION|${date}|${shift}|checkOut`),
      ],
    },
  });
}

async function selectMakeupAction(event, text) {
  const [, date, shift, action] = text.split("|");
  return reply(event, {
    type: "text",
    text: "請輸入補打卡原因",
    quickReply: {
      items: [qr(`MAKEUP_REASON|${date}|${shift}|${action}`)],
    },
  });
}

async function submitMakeup(event, emp, text) {
  const [, date, shift, action] = text.split("|");
  const reason = event.message.text.replace(text, "").trim();

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

  await notifyApprovers(emp, date, shift, action, reason, ref.id);

  return reply(event, { type: "text", text: "📨 已送出補打卡申請" });
}

/* ================= 核准 ================= */

async function notifyApprovers(emp, date, shift, action, reason, id) {
  const snap = await db.collection("employees").get();

  for (const doc of snap.docs) {
    const u = doc.data();
    if (!u.userId) continue;
    if (!(u.role === "admin" || u.canApprove === "true")) continue;

    await client.pushMessage(u.userId, {
      type: "text",
      text:
        `📌 補打卡申請\n員工：${emp.empKey}\n日期：${date}\n班別：${shift}\n動作：${action}\n原因：${reason}`,
      quickReply: {
        items: [
          qr(`MAKEUP|APPROVE|${id}`),
          qr(`MAKEUP|REJECT|${id}`),
        ],
      },
    });
  }
}

async function handleMakeupDecision(event, emp, text) {
  if (!canApproveMakeup(emp))
    return reply(event, { type: "text", text: "❌ 無權限" });

  const [, action, id] = text.split("|");
  const ref = db.collection("makeupRequests").doc(id);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const req = snap.data();
    if (req.status !== "pending") throw new Error();

    tx.update(ref, {
      status: action === "APPROVE" ? "approved" : "rejected",
      reviewedBy: emp.empKey,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return reply(event, { type: "text", text: "✅ 已處理" });
}

/* ================= Server ================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
