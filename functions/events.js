// 門市活動：直接讀行銷排程試算表的「活動明細」分頁（唯讀），只給門市看兩週內、通路有門市的活動。
// 給門市的欄位只有：名稱、類型、檔期、通路、優惠機制、門市注意事項。
// 「注意標籤」「行銷企劃」等內部欄位（可能有毛利、抽成）一律不讀出去。
const EVENT_SHEET = "1vrsXPERq4ppkHmlhdwU3IHKc6WZrgN9Kc8H97mvVQAs";
const RANGE = "活動明細!A2:R300";
const SPAN = 14;

const iso = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const addDays = (date, n) => { const [y, m, d] = date.split("-").map(Number); return iso(y, m, d + n); };
const diff = (a, b) => Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);
const short = (date) => { const [y, m, d] = date.split("-").map(Number); return `${m}/${d}（${"日一二三四五六".charAt(new Date(Date.UTC(y, m - 1, d)).getUTCDay())}）`; };
const clean = (v, max) => String(v === undefined || v === null ? "" : v).replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim().slice(0, max);

// 表上的日期沒有年份（例如「11/27（五）\n10:00」「12/1（直播 11/30）」），年份取離今天最近的那一年
function parseWhen(v, today) {
  if (typeof v === "number" && v > 30000) {
    const ms = Math.round((v - 25569) * 86400000), d = new Date(ms);
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    return { date: d.toISOString().slice(0, 10), time: mins ? d.toISOString().slice(11, 16) : "" };
  }
  const s = String(v || "");
  let m = /(\d{4})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})/.exec(s), date;
  if (m) date = iso(+m[1], +m[2], +m[3]);
  else {
    m = /(\d{1,2})\s*\/\s*(\d{1,2})/.exec(s);
    if (!m || +m[1] < 1 || +m[1] > 12 || +m[2] < 1 || +m[2] > 31) return null;
    const y = +today.slice(0, 4);
    date = [y - 1, y, y + 1].map((yy) => iso(yy, +m[1], +m[2])).sort((a, b) => Math.abs(diff(a, today)) - Math.abs(diff(b, today)))[0];
  }
  // 時間只認日期後面、括號外面的（括號裡常是直播時間之類的備註）
  const rest = s.slice(m.index + m[0].length).replace(/[（(][^）)]*[）)]/g, "");
  const t = /(\d{1,2})[:：](\d{2})/.exec(rest);
  return { date, time: t && +t[1] < 24 && +t[2] < 60 ? `${String(+t[1]).padStart(2, "0")}:${t[2]}` : "" };
}

// rows[0] 是欄名列；欄位用欄名找，表上加欄、搬欄都不用改
function parseEvents(rows, today) {
  const head = (rows[0] || []).map((h) => String(h || "").trim());
  const find = (re) => head.findIndex((h) => re.test(h));
  const ix = { type: find(/^類型/), name: find(/名稱/), start: find(/^開始/), end: find(/^結束/), channel: find(/^通路/), mech: find(/優惠機制/), note: find(/^門市注意事項/) };
  if (ix.name < 0 || ix.start < 0 || ix.channel < 0) return [];
  const out = [];
  rows.slice(1).forEach((r) => {
    const name = clean(r[ix.name], 60), s = parseWhen(r[ix.start], today);
    if (!name || !s) return;
    const channel = clean(r[ix.channel], 30);
    // 「官網（門市待確認）」不算有門市
    if (!/門市/.test(channel.replace(/[（(][^）)]*[）)]/g, ""))) return;
    let e = ix.end >= 0 ? parseWhen(r[ix.end], s.date) : null;
    if (e && e.date < s.date) e = null;
    const mech = ix.mech >= 0 ? clean(r[ix.mech], 300) : "";
    out.push({
      name, type: ix.type >= 0 ? clean(r[ix.type], 10) : "", channel: channel.replace(/\s*[&＆+＋]\s*/g, "＋"),
      start: s.date, startTime: s.time, end: e ? e.date : "", endTime: e ? e.time : "",
      mech: mech === "無" ? "" : mech, note: ix.note >= 0 ? clean(r[ix.note], 200) : "",
    });
  });
  return out;
}

function decorate(e, today) {
  const when = `${short(e.start)}${e.startTime ? " " + e.startTime : ""}${e.end ? ` – ${short(e.end)}${e.endTime ? " " + e.endTime : ""}` : " 起"}`;
  let state, tag;
  if (e.start > today) { const n = diff(e.start, today); state = "soon"; tag = n === 1 ? "明天開始" : `${n} 天後開始`; }
  else if (e.end === today) { state = "last"; tag = e.endTime ? `今天 ${e.endTime} 結束` : "今天最後一天"; }
  else if (e.start === today) { state = "start"; tag = e.startTime ? `今天 ${e.startTime} 開始` : "今天開始"; }
  else { state = "on"; tag = e.end ? `進行中，到 ${short(e.end)}` : "進行中"; }
  return { ...e, when, state, tag };
}
// 兩週內：還沒結束、而且 14 天內會開始。沒寫結束日的，開始後 30 天內都算進行中
function upcoming(events, today, span = SPAN) {
  return events
    .filter((e) => (e.end ? e.end >= today : addDays(e.start, 30) >= today) && e.start <= addDays(today, span))
    .sort((a, b) => (a.start + a.startTime < b.start + b.startTime ? -1 : a.start + a.startTime > b.start + b.startTime ? 1 : 0))
    .map((e) => decorate(e, today));
}
async function load(ctx, today) {
  if (!ctx.eventRows) ctx.eventRows = await ctx.eventSheets.get(RANGE);
  return upcoming(parseEvents(ctx.eventRows, today), today);
}

// 開店提醒卡片裡的「近期活動」段落
function cardBlocks(list, heading) {
  if (!list.length) return [];
  const body = [heading("近期活動 📣")];
  const group = (title, arr) => {
    if (!arr.length) return;
    body.push({ type: "TextBlock", text: title, weight: "Bolder", isSubtle: true, size: "Small", spacing: "Medium" });
    arr.forEach((e) => {
      const mark = e.state === "start" ? "🟢" : e.state === "last" ? "🔴" : e.state === "on" ? "🟡" : "🗓️";
      body.push({ type: "TextBlock", text: `${mark} **${e.name}**　${e.tag}`, wrap: true, spacing: "Small" });
      body.push({ type: "TextBlock", text: `${e.when}　${e.channel}`, wrap: true, isSubtle: true, size: "Small", spacing: "None" });
      if (e.mech) body.push({ type: "TextBlock", text: e.mech.replace(/\n/g, "\n\n"), wrap: true, spacing: "None" });
      if (e.note) body.push({ type: "TextBlock", text: `⚠️ ${e.note.replace(/\n/g, "\n\n")}`, wrap: true, color: "Attention", spacing: "None" });
    });
  };
  const shown = list.slice(0, 6);
  group("進行中", shown.filter((e) => e.state !== "soon"));
  group("即將開始", shown.filter((e) => e.state === "soon"));
  return body;
}

module.exports = { EVENT_SHEET, parseWhen, parseEvents, upcoming, load, cardBlocks, addDays };
