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

// 🔴 給 LIFF API 用
app.use(express.json());

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

/* ================= 工具 ================= */

const reply = (event, msg) =>
  client.replyMessage(event.replyToken, msg);

const todayISO = () => new Date().toISOString().slice(0, 10);

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

/* ================= LINE Webhook（原本功能保留） ================= */

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const text = event.message.text.trim();
  const userId = event.source.userId;

  const emp = await getEmployee(userId);
  if (!emp)
    return reply(event, {
      type: "text",
      text: "❌ 尚未註冊\n請輸入：註冊 A001",
    });

  // 聊天室仍可用打卡（保留）
  if (text === "上班") return handleClockLegacy(event, emp, "in");
  if (text === "下班") return handleClockLegacy(event, emp, "out");

  return reply(event, { type: "text", text: "請使用選單操作" });
}

async function handleClockLegacy(event, emp, type) {
  const map = {
    in: ["morning", "checkIn"],
    out: ["morning", "checkOut"],
  };

  const [shift, action] = map[type];
  const date = todayISO();

  const ref = db.collection("attendance").doc(`${emp.empKey}_${date}`);
  await ref.set(
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

/* ================= 🔥 LIFF API（新增） ================= */

/**
 * 員工打卡 API
 * POST /api/clock
 * body: { userId, type: "in" | "out" }
 */
app.post("/api/clock", async (req, res) => {
  try {
    const { userId, type } = req.body;
    if (!userId || !type) {
      return res.status(400).json({ ok: false });
    }

    const emp = await getEmployee(userId);
    if (!emp) {
      return res.status(403).json({ ok: false, msg: "not registered" });
    }

    const map = {
      in: ["morning", "checkIn"],
      out: ["morning", "checkOut"],
    };

    const [shift, action] = map[type];
    const date = todayISO();

    const ref = db.collection("attendance").doc(`${emp.empKey}_${date}`);
    await ref.set(
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

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

/**
 * 補打卡申請
 * POST /api/makeup/apply
 */
app.post("/api/makeup/apply", async (req, res) => {
  try {
    const { userId, date, shift, action, reason } = req.body;
    const emp = await getEmployee(userId);
    if (!emp) return res.status(403).json({ ok: false });

    await db.collection("makeupRequests").add({
      empKey: emp.empKey,
      requesterUserId: userId,
      date,
      shift,
      action,
      reason,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

/**
 * 管理員核准 / 退回
 * POST /api/makeup/decision
 */
app.post("/api/makeup/decision", async (req, res) => {
  try {
    const { userId, id, decision } = req.body;
    const emp = await getEmployee(userId);
    if (!emp || !emp.canApprove)
      return res.status(403).json({ ok: false });

    const ref = db.collection("makeupRequests").doc(id);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("not found");
      tx.update(ref, {
        status: decision,
        reviewedBy: emp.empKey,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

/* ================= Server ================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
