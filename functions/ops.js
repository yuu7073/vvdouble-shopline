// 門市回報的「本月進度」與「開店提醒」：
// 資料 = 試算表（新的回報）＋ 門市營運中心資料庫（舊的日誌、目標、營業時間；唯讀）
const R = require("./report");

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
  const w = String(r[27] || "");
  return {
    sales: n0(r[3]), customers: n0(r[7]), items: n0(r[17]),
    weather: /雷/.test(w) ? "storm" : /雨/.test(w) ? "rainy" : w ? "other" : "",
    crowd: rev("crowd")[String(r[28] || "")] || "", stock: rev("stock")[String(r[31] || "")] || "", tryc: rev("tryc")[String(r[32] || "")] || "",
    hot: String(r[30] || "").split("、").map((x) => rev("hot")[x]).filter(Boolean),
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
  if (c(st.stock, "hot-out") >= 2) add(1, "熱門商品常斷貨", `近 7 天有 ${c(st.stock, "hot-out")} 天熱門商品斷貨，今天記得跟總部追補貨，先準備替代款的推薦說法`);
  if (c(st.stock, "new") >= 2) add(4, "近期新品到貨多", `近 7 天有 ${c(st.stock, "new")} 天新品到貨，主動介紹給回頭客，用穿搭組合帶新品`);
  const rainy = c(st.weather, "rainy") + c(st.weather, "storm");
  const low = st.avgRate !== null && st.avgRate < 90;
  if (rainy >= 3 && low) add(3, "雨天多影響業績", `近 7 天有 ${rainy} 天下雨，客流受影響，進店的每一位都要做完整服務`);
  if (c(st.crowd, "cold") >= 3 && low) add(3, "近期人潮偏少", `近 7 天有 ${c(st.crowd, "cold")} 天人潮冷清，今天主動招呼店外客人，進店客要留久一點`);
  const busy = c(st.crowd, "warm") + c(st.crowd, "full");
  if (busy >= 4 && st.avgRate !== null && st.avgRate < 100) add(3, "人潮多但業績沒跟上", `近 7 天有 ${busy} 天人潮熱絡但沒達標，人手分配要更積極，結帳加快，別讓客人等`);
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
  if ([5, 6, 0].includes(dow(date))) tips.push({ label: "週末人潮", text: "開門前先排好人力和試衣間動線，熱賣尺寸先補上架" });
  return tips.slice(0, 2);
}

// ---------- 開店提醒卡片 ----------
function openingCard(o) {
  const { store, date, open, w, pg, last, tips, tag } = o;
  const facts = [];
  if (w) facts.push({ title: "天氣", value: `${w.text}　${w.tmin}–${w.tmax}°C${w.pop !== null ? `　降雨機率 ${w.pop}%` : ""}` });
  if (pg.todayTarget) facts.push({ title: "今日目標", value: R.money(pg.todayTarget) });
  if (pg.monthTarget) {
    facts.push({ title: "本月進度", value: `${R.money(pg.cum)} / ${R.money(pg.monthTarget)}（${pg.rate}%）` });
    if (pg.needPerDay !== null) facts.push({ title: "剩餘每日需", value: `${R.money(pg.needPerDay)}（剩 ${pg.daysLeft} 天）` });
  } else if (pg.cum) facts.push({ title: "本月累計", value: R.money(pg.cum) });
  if (last) facts.push({ title: "上週同日", value: `${R.money(last.sales)}　來客 ${last.customers}` });
  const body = [
    { type: "TextBlock", text: `${R.STORES[store]}　開店提醒${tag ? `（${tag}）` : ""}`, weight: "Bolder", size: "Medium", wrap: true },
    { type: "TextBlock", text: `${R.shortDate(date)}${open ? `　${open} 開門` : ""}`, isSubtle: true, spacing: "None", wrap: true },
  ];
  if (facts.length) body.push({ type: "FactSet", facts });
  if (tips.length) {
    body.push({ type: "TextBlock", text: "今日建議", weight: "Bolder", spacing: "Medium" });
    tips.forEach((t) => body.push({ type: "TextBlock", text: `**${t.label}**　${t.text}`, wrap: true, spacing: "Small" }));
  }
  return { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body } }] };
}
async function buildOpening(ctx, store, date, tag, open) {
  const [data, w] = await Promise.all([loadStore(ctx, store, date), quiet(forecast(store, date), "forecast")]);
  const pg = progress(data, date);
  const lastDay = data.days[addDays(date, -7)];
  let tips = [...todayTips(w, date), ...coachTips(stats7(data, date))].slice(0, 4);
  if (!tips.length) tips = [{ label: "維持節奏", text: "照平常的服務節奏，主動招呼、完整搭配、結帳前多問一句" }];
  return openingCard({ store, date, open, w, pg, last: lastDay && lastDay.sales > 0 ? lastDay : null, tips, tag });
}
async function postOpening(ctx, store, date, tag, open) {
  const hook = await R.readWebhook(ctx.sheets, store, ctx.GoogleAuth);
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
  if (!on.length) return [];
  const hours = await quiet(R.storeDbGet(ctx.GoogleAuth, "/global/settings/storeHours"), "hours");
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

module.exports = { GEO, OPEN_DEFAULT, openTime, weatherKey, forecast, sheetDay, oldDay, loadStore, progress, progressFor, progressAll, stats7, coachTips, todayTips, openingCard, buildOpening, postOpening, sweepOpening, addDays };
