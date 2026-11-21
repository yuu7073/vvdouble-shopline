// VV DOUBLE · 門市每日回報（Teams 分頁表單 → 這裡）
// 流程：驗證 Teams 身分 → 存日結照片 → 寫進 Google 試算表 → 貼卡片到該店 Teams 聊天室
// 這支不對外提供任何讀取業績的入口；沒有通過公司 Teams 身分驗證的請求一律拒絕。

const crypto = require("crypto");

const TENANT_ID = "09e6a165-8708-419d-92c1-9cd91278f953";
const CLIENT_ID = "2181881e-8ca1-469f-b282-142f9dac88c0";
const APP_URI = `api://vvdouble-shopline.web.app/${CLIENT_ID}`;
const SHEET_ID = "1ezYxmJafhs7CHAPO-VNqLhRYOyB1PrKEvcYvaJ1TGw8";
const PHOTO_BUCKET = "vvdouble-shopline-reports";
const SELF = "https://asia-east1-vvdouble-shopline.cloudfunctions.net/report";
const ORIGIN = "https://vvdouble-shopline.web.app";

const STORES = {
  zhongxiao: "台北忠孝旗艦",
  tongyi: "統一門市",
  taoyuan: "桃園 ATT",
  yizhong: "一中門市",
  xinyizhong: "台中新一中",
  xintiandi: "台南門市",
  xinjuejiang: "高雄門市",
};

const HEADERS = ["日期", "門市", "回報人", "總業績", "現金", "刷卡", "LINE Pay", "來客數", "會員", "非會員", "平均客單", "滯銷", "照片", "送出時間", "Teams 帳號", "零用金小計", "零用金明細", "件數", "電子抵用券", "商品抵用券", "行動支付", "其他支付", "付款明細",
  "銷退金額", "銷退明細", "實際投庫", "投庫差額", "天氣", "人潮", "客群", "熱銷類別", "商品狀態", "試穿轉換", "現場補充", "特別狀況"];
const LAST_COL = "AI";
// 現場狀況的選項（代號沿用舊的門市營運中心，試算表裡存中文）
const OPTS = {
  crowd: { cold: "冷清", normal: "普通", warm: "熱絡", full: "爆滿" },
  customer: { vip: "VIP 較多", new: "新客較多", return: "回頭客多", tourist: "遊客較多" },
  hot: { dress: "洋裝", top: "上衣", pants: "褲裝", outer: "外套", acc: "配件" },
  stock: { ok: "正常", partial: "部分缺貨", "hot-out": "熱門商品斷貨", new: "新品到貨" },
  tryc: { rare: "幾乎沒人試穿", low: "試穿多但成交低", normal: "普通", good: "轉換好" },
};
// 百貨店（付款多了抵用券、行動支付、其他支付；沒有單獨的 LINE Pay 欄）
const DEPT = ["tongyi", "taoyuan", "xintiandi"];
const PAY = [["cash", "現金"], ["card", "刷卡"], ["linepay", "LINE Pay"], ["voucherE", "電子抵用券"], ["voucherG", "商品抵用券"], ["mobile", "行動支付"], ["other", "其他"]];
// 總部帳號：只有這兩個 Teams 帳號能用總部功能（目前是「發測試卡片」）
const HQ = ["vvnyu@vvteam888.onmicrosoft.com", "biggaga0586@vvteam888.onmicrosoft.com"];
const isHq = (account) => HQ.includes(String(account || "").toLowerCase());
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
const num = (n) => Math.round(n).toLocaleString("en-US");

function twNow(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600000);
  const p = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    stamp: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}
function shortDate(date) {
  const [y, m, d] = date.split("-").map(Number);
  const w = "日一二三四五六".charAt(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
  return `${m}/${d}（${w}）`;
}

// 試算表的日期欄：程式寫入的是文字，但有人手動改過就會變成「日期序號」，兩種都要認得
function cellDate(v) {
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
  const t = String(v === undefined || v === null ? "" : v).trim();
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(t);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : t;
}

// ---------- Teams 身分驗證（驗簽章、租用戶、對象、有效期） ----------
let keyCache = { at: 0, keys: [] };
async function msKeys(fetchFn = fetch) {
  if (Date.now() - keyCache.at < 6 * 3600000 && keyCache.keys.length) return keyCache.keys;
  const r = await fetchFn(`https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`);
  if (!r.ok) throw new Error("讀不到 Microsoft 金鑰 " + r.status);
  const j = await r.json();
  keyCache = { at: Date.now(), keys: j.keys || [] };
  return keyCache.keys;
}
const b64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

function verifyToken(token, keys, opt = {}) {
  const now = opt.now || Date.now();
  const tenant = opt.tenant || TENANT_ID;
  const audiences = opt.audiences || [CLIENT_ID, APP_URI];
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("格式不對");
  let head, body;
  try { head = JSON.parse(b64u(parts[0]).toString("utf8")); body = JSON.parse(b64u(parts[1]).toString("utf8")); }
  catch (e) { throw new Error("格式不對"); }
  if (head.alg !== "RS256") throw new Error("簽章方式不對");
  const jwk = (keys || []).find((k) => k.kid === head.kid);
  if (!jwk) throw new Error("找不到金鑰");
  const pub = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
  const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), pub, b64u(parts[2]));
  if (!ok) throw new Error("簽章不對");
  if (body.tid !== tenant) throw new Error("不是公司帳號");
  const issOk = body.iss === `https://login.microsoftonline.com/${tenant}/v2.0` || body.iss === `https://sts.windows.net/${tenant}/`;
  if (!issOk) throw new Error("發行者不對");
  if (!audiences.includes(body.aud)) throw new Error("對象不對");
  const sec = Math.floor(now / 1000);
  if (!(Number(body.exp) > sec - 60)) throw new Error("已過期");
  if (body.nbf && Number(body.nbf) > sec + 300) throw new Error("尚未生效");
  return { account: body.preferred_username || body.upn || body.unique_name || "", name: body.name || "", oid: body.oid || "" };
}

// ---------- 檢查表單內容 ----------
function int(v, max) {
  if (v === "" || v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) return NaN;
  return n;
}
function validate(b, today) {
  const errs = [];
  const store = String(b.store || "");
  if (!STORES[store]) errs.push("門市不對");
  const date = String(b.date || "");
  if (!DATE_RE.test(date) || date > today) errs.push("日期不對");
  const who = String(b.who || "").trim().slice(0, 30);
  if (!who) errs.push("請填回報人");
  const f = {};
  for (const [k] of PAY) { f[k] = int(b[k], 100000000); if (Number.isNaN(f[k])) errs.push("金額不對"); }
  for (const k of ["mem", "non"]) { f[k] = int(b[k], 100000); if (Number.isNaN(f[k])) errs.push("來客數不對"); }
  f.pieces = int(b.pieces, 100000); if (Number.isNaN(f.pieces)) errs.push("件數不對");
  const items = [];
  (Array.isArray(b.items) ? b.items : []).slice(0, 60).forEach((it) => {
    const name = String((it && it.name) || "").trim().slice(0, 120);
    const series = String((it && it.series) || "").trim().slice(0, 40);
    const qty = int(it && it.qty, 100000);
    if (!name) return;
    if (Number.isNaN(qty)) errs.push("滯銷數量不對"); else items.push({ series, name, qty });
  });
  // 零用金：每筆要有金額、用途、經手人；整列空白的略過
  const petty = [];
  (Array.isArray(b.petty) ? b.petty : []).slice(0, 30).forEach((it) => {
    const raw = it && it.amount;
    const note = String((it && it.note) || "").trim().slice(0, 60);
    const handler = String((it && it.handler) || "").trim().slice(0, 30);
    const blank = (raw === "" || raw === null || raw === undefined || Number(raw) === 0) && !note && !handler;
    if (blank) return;
    const amount = int(raw, 1000000);
    if (Number.isNaN(amount) || amount <= 0 || !note || !handler) errs.push("零用金每筆要填金額、用途、經手人");
    else petty.push({ amount, note, handler });
  });
  // 銷退：選填；有填就要有單號和金額
  const returns = [];
  (Array.isArray(b.returns) ? b.returns : []).slice(0, 20).forEach((it) => {
    const no = String((it && it.no) || "").trim().slice(0, 40);
    const raw = it && it.amount;
    if (!no && (raw === "" || raw === null || raw === undefined || Number(raw) === 0)) return;
    const amount = int(raw, 100000000);
    if (!no || Number.isNaN(amount) || amount <= 0) errs.push("銷退每筆要填單號和金額");
    else returns.push({ no, amount });
  });
  // 現金月結：實際投庫沒填就是 null（不是 0）
  let actualDeposit = null;
  if (!(b.actualDeposit === "" || b.actualDeposit === null || b.actualDeposit === undefined)) {
    actualDeposit = int(b.actualDeposit, 100000000);
    if (Number.isNaN(actualDeposit)) errs.push("實際投庫金額不對");
  }
  // 現場狀況：只收名單內的選項
  const pick = (group, v) => (Object.prototype.hasOwnProperty.call(OPTS[group], String(v || "")) ? String(v) : "");
  const scene = {
    crowd: pick("crowd", b.crowd), customer: pick("customer", b.customer), stock: pick("stock", b.stock), tryc: pick("tryc", b.tryc),
    hot: [...new Set((Array.isArray(b.hot) ? b.hot : []).map((h) => pick("hot", h)).filter(Boolean))],
    sceneNote: String(b.sceneNote || "").trim().slice(0, 200),
    specialNote: String(b.specialNote || "").trim().slice(0, 500),
  };
  const photo = String(b.photo || "");
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(photo);
  if (!m) errs.push("請附日結畫面照片");
  else if (m[1].length > 6000000) errs.push("照片太大");
  if (errs.length) return { errs: [...new Set(errs)] };
  const total = PAY.reduce((a, [k]) => a + f[k], 0);
  const cust = f.mem + f.non;
  return {
    data: { store, date, who, ...f, total, cust, avg: cust > 0 ? Math.round(total / cust) : 0, items, petty, pettySum: petty.reduce((a, p) => a + p.amount, 0),
      returns, returnSum: returns.reduce((a, p) => a + p.amount, 0),
      // 應投庫 = 今日現金業績（不扣零用金，沿用舊工具修正後的算法）
      actualDeposit, depositDiff: actualDeposit === null ? null : actualDeposit - f.cash, ...scene, weather: "" },
    photoB64: m[1],
  };
}

function itemsText(items) {
  return items.map((i) => `${i.series ? `《${i.series}》` : ""}${i.name}*${i.qty}`).join("\n");
}
// 以單引號開頭的話試算表會吃掉；回報人、帳號這類文字欄一律當純文字寫入（RAW），不會被當公式執行
function pettyText(petty) {
  return (petty || []).map((p) => `${num(p.amount)}　${p.note}　${p.handler}`).join("\n");
}
function buildRow(d, photoUrl, stamp, account) {
  return [d.date, STORES[d.store], d.who, d.total, d.cash, d.card, d.linepay, d.cust, d.mem, d.non, d.avg, itemsText(d.items), photoUrl, stamp, account, d.pettySum || 0, pettyText(d.petty),
    d.pieces || 0, d.voucherE || 0, d.voucherG || 0, d.mobile || 0, d.other || 0, "",
    d.returnSum || 0, (d.returns || []).map((r) => `${r.no}　${num(r.amount)}`).join("\n"),
    d.actualDeposit === null || d.actualDeposit === undefined ? "" : d.actualDeposit,
    d.depositDiff === null || d.depositDiff === undefined ? "" : d.depositDiff,
    d.weather || "", OPTS.crowd[d.crowd] || "", OPTS.customer[d.customer] || "", (d.hot || []).map((h) => OPTS.hot[h]).join("、"),
    OPTS.stock[d.stock] || "", OPTS.tryc[d.tryc] || "", d.sceneNote || "", d.specialNote || ""];
}
function sceneText(d) {
  const parts = [];
  if (d.weather) parts.push(`天氣 ${d.weather}`);
  if (d.crowd) parts.push(`人潮 ${OPTS.crowd[d.crowd]}`);
  if (d.customer) parts.push(`客群 ${OPTS.customer[d.customer]}`);
  if (d.hot && d.hot.length) parts.push(`熱銷 ${d.hot.map((h) => OPTS.hot[h]).join("、")}`);
  if (d.stock) parts.push(`商品 ${OPTS.stock[d.stock]}`);
  if (d.tryc) parts.push(`試穿 ${OPTS.tryc[d.tryc]}`);
  return parts.join("｜");
}
// 付款那一行：街邊店固定列 現金／刷卡／LINE Pay；百貨店列它自己的欄位；金額是 0 的抵用券類不列
function payText(d) {
  const keys = DEPT.includes(d.store) ? ["cash", "card", "voucherE", "voucherG", "mobile", "other"] : ["cash", "card", "linepay"];
  const always = ["cash", "card", "linepay", "mobile"];
  return PAY.filter(([k]) => keys.includes(k) && (always.includes(k) || d[k] > 0)).map(([k, label]) => `${label} ${num(d[k] || 0)}`).join(" / ");
}

function buildCard(d, photoUrl, tag) {
  const body = [
    { type: "TextBlock", text: `${STORES[d.store]}　每日回報${tag ? `（${tag}）` : ""}`, size: "Large", weight: "Bolder", wrap: true },
    { type: "TextBlock", text: `${shortDate(d.date)}　回報人 ${d.who}`, isSubtle: true, wrap: true, spacing: "Small" },
    { type: "FactSet", spacing: "Medium", facts: [
      { title: "總業績", value: money(d.total) },
      { title: "付款", value: payText(d) },
      { title: "來客數", value: `${num(d.cust)}（會員 ${num(d.mem)} / 非會員 ${num(d.non)}）` },
      { title: "平均客單", value: d.cust > 0 ? money(d.avg) : "—" },
      ...(d.pieces > 0 ? [{ title: "件數", value: num(d.pieces) }] : []),
    ] },
  ];
  if (d.items.length) {
    body.push({ type: "TextBlock", text: "滯銷", weight: "Bolder", spacing: "Medium" });
    body.push({ type: "TextBlock", text: d.items.map((i) => `${i.series ? `《${i.series}》` : ""}${i.name} *${i.qty}`).join("\n\n"), wrap: true, spacing: "Small" });
  }
  if (d.returns && d.returns.length) {
    body.push({ type: "TextBlock", text: `銷退　${money(d.returnSum)}`, weight: "Bolder", spacing: "Medium" });
    body.push({ type: "TextBlock", text: d.returns.map((r) => `${r.no}　${money(r.amount)}`).join("\n\n"), wrap: true, spacing: "Small" });
  }
  if (d.actualDeposit !== null && d.actualDeposit !== undefined) {
    const diff = d.depositDiff || 0;
    body.push({ type: "TextBlock", text: `現金月結　應投庫 ${money(d.cash)} / 實際 ${money(d.actualDeposit)}${diff ? `（差 ${diff > 0 ? "+" : "-"}${money(Math.abs(diff))}）` : ""}`, wrap: true, spacing: "Medium" });
  }
  const sc = sceneText(d);
  if (sc || d.sceneNote || d.specialNote) {
    body.push({ type: "TextBlock", text: "現場狀況", weight: "Bolder", spacing: "Medium" });
    if (sc) body.push({ type: "TextBlock", text: sc, wrap: true, spacing: "Small" });
    if (d.sceneNote) body.push({ type: "TextBlock", text: d.sceneNote, wrap: true, spacing: "Small" });
    if (d.specialNote) body.push({ type: "TextBlock", text: `特別狀況：${d.specialNote}`, wrap: true, spacing: "Small" });
  }
  if (d.petty && d.petty.length) {
    body.push({ type: "TextBlock", text: `零用金　${money(d.pettySum)}`, weight: "Bolder", spacing: "Medium" });
    body.push({ type: "TextBlock", text: d.petty.map((p) => `${money(p.amount)}　${p.note}（${p.handler}）`).join("\n\n"), wrap: true, spacing: "Small" });
  }
  if (photoUrl) body.push({ type: "Image", url: photoUrl, size: "Large", spacing: "Medium", altText: "日結畫面" });
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body },
    }],
  };
}

// ---------- 試算表 ----------
function sheetsApi(GoogleAuth) {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
  const call = async (path, opt = {}) => {
    const client = await auth.getClient();
    const r = await client.request({ url: base + path, method: opt.method || "GET", data: opt.data });
    return r.data;
  };
  return {
    get: (range) => call(`/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`).then((d) => d.values || []),
    update: (range, row) => call(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { method: "PUT", data: { values: [row] } }),
    put: (range, rows) => call(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { method: "PUT", data: { values: rows } }),
    appendRows: (range, rows) => call(`/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: "POST", data: { values: rows } }),
    append: (range, row) => call(`/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: "POST", data: { values: [row] } }),
  };
}
// 同一間店同一天再送一次＝更新那一列，不會多出一列
async function upsertRow(sheets, row) {
  const keys = await sheets.get("回報!A2:B");
  const idx = keys.findIndex((r) => cellDate(r[0]) === row[0] && String(r[1] || "").trim() === row[1]);
  if (idx >= 0) { await sheets.update(`回報!A${idx + 2}:${LAST_COL}${idx + 2}`, row); return "updated"; }
  await sheets.append(`回報!A:${LAST_COL}`, row);
  return "added";
}
async function readItems(sheets) {
  const rows = await sheets.get("滯銷品項!A2:B");
  return rows.map((r) => ({ series: String(r[0] || "").trim(), name: String(r[1] || "").trim() })).filter((r) => r.name);
}
// 各店聊天室的通知網址：存在門市營運中心的資料庫（已上鎖），後端用服務帳號讀，網址不經過任何頁面
const STORE_DB = "https://vvdouble-store-default-rtdb.asia-southeast1.firebasedatabase.app";
async function storeDbGet(GoogleAuth, path, query) {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/firebase.database", "https://www.googleapis.com/auth/userinfo.email"] });
  const token = await auth.getAccessToken();
  const r = await fetch(`${STORE_DB}${path}.json${query ? "?" + query : ""}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error("讀門市資料庫失敗 " + r.status);
  return r.json();
}
const okUrl = (u) => (/^https:\/\//.test(String(u || "").trim()) ? String(u).trim() : "");
// 測試卡片的去處：試算表「設定」分頁代號 test 那一列有填網址，就貼到那裡（不打擾門市聊天室）
async function testWebhook(sheets) {
  try { const hit = (await sheets.get("設定!A2:C")).find((r) => r[0] === "test"); return okUrl(hit && hit[2]); } catch (e) { return ""; }
}
async function readWebhook(sheets, store, GoogleAuth) {
  // 試算表「設定」分頁有填就以它為準，沒填才讀舊資料庫
  try {
    const rows = await sheets.get("設定!A2:C");
    const hit = rows.find((r) => r[0] === store);
    const u = okUrl(hit && hit[2]);
    if (u) return u;
  } catch (e) { console.error("report webhook sheet", e); }
  if (!GoogleAuth || !STORES[store]) return "";
  return okUrl(await storeDbGet(GoogleAuth, `/global/settings/teamsRouting/channels/${store}`));
}

// ---------- 照片（私人儲存；網址含一段猜不到的亂碼，只寫在試算表與該店聊天室） ----------
async function savePhoto(admin, b64) {
  const bucket = admin.storage().bucket(PHOTO_BUCKET);
  const [exists] = await bucket.exists();
  if (!exists) await bucket.create({ location: "asia-east1" });
  const key = crypto.randomBytes(24).toString("hex");
  await bucket.file(`photos/${key}.jpg`).save(Buffer.from(b64, "base64"), { contentType: "image/jpeg", resumable: false });
  return `${SELF}?op=photo&k=${key}`;
}
async function sendPhoto(admin, res, key) {
  if (!/^[a-f0-9]{48}$/.test(String(key || ""))) return res.status(404).send("");
  const file = admin.storage().bucket(PHOTO_BUCKET).file(`photos/${key}.jpg`);
  const [exists] = await file.exists();
  if (!exists) return res.status(404).send("");
  res.set("Content-Type", "image/jpeg");
  res.set("Cache-Control", "private, max-age=86400");
  res.set("X-Robots-Tag", "noindex");
  file.createReadStream().on("error", () => res.status(500).end()).pipe(res);
}

// ---------- LINE：一天一則彙整（省額度），另外私訊「今日」隨時查（回覆不計額度） ----------
function digestText(date, rows) {
  const done = rows.filter((r) => cellDate(r[0]) === date).map((r) => { const c = r.slice(); c[1] = String(c[1] || "").trim(); return c; });
  const names = Object.values(STORES);
  const missing = names.filter((n) => !done.some((r) => r[1] === n));
  const n = (v) => Number(v) || 0;
  const block = (title, total, cust, mem, non) => [
    title,
    `總業績 ${money(total)}`,
    `來客 ${num(cust)}（會員 ${num(mem)} / 非會員 ${num(non)}）`,
    `平均客單 ${cust > 0 ? money(total / cust) : "—"}`,
  ];
  const lines = [`每日回報｜${shortDate(date)}`, `已回報 ${done.length} / ${names.length}`];
  if (done.length) {
    const sum = done.reduce((a, r) => ({ total: a.total + n(r[3]), cust: a.cust + n(r[7]), mem: a.mem + n(r[8]), non: a.non + n(r[9]) }), { total: 0, cust: 0, mem: 0, non: 0 });
    lines.push("", ...block("【合計】", sum.total, sum.cust, sum.mem, sum.non));
    // 照門市固定順序排，不是照送出先後
    names.forEach((name) => {
      const r = done.find((x) => x[1] === name);
      if (r) lines.push("", ...block(`【${name}】`, n(r[3]), n(r[7]), n(r[8]), n(r[9])));
    });
  }
  if (missing.length) lines.push("", "【未回報】", missing.join("、"));
  return lines.join("\n");
}
async function lineOwner(db) {
  const [o, t] = await Promise.all([db.ref("/line/weeklyOwner").get(), db.ref("/config/lineToken").get()]);
  return { owner: o.exists() ? o.val().id : "", token: t.exists() ? t.val() : "" };
}
async function pushDigest(db, sheets, date) {
  const { owner, token } = await lineOwner(db);
  if (!owner || !token) return { ok: false, skipped: "LINE 還沒設定接收人" };
  const rows = await sheets.get("回報!A2:O");
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: owner, messages: [{ type: "text", text: digestText(date, rows).slice(0, 4900) }] }),
  });
  return { ok: r.ok, status: r.status };
}
// 只有週報接收人本人私訊「今日」才會回，其他人傳一樣的字不會有反應
async function handleLineEvent(db, ev, GoogleAuth) {
  const src = ev.source || {};
  if (ev.type !== "message" || src.type !== "user" || !src.userId) return false;
  const text = String((ev.message || {}).text || "").trim();
  if (text !== "今日" && text !== "昨日") return false;
  const { owner, token } = await lineOwner(db);
  if (!owner || owner !== src.userId || !token || !ev.replyToken) return true;
  const date = twNow(Date.now() - (text === "昨日" ? 86400000 : 0)).date;
  const rows = await sheetsApi(GoogleAuth).get("回報!A2:O");
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: "text", text: digestText(date, rows).slice(0, 4900) }] }),
  });
  return true;
}

// ---------- HTTP 入口 ----------
async function handle(req, res, deps) {
  const { admin, GoogleAuth } = deps;
  res.set("Access-Control-Allow-Origin", ORIGIN);
  res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age", "3600");
  res.set("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(204).send("");

  // 開店提醒卡片裡的進度條圖片（只有百分比，沒有門市與金額；Teams 讀圖不帶身分所以不驗證）
  if (req.method === "GET" && req.query.op === "bar") {
    res.set("Content-Type", "image/png"); res.set("Cache-Control", "public, max-age=86400");
    return res.send(require("./ops").barPng(req.query.f, req.query.m, req.query.ok === "1"));
  }
  if (req.method === "GET" && req.query.op === "photo") return sendPhoto(admin, res, req.query.k);

  let user;
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!m) throw new Error("沒有身分");
    user = verifyToken(m[1], await msKeys());
  } catch (e) {
    return res.status(401).json({ ok: false, error: "身分驗證沒過，請從 Teams 重新開啟" });
  }

  const sheets = sheetsApi(GoogleAuth);
  try {
    if (req.method === "GET" && req.query.op === "config") {
      return res.json({ ok: true, items: await readItems(sheets), account: user.account, name: user.name, hq: isHq(user.account), dept: DEPT });
    }
    const ops = require("./ops");
    // 本月進度：門市帳號看得到每一間（聊天室分頁本來就綁門市）；七間總覽只給總部
    if (req.method === "GET" && req.query.op === "progress") {
      const today = twNow().date;
      if (req.query.all === "1") {
        if (!isHq(user.account)) return res.status(403).json({ ok: false, error: "只有總部帳號可以看七間總覽" });
        return res.json({ ok: true, today, stores: await ops.progressAll({ sheets, GoogleAuth }, today) });
      }
      const store = String(req.query.store || "");
      if (!STORES[store]) return res.status(400).json({ ok: false, error: "門市不對" });
      return res.json({ ok: true, today, progress: await ops.progressFor({ sheets, GoogleAuth }, store, today) });
    }
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "不支援" });

    // 總部專用：現在就發一張開店提醒到指定門市（測試用，不影響當天正式那張）
    if (req.query.op === "testopen") {
      if (!isHq(user.account)) return res.status(403).json({ ok: false, error: "只有總部帳號可以發測試卡片" });
      const store = String((req.body || {}).store || "");
      if (!STORES[store]) return res.status(400).json({ ok: false, error: "門市不對" });
      const r = await ops.postOpening({ sheets, GoogleAuth }, store, twNow().date, "測試", undefined, await testWebhook(sheets));
      return res.json({ ok: true, ...r });
    }

    // 總部專用：發一張測試卡片到指定門市的聊天室（不寫試算表、不存照片）
    if (req.query.op === "testcard") {
      if (!isHq(user.account)) return res.status(403).json({ ok: false, error: "只有總部帳號可以發測試卡片" });
      const store = String((req.body || {}).store || "");
      if (!STORES[store]) return res.status(400).json({ ok: false, error: "門市不對" });
      const hook = (await testWebhook(sheets)) || (await readWebhook(sheets, store, GoogleAuth));
      if (!hook) return res.json({ ok: true, posted: false, reason: "找不到這間店的通知網址" });
      const sample = { store, date: twNow().date, who: "測試", cash: 469, card: 33014, linepay: DEPT.includes(store) ? 0 : 31396, mobile: DEPT.includes(store) ? 31396 : 0, voucherE: 0, voucherG: 0, other: 0, pieces: 31, mem: 23, non: 1, total: 64879, cust: 24, avg: 2703,
        items: (await readItems(sheets)).map((it, i) => ({ ...it, qty: i % 2 })), petty: [{ amount: 120, note: "買垃圾袋", handler: "測試" }], pettySum: 120 };
      const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildCard(sample, "", "測試")) });
      return res.json({ ok: true, posted: r.ok || r.status === 202, status: r.status });
    }

    const v = validate(req.body || {}, twNow().date);
    if (v.errs) return res.status(400).json({ ok: false, error: v.errs.join("、") });

    // 天氣自動帶入（只帶當天的；補登以前的日期不帶，避免寫成今天的天氣）
    if (v.data.date === twNow().date) {
      try { const w = await ops.forecast(v.data.store, v.data.date); if (w) v.data.weather = `${w.text} ${w.tmin}–${w.tmax}°C`; } catch (e) { console.error("report weather", e); }
    }
    const photoUrl = await savePhoto(admin, v.photoB64);
    const result = await upsertRow(sheets, buildRow(v.data, photoUrl, twNow().stamp, user.account));

    // 貼到該店聊天室：失敗不影響回報本身（資料已經在試算表）
    let posted = false;
    try {
      const hook = await readWebhook(sheets, v.data.store, GoogleAuth);
      if (hook) {
        const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildCard(v.data, photoUrl)) });
        posted = r.ok || r.status === 202;
      }
    } catch (e) { console.error("report teams", e); }

    return res.json({ ok: true, result, posted });
  } catch (e) {
    console.error("report", e);
    return res.status(500).json({ ok: false, error: "儲存失敗，請再試一次" });
  }
}

module.exports = {
  STORES, HEADERS, TENANT_ID, CLIENT_ID, APP_URI,
  twNow, shortDate, verifyToken, validate, buildRow, buildCard, itemsText, pettyText,
  upsertRow, readItems, readWebhook, storeDbGet, isHq, cellDate, payText, DEPT, OPTS, LAST_COL, sceneText, money, num, digestText, sheetsApi, pushDigest, handleLineEvent, handle,
};
