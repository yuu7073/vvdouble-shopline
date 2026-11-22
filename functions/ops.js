// 門市回報的「本月進度」與「開店提醒」：
// 資料 = 試算表（新的回報）＋ 門市營運中心資料庫（舊的日誌、目標、營業時間；唯讀）
const R = require("./report");

const BAR_URL = "https://asia-east1-vvdouble-shopline.cloudfunctions.net/report?op=bar";
const GEO = {
  zhongxiao: [25.041, 121.564], tongyi: [25.046, 121.516], taoyuan: [24.993, 121.301], yizhong: [24.146, 120.685],
  xinyizhong: [24.15, 120.683], xintiandi: [22.992, 120.213], xinjuejiang: [22.624, 120.302],
};
// 開門時間（星期 0＝週日），沿用舊工具的預設值；舊資料庫 /global/settings/storeHours 有改就以它為準
const wk = (a, b, c, d, e, f, g) => ({ 0: a, 1: b, 2: c, 3: d, 4: e, 5: f, 6: g });
const OPEN_DEFAULT = {
  zhongxiao: wk("12:30", "12:30", "12:30", "12:30", "12:30", "13:00", "13:00"),
  tongyi: wk("12:30", "10:30", "10:30", "10:30", "10:30", "13:00", "13:00"),
  taoyuan: wk("13:00", "10:30", "10:30", "10:30", "10:30", "10:30", "13:00"),
  yizhong: wk("12:30", "12:30", "12:30", "12:30", "12:30", "12:30", "12:30"),
  xinyizhong: wk("13:00", "13:00", "13:00", "13:00", "13:00", "13:00", "13:00"),
  xintiandi: wk("13:00", "10:30", "10:30", "10:30", "10:30", "10:30", "13:00"),
  xinjuejiang: wk("13:00", "13:00", "13:00", "13:00", "13:00", "13:00", "13:00"),
};
const dow = (date) => { const [y, m, d] = date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const addDays = (date, n) => { const [y, m, d] = date.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const monthDays = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const n0 = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

function openTime(store, date, override) {
  const day = override && override[store] && override[store][dow(date)];
  const t = day && day.open;
  if (t === "closed" || t === "公休") return null;
  if (/^\d{1,2}:\d{2}$/.test(String(t || ""))) return String(t).padStart(5, "0");
  return (OPEN_DEFAULT[store] || {})[dow(date)] || null;
}

// ---------- 天氣（Open-Meteo，免金鑰） ----------
function weatherKey(code) {
  if (code <= 1) return ["sunny", "晴"];
  if (code === 2) return ["cloudy", "多雲"];
  if (code === 3) return ["cloudy", "陰"];
  if (code >= 45 && code <= 48) return ["cloudy", "霧"];
  if (code >= 51 && code <= 57) return ["rainy", "毛毛雨"];
  if (code >= 61 && code <= 67) return ["rainy", "雨"];
  if (code >= 80 && code <= 82) return ["rainy", "陣雨"];
  if (code >= 95) return ["storm", "雷雨"];
  return ["cloudy", "多雲"];
}
async function forecast(store, date, fetchFn = fetch) {
  const g = GEO[store];
  if (!g) return null;
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${g[0]}&longitude=${g[1]}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTaipei&start_date=${date}&end_date=${date}`;
  const r = await fetchFn(u);
  if (!r.ok) return null;
  const d = (await r.json()).daily || {};
  if (!d.weathercode || d.weathercode[0] === null || d.weathercode[0] === undefined) return null;
  const [key, text] = weatherKey(d.weathercode[0]);
  const pop = d.precipitation_probability_max && d.precipitation_probability_max[0];
  return { key, text, tmax: Math.round(d.temperature_2m_max[0]), tmin: Math.round(d.temperature_2m_min[0]), pop: pop === null || pop === undefined ? null : Math.round(pop) };
}

// ---------- 歷史資料：舊日誌 ＋ 試算表（同一天以試算表為準） ----------
const rev = (group) => Object.fromEntries(Object.entries(R.OPTS[group]).map(([k, v]) => [v, k]));
function sheetDay(r) {
  const w = String(r[38] || "");
  return {
    sales: n0(r[3]), customers: n0(r[7]), items: n0(r[12]),
    weather: /雷/.test(w) ? "storm" : /雨/.test(w) ? "rainy" : w ? "other" : "",
    crowd: rev("crowd")[String(r[39] || "")] || "", stock: rev("stock")[String(r[42] || "")] || "", tryc: rev("tryc")[String(r[43] || "")] || "",
    hot: String(r[41] || "").split("、").map((x) => rev("hot")[x]).filter(Boolean),
  };
}
function oldDay(l) {
  return {
    sales: n0(l.sales), customers: n0(l.customers), items: n0(l.items),
    weather: (l.weather && l.weather.key) || "", crowd: l.crowd || "", stock: l.stockStatus || "", tryc: l.tryConversion || "",
    hot: Array.isArray(l.hotCategories) ? l.hotCategories : [],
  };
}
async function sheetRows(ctx) {
  if (!ctx.rows) ctx.rows = await ctx.sheets.get(`回報!A2:${R.LAST_COL}`);
  return ctx.rows;
}
const quiet = async (p, label) => { try { return await p; } catch (e) { console.error("ops " + label, e.message || e); return null; } };
async function loadStore(ctx, store, today) {
  const ym = today.slice(0, 7);
  const from = [addDays(today, -8), ym + "-01"].sort()[0];
  const get = (path, q) => quiet(R.storeDbGet(ctx.GoogleAuth, path, q), path);
  const [rows, logs, t1, t0, mt] = await Promise.all([
    sheetRows(ctx),
    get(`/stores/${store}/dailyLogs`, `orderBy=%22%24key%22&startAt=%22${from}%22`),
    get(`/stores/${store}/targets/${ym}`),
    from.slice(0, 7) === ym ? null : get(`/stores/${store}/targets/${from.slice(0, 7)}`),
    get(`/global/monthlyTargets/${ym}/${store}`),
  ]);
  const days = {};
  Object.entries(logs || {}).forEach(([d, l]) => { if (l && typeof l === "object" && n0(l.sales) > 0) days[d] = oldDay(l); });
  rows.forEach((r) => { if (String(r[1] || "").trim() === R.STORES[store]) days[R.cellDate(r[0])] = sheetDay(r); });
  const targets = {};
  [t0, t1].forEach((t) => Object.entries(t || {}).forEach(([d, v]) => { if (n0(v) > 0) targets[d] = n0(v); }));
  const daily = Object.entries(targets).filter(([d]) => d.startsWith(ym)).reduce((a, [, v]) => a + v, 0);
  return { days, targets, monthTarget: n0(mt && typeof mt === "object" ? mt.target || mt.amount : mt) || daily };
}

// ---------- 本月進度 ----------
function progress(data, today) {
  const ym = today.slice(0, 7);
  const total = monthDays(ym);
  const list = [];
  let cum = 0, cust = 0, reported = 0, paceTarget = 0;
  for (let i = 1; i <= total; i++) {
    const d = `${ym}-${String(i).padStart(2, "0")}`;
    const day = data.days[d];
    const target = data.targets[d] || 0;
    if (d <= today && day) { cum += day.sales; cust += day.customers; reported++; if (target) paceTarget += target; }
    if (d <= today) list.push({ date: d, sales: day ? day.sales : null, customers: day ? day.customers : null, target });
  }
  // 今天已經回報就從明天算剩餘天數，還沒回報就把今天算進去
  const todayDay = Number(today.slice(8));
  const left = total - todayDay + (data.days[today] ? 0 : 1);
  const mt = data.monthTarget;
  return {
    month: ym, monthTarget: mt, cum, customers: cust, reported, daysLeft: left,
    rate: mt ? Math.round((cum / mt) * 1000) / 10 : null,
    remaining: mt ? Math.max(0, mt - cum) : null,
    needPerDay: mt && left > 0 ? Math.ceil(Math.max(0, mt - cum) / left) : null,
    // 已回報那幾天的每日目標合計：用來看「到目前為止」是超前還是落後
    paceTarget, todayTarget: data.targets[today] || 0, days: list,
  };
}
async function progressFor(ctx, store, today) {
  return { store, name: R.STORES[store], ...progress(await loadStore(ctx, store, today), today) };
}
async function progressAll(ctx, today) {
  await sheetRows(ctx);
  const all = await Promise.all(Object.keys(R.STORES).map((s) => progressFor(ctx, s, today)));
  return all.map(({ days, ...rest }) => rest);
}

// ---------- 近 7 天統計與建議（沿用舊工具「營運教練」的判斷，去掉表情符號） ----------
function stats7(data, today) {
  const s = { n: 0, sales: 0, cust: 0, items: 0, itemCust: 0, rates: [], try: {}, stock: {}, weather: {}, crowd: {}, hot: {} };
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, -i);
    const day = data.days[d];
    if (!day || !(day.sales > 0)) continue;
    s.n++; s.sales += day.sales; s.cust += day.customers;
    if (day.items > 0 && day.customers > 0) { s.items += day.items; s.itemCust += day.customers; }
    if (data.targets[d]) s.rates.push((day.sales / data.targets[d]) * 100);
    const inc = (o, k) => { if (k) o[k] = (o[k] || 0) + 1; };
    inc(s.try, day.tryc); inc(s.stock, day.stock); inc(s.weather, day.weather); inc(s.crowd, day.crowd);
    day.hot.forEach((h) => inc(s.hot, h));
  }
  return {
    days: s.n,
    avgRate: s.rates.length ? s.rates.reduce((a, b) => a + b, 0) / s.rates.length : null,
    avgPrice: s.cust > 0 ? Math.round(s.sales / s.cust) : null,
    avgUpt: s.itemCust > 0 ? s.items / s.itemCust : null,
    try: s.try, stock: s.stock, weather: s.weather, crowd: s.crowd, hot: s.hot,
  };
}
function coachTips(st) {
  const tips = [];
  const c = (o, k) => o[k] || 0;
  const add = (priority, label, text) => tips.push({ priority, label, text });
  if (!st.days) return tips;
  if (st.avgRate !== null) {
    const r = st.avgRate.toFixed(0);
    if (st.avgRate >= 130) add(2, "近期表現超標", `近 7 天平均達成率 ${r}%，可以挑戰拉高客單，把節奏延續到月底`);
    else if (st.avgRate >= 100) add(3, "近期穩定達標", `近 7 天平均達成率 ${r}%，維持目前節奏，把握每位客人的連帶機會`);
    else if (st.avgRate >= 80) add(2, "近期接近達標", `近 7 天平均達成率 ${r}%，從試穿轉換和連帶銷售下手再推一把`);
    else if (st.avgRate >= 60) add(1, "近期落後", `近 7 天平均達成率 ${r}%，今天從主動推組合優惠、加強試穿引導開始`);
    else add(0, "近期業績明顯落後", `近 7 天平均達成率 ${r}%，今天要主動接觸每位進店客，用力推連帶與組合優惠`);
  }
  if (st.avgPrice !== null) {
    const p = "$" + st.avgPrice.toLocaleString("en-US");
    if (st.avgPrice < 1500) add(2, "近期客單偏低", `近 7 天平均客單 ${p}，今天多推高單價單品和外套類，用組合優惠拉高客單`);
    else if (st.avgPrice > 2500) add(5, "近期客單亮眼", `近 7 天平均客單 ${p}，維持完整的搭配建議，主推質感單品`);
    else if (st.avgPrice >= 1800) add(5, "近期客單穩定", `近 7 天平均客單 ${p}，可以用獨家款、外套類再往上推`);
  }
  if (st.avgUpt !== null) {
    const u = st.avgUpt.toFixed(1);
    if (st.avgUpt < 1.3) add(2, "近期客件數偏低", `近 7 天平均每人 ${u} 件，今天著重成套搭配（洋裝配外套、上衣配褲）`);
    else if (st.avgUpt < 1.5) add(3, "客件數可以加強", `近 7 天平均每人 ${u} 件，主動推連帶搭配與配件加購，目標 1.8 件以上`);
    else if (st.avgUpt > 2.5) add(5, "搭配能力出色", `近 7 天平均每人 ${u} 件，今天可以挑戰第 3 件配件加購`);
  }
  const lowTry = c(st.try, "low") + c(st.try, "rare");
  if (lowTry >= 3) add(2, "近期試穿轉換偏低", `近 7 天有 ${lowTry} 天試穿轉換不理想，試衣間的客人是今天重點：問出猶豫點，主動給尺寸或版型替代`);
  if (c(st.stock, "hot-out") >= 2) add(1, "熱門商品常斷貨", `近 7 天有 ${c(st.stock, "hot-out")} 天熱門商品斷貨，今天先準備好替代款的推薦說法，客人問到缺貨款時馬上接得上`);
  if (c(st.stock, "new") >= 2) add(4, "近期新品到貨多", `近 7 天有 ${c(st.stock, "new")} 天新品到貨，主動介紹給回頭客，用穿搭組合帶新品`);
  const rainy = c(st.weather, "rainy") + c(st.weather, "storm");
  const low = st.avgRate !== null && st.avgRate < 90;
  if (rainy >= 3 && low) add(3, "雨天多影響業績", `近 7 天有 ${rainy} 天下雨，客流受影響，進店的每一位都要做完整服務`);
  if (c(st.crowd, "cold") >= 3 && low) add(3, "近期人潮偏少", `近 7 天有 ${c(st.crowd, "cold")} 天人潮冷清，今天主動招呼店外客人，進店客要留久一點`);
  const busy = c(st.crowd, "warm") + c(st.crowd, "full");
  if (busy >= 4 && st.avgRate !== null && st.avgRate < 100) add(3, "人潮多但業績沒跟上", `近 7 天有 ${busy} 天人潮熱絡但沒達標，每位客人都先招呼到，結帳加快，別讓客人等`);
  const hot = Object.entries(st.hot).sort((a, b) => b[1] - a[1]);
  if (hot.length >= 2) add(4, "近期熱銷", `近 7 天賣得最好的是${hot.slice(0, 2).map(([k]) => R.OPTS.hot[k] || k).join("、")}，今天陳列和搭配推薦以這兩類為主`);
  return tips.sort((a, b) => a.priority - b.priority).slice(0, 3);
}
// 依「今天」的天氣與星期給的提醒（這段是新加的，舊工具沒有）
function todayTips(w, date) {
  const tips = [];
  if (w) {
    if (w.key === "rainy" || w.key === "storm" || (w.pop !== null && w.pop >= 60)) tips.push({ label: "今天有雨", text: `${w.pop !== null ? `降雨機率 ${w.pop}%，` : ""}進店客會比較少，每一位都做完整搭配服務；門口備好傘套，地板保持乾` });
    if (w.tmax <= 18) tips.push({ label: "今天偏冷", text: `最高 ${w.tmax}°C，外套、針織、鋪棉款放到最前面，結帳前多問一句要不要加外套` });
    else if (w.tmax >= 28) tips.push({ label: "今天偏熱", text: `最高 ${w.tmax}°C，短袖、輕薄款放前面，厚款改用「先買先備」的說法帶` });
    else if (w.tmax - w.tmin >= 8) tips.push({ label: "早晚溫差大", text: `${w.tmin}–${w.tmax}°C，主推薄外套、罩衫這類好疊穿的單品做連帶` });
  }
  if ([5, 6, 0].includes(dow(date))) tips.push({ label: "週末人潮", text: "開門前把熱賣尺寸補上架、試衣間整理好，客人多的時候先打招呼再輪流服務" });
  return tips.slice(0, 2);
}

// 依日子給的整理提醒：週末結束後、新品到貨隔天
function contextTips(data, date) {
  const tips = [];
  const y = data.days[addDays(date, -1)];
  if (y && y.stock === "new") tips.push({ label: "新品上架隔天", text: "開門前把新品的線頭修乾淨、吊牌擺正，陳列照昨天賣的狀況調整，試穿過的掛回原位" });
  if (dow(date) === 1) tips.push({ label: "週末結束後整理", text: "修剪線頭、整燙被試穿過的款式，補齊賣掉的尺寸，把週末賣得好的款式移到前面" });
  return tips.slice(0, 1);
}
// 服務技巧：有數據就對症下藥，沒有就每天輪一則
const SERVICE = [
  ["試衣間對話", "客人從試衣間出來先問「哪裡喜歡、哪裡卡」，再遞上 2–3 件類似款或不同版型讓她比較，不要讓她空手走出來"],
  ["先備好替代款", "客人進試衣間時，先在外面準備同類型不同顏色、不同長度的款式，她一出來就能接著試"],
  ["多帶一件進試衣間", "客人拿上衣就多帶一件好搭的下身或外套，一起試才有整套的感覺"],
  ["結帳前多問一句", "結帳前拿一件能搭她手上那件的單品問「這件配起來要不要看一下」"],
  ["主動報尺寸", "看到客人翻吊牌就主動說有哪些尺寸、建議她穿哪一個，減少她自己猜"],
];
function serviceTip(st, data, date) {
  const c = (o, k) => o[k] || 0;
  if (st.days && c(st.try, "low") + c(st.try, "rare") >= 2) return { label: SERVICE[0][0], text: SERVICE[0][1] };
  if (st.avgUpt !== null && st.avgUpt < 1.5) return { label: SERVICE[2][0], text: SERVICE[2][1] };
  const [y, m, d] = date.split("-").map(Number);
  const pick = SERVICE[Math.floor(Date.UTC(y, m - 1, d) / 86400000) % SERVICE.length];
  return { label: pick[0], text: pick[1] };
}
// 進度條：後端畫成一張 PNG（Teams 卡片沒有內建進度條，用底色欄位拼的很醜）。
// 圖只帶百分比，不含門市名稱與金額。fill＝業績進度，mark＝應有進度的直線，ok＝超前(綠)／落後(紅)
function barPng(fill, mark, ok, solid) {
  const zlib = require("zlib");
  const W = solid ? 8 : 880, H = solid ? 8 : 36, r = H / 2;
  const f = Math.max(0, Math.min(100, Number(fill) || 0)) / 100 * W;
  const m = mark === null || mark === undefined || mark === "" ? null : Math.max(0, Math.min(100, Number(mark) || 0)) / 100 * W;
  const col = ok ? [46, 158, 91] : [217, 83, 79];
  const raw = Buffer.alloc((W * 4 + 1) * H);
  // 圓角膠囊的覆蓋率（邊緣做 1px 柔邊）
  const cover = (x, y, x1) => {
    if (x1 <= 0) return 0;
    const cx = Math.max(r, Math.min(Math.max(r, x1 - r), x)), dx = x - cx, dy = y - r;
    const edge = x1 < 2 * r ? Math.min(r - Math.hypot(Math.min(0, x - r), dy), x1 - x) : r - Math.hypot(dx, dy);
    return Math.max(0, Math.min(1, edge + 0.5));
  };
  for (let y = 0; y < H; y++) {
    const o = y * (W * 4 + 1);
    for (let x = 0; x < W; x++) {
      if (solid) { const q = o + 1 + x * 4; raw[q] = 255; raw[q + 1] = 214; raw[q + 2] = 64; raw[q + 3] = 255; continue; }
      const px = x + 0.5, py = y + 0.5, t = cover(px, py, W), c = Math.min(t, cover(px, py, f));
      // 軌道：半透明灰，深色淺色背景都看得到
      let R_ = 138, G_ = 143, B_ = 152, A = t * 0.38;
      if (c > 0) { const a = c + A * (1 - c); R_ = (col[0] * c + R_ * A * (1 - c)) / a; G_ = (col[1] * c + G_ * A * (1 - c)) / a; B_ = (col[2] * c + B_ * A * (1 - c)) / a; A = a; }
      if (m !== null && Math.abs(px - Math.max(3, Math.min(W - 3, m))) <= 3) { R_ = 255; G_ = 255; B_ = 255; A = 1; if (Math.abs(px - Math.max(3, Math.min(W - 3, m))) > 1.5) { R_ = 31; G_ = 36; B_ = 48; } }
      const k = o + 1 + x * 4;
      raw[k] = Math.round(R_); raw[k + 1] = Math.round(G_); raw[k + 2] = Math.round(B_); raw[k + 3] = Math.round(A * 255);
    }
  }
  const tbl = barPng.t || (barPng.t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = tbl[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
function progressBars(pg, date) {
  if (!pg.monthTarget) return [];
  const head = heading("本月進度 📊");
  const line = (text, subtle) => ({ type: "TextBlock", wrap: true, spacing: "Small", size: subtle ? "Small" : "Default", isSubtle: !!subtle, text });
  const img = (fill, mark, ok, alt) => ({ type: "Image", url: `${BAR_URL}&f=${fill}${mark === null ? "" : `&m=${mark}`}&ok=${ok ? 1 : 0}`, altText: alt, size: "Stretch", spacing: "Small" });
  const sales = `業績 **${pg.rate}%**　${R.money(pg.cum)} / ${R.money(pg.monthTarget)}`;
  // 有每日目標：直線標出「照每日目標到昨天應該到哪裡」；沒有才用過了幾天來比
  let due, label;
  if (pg.paceTarget) { due = Math.round((pg.paceTarget / pg.monthTarget) * 1000) / 10; label = `直線是應有進度 ${due}%（照每日目標應累計 ${R.money(pg.paceTarget)}）`; }
  else { const total = monthDays(date.slice(0, 7)), passed = Number(date.slice(8)) - 1; due = Math.round((passed / total) * 1000) / 10; label = `直線是時間進度 ${due}%（已過 ${passed} 天 / ${total} 天）`; }
  const gap = pg.paceTarget ? pg.cum - pg.paceTarget : null;
  const ok = gap === null ? pg.rate >= due : gap >= 0;
  const out = [head, line(sales), img(pg.rate, due, ok, `業績進度 ${pg.rate}%，應有 ${due}%`), line(label, true)];
  if (gap !== null) out.push({ type: "TextBlock", wrap: true, spacing: "Small", weight: "Bolder", color: ok ? "Good" : "Attention", text: ok ? `超前 ${R.money(gap)} 🎉 繼續保持` : `落後 ${R.money(-gap)}，今天追回來 💪` });
  return out;
}

// 讓卡片活潑一點：標題配表情符號，每則建議後面接一個每天輪替的顏文字
const EMOJI = {
  "今天有雨": "☔", "今天偏冷": "🧣", "今天偏熱": "☀️", "早晚溫差大": "🌤️", "週末人潮": "🔥", "新品上架隔天": "✨", "週末結束後整理": "🧹",
  "試衣間對話": "💬", "先備好替代款": "👗", "多帶一件進試衣間": "🛍️", "結帳前多問一句": "💡", "主動報尺寸": "📏",
  "近期表現超標": "🏆", "近期穩定達標": "✅", "近期接近達標": "💪", "近期落後": "🚀", "近期業績明顯落後": "⚡",
  "近期客單偏低": "💰", "近期客單亮眼": "💎", "近期客單穩定": "💰", "近期客件數偏低": "🛍️", "客件數可以加強": "🛍️", "搭配能力出色": "🌟",
  "近期試穿轉換偏低": "👗", "熱門商品常斷貨": "📦", "近期新品到貨多": "✨", "雨天多影響業績": "☔", "近期人潮偏少": "🚶", "人潮多但業績沒跟上": "⚡", "近期熱銷": "🔥", "維持節奏": "🌈",
};
const KAO = ["(≧▽≦)/", "(＾▽＾)b", "ヾ(＾∇＾)ノ", "(*´∀`*)", "o(≧▽≦)o", "(・∀・)b", "＼(^o^)／", "(｀・ω・´)ゞ", "(*^▽^*)", "ヽ(´▽`)ノ"];
const HELLO = ["今天也一起加油", "開門囉，今天也要漂亮收班", "新的一天，衝一波", "準備好了嗎，開工", "今天的目標一起拿下", "笑著開門，笑著結帳", "今天也要讓客人美美地走出去"];
const WX = { sunny: "☀️", cloudy: "⛅", rainy: "🌧️", storm: "⛈️" };
const dayNo = (date) => { const [y, m, d] = date.split("-").map(Number); return Math.floor(Date.UTC(y, m - 1, d) / 86400000); };
// 黃底粗體的段落標題
const heading = (text, first) => ({ type: "Container", style: "warning", backgroundImage: { url: `${BAR_URL}&solid=1`, fillMode: "Repeat" }, spacing: first ? "None" : "Medium",
  items: [{ type: "TextBlock", text, weight: "Bolder", color: "Dark", wrap: true, size: first ? "Medium" : "Default" }] });

// ---------- 開店提醒卡片 ----------
function openingCard(o) {
  const { store, date, open, w, pg, last, tips, tag } = o;
  const facts = [];
  if (w) facts.push({ title: "天氣", value: `${WX[w.key] || ""} ${w.text}　${w.tmin}–${w.tmax}°C${w.pop !== null ? `　降雨機率 ${w.pop}%` : ""}` });
  if (pg.todayTarget) facts.push({ title: "今日目標", value: `🎯 ${R.money(pg.todayTarget)}` });
  if (!pg.monthTarget && pg.cum) facts.push({ title: "本月累計", value: R.money(pg.cum) });
  const n = dayNo(date);
  const body = [
    heading(`${R.STORES[store]}　開店提醒${tag ? `（${tag}）` : ""}`, true),
    { type: "TextBlock", text: `${R.shortDate(date)}${open ? `　${open} 開門` : ""}　${HELLO[n % HELLO.length]} ${KAO[n % KAO.length]}`, spacing: "Small", wrap: true },
  ];
  if (facts.length) body.push({ type: "FactSet", facts });
  body.push(...progressBars(pg, date));
  if (tips.length) {
    body.push(heading("今日建議 📝"));
    tips.forEach((t, k) => body.push({ type: "TextBlock", text: `${EMOJI[t.label] || "👉"} **${t.label}**　${t.text}`, wrap: true, spacing: k ? "Small" : "Medium" }));
  }
  return { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body } }] };
}
async function buildOpening(ctx, store, date, tag, open) {
  const [data, w] = await Promise.all([loadStore(ctx, store, date), quiet(forecast(store, date), "forecast")]);
  const pg = progress(data, date);
  const lastDay = data.days[addDays(date, -7)];
  const st = stats7(data, date);
  // 順序：整理提醒 → 今天天氣／週末 → 服務技巧 → 近 7 天數據（最多 5 則）
  const coach = coachTips(st).slice(0, 2);
  let svc = serviceTip(st, data, date);
  // 數據建議已經在講試穿轉換時，服務技巧換一則別的，不重複
  if (coach.some((t) => t.label === "近期試穿轉換偏低") && svc.label === SERVICE[0][0]) { const alt = SERVICE[1 + (dayNo(date) % (SERVICE.length - 1))]; svc = { label: alt[0], text: alt[1] }; }
  const tips = [...contextTips(data, date), ...todayTips(w, date), svc, ...coach].slice(0, 5);
  return openingCard({ store, date, open, w, pg, last: lastDay && lastDay.sales > 0 ? lastDay : null, tips, tag });
}
async function postOpening(ctx, store, date, tag, open, hookOverride) {
  const hook = hookOverride || (await R.readWebhook(ctx.sheets, store, ctx.GoogleAuth));
  if (!hook) return { posted: false, reason: "這間門市還沒有設定聊天室通知" };
  if (open === undefined) open = openTime(store, date, await quiet(R.storeDbGet(ctx.GoogleAuth, "/global/settings/storeHours"), "hours"));
  const card = await buildOpening(ctx, store, date, tag, open);
  const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(card) });
  return { posted: r.ok, status: r.status };
}
// 排程每 5 分鐘跑一次：開門前 10 分鐘貼卡片，同一間同一天只貼一次。
// 哪幾間要貼：試算表「設定」分頁 D 欄填「開」的門市。
async function sweepOpening(db, ctx, ts = Date.now()) {
  const now = R.twNow(ts);
  const mins = Number(now.stamp.slice(11, 13)) * 60 + Number(now.stamp.slice(14, 16));
  const cfg = await ctx.sheets.get("設定!A2:D");
  const on = cfg.filter((r) => String(r[3] || "").trim() === "開").map((r) => String(r[0] || "").trim()).filter((s) => R.STORES[s]);
  const hours = await quiet(R.storeDbGet(ctx.GoogleAuth, "/global/settings/storeHours"), "hours");
  await quiet(ctx.sheets.put(`設定!E1:E${cfg.length + 1}`, [[`今日開門時間（${now.date}，${hours ? "含舊工具的調整" : "預設值"}）`], ...cfg.map((r) => [R.STORES[r[0]] ? openTime(r[0], now.date, hours) || "公休" : ""])]), "hours sheet");
  if (!on.length) return [];
  const out = [];
  for (const store of on) {
    const open = openTime(store, now.date, hours);
    if (!open) continue;
    const om = Number(open.slice(0, 2)) * 60 + Number(open.slice(3));
    // 開門前 10 分鐘到開門後 20 分鐘之間都算（排程晚到也補得上）
    if (mins < om - 10 || mins >= om + 20) continue;
    const ref = db.ref(`/report/openSent/${now.date}/${store}`);
    const tx = await ref.transaction((cur) => (cur ? undefined : { at: now.stamp }));
    if (!tx.committed) continue;
    try {
      const r = await postOpening(ctx, store, now.date, "", open);
      if (!r.posted) await ref.remove();
      out.push({ store, ...r });
    } catch (e) { await ref.remove(); out.push({ store, posted: false, error: String(e.message || e) }); }
  }
  return out;
}

// ---------- 一次性：把舊工具某個月的日誌搬進試算表（已有的日期＋門市不覆蓋） ----------
const MOBILE = { linepay: "LINE Pay", jkopay: "街口", applepay: "Apple Pay", pxpay: "全支付", easywallet: "悠遊付", taiwanpay: "台灣 Pay", pi: "Pi 錢包" };
function oldRow(store, date, l) {
  const pay = l.payment || {};
  const arr = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []);
  const sum = (v) => arr(v).reduce((a, x) => a + n0(x && x.amount), 0);
  const detail = [...arr(pay.mobile).map((x) => `${MOBILE[x.key] || x.key || "行動支付"} ${R.num(n0(x.amount))}`), ...arr(pay.other).map((x) => `${x.customName || x.key || "其他"} ${R.num(n0(x.amount))}`)].join("、");
  const petty = arr(l.pettyCash);
  const cc = l.cashClose || {};
  const cust = n0(l.customers) || n0(l.memberCount) + n0(l.nonMemberCount);
  const ts = l._firstSubmittedAt || l._lastModified;
  const w = l.weather || {};
  const wt = [w.text, w.tempMin !== undefined && w.tempMax !== undefined ? `${Math.round(w.tempMin)}–${Math.round(w.tempMax)}°C` : "", l.weatherSupp].filter(Boolean).join(" ");
  const supp = [["人潮", l.crowdSupp], ["客群", l.customerSupp], ["熱銷", l.hotSupp], ["商品", l.stockSupp], ["試穿", l.trySupp]].filter(([, v]) => v).map(([k, v]) => `${k}：${v}`).join("；");
  const blank = (v) => (v === null || v === undefined || v === "" ? "" : n0(v));
  return [date, R.STORES[store], l._firstSubmittedBy || l._modifiedBy || "", n0(l.sales), n0(pay.cash), n0(pay.card), n0(pay.linePay), cust, n0(l.memberCount), n0(l.nonMemberCount),
    cust > 0 ? Math.round(n0(l.sales) / cust) : 0, "",
    n0(l.items), n0(pay.voucherE), n0(pay.voucherG), ...R.paySpread({ mobile: sum(pay.mobile), other: sum(pay.other), payDetail: {
      mobile: arr(pay.mobile).map((x) => ({ key: R.PAY_OPTS.mobile.includes(x.key) ? x.key : "", amount: n0(x.amount) })),
      other: arr(pay.other).map((x) => (R.OTHER_FIXED.includes(x.key) ? { key: x.key, amount: n0(x.amount) } : { key: "其他", name: x.customName || x.key || "", amount: n0(x.amount) })) } }),
    0, "", blank(cc.actual), blank(cc.diff), wt, R.OPTS.crowd[l.crowd] || "", R.OPTS.customer[l.customerType] || "",
    arr(l.hotCategories).map((h) => R.OPTS.hot[h]).filter(Boolean).join("、"), R.OPTS.stock[l.stockStatus] || "", R.OPTS.tryc[l.tryConversion] || "", supp, l.specialNote || "", ts ? R.twNow(ts).stamp : "", l.submitted ? "舊工具匯入" : "舊工具匯入（未送出）"];
}
async function importOld(ctx, ym) {
  const ids = Object.keys(R.STORES);
  const have = new Set((await ctx.sheets.get("回報!A2:B")).map((r) => `${R.cellDate(r[0])}|${String(r[1] || "").trim()}`));
  const [logs, tg, mt] = await Promise.all([
    Promise.all(ids.map((s) => R.storeDbGet(ctx.GoogleAuth, `/stores/${s}/dailyLogs`, `orderBy=%22%24key%22&startAt=%22${ym}-01%22&endAt=%22${ym}-31%22`))),
    Promise.all(ids.map((s) => R.storeDbGet(ctx.GoogleAuth, `/stores/${s}/targets/${ym}`))),
    R.storeDbGet(ctx.GoogleAuth, `/global/monthlyTargets/${ym}`),
  ]);
  const rows = [];
  ids.forEach((s, i) => Object.entries(logs[i] || {}).forEach(([d, l]) => {
    if (!l || typeof l !== "object" || !(n0(l.sales) > 0) || have.has(`${d}|${R.STORES[s]}`)) return;
    rows.push(oldRow(s, d, l));
  }));
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : ids.findIndex((s) => R.STORES[s] === a[1]) - ids.findIndex((s) => R.STORES[s] === b[1])));
  if (rows.length) await ctx.sheets.appendRows(`回報!A:${R.LAST_COL}`, rows);
  // 目標另外存一個分頁（每日目標＋月目標），之後不靠舊資料庫也查得到
  const trows = [["日期", "門市代號", "門市", "每日目標", "月目標"]];
  ids.forEach((s, i) => Object.entries(tg[i] || {}).sort().forEach(([d, v]) => { if (/^\d{4}-\d{2}-\d{2}$/.test(d)) trows.push([d, s, R.STORES[s], n0(v), n0(mt && mt[s])]); }));
  await ctx.sheets.put(`目標!A1:E${trows.length}`, trows);
  return { added: rows.length, targets: trows.length - 1 };
}
// 把某間店某天的開店提醒內容寫成文字放到「開店提醒預覽」分頁（不貼聊天室）
async function previewOpening(ctx, store, date) {
  const hours = await quiet(R.storeDbGet(ctx.GoogleAuth, "/global/settings/storeHours"), "hours");
  const card = await buildOpening(ctx, store, date, "", openTime(store, date, hours));
  const lines = [];
  card.attachments[0].content.body.forEach((b0) => { let b = b0; if (b.type === "Image") return; if (b.items) b = b.items[0]; if (b.facts) b.facts.forEach((f) => lines.push(`${f.title}　${f.value}`)); else lines.push(String(b.text || "").replace(/\*\*/g, "")); });
  await ctx.sheets.put(`開店提醒預覽!A1:A${lines.length + 1}`, [[`產生時間 ${R.twNow().stamp}`], ...lines.map((x) => [x])]);
  return lines.length;
}

module.exports = { barPng, contextTips, serviceTip, progressBars, oldRow, importOld, previewOpening,  GEO, OPEN_DEFAULT, openTime, weatherKey, forecast, sheetDay, oldDay, loadStore, progress, progressFor, progressAll, stats7, coachTips, todayTips, openingCard, buildOpening, postOpening, sweepOpening, addDays };
