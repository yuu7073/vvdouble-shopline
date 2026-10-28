// VV DOUBLE · 商品 SEO 標題／描述自動產生
// 規則（2026-10-29 Vivian 定案）：
//   標題 = 品名去掉「-顏色」＋「｜大尺碼女裝 VV DOUBLE」（組合價前綴保留）
//   描述 = VV DOUBLE（獨家自訂）大尺碼＋品類，商品描述的「・」重點（最多兩條），尺寸，全台門市都能試穿
//   不寫材質；重點句拿掉 ~ ! 與「必買」；含品牌禁用詞的句子整句略過

const SUFFIX = "｜大尺碼女裝 VV DOUBLE";
const MAX_DESC = 80;
// 規則版本：改了規則就 +1，雲端排程會自動把上架商品重跑一次
const RULE_VERSION = 2;
// 身形焦慮相關字眼：重點句含任一個就整句略過（2026-10-29 Vivian：遮、肉、修飾、顯 都要拿掉）
const BANNED = ["遮", "藏", "肉", "胖", "瘦", "顯", "修飾", "缺點", "掰掰袖", "蝴蝶袖", "副乳", "小腹", "肚", "腿粗", "手臂粗", "蘿蔔腿", "大腿", "比例", "身材", "不怕", "顯小", "臉小"];

// 品類：依序比對品名，先中先用
const CATS = [
  ["BRA TOP", "BRA TOP"], ["內著", "內著"], ["內衣", "內著"],
  ["泳裝", "泳裝"], ["泳衣", "泳裝"],
  ["洋裝", "洋裝"], ["連身裙", "連身裙"], ["連身褲", "連身褲"], ["吊帶褲", "吊帶褲"],
  ["套裝", "套裝"],
  ["牛仔外套", "牛仔外套"], ["西裝外套", "西裝外套"], ["針織外套", "針織外套"], ["外套", "外套"],
  ["風衣", "風衣"], ["大衣", "大衣"], ["罩衫", "罩衫"], ["背心外套", "背心外套"],
  ["牛仔褲", "牛仔褲"], ["寬褲", "寬褲"], ["褲裙", "褲裙"], ["長褲", "長褲"], ["短褲", "短褲"], ["褲", "褲子"],
  ["半身裙", "半身裙"], ["長裙", "長裙"], ["短裙", "短裙"], ["百褶裙", "百褶裙"], ["裙", "裙子"],
  ["大學T", "大學T"], ["帽T", "帽T"], ["T-SHIRT", "T恤"], ["TSHIRT", "T恤"], ["T恤", "T恤"], ["襯衫", "襯衫"], ["針織", "針織上衣"],
  ["背心", "背心"], ["細肩帶", "細肩帶上衣"], ["上衣", "上衣"],
  ["鞋", "鞋款"], ["皮帶", "加長皮帶"],
];
// 這些不加「大尺碼」
const ACC = [["包", "包款"], ["帽", "帽款"], ["項鍊", "飾品"], ["耳環", "飾品"], ["髮", "飾品"], ["襪", "襪子"]];

function zh(t) { return ((t || {})["zh-hant"] || "").trim(); }

function stripTags(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|td|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/ /g, " ");
}

function colorNames(p) {
  return (p.variant_options || [])
    .filter((o) => o.type === "color")
    .map((o) => zh(o.name_translations).replace(/[（(].*$/, "").trim())
    .filter(Boolean);
}

function sizeNames(p) {
  const out = [];
  (p.variant_options || []).filter((o) => o.type === "size").forEach((o) => {
    const n = zh(o.name_translations).replace(/[（(].*$/, "").trim();
    if (n && out.indexOf(n) < 0) out.push(n);
  });
  return out;
}

// 品名去掉最後的「-顏色」：只有確定是顏色才拿掉（含「色」字，或等於規格裡的顏色名）
function baseTitle(p) {
  const t = zh(p.title_translations);
  const m = t.match(/^(.*\S)\s*[-－]\s*([^-－]{1,10})$/);
  if (!m) return t;
  const seg = m[2].trim();
  const colors = colorNames(p);
  const isColor = /色/.test(seg) || colors.some((c) => c && (seg === c || seg.indexOf(c) === 0 || c.indexOf(seg) === 0));
  return isColor ? m[1].trim() : t;
}

function seoTitle(p) {
  const b = baseTitle(p);
  if (!b) return "";
  return b.indexOf("大尺碼女裝 VV DOUBLE") >= 0 ? b : b + SUFFIX;
}

function bullets(html) {
  const lines = stripTags(html).split("\n").map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const l of lines) {
    if (!/^[・•‧·●▪︎]/.test(l)) continue;
    let s = l.replace(/^[・•‧·●▪︎\s]+/, "")
      .replace(/必買/g, "")
      .replace(/[~～]+/g, "，")
      .replace(/[!！]+/g, "")
      .replace(/\s+/g, " ")
      .replace(/^[，、。\s]+|[，、。\s]+$/g, "")
      .replace(/，{2,}/g, "，");
    if (!s || s.length < 4) continue;
    if (BANNED.some((w) => s.indexOf(w) >= 0)) continue;
    out.push(s);
    if (out.length >= 2) break;
  }
  return out;
}

// 規格沒有尺寸時，從尺寸表標題列抓（SIZE (CM) | F | ...）
function sizesFromChart(html) {
  const text = stripTags(html).split("\n").map((s) => s.trim()).filter(Boolean);
  const i = text.findIndex((s) => /^SIZE\s*\(?CM\)?$/i.test(s));
  if (i < 0) return [];
  const out = [];
  for (let k = i + 1; k < text.length && k < i + 8; k++) {
    const s = text[k];
    if (/^(F|[SMLX0-9]{1,6}|\d?L\d?L|[SMLX]+[0-9]?L?)$/i.test(s) && s.length <= 6) out.push(s);
    else break;
  }
  return out;
}

function sizePart(sizes) {
  if (!sizes.length) return "";
  if (sizes.length === 1) return sizes[0] + " 尺寸";
  if (sizes.length > 4) return "尺寸 " + sizes[0] + "–" + sizes[sizes.length - 1];
  return "尺寸 " + sizes.join("、");
}

function category(title) {
  const T = title.toUpperCase();
  for (const [k, w] of ACC) if (title.indexOf(k) >= 0 && !CATS.some(([c]) => title.indexOf(c) >= 0)) return { word: w, plus: false };
  for (const [k, w] of CATS) if (T.indexOf(k.toUpperCase()) >= 0) return { word: w, plus: true };
  return { word: "女裝", plus: true };
}

function seoDescription(p) {
  const title = zh(p.title_translations);
  const html = zh(p.description_translations);
  const cat = category(title);
  const head = "VV DOUBLE " + (title.indexOf("獨家自訂") >= 0 ? "獨家自訂" : "") + (cat.plus ? "大尺碼" : "") +
    (/^[A-Z]/i.test(cat.word) && cat.plus ? " " : "") + cat.word;
  let sizes = sizeNames(p);
  if (!sizes.length) sizes = sizesFromChart(html);
  const sz = sizePart(sizes);
  const tail = (sz ? sz + "，" : "") + "全台門市都能試穿。";
  const bs = bullets(html);
  const build = (list) => head + (list.length ? "，" + list.join("，") : "") + "。" + tail;
  let d = build(bs);
  if (d.length > MAX_DESC && bs.length > 1) d = build(bs.slice(0, 1));
  return d;
}

function buildSeo(p) {
  return { title: seoTitle(p), description: seoDescription(p) };
}

module.exports = { RULE_VERSION, buildSeo, seoTitle, seoDescription, baseTitle, bullets, sizesFromChart, SUFFIX };
