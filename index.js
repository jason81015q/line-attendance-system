require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const admin = require("firebase-admin");

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
const reply = (token, message) => client.replyMessage(token, message);

const normalizeText = (raw = "") =>
  raw.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

const todayStr = () => new Date().toISOString().slice(0, 10);

/* ================= Helpers ================= */
async function getEmployeeByUserId(userId) {
  const q = await db
    .collection("employees")
    .where("userId", "==", userId)
    .limit(1)
    .get();
  if (q.empty) return null;
  const d = q.docs[0];
  return { empNo: d.id, ...d.data() };
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
    },
    { merge: true }
  );
  return ref;
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
  const token = event.replyToken;
  const text = normalizeText(event.message.text);

  const employee = await getEmployeeByUserId(userId);
  if (!employee) {
    return reply(token, { type: "text", text: "❌ 尚未註冊身分" });
  }

  /* =====================================================
     員工端：補打卡申請
     ===================================================== */
  if (employee.role === "staff") {
    // 入口
    if (text === "補打卡") {
      return reply(token, {
        type: "text",
        text: "📌 請選擇補打卡班別",
        quickReply: {
          items: [
            { type: "action", action: { type: "message", label: "早班", text: "補早班" } },
            { type: "action", action: { type: "message", label: "晚班", text: "補晚班" } },
          ],
        },
      });
    }

    if (text === "補早班" || text === "補晚班") {
      const shift = text === "補早班" ? "morning" : "night";
      await db.collection("sessions").doc(userId).set(
        { makeupShift: shift },
        { merge: true }
      );

      return reply(token, {
        type: "text",
        text: "請選擇補打卡類型",
        quickReply: {
          items: [
            { type: "action", action: { type: "message", label: "上班", text: "補上班" } },
            { type: "action", action: { type: "message", label: "下班", text: "補下班" } },
          ],
        },
      });
    }

    if (text === "補上班" || text === "補下班") {
      const type = text === "補上班" ? "checkIn" : "checkOut";
      await db.collection("sessions").doc(userId).set(
        { makeupType: type },
        { merge: true }
      );

      return reply(token, {
        type: "text",
        text: "✏️ 請輸入補打卡原因（一句話即可）",
      });
    }

    // 原因輸入
    const sessionSnap = await db.collection("sessions").doc(userId).get();
    const session = sessionSnap.exists ? sessionSnap.data() : {};

    if (session.makeupShift && session.makeupType) {
      await db.collection("makeupRequests").add({
        empNo: employee.empNo,
        date: todayStr(),
        shift: session.makeupShift,
        type: session.makeupType,
        reason: text,
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await db.collection("sessions").doc(userId).delete();

      return reply(token, {
        type: "text",
        text: "✅ 補打卡申請已送出，等待老闆確認",
      });
    }

    return reply(token, {
      type: "text",
      text: "請輸入「補打卡」開始流程",
    });
  }

  /* =====================================================
     老闆端：審核補打卡
     ===================================================== */
  if (employee.role === "admin") {
    if (text === "補打卡申請") {
      const q = await db
        .collection("makeupRequests")
        .where("status", "==", "pending")
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

      if (q.empty) {
        return reply(token, { type: "text", text: "目前沒有補打卡申請" });
      }

      const d = q.docs[0];
      const r = d.data();

      await db.collection("sessions").doc(userId).set(
        { reviewRequestId: d.id },
        { merge: true }
      );

      return reply(token, {
        type: "text",
        text: `📄 補打卡申請\n員工：${r.empNo}\n班別：${r.shift}\n類型：${r.type}\n原因：${r.reason}`,
        quickReply: {
          items: [
            { type: "action", action: { type: "message", label: "同意", text: "同意補打卡" } },
            { type: "action", action: { type: "message", label: "拒絕", text: "拒絕補打卡" } },
          ],
        },
      });
    }

    if (text === "同意補打卡" || text === "拒絕補打卡") {
      const s = await db.collection("sessions").doc(userId).get();
      if (!s.exists || !s.data().reviewRequestId) {
        return reply(token, { type: "text", text: "❌ 找不到審核中的申請" });
      }

      const reqId = s.data().reviewRequestId;
      const ref = db.collection("makeupRequests").doc(reqId);
      const snap = await ref.get();
      if (!snap.exists) {
        return reply(token, { type: "text", text: "❌ 申請不存在" });
      }

      const r = snap.data();

      if (text === "同意補打卡") {
        const attRef = await ensureAttendance(r.empNo, r.date);
        await attRef.update({
          [`shift.${r.shift}.${r.type}`]:
            admin.firestore.FieldValue.serverTimestamp(),
        });

        await ref.update({
          status: "approved",
          reviewedBy: employee.empNo,
          reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await db.collection("sessions").doc(userId).delete();

        return reply(token, { type: "text", text: "✅ 已同意並補打卡完成" });
      }

      await ref.update({
        status: "rejected",
        reviewedBy: employee.empNo,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await db.collection("sessions").doc(userId).delete();

      return reply(token, { type: "text", text: "❌ 已拒絕補打卡" });
    }

    return reply(token, {
      type: "text",
      text: "老闆指令：\n補打卡申請",
    });
  }
}

/* ================= Server ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  console.log("🟢 MAKEUP FLOW READY");
});
