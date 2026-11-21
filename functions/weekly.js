// VV DOUBLE · 門市營運中心「店長週報」→ LINE（只推給設定的那一位）
// 店長在 vvdouble-store 提交週報 → 這裡讀那邊的資料庫 → 用同一個 LINE 官方帳號推播
// 內容由這裡自己從資料庫讀，不收外部傳進來的文字，所以沒辦法被拿來亂發訊息。

const STORE_DB = "https://vvdouble-store-default-rtdb.asia-southeast1.firebasedatabase.app";

const STORES = {
  zhongxiao: "台北忠孝旗艦",
  tongyi: "統一門市",
  taoyuan: "桃園 ATT",
  yizhong: "一中門市",
  xinyizhong: "台中新一中",
  xintiandi: "台南門市",
  xinjuejiang: "高雄門市",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECENT_MS = 24 * 3600000; // 巡檢只補推 24 小時內提交的，避免把舊週報一次倒出來

// ---------- 日期（一律用 UTC 算，避免時區位移） ----------
function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function isMonday(dateStr) {
  if (!DATE_RE.test(dateStr)) return false;
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10) === dateStr && dt.getUTCDay() === 1;
}
function weekLabel(monday) {
  const sun = shiftDate(monday, 6);
  const a = monday.split("-"), b = sun.split("-");
  return `${parseInt(a[1])}/${parseInt(a[2])} - ${parseInt(b[1])}/${parseInt(b[2])}`;
}
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function twTime(ts) {
  const d = new Date(Number(ts) + 8 * 3600000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
const money = (n) => "$" + Math.round(n).toLocaleString("en-US");

// ---------- 數字（算法跟門市營運中心「週報詳情」同一套） ----------
function weekNumbers(monday, thisLogs, lastLogs, monthTarget) {
  const sum = (logs) => {
    let sales = 0, customers = 0;
    Object.values(logs || {}).forEach((l) => {
      if (l && l.sales) { sales += Number(l.sales) || 0; customers += Number(l.customers || 0) || 0; }
    });
    return { sales, customers };
  };
  const t = sum(thisLogs), l = sum(lastLogs);
  let rate = null;
  if (Number(monthTarget) > 0) {
    const [y, m] = monday.split("-").map(Number);
    const weekTarget = (Number(monthTarget) / daysInMonth(y, m)) * 7;
    rate = weekTarget > 0 ? (t.sales / weekTarget) * 100 : null;
  }
  const vsLast = l.sales > 0 ? ((t.sales - l.sales) / l.sales) * 100 : null;
  const avg = t.customers > 0 ? Math.round(t.sales / t.customers) : null;
  return { sales: t.sales, rate, vsLast, avg };
}

function formatWeekly(storeId, monday, report, nums) {
  const by = report._firstSubmittedBy || report._modifiedBy || "";
  const at = report._firstSubmittedAt || report._lastModified;
  const lines = [`週報已提交｜${STORES[storeId] || storeId}`, `${weekLabel(monday)}${by ? "　" + by : ""}`];
  if (at) lines.push(`提交時間 ${twTime(at)}`);
  lines.push("");
  lines.push(`本週業績 ${money(nums.sales)}${nums.rate !== null ? `（達成 ${nums.rate.toFixed(0)}%）` : ""}`);
  if (nums.vsLast !== null) lines.push(`較上週 ${nums.vsLast >= 0 ? "+" : ""}${nums.vsLast.toFixed(0)}%`);
  if (nums.avg !== null) lines.push(`客單價 ${money(nums.avg)}`);
  const sec = (title, v) => { lines.push("", `【${title}】`, String(v || "").trim() || "未填寫"); };
  sec("員工狀態", report.staffStatus);
  sec("趨勢觀察", report.insights);
  sec("下週重點", report.nextWeekFocus);
  sec("給總部的話", report.messageToHQ || "無");
  return lines.join("\n");
}

// LINE 一則文字上限 5000 字，一次推播最多 5 則（算 1 則額度）。全文照發、不截斷。
function splitText(text, size = 4500) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

// ---------- 讀門市營運中心的資料庫（已上鎖，用服務帳號讀） ----------
let dbAuth = null;
let tokenProvider = async () => {
  if (!dbAuth) {
    const { GoogleAuth } = require("google-auth-library");
    dbAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/firebase.database", "https://www.googleapis.com/auth/userinfo.email"] });
  }
  return dbAuth.getAccessToken();
};
function setTokenProvider(fn) { tokenProvider = fn; }
async function storeGet(path, query = "") {
  const token = await tokenProvider();
  const r = await fetch(`${STORE_DB}${path}.json${query ? "?" + query : ""}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`讀門市資料庫失敗 ${r.status} ${path}`);
  return r.json();
}
async function logsBetween(storeId, from, to) {
  const q = `orderBy=${encodeURIComponent('"$key"')}&startAt=${encodeURIComponent(`"${from}"`)}&endAt=${encodeURIComponent(`"${to}"`)}`;
  return (await storeGet(`/stores/${storeId}/dailyLogs`, q)) || {};
}

async function linePushTo(token, to, text) {
  const batches = [];
  const parts = splitText(text);
  for (let i = 0; i < parts.length; i += 5) batches.push(parts.slice(i, i + 5));
  for (const b of batches) {
    const r = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: b.map((t) => ({ type: "text", text: t })) }),
    });
    if (!r.ok) throw new Error(`LINE ${r.status} ${(await r.text()).slice(0, 160)}`);
  }
}

async function lineReply(db, replyToken, text) {
  try {
    const tkS = await db.ref("/config/lineToken").get();
    if (!tkS.exists() || !replyToken) return;
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tkS.val()}` },
      body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
    });
  } catch (e) { console.error("line reply", e); }
}

// ---------- 推一份週報（同一份只推一次；被改過重新提交才會再推） ----------
async function pushWeekly(db, storeId, monday, report) {
  if (!STORES[storeId] || !isMonday(monday)) return { ok: false, skipped: "參數不對" };
  if (report === undefined) report = await storeGet(`/stores/${storeId}/weeklyReports/${monday}`);
  if (!report || !report.submitted) return { ok: false, skipped: "還沒提交" };

  const ownerS = await db.ref("/line/weeklyOwner").get();
  const owner = ownerS.exists() ? ownerS.val().id : "";
  if (!owner) return { ok: false, skipped: "還沒設定接收人" };
  const tkS = await db.ref("/config/lineToken").get();
  const token = tkS.exists() ? tkS.val() : "";
  if (!token) return { ok: false, skipped: "沒有設定 LINE token" };

  const mod = Number(report._lastModified || report._firstSubmittedAt || 0);
  const sentRef = db.ref(`/line/weeklySent/${storeId}/${monday}`);
  // 先佔位再發，避免「店長提交當下的通知」跟「定時巡檢」同時發兩次
  const claim = await sentRef.transaction((cur) => (cur && cur.mod === mod ? undefined : { mod, at: Date.now() }));
  if (!claim.committed) return { ok: false, skipped: "已推過" };

  try {
    const [thisLogs, lastLogs, target] = await Promise.all([
      logsBetween(storeId, monday, shiftDate(monday, 6)),
      logsBetween(storeId, shiftDate(monday, -7), shiftDate(monday, -1)),
      storeGet(`/global/monthlyTargets/${monday.slice(0, 7)}/${storeId}`),
    ]);
    const text = formatWeekly(storeId, monday, report, weekNumbers(monday, thisLogs, lastLogs, target));
    await linePushTo(token, owner, text);
    return { ok: true };
  } catch (e) {
    await sentRef.remove(); // 沒發成功就放掉佔位，下次巡檢會再試
    console.error("pushWeekly", storeId, monday, e);
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------- 定時巡檢：補推店長那邊沒通知到的（例如她的瀏覽器還是舊版頁面） ----------
async function sweepWeekly(db) {
  const now = Date.now();
  const out = [];
  for (const storeId of Object.keys(STORES)) {
    let reports;
    try { reports = (await storeGet(`/stores/${storeId}/weeklyReports`)) || {}; }
    catch (e) { console.error("sweepWeekly", storeId, e); continue; }
    for (const [monday, report] of Object.entries(reports)) {
      if (!report || !report.submitted || !isMonday(monday)) continue;
      const mod = Number(report._lastModified || report._firstSubmittedAt || 0);
      if (now - mod > RECENT_MS) continue;
      const r = await pushWeekly(db, storeId, monday, report);
      if (r.ok || r.error) out.push({ storeId, monday, ...r });
    }
  }
  return out;
}

// ---------- LINE webhook：私訊機器人「週報」＝設定自己為接收人（先設定的人為準） ----------
async function handleLineEvent(db, ev) {
  const src = ev.source || {};
  if (ev.type !== "message" || src.type !== "user" || !src.userId) return false;
  const text = String((ev.message || {}).text || "").trim();
  if (text !== "週報" && text !== "取消週報") return false;
  const ref = db.ref("/line/weeklyOwner");
  const cur = await ref.get();
  const mine = cur.exists() && cur.val().id === src.userId;
  if (text === "取消週報") {
    if (mine) { await ref.remove(); await lineReply(db, ev.replyToken, "已取消，之後不會再收到店長週報。"); }
    return true;
  }
  if (mine) { await lineReply(db, ev.replyToken, "你已經是店長週報的接收人了。"); return true; }
  if (cur.exists()) { await lineReply(db, ev.replyToken, "店長週報已經有設定接收人，這裡不會收到。"); return true; }
  await ref.set({ id: src.userId, at: Date.now() });
  await lineReply(db, ev.replyToken, "設定完成。之後店長一提交週報，全文會傳到這裡。要停止請傳「取消週報」。");
  return true;
}

module.exports = { STORES, isMonday, shiftDate, weekLabel, weekNumbers, formatWeekly, splitText, pushWeekly, sweepWeekly, handleLineEvent, setTokenProvider };
