require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const admin = require("firebase-admin");

// ================= LINE =================
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);
const app = express();

// ================= Firebase =================
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});
const db = admin.firestore();

// ================= Utils =================
const reply = (token, text) =>
  client.replyMessage(token, { type: "text", text });

const todayStr = () => new Date().toISOString().slice(0, 10);

// ================= DB helpers =================
async function isEngineer(userId) {
  const d = await db.collection("systemAdmins").doc(userId).get();
  return d.exists && d.data().canImpersonate === true;
}

async function getSession(userId) {
  const d = await db.collection("sessions").doc(userId).get();
  return d.exists ? d.data() : {};
}

async function setSession(userId, data) {
  await db.collection("sessions").doc(userId).set(
    {
      ...data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function clearSession(userId) {
  await db.collection("sessions").doc(userId).delete().catch(() => {});
}

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

async function getEmployeeByEmpNo(empNo) {
  const d = await db.collection("employees").doc(empNo).get();
  return d.exists ? { empNo: d.id, ...d.data() } : null;
}

// ================= Webhook =================
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error("Webhook error", e);
    res.status(500).end();
  }
});

// ================= Main =================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  
  console.log("🔥 REAL userId =", event.source.userId); 
  const userId = event.source.userId;
  const text = event.message.text.trim();
  const token = event.replyToken;
  const args = text.split(" ");

  // ======================================================
  // ① 工程師 HARD-OVERRIDE（最優先，完全獨立）
  // ======================================================
  const engineer = await isEngineer(userId);
  if (engineer) {
    // 工程師指令「只要命中就 return」，不往下跑
    if (text.replace(/\s/g, "") === "工程師模式") {
      const s = await getSession(userId);
      return reply(
        token,
        [
          "🧑‍💻 工程師模式（系統）",
          s.impersonateEmpNo
            ? `目前模擬：${s.impersonateEmpNo}`
            : "目前：工程師本體",
          "",
          "可用指令：",
          "模擬員工 A003",
          "模擬老闆 A001",
          "目前身分",
          "退出模擬",
        ].join("\n")
      );
    }

    if (text.replace(/\s/g, "") === "目前身分") {
      const s = await getSession(userId);
      if (!s.impersonateEmpNo) {
        return reply(token, "🧑‍💻 目前身分：工程師本體");
      }
      const emp = await getEmployeeByEmpNo(s.impersonateEmpNo);
      return reply(
        token,
        `🧪 目前模擬：${emp.empNo}（${emp.role}）`
      );
    }

    if (text.replace(/\s/g, "").startsWith("模擬員工")) {
      const empNo = args[1];
      const emp = await getEmployeeByEmpNo(empNo);
      if (!emp || emp.role !== "staff") {
        return reply(token, "❌ 找不到員工或身分不是員工");
      }
      await setSession(userId, { impersonateEmpNo: empNo });
      return reply(token, `✅ 已模擬員工 ${empNo}`);
    }

    if (text.replace(/\s/g, "").startsWith("模擬老闆")) {
      const empNo = args[1];
      const emp = await getEmployeeByEmpNo(empNo);
      if (!emp || emp.role !== "admin") {
        return reply(token, "❌ 找不到老闆身分");
      }
      await setSession(userId, { impersonateEmpNo: empNo });
      return reply(token, `✅ 已模擬老闆 ${empNo}`);
    }

    if (text.replace(/\s/g, "") === "退出模擬") {
      await clearSession(userId);
      return reply(token, "✅ 已退出模擬，回到工程師本體");
    }
    // ⚠️ 工程師但不是工程師指令 → 繼續往下（模擬用）
  }

  // ======================================================
  // ② 決定「實際操作身分」
  // ======================================================
  let employee = null;
  let impersonated = false;

  if (engineer) {
    const s = await getSession(userId);
    if (!s.impersonateEmpNo) {
      return reply(
        token,
        "🧑‍💻 你是工程師，請先輸入「工程師模式」並模擬身分"
      );
    }
    employee = await getEmployeeByEmpNo(s.impersonateEmpNo);
    impersonated = true;
  } else {
    employee = await getEmployeeByUserId(userId);
  }

  if (!employee) {
    return reply(token, "尚未註冊身分");
  }

  // ======================================================
  // ③ 老闆模式
  // ======================================================
  if (employee.role === "admin") {
    if (text === "老闆") {
      return reply(
        token,
        [
          "👑 老闆模式",
          impersonated ? "（工程師模擬）" : "",
          "",
          "指令：",
          "新增員工 A002 小明",
          "設定早班 A001 2025-12-12 10:00 14:30",
          "設定晚班 A001 2025-12-12 17:00 21:30",
          "補打卡列表",
        ].join("\n")
      );
    }
    return reply(token, "老闆指令不正確，輸入：老闆");
  }

  // ======================================================
  // ④ 員工模式
  // ======================================================
  if (text === "今日") {
    return reply(
      token,
      `📋 今日 ${todayStr()}\n員工：${employee.empNo}${
        impersonated ? "（工程師模擬）" : ""
      }`
    );
  }

  return reply(
    token,
    [
      "員工指令：",
      "今日",
      "早班上班 / 早班下班",
      "晚班上班 / 晚班下班",
    ].join("\n")
  );
}

// ================= Server =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("🔥 ENGINEER HARD OVERRIDE VERSION v1");
});
