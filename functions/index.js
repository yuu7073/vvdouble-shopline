// VV DOUBLE · Shopline 批次上圖 · Cloud Function 中間站
// 網頁 → 這裡（Token 存在 Secret）→ Shopline Open API
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { GoogleAuth } = require("google-auth-library");
const { buildSeo, RULE_VERSION } = require("./seo");

admin.initializeApp();

const SHOPLINE_TOKEN = defineSecret("SHOPLINE_TOKEN");
const TOOL_PASSWORD = defineSecret("TOOL_PASSWORD");
const ANTHROPIC_KEY = defineSecret("ANTHROPIC_KEY");

// 美編整合工具 · 商品文案 AI 生成（P1 四段）品牌鐵律 prompt
const BRAND_SYS = `你是 VV DOUBLE（台灣大尺碼女裝品牌）的美編，負責寫 P1 商品圖上的四段文字。
核心原則：每一段都只講「衣服本身的事實」（材質、版型、設計細節、穿法、尺碼、穿起來的感覺）。
品名裡常夾雜行銷口號、系列名、情境句（例：下班後換我了、太涼了吧、借我穿一下、木槿花開），這些一律忽略、不得出現也不得延伸；只取品名中的材質、版型、設計細節、品項四類字。

品牌鐵律（全部遵守）：
1. 絕不販賣身形焦慮，不先戳痛點再給解法。
2. 禁用字：顯胖、遮肉、藏肉、修飾缺點。「顯瘦」不可當賣點。
3. 正向框架：舒適、合身、自在；衣服配合人，不是人配合衣服。
4. 不提競品、不做比較。不帶價格。永久禁用破折號「——」。
5. 不做負面行銷、飢餓行銷。
6. 語氣平實、口語、像店員在介紹，不要文青、不要擬人、不要雙關、不要誇飾、不要「每天都有小亮點」這類空話。
7. 大標不得出現「顯瘦」「修飾」；賣點與三標籤可用「修飾身型」「修身」「順身」。
目標客群稱呼：棉花糖女孩、肉肉女孩。

四段寫法：
- tag（情境標籤）：優先從句庫挑一個最合適的：#不修邊幅、#每天都想穿、#剛剛好的浪漫、#精緻小巧思、#穿搭小心機、#夏日降溫提案、#日常慵懶感、#舒服到不想脫、#秋冬必備款。真的都不合才自己寫，必須同樣是講「穿衣狀態」的 4～6 字短句。
- title（商品大標，兩行）：就是衣服名稱，只用「版型或設計詞＋材質＋品項」組成，例：["自在慵懶落肩","寬鬆長袖上衣"]、["彈力蕾絲撞色","包邊透膚上衣"]、["燈芯絨領片","牛仔外套"]。每行 4～6 字，語意自然斷句，不加形容、不加情境。
- slogan（一句賣點）：一句話講穿起來的事實，8～12 字，最多一個驚嘆號。範例：寬鬆版型設計，不貼身更自在！／舒服到不想脫下來！／撞色細節，讓簡約多一點亮點／輕鬆穿出好比例，舒服一整天／親膚舒適材質，推薦包色！
- tags3（三標籤）：格式「特性｜尺碼或穿法｜族群」。第 1 個講這件的材質或版型特點（4～5 字，如：挺版材質、親膚彈性、落肩修飾身型、可調節肩帶、舒適彈性腰圍）；第 2 個是尺碼標籤，若 user 訊息有提供「尺碼標籤」就原封不動使用，沒有就寫穿法（如：疊穿搭配、單穿好看）；第 3 個從族群詞庫選：不挑身型、不限身型、肉肉友善款、肉肉女友善、日常百搭、精緻系穿搭、日常慵懶感。

字數是硬限制，做圖時每段只能排在一行。
只輸出 JSON：{"tag":"...","title":["...","..."],"slogan":"...","tags3":["...","...","..."]}，不要任何其他文字。`;

const LIMITS = { tag: 7, titleLine: 6, slogan: 12, tagItem: 6 };
function copyTooLong(o, sizeTag) {
  const t = (o.tag || "").replace(/^#/, "");
  if (t.length > LIMITS.tag) return true;
  if ((o.titleLines || []).some((l) => l.length > LIMITS.titleLine)) return true;
  if ((o.slogan || "").replace(/[！!，,。]/g, "").length > LIMITS.slogan) return true;
  if ((o.tags3 || []).some((x) => x !== sizeTag && x.length > LIMITS.tagItem)) return true;
  return false;
}

// 品名過濾：去《》〈〉【】內容、去尾端顏色、去常見行銷口號前綴，只留設計詞＋品項
function cleanProductName(name) {
  let s = String(name || "");
  s = s.replace(/[《〈【\[][^》〉】\]]*[》〉】\]]/g, "");
  s = s.replace(/[-－–][^-－–]{1,6}$/, ""); // -藍色 / -淺灰
  s = s.replace(/顯瘦/g, "");
  return s.trim();
}

// 從 Shopline 商品描述的尺寸表抓尺碼：<td>SIZE (CM)</td><td>F</td>... 或 SM/ML/XL2L/3L4L/5L6L
function extractSizes(descHtml) {
  const h = String(descHtml || "");
  const i = h.search(/SIZE\s*\(?CM\)?/i);
  if (i < 0) return [];
  const rowEnd = h.indexOf("</tr>", i);
  const row = h.slice(i, rowEnd > 0 ? rowEnd : i + 2000);
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean);
  return cells.filter((c) => !/SIZE/i.test(c) && c.length <= 6);
}
function sizeTagFor(sizes) {
  if (!sizes || !sizes.length) return "";
  if (sizes.length === 1 && /^F$/i.test(sizes[0])) return "60-120kg皆可穿";
  const tail = (code) => { const t = String(code).toUpperCase().match(/\d+[A-Z]|[A-Z]/g); return t ? t[t.length - 1] : code; };
  return `${tail(sizes[0])}-${tail(sizes[sizes.length - 1])}都能穿`;
}

async function anthropicCopyOnce(key, title, desc, mode, sizeTag, extraNote) {
  const user = `取向：${mode || "新品介紹"}\n品名（已過濾）：${title}\n商品描述：${(desc || "").slice(0, 500)}${sizeTag ? `\n尺碼標籤（tags3 第 2 個，原封不動使用）：${sizeTag}` : ""}${extraNote ? "\n\n" + extraNote : ""}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1024, system: BRAND_SYS, messages: [{ role: "user", content: user }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ("HTTP " + r.status));
  const txt = (j.content && j.content[0] && j.content[0].text) || "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("AI 回傳格式異常");
  const o = JSON.parse(m[0]);
  let tag = (o.tag || "").trim();
  if (tag && tag[0] !== "#") tag = "#" + tag;
  let titleLines = Array.isArray(o.title) ? o.title : String(o.title || "").split(/[\n／/]/);
  titleLines = titleLines.map((s) => String(s).trim()).filter(Boolean).slice(0, 2);
  let tags3 = (o.tags3 || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 3);
  if (sizeTag && tags3.length === 3) tags3[1] = sizeTag; // 尺碼標籤一律用系統算的
  return { tag, titleLines, slogan: (o.slogan || "").trim(), tags3 };
}

async function anthropicCopy(key, rawTitle, desc, mode, descHtml) {
  const title = cleanProductName(rawTitle);
  const sizeTag = sizeTagFor(extractSizes(descHtml));
  let o = await anthropicCopyOnce(key, title, desc, mode, sizeTag);
  if (copyTooLong(o, sizeTag)) {
    const note = `上一版太長，不符合字數硬限制，請縮短後重寫：${JSON.stringify({ tag: o.tag, title: o.titleLines, slogan: o.slogan, tags3: o.tags3 })}`;
    o = await anthropicCopyOnce(key, title, desc, mode, sizeTag, note);
  }
  return { tag: o.tag, title: o.titleLines.join("\n"), titleLines: o.titleLines, slogan: o.slogan, tags3: o.tags3, sizeTag };
}

const SL = "https://open.shopline.io/v1";
const ALLOW_ORIGINS = [
  "https://yuu7073.github.io",
  "https://vvdouble-shopline.web.app",
  "https://vvdouble-shopline.firebaseapp.com",
  "http://localhost",
  "http://127.0.0.1",
  "null", // 直接用檔案開啟 HTML 時
];

function cors(req, res) {
  const origin = req.headers.origin || "null";
  const ok = ALLOW_ORIGINS.some((o) => origin === o || origin.startsWith(o + ":"));
  res.set("Access-Control-Allow-Origin", ok ? origin : ALLOW_ORIGINS[0]);
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Tool-Password");
  res.set("Access-Control-Max-Age", "3600");
}

// Google Sheets（用 Cloud Function 的服務帳號讀取；表單需分享給該帳號）
async function sheetsFetch(path) {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const client = await auth.getClient();
  const r = await client.request({ url: "https://sheets.googleapis.com/v4/spreadsheets/" + path });
  return r.data;
}
async function serviceEmail() {
  try {
    const auth = new GoogleAuth();
    const c = await auth.getCredentials();
    if (c && c.client_email) return c.client_email;
  } catch (e) {}
  try {
    const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email", { headers: { "Metadata-Flavor": "Google" } });
    return await r.text();
  } catch (e) { return ""; }
}

async function slFetch(token, path, opt = {}) {
  const headers = { Authorization: "Bearer " + token, Accept: "application/json" };
  if (opt.json) {
    headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(opt.json);
  }
  const r = await fetch(SL + path, { method: opt.method || "GET", headers, body: opt.body });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

// ===== 活動收尾（活動結束後恢復原狀）=====
async function runCleanupJob(token, db, jobId, job) {
  const ref = db.ref(`/cleanupJobs/${jobId}`);
  await ref.update({ status: "running", startedAt: Date.now() });
  const products = job.products || [];
  const revert = job.revert || {};
  const results = {};
  const note = (id, m) => { results[id] = ((results[id] || "") + m + " ").trim(); };
  // 1) 分類：原本沒有這個分類的商品才移除
  if (revert.category && job.categoryId) {
    const ids = products.filter((p) => !((p.before && p.before.category_ids) || []).includes(job.categoryId)).map((p) => p.id);
    for (let i = 0; i < ids.length; i += 100) {
      const grp = ids.slice(i, i + 100);
      const r = await slFetch(token, `/categories/bulk_assign`, { method: "POST", json: { product_ids: grp, category_ids: [job.categoryId], is_bulk_remove: true, unset_other_categories: false } });
      grp.forEach((id) => note(id, r.status === 200 || r.status === 201 ? "✔分類" : "✖分類"));
    }
  }
  for (const p of products) {
    const before = p.before || {};
    try {
      // 2) 標籤：只移除這次新加、原本沒有的
      if (revert.tags && (job.tags || []).length) {
        const toRemove = (job.tags || []).filter((t) => !(before.tags || []).includes(t));
        if (toRemove.length) {
          const r = await slFetch(token, `/products/${p.id}/tags`, { method: "PATCH", json: { tags: toRemove, update_mode: "remove" } });
          note(p.id, r.status === 200 ? "✔標籤" : "✖標籤");
        }
      }
      // 3) 不適用折扣／上架時間：恢復原值
      const fields = {};
      if (revert.excluded && before.is_excluded_promotion === false) note(p.id, "⚠手動關閉不適用折扣");
      if (revert.schedule) fields.schedule_publish_at = before.schedule_publish_at || null;
      if (revert.status && before.status) fields.status = before.status;
      if (Object.keys(fields).length) {
        const r = await slFetch(token, `/products/${p.id}`, { method: "PUT", json: fields });
        note(p.id, (r.status === 200 || r.status === 201) ? "✔恢復" : "✖恢復" + JSON.stringify(r.body).slice(0, 80));
      }
    } catch (e) { note(p.id, "✖" + String(e.message).slice(0, 80)); }
  }
  // 3b) 庫存：Primary 倉數量 > 0 的商品上架
  if (revert.restock) {
    try {
      const wr = await slFetch(token, `/warehouses?per_page=50`);
      const whs = (wr.body && wr.body.items) || [];
      const primary = whs.find((w) => /primary|預設/i.test(w.name || "")) || whs[0];
      if (!primary) throw new Error("找不到 Primary 倉庫");
      const toActive = [];
      for (const p of products) {
        const sr = await slFetch(token, `/products/${p.id}/stocks`);
        const b = sr.body || {};
        let qty = 0;
        const sum = (arr) => (arr || []).filter((x) => x.warehouse_id === primary.id).reduce((a, x) => a + (Number(x.quantity) || 0), 0);
        if (Array.isArray(b.variations) && b.variations.length) b.variations.forEach((v) => { qty += sum(v.stocks); });
        else qty = sum(b.stocks);
        if (qty > 0) toActive.push(p.id); else note(p.id, "庫存0不上架");
      }
      for (let i = 0; i < toActive.length; i += 100) {
        const grp = toActive.slice(i, i + 100);
        const r = await slFetch(token, `/products/status/bulk`, { method: "PUT", json: { products: grp.map((id) => ({ id, status: "active" })) } });
        grp.forEach((id) => note(id, (r.status === 200 || r.status === 201) ? "✔上架" : "✖上架"));
      }
    } catch (e) { results["_restock"] = "✖ 庫存判斷失敗 " + String(e.message).slice(0, 80); }
  }
  // 4) 測試用：刪掉這次建立的限時促銷價活動
  if (revert.flash && (job.flashIds || []).length) {
    for (const fid of job.flashIds) {
      const r = await slFetch(token, `/flash_price_campaigns/${fid}`, { method: "DELETE" });
      results["flash_" + fid] = (r.status === 200 || r.status === 204) ? "✔刪除促銷活動" : "✖刪除促銷活動 " + r.status;
    }
  }
  const failed = Object.values(results).filter((v) => v.includes("✖")).length;
  await ref.update({ status: "done", finishedAt: Date.now(), results, failed });
  return { results, failed };
}

async function runDueCleanups(token, db) {
  const snap = await db.ref("/cleanupJobs").get();
  const out = [];
  if (!snap.exists()) return out;
  const jobs = snap.val();
  for (const id of Object.keys(jobs)) {
    if (jobs[id].status === "pending" && (jobs[id].endAt || 0) <= Date.now()) {
      const r = await runCleanupJob(token, db, id, jobs[id]);
      out.push({ id, failed: r.failed });
    }
  }
  return out;
}

exports.cleanupHourly = onSchedule(
  { schedule: "every 60 minutes", region: "asia-east1", timeZone: "Asia/Taipei", secrets: [SHOPLINE_TOKEN], timeoutSeconds: 540, memory: "512MiB" },
  async () => {
    const ran = await runDueCleanups(SHOPLINE_TOKEN.value(), admin.database());
    try {
      const seo = await seoRerunIfRuleChanged(SHOPLINE_TOKEN.value(), admin.database());
      if (seo) console.log("SEO 規則更新，已重跑：" + seo);
    } catch (e) { console.error("SEO 重跑失敗", e); }
    console.log("cleanup ran:", JSON.stringify(ran));
  }
);

// ===== 商品 SEO 自動產生（標題＝品名去顏色＋｜大尺碼女裝 VV DOUBLE；描述＝品類＋重點＋尺寸）=====
const SEO_FIELDS = ["id", "title_translations", "description_translations", "variant_options", "seo_title_translations", "seo_description_translations", "status"];
async function applySeo(token, db, p, by) {
  const seo = buildSeo(p);
  if (!seo.title) return { id: p.id, skipped: "沒有品名" };
  const curT = (p.seo_title_translations || {})["zh-hant"] || "";
  const curD = (p.seo_description_translations || {})["zh-hant"] || "";
  if (curT === seo.title && curD === seo.description) return { id: p.id, same: true, title: seo.title, description: seo.description };
  const bk = db.ref(`/seoBackups/${p.id}`);
  const had = await bk.get();
  if (!had.exists()) await bk.set({ title: curT, description: curD, at: Date.now(), by: by || "" });
  const json = {
    seo_title_translations: Object.assign({}, p.seo_title_translations || {}, { "zh-hant": seo.title }),
    seo_description_translations: Object.assign({}, p.seo_description_translations || {}, { "zh-hant": seo.description }),
  };
  const r = await slFetch(token, `/products/${p.id}`, { method: "PUT", json });
  const ok = r.status === 200 || r.status === 201;
  return { id: p.id, ok, title: seo.title, description: seo.description, error: ok ? null : r.body };
}
async function seoPage(token, db, page, per, by) {
  const qs = SEO_FIELDS.map((f) => "fields[]=items." + f).join("&");
  const r = await slFetch(token, `/products/search?status=active&page=${page}&per_page=${per}&${qs}`);
  if (r.status !== 200) throw new Error("讀取商品失敗 " + r.status);
  const raw = r.body.items || [];
  const items = raw.filter((p) => p.status !== "removed");
  const results = [];
  for (let i = 0; i < items.length; i += 5) {
    const part = await Promise.all(items.slice(i, i + 5).map((p) => applySeo(token, db, p, by).catch((e) => ({ id: p.id, ok: false, error: String(e.message || e) }))));
    part.forEach((x, k) => { x.name = ((items[i + k].title_translations || {})["zh-hant"]) || ""; });
    results.push(...part);
  }
  // 只要求 items 欄位時 Shopline 不會回 pagination，所以用「這頁是否滿」判斷還有沒有下一頁
  const pg = r.body.pagination || {};
  const hasMore = pg.total_pages ? page < pg.total_pages : raw.length >= per;
  return { hasMore, results };
}
// 規則版本變了 → 自動把全部上架商品重跑一次（由每小時排程呼叫）
async function seoRerunIfRuleChanged(token, db) {
  const st = (await db.ref("/seoRun").get()).val() || {};
  if (st.version === RULE_VERSION) return null;
  let page = 1, up = 0, same = 0, bad = 0;
  const fails = [];
  for (; page <= 60; page++) {
    const r = await seoPage(token, db, page, 50, "自動排程");
    r.results.forEach((x) => { if (x.same) same++; else if (x.ok) up++; else { bad++; fails.push(x.name); } });
    if (!r.hasMore) break;
  }
  const summary = `更新 ${up}、不用改 ${same}、失敗 ${bad}`;
  await db.ref("/seoRun").set({ at: Date.now(), by: "自動排程", version: RULE_VERSION, summary, fails: fails.slice(0, 50) });
  return summary;
}
async function autoSeo(token, db, productId, by) {
  try {
    const qs = SEO_FIELDS.map((f) => "fields[]=" + f).join("&");
    const g = await slFetch(token, `/products/${productId}?${qs}`);
    if (g.status !== 200) return { ok: false, error: "讀不到商品" };
    return await applySeo(token, db, g.body, by);
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

exports.shopline = onRequest(
  {
    region: "asia-east1",
    memory: "512MiB",
    timeoutSeconds: 120,
    secrets: [SHOPLINE_TOKEN, TOOL_PASSWORD, ANTHROPIC_KEY],
    cors: false,
  },
  async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const pw = req.get("X-Tool-Password") || "";
    if (!pw || pw !== TOOL_PASSWORD.value()) {
      return res.status(401).json({ error: "密碼錯誤" });
    }

    const token = SHOPLINE_TOKEN.value();
    const { action } = req.body || {};
    const db = admin.database();

    try {
      switch (action) {
        case "ping": {
          const r = await slFetch(token, "/token/info");
          return res.json({ ok: r.status === 200, merchant: r.body && r.body.merchant && r.body.merchant.name });
        }

        case "search": {
          // 用商品名稱搜尋，回傳精簡資料
          const q = encodeURIComponent(req.body.query || "");
          const r = await slFetch(
            token,
            `/products/search?query=${q}&per_page=30&fields[]=items.id&fields[]=items.title_translations&fields[]=items.status&fields[]=items.medias&fields[]=items.detail_medias&fields[]=items.variations`
          );
          const items = (r.body.items || []).map((it) => ({
            id: it.id,
            title: (it.title_translations || {})["zh-hant"] || "",
            status: it.status,
            sku: ((it.variations || [])[0] || {}).sku || "",
            mainCount: (it.medias || []).length,
            detailCount: (it.detail_medias || []).length,
            mainUrls: (it.medias || []).map((m) => m.images.original.url),
            detailUrls: (it.detail_medias || []).map((m) => m.images.original.url),
          }));
          return res.json({ status: r.status, items });
        }

        case "upload": {
          // 圖片 base64 → Shopline media → 回傳 CDN 網址
          const { name, mime, b64 } = req.body;
          if (!b64) return res.status(400).json({ error: "缺少圖片" });
          const buf = Buffer.from(b64, "base64");
          const fd = new FormData();
          fd.append("data", new Blob([buf], { type: mime || "image/jpeg" }), name || "image.jpg");
          const r = await fetch(SL + "/media", {
            method: "POST",
            headers: { Authorization: "Bearer " + token, Accept: "application/json" },
            body: fd,
          });
          const body = await r.json().catch(() => ({}));
          const img = body && body.data && body.data.images && body.data.images.original;
          if (!img) return res.status(502).json({ error: "Shopline 上傳失敗", detail: body });
          return res.json({ url: img.url, width: img.width, height: img.height });
        }

        case "addImages": {
          // 掛圖：image_type main|detail，replace true = 取代原本
          const { productId, type, urls, replace, backup, uploader, productTitle } = req.body;
          if (!productId || !urls || !urls.length) return res.status(400).json({ error: "參數不足" });
          if (backup && backup.length) {
            await db.ref(`/backups/${productId}/${type}`).push({
              urls: backup, at: Date.now(), by: uploader || "",
            });
          }
          const r = await slFetch(token, `/products/${productId}/add_images`, {
            method: "POST",
            json: { image_type: type, is_replcae: !!replace, urls },
          });
          const okStatus = r.status === 200 || r.status === 201;
          if (okStatus) {
            await db.ref(`/uploads/${productId}`).set({
              title: productTitle || "", type, count: urls.length, at: Date.now(), by: uploader || "",
            });
          }
          const resultCount = okStatus
            ? ((type === "main" ? r.body.medias : r.body.detail_medias) || []).length
            : null;
          return res.json({ status: r.status, ok: okStatus, count: resultCount, error: okStatus ? null : r.body });
        }

        case "getProduct": {
          const r = await slFetch(token, `/products/${req.body.productId}?fields[]=description_translations&fields[]=title_translations&fields[]=status`);
          return res.json({ status: r.status, title: ((r.body.title_translations||{})["zh-hant"])||"", productStatus: r.body.status, description: ((r.body.description_translations||{})["zh-hant"])||"" });
        }

        case "genCopy": {
          // 商品文案 AI 生成（P1 四段）；API Key 存後端 secret，同事不需輸入
          const key = ANTHROPIC_KEY.value();
          if (!key) return res.status(500).json({ error: "後端尚未設定 ANTHROPIC_KEY" });
          const { title, desc, mode, descHtml } = req.body;
          if (!title) return res.status(400).json({ error: "缺少商品名稱" });
          try {
            const ref = await anthropicCopy(key, title, desc, mode, descHtml);
            return res.json({ ok: true, ref });
          } catch (e) {
            return res.status(502).json({ error: "AI 生成失敗：" + (e.message || "") });
          }
        }

        case "setDescription": {
          // 寫入商品描述（zh-hant），先備份舊內容
          const { productId, html, uploader, productTitle } = req.body;
          if (!productId || typeof html !== "string") return res.status(400).json({ error: "參數不足" });
          const cur = await slFetch(token, `/products/${productId}?fields[]=description_translations`);
          const old = ((cur.body && cur.body.description_translations) || {})["zh-hant"] || "";
          if (old) await db.ref(`/backups/${productId}/description`).push({ html: old, at: Date.now(), by: uploader || "" });
          const r = await slFetch(token, `/products/${productId}`, { method: "PUT", json: { description_translations: { "zh-hant": html } } });
          const ok = r.status === 200 || r.status === 201;
          if (ok) await db.ref(`/descUpdates/${productId}`).set({ title: productTitle || "", len: html.length, at: Date.now(), by: uploader || "" });
          const saved = ok ? (((r.body.description_translations||{})["zh-hant"])||"").length : null;
          const seo = ok ? await autoSeo(token, db, productId, uploader) : null;
          return res.json({ status: r.status, ok, saved, seo, error: ok ? null : r.body });
        }

        case "whoami": {
          return res.json({ email: await serviceEmail() });
        }

        case "sheetTabs": {
          const { spreadsheetId } = req.body;
          if (!spreadsheetId) return res.status(400).json({ error: "缺少試算表 ID" });
          try {
            const d = await sheetsFetch(`${spreadsheetId}?fields=properties.title,sheets.properties.title`);
            return res.json({ title: d.properties.title, tabs: (d.sheets || []).map((x) => x.properties.title) });
          } catch (e) {
            const code = e.response && e.response.status;
            return res.status(code === 403 || code === 404 ? 403 : 500).json({ error: code === 403 || code === 404 ? "沒有權限讀這張表單，請先分享給機器人帳號（檢視者）" : String(e.message), email: await serviceEmail() });
          }
        }

        case "sheetRows": {
          const { spreadsheetId, tab } = req.body;
          if (!spreadsheetId || !tab) return res.status(400).json({ error: "參數不足" });
          const d = await sheetsFetch(`${spreadsheetId}/values/${encodeURIComponent("'" + tab.replace(/'/g, "''") + "'")}?valueRenderOption=FORMATTED_VALUE`);
          return res.json({ rows: d.values || [] });
        }

        // ===== 活動設定 =====
        case "categories": {
          const out = [];
          for (let page = 1; page <= 10; page++) {
            const r = await slFetch(token, `/categories?page=${page}&per_page=100&fields[]=items.id&fields[]=items.name_translations&fields[]=items.status&fields[]=items.parent_id&fields[]=items.children`);
            const items = (r.body && r.body.items) || [];
            // 子分類巢狀在 children 裡，攤平成一層並保留 parent
            const walk = (c, parent) => {
              out.push({ id: c.id, name: (c.name_translations || {})["zh-hant"] || (c.name_translations || {}).en || "", status: c.status, parent: c.parent_id || parent || null });
              (c.children || []).forEach((ch) => walk(ch, c.id));
            };
            items.forEach((c) => walk(c, null));
            if (items.length < 100) break;
          }
          return res.json({ items: out });
        }

        case "searchFull": {
          // 用組頭/貨號搜尋，回傳活動設定需要的欄位
          const q = encodeURIComponent(req.body.query || "");
          const r = await slFetch(token, `/products/search?query=${q}&per_page=50&fields[]=items.id&fields[]=items.title_translations&fields[]=items.status&fields[]=items.sku&fields[]=items.price&fields[]=items.price_sale&fields[]=items.same_price&fields[]=items.category_ids&fields[]=items.tags&fields[]=items.schedule_publish_at&fields[]=items.is_excluded_promotion&fields[]=items.available_start_time&fields[]=items.available_end_time&fields[]=items.variations`);
          const items = (r.body.items || []).map((it) => ({
            id: it.id,
            title: (it.title_translations || {})["zh-hant"] || "",
            status: it.status,
            sku: it.sku || ((it.variations || [])[0] || {}).sku || "",
            price: it.price ? it.price.dollars : null,
            price_sale: it.price_sale ? it.price_sale.dollars : null,
            same_price: it.same_price,
            category_ids: it.category_ids || [],
            tags: it.tags || [],
            schedule_publish_at: it.schedule_publish_at || null,
            is_excluded_promotion: !!it.is_excluded_promotion,
            available_start_time: it.available_start_time || null,
            available_end_time: it.available_end_time || null,
            variations: (it.variations || []).map((v) => ({ id: v.id, sku: v.sku, price: v.price ? v.price.dollars : null, price_sale: v.price_sale ? v.price_sale.dollars : null })),
          }));
          return res.json({ status: r.status, items });
        }

        case "bulkStatus": {
          const { products } = req.body; // [{id,status}]
          const r = await slFetch(token, `/products/status/bulk`, { method: "PUT", json: { products } });
          return res.json({ status: r.status, body: r.body });
        }

        case "bulkCategory": {
          const { productIds, categoryIds } = req.body;
          const r = await slFetch(token, `/categories/bulk_assign`, { method: "POST", json: { product_ids: productIds, category_ids: categoryIds, is_bulk_remove: false, unset_other_categories: false } });
          return res.json({ status: r.status, ok: r.status === 200 || r.status === 201, body: r.body });
        }

        case "addTags": {
          const { productId, tags } = req.body;
          const r = await slFetch(token, `/products/${productId}/tags`, { method: "PATCH", json: { tags, update_mode: "add" } });
          return res.json({ status: r.status, ok: r.status === 200, tags: r.body && r.body.tags, error: r.status === 200 ? null : r.body });
        }

        case "updateProduct": {
          // 只允許活動設定相關欄位，寫入後重新讀取確認
          const { productId, fields } = req.body;
          const ALLOW = ["schedule_publish_at", "is_excluded_promotion", "available_start_time", "available_end_time"];
          const body = {};
          ALLOW.forEach((k) => { if (fields && Object.prototype.hasOwnProperty.call(fields, k)) body[k] = fields[k]; });
          if (!productId || !Object.keys(body).length) return res.status(400).json({ error: "參數不足" });
          const r = await slFetch(token, `/products/${productId}`, { method: "PUT", json: body });
          const ok = r.status === 200 || r.status === 201;
          const chk = await slFetch(token, `/products/${productId}?fields[]=schedule_publish_at&fields[]=is_excluded_promotion&fields[]=available_start_time&fields[]=available_end_time&fields[]=status`);
          return res.json({ status: r.status, ok, now: chk.body, error: ok ? null : r.body });
        }

        case "flashCampaigns": {
          const out = [];
          for (let page = 1; page <= 5; page++) {
            const r = await slFetch(token, `/flash_price_campaigns?page=${page}&per_page=50`);
            const items = (r.body && r.body.items) || [];
            items.forEach((c) => out.push({ id: c.id, title: c.title, start_at: c.start_at, end_at: c.end_at, count: (c.product_ids || []).length }));
            if (items.length < 50) break;
          }
          return res.json({ items: out });
        }

        case "createFlashCampaign": {
          const { title, start_at, end_at, price_sets, uploader } = req.body;
          if (!title || !start_at || !end_at || !price_sets || !price_sets.length) return res.status(400).json({ error: "參數不足" });
          const r = await slFetch(token, `/flash_price_campaigns`, { method: "POST", json: { flash_price_campaign: { title, start_at, end_at, price_sets } } });
          const ok = r.status === 200 || r.status === 201;
          if (ok) await db.ref(`/campaigns`).push({ id: r.body.id, title, start_at, end_at, count: price_sets.length, at: Date.now(), by: uploader || "" });
          return res.json({ status: r.status, ok, id: ok ? r.body.id : null, count: ok ? (r.body.product_ids || []).length : null, error: ok ? null : r.body });
        }

        case "createProduct": {
          // 商品建檔：POST /products，成功後回讀確認
          const { product, by } = req.body;
          if (!product || !product.title_translations) return res.status(400).json({ error: "參數不足" });
          let r = await slFetch(token, `/products`, { method: "POST", json: { product } });
          if (r.status === 400 && product.is_excluded_promotion !== undefined) {
            // 不適用折扣若不接受就拿掉重送
            const p2 = Object.assign({}, product); delete p2.is_excluded_promotion;
            r = await slFetch(token, `/products`, { method: "POST", json: { product: p2 } });
          }
          const ok = r.status === 200 || r.status === 201;
          const id = ok && r.body && (r.body.id || (r.body.product && r.body.product.id));
          let chk = null;
          if (id) {
            const c = await slFetch(token, `/products/${id}?fields[]=id&fields[]=title_translations&fields[]=status&fields[]=price&fields[]=category_ids&fields[]=variations&fields[]=schedule_publish_at&fields[]=available_start_time&fields[]=is_excluded_promotion`);
            chk = c.body;
            await db.ref(`/createdProducts/${id}`).set({ at: Date.now(), by: by || "", title: (product.title_translations || {})["zh-hant"] || "", skus: (product.variations || []).map((v) => v.sku) });
          }
          const seo = id ? await autoSeo(token, db, id, by) : null;
          return res.json({ status: r.status, ok, id: id || null, now: chk, seo, error: ok ? null : r.body });
        }

        case "productsByCategory": {
          // 讀取某分類下全部商品（手動設定的活動要收尾時用）
          const { categoryId } = req.body;
          if (!categoryId) return res.status(400).json({ error: "參數不足" });
          const out = [];
          for (let page = 1; page <= 40; page++) {
            const r = await slFetch(token, `/products/search?category_id=${categoryId}&page=${page}&per_page=50&fields[]=items.id&fields[]=items.title_translations&fields[]=items.status&fields[]=items.category_ids&fields[]=items.tags&fields[]=items.is_excluded_promotion&fields[]=items.sku`);
            const items = (r.body && r.body.items) || [];
            items.forEach((it) => out.push({ id: it.id, title: (it.title_translations || {})["zh-hant"] || "", status: it.status, category_ids: it.category_ids || [], tags: it.tags || [], is_excluded_promotion: !!it.is_excluded_promotion, sku: it.sku || "" }));
            if (items.length < 50) break;
          }
          return res.json({ items: out });
        }

        case "productsByCategory": {
          // 讀取某分類下全部商品（手動設定的活動要收尾時用）
          const { categoryId } = req.body;
          if (!categoryId) return res.status(400).json({ error: "參數不足" });
          const out = [];
          for (let page = 1; page <= 40; page++) {
            const r = await slFetch(token, `/products/search?category_id=${categoryId}&page=${page}&per_page=50&fields[]=items.id&fields[]=items.title_translations&fields[]=items.status&fields[]=items.category_ids&fields[]=items.tags&fields[]=items.is_excluded_promotion&fields[]=items.sku`);
            const items = (r.body && r.body.items) || [];
            items.forEach((it) => out.push({ id: it.id, title: (it.title_translations || {})["zh-hant"] || "", status: it.status, category_ids: it.category_ids || [], tags: it.tags || [], is_excluded_promotion: !!it.is_excluded_promotion, sku: it.sku || "" }));
            if (items.length < 50) break;
          }
          return res.json({ items: out });
        }

        case "logOps": {
          const { key, data } = req.body;
          await db.ref(`/campaignOps/${key || Date.now()}`).set(Object.assign({ at: Date.now() }, data || {}));
          return res.json({ ok: true });
        }

        case "scheduleCleanup": {
          const { title, endAt, revert, products, categoryId, tags, flashIds, by } = req.body;
          if (!endAt || !products || !products.length) return res.status(400).json({ error: "參數不足" });
          const r = await db.ref("/cleanupJobs").push({ title: title || "", endAt, revert: revert || {}, products, categoryId: categoryId || null, tags: tags || [], flashIds: flashIds || [], by: by || "", status: "pending", createdAt: Date.now() });
          return res.json({ ok: true, jobId: r.key });
        }

        case "cleanupJobs": {
          const snap = await db.ref("/cleanupJobs").get();
          const out = [];
          if (snap.exists()) { const v = snap.val(); Object.keys(v).forEach((k) => out.push({ id: k, title: v[k].title, endAt: v[k].endAt, status: v[k].status, count: (v[k].products || []).length, failed: v[k].failed || 0, by: v[k].by, finishedAt: v[k].finishedAt || null, results: v[k].results || null, revert: v[k].revert || {}, titles: Object.fromEntries((v[k].products || []).map((p) => [p.id, p.title])), manualOff: (v[k].revert && v[k].revert.excluded) ? (v[k].products || []).filter((p) => p.before && p.before.is_excluded_promotion === false).map((p) => p.id) : [] })); }
          out.sort((a, b) => b.endAt - a.endAt);
          return res.json({ items: out.slice(0, 30) });
        }

        case "runCleanupNow": {
          const snap = await db.ref(`/cleanupJobs/${req.body.jobId}`).get();
          if (!snap.exists()) return res.status(404).json({ error: "找不到任務" });
          const r = await runCleanupJob(token, db, req.body.jobId, snap.val());
          return res.json({ ok: true, failed: r.failed, results: r.results });
        }

        case "cancelCleanup": {
          await db.ref(`/cleanupJobs/${req.body.jobId}`).update({ status: "cancelled" });
          return res.json({ ok: true });
        }

        case "deleteFlashCampaign": {
          const r = await slFetch(token, `/flash_price_campaigns/${req.body.id}`, { method: "DELETE" });
          return res.json({ status: r.status, ok: r.status === 200 || r.status === 204, body: r.body });
        }

        case "getFlashCampaign": {
          const r = await slFetch(token, `/flash_price_campaigns/${req.body.id}`);
          const b = r.body || {};
          const sets = (b.price_sets || []).map((ps) => ({
            product_id: ps.product_id || (ps.product && ps.product.id) || null,
            price_sale: ps.price_sale ? ps.price_sale.dollars : null,
            details: (ps.price_details || []).map((d) => ({ variation_key: d.variation_key, price_sale: d.price_sale ? d.price_sale.dollars : null })),
          }));
          return res.json({ status: r.status, id: b.id, title: b.title, product_ids: b.product_ids || [], price_sets: sets });
        }

        case "seoPreview": {
          // 用品名搜尋，回傳會套用的 SEO（不寫入）
          const q = encodeURIComponent(req.body.query || "");
          const qs = SEO_FIELDS.map((f) => "fields[]=items." + f).join("&");
          const r = await slFetch(token, `/products/search?query=${q}&per_page=10&${qs}`);
          const items = (r.body.items || []).map((p) => {
            const s = buildSeo(p);
            return { id: p.id, name: (p.title_translations || {})["zh-hant"] || "", oldTitle: (p.seo_title_translations || {})["zh-hant"] || "", oldDesc: (p.seo_description_translations || {})["zh-hant"] || "", title: s.title, description: s.description };
          });
          return res.json({ status: r.status, items });
        }

        case "seoBatch": {
          const page = Math.max(1, Number(req.body.page) || 1);
          const per = Math.min(50, Math.max(5, Number(req.body.perPage) || 25));
          const r = await seoPage(token, db, page, per, req.body.by);
          return res.json({ page, hasMore: r.hasMore, totalPages: r.hasMore ? page + 1 : page, results: r.results });
        }

        case "seoRestore": {
          // 還原單一商品到批次前的 SEO
          const id = req.body.productId;
          const s = await db.ref(`/seoBackups/${id}`).get();
          if (!s.exists()) return res.status(404).json({ error: "沒有備份" });
          const b = s.val();
          const cur = await slFetch(token, `/products/${id}?fields[]=seo_title_translations&fields[]=seo_description_translations`);
          const json = {
            seo_title_translations: Object.assign({}, cur.body.seo_title_translations || {}, { "zh-hant": b.title || "" }),
            seo_description_translations: Object.assign({}, cur.body.seo_description_translations || {}, { "zh-hant": b.description || "" }),
          };
          const r = await slFetch(token, `/products/${id}`, { method: "PUT", json });
          return res.json({ ok: r.status === 200 || r.status === 201 });
        }

        case "seoStatus": {
          const s = await db.ref("/seoRun").get();
          return res.json(s.exists() ? s.val() : {});
        }

        case "seoMark": {
          await db.ref("/seoRun").set({ at: Date.now(), by: req.body.by || "", summary: req.body.summary || "" });
          return res.json({ ok: true });
        }

        case "lastUpload": {
          const ids = req.body.productIds || [];
          const out = {};
          for (const id of ids) {
            const s = await db.ref(`/uploads/${id}`).get();
            if (s.exists()) out[id] = s.val();
          }
          return res.json(out);
        }

        default:
          return res.status(400).json({ error: "未知 action" });
      }
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e && e.message || e) });
    }
  }
);

// ===== 實穿草稿產生器（桌面程式）後端：YouTube 上傳授權 + AI 標題 + 嵌入商品頁
// 桌面程式 → 這裡（Shopline Token / YouTube 授權 存在雲端）→ YouTube / Shopline


const SELF_URL = "https://asia-east1-vvdouble-shopline.cloudfunctions.net/reels";

// ---------- LINE 官方帳號推播（每日摘要、錯誤即時通知） ----------
async function linePush(db, text) {
  const tkS = await db.ref("/config/lineToken").get();
  const token = tkS.exists() ? tkS.val() : "";
  if (!token) return { ok: false, error: "沒有設定 LINE token" };
  const tgS = await db.ref("/line/targets").get();
  const targets = tgS.exists() ? Object.keys(tgS.val()) : [];
  if (!targets.length) return { ok: false, error: "機器人還沒被加進任何群組／好友" };
  let sent = 0; const errors = [];
  for (const to of targets) {
    try {
      const r = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to, messages: [{ type: "text", text: String(text).slice(0, 4900) }] }),
      });
      if (r.ok) sent++; else errors.push(`${to.slice(0, 6)}… ${r.status} ${(await r.text()).slice(0, 120)}`);
    } catch (e) { errors.push(String(e)); }
  }
  return { ok: sent > 0, sent, targets: targets.length, errors };
}

function twDate(ts) { return new Date(ts + 8 * 3600000).toISOString().slice(0, 10); }

async function buildDailySummary(db) {
  const now = Date.now(), since = now - 24 * 3600000;
  const evS = await db.ref("/reels_events").orderByChild("ts").startAt(since).get();
  const errS = await db.ref("/reels_errors").orderByChild("ts").startAt(since).get();
  const ev = []; evS.forEach((c) => { ev.push(c.val()); });
  const errs = []; errS.forEach((c) => { errs.push(c.val()); });
  const by = (k) => ev.filter((e) => e.kind === k);
  const names = (list) => [...new Set(list.map((e) => e.name).filter(Boolean))];
  const drafts = by("draft"), exps = by("export"), ups = by("upload");
  const pending = names(exps).filter((n) => !names(ups).includes(n));
  const who = [...new Set(ev.map((e) => e.by).filter(Boolean))];
  const lines = [`📋 實穿影片 ${twDate(since)}～今天`, ``,
    `產生草稿 ${drafts.length} 支`, `匯出成品 ${exps.length} 支`, `上傳 YouTube＋商品頁 ${ups.length} 支`];
  if (pending.length) lines.push(``, `已匯出還沒上傳：`, ...pending.slice(0, 10).map((n) => `・${n}`));
  if (errs.length) lines.push(``, `⚠ 錯誤 ${errs.length} 則：`, ...errs.slice(-5).map((e) => `・${e.computer || e.user || ""} ${e.context || ""}：${(e.error || "").slice(0, 60)}`));
  if (who.length) lines.push(``, `操作：${who.join("、")}`);
  if (!ev.length && !errs.length) lines.push(``, `（這 24 小時沒有動作）`);
  return lines.join("\n");
}

exports.reelsDaily = onSchedule(
  { schedule: "every day 09:00", region: "asia-east1", timeZone: "Asia/Taipei", timeoutSeconds: 120, memory: "256MiB" },
  async () => {
    const db = admin.database();
    const text = await buildDailySummary(db);
    const r = await linePush(db, text);
    console.log("daily summary:", JSON.stringify(r));
  }
);

const YT_SCOPE = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl";
const EMBED_MARK = "vv-reel-embed";

async function slFetchR(token, path, opt = {}) {
  const headers = { Authorization: "Bearer " + token, Accept: "application/json" };
  if (opt.json) { headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(opt.json); }
  const r = await fetch(SL + path, { method: opt.method || "GET", headers, body: opt.body });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

function page(title, msg) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,'Noto Sans TC',sans-serif;padding:40px;color:#1d2433"><h2>${title}</h2><p style="font-size:15px;line-height:1.8">${msg}</p></body>`;
}

async function ytClient(db) {
  const s = await db.ref("/youtube/client").get();
  return s.exists() ? s.val() : null;
}

async function ytAccessToken(db) {
  const client = await ytClient(db);
  const tk = await db.ref("/youtube/token").get();
  if (!client || !tk.exists() || !tk.val().refresh_token) throw new Error("YouTube 尚未授權");
  const body = new URLSearchParams({
    client_id: client.client_id, client_secret: client.client_secret,
    refresh_token: tk.val().refresh_token, grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const j = await r.json();
  if (!j.access_token) throw new Error("取得 YouTube 存取權失敗：" + JSON.stringify(j).slice(0, 200));
  return { access_token: j.access_token, expires_in: j.expires_in };
}

// 嵌入用的 HTML：放在商品描述最前面，有舊的就換掉
function embedHtml(videoId, title) {
  const t = String(title || "").replace(/[<>"]/g, "");
  return `<div class="${EMBED_MARK}" data-video="${videoId}" style="position:relative;width:100%;max-width:420px;margin:0 auto 16px;aspect-ratio:9/16;"><iframe src="https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1&playsinline=1" title="${t}" style="position:absolute;inset:0;width:100%;height:100%;border:0;" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
}
function stripEmbed(html) {
  // 移除舊的嵌入區塊（含 iframe）
  return String(html || "").replace(new RegExp(`<div class="${EMBED_MARK}"[\\s\\S]*?<\\/iframe>\\s*<\\/div>`, "g"), "").replace(/^\s+/, "");
}

const FALLBACK_TITLES = [
  (p) => `${p.category || "這件"}這樣穿，不同身形都好看｜VV Double`,
  (p) => `同一件，大尺碼和中尺碼各自的穿法｜VV Double`,
  (p) => `穿上就知道的舒服，看看實穿怎麼動｜VV Double`,
];

async function productDescription(token, name) {
  // 用商品名稱到 Shopline 找同名商品，回傳描述純文字（給 AI 標題當依據，不能腦補）
  const base = String(name || "").replace(/\s+/g, "");
  if (!base) return "";
  try {
    const r = await slFetchR(token, `/products/search?query=${encodeURIComponent(name)}&per_page=10&fields[]=items.id&fields[]=items.title_translations`);
    const items = r.body.items || [];
    const hit = items.find((it) => (((it.title_translations || {})["zh-hant"] || "").replace(/\s+/g, "").startsWith(base))) || items[0];
    if (!hit) return "";
    const d = await slFetchR(token, `/products/${hit.id}?fields[]=description_translations&fields[]=summary_translations`);
    const html = (((d.body || {}).description_translations || {})["zh-hant"]) || "";
    const summary = (((d.body || {}).summary_translations || {})["zh-hant"]) || "";
    let text = (summary + "\n" + html)
      .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
    // 只留賣點文案：材質、尺寸表、模特表、洗滌說明不給 AI（那些不是標題素材）
    const cut = text.search(/材質\s*[:：]|商品平量尺寸表|SIZE CHART|模特兒參考|CARE GUIDE|洗滌/i);
    if (cut > 0) text = text.slice(0, cut).trim();
    text = text.replace(/往下看更多詳細穿搭照片/g, "").trim();
    return text.slice(0, 1200);
  } catch (e) { console.error("productDescription", e); return ""; }
}

let AI_LAST_ERROR = "";
async function aiTitle(db, p, token) {
  const keyS = await db.ref("/config/anthropicKey").get();
  const key = keyS.exists() ? keyS.val() : "";
  const desc = (token && p.name) ? await productDescription(token, p.name) : "";
  const ctx = [
    p.name ? `商品名稱：${p.name}` : "",
    p.category ? `類別：${p.category}` : "",
    (p.features || []).length ? `拍攝特點：${p.features.join("、")}` : "",
    (p.colors || []).length ? `顏色：${p.colors.join("、")}` : "",

    p.extra ? `補充：${p.extra}` : "",
    desc ? `官網商品描述（唯一可用的事實來源）：\n${desc}` : "",
  ].filter(Boolean).join("\n");
  if (key) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-5-5",
          max_tokens: 1200,
          thinking: { type: "between_tools" },     // 這個模型關思考要用 between_tools（API 錯誤訊息指定的寫法）
          system: "你是台灣大尺碼女裝品牌 VV DOUBLE 的社群小編，為一支模特實穿影片寫 YouTube Shorts 標題。\n品名結構：《標籤》＋情境短語＋特徵＋品類，例如《獨家自訂》準時上課去荷葉邊設計寬鬆短袖襯衫 → 情境＝上課、特徵＝荷葉邊／寬鬆／短袖、品類＝襯衫。\n寫法：一句繁體中文 15–18 字，情境放前面、口語像朋友推薦；後半只點品類加一個特徵（例：早八也要可愛，荷葉邊襯衫），不要把品名整串抄進去。\n事實限制：情境、特徵、品類、材質感受只能來自品名與官網描述，描述沒寫的一律不寫、不猜（不寫透氣、顯瘦、修身這類沒出現的詞）；品類寫錯是最嚴重的錯誤。\n禁止：不寫怎麼搭配（不要出現 配、搭、搭配、疊穿 + 其他單品，因為你不知道影片裡怎麼搭）、不寫模特名字或誰穿、不寫品牌名、不抄情境短語整句、不用引號／井字標籤／emoji／驚嘆號。只輸出標題本身，一行一個。",
          messages: [{ role: "user", content: `請給 ${p.n || 3} 個不同角度的標題，一行一個，不要編號。\n${ctx}` }],
        }),
      });
      const j = await r.json();
      if (j.error) { AI_LAST_ERROR = `${j.error.type || ""} ${j.error.message || ""}`.trim(); console.error("aiTitle api", AI_LAST_ERROR); }
      else AI_LAST_ERROR = "";
      const text = (j.content || []).filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n");
      if (!text && !j.error) AI_LAST_ERROR = "AI 沒有回傳文字：" + JSON.stringify(j).slice(0, 400);
      const lines = text.split(/\r?\n/).map((x) => x.replace(/^[\d\.\-\s、]+/, "").replace(/[「」"'#!！]/g, "").trim())
        .filter(Boolean);
      const clean = lines.filter((x) => !/[配搭]/.test(x));      // 寫了「配／搭」什麼的那句不要（影片裡怎麼搭不知道）
      if (clean.length) lines.splice(0, lines.length, ...clean);
      if (lines.length) return lines.map((l) => (l.endsWith("｜VV Double") ? l : l.replace(/[｜|].*$/, "").trim() + "｜VV Double"));
    } catch (e) { AI_LAST_ERROR = String(e); console.error("aiTitle", e); }
  } else AI_LAST_ERROR = "沒有設定 Anthropic 金鑰";
  return FALLBACK_TITLES.map((f) => f(p));
}

exports.reels = onRequest(
  { region: "asia-east1", memory: "512MiB", timeoutSeconds: 120, secrets: [SHOPLINE_TOKEN, TOOL_PASSWORD], cors: false },
  async (req, res) => {
    const db = admin.database();
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, X-Tool-Password");
    if (req.method === "OPTIONS") return res.status(204).send("");

    // ---------- 瀏覽器流程：YouTube 授權 ----------
    if (req.method === "GET") {
      const op = req.query.op || "";
      try {
        if (op === "auth") {
          if ((req.query.pw || "") !== TOOL_PASSWORD.value()) return res.status(401).send(page("密碼錯誤", "請從程式的設定頁重新點「授權 YouTube」。"));
          const client = await ytClient(db);
          if (!client) return res.status(400).send(page("還沒設定", "請先在程式設定頁填入 YouTube 用戶端 ID 與密鑰。"));
          const state = Buffer.from(JSON.stringify({ pw: req.query.pw, t: Date.now() })).toString("base64url");
          const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
          u.searchParams.set("client_id", client.client_id);
          u.searchParams.set("redirect_uri", SELF_URL + "?op=oauth");
          u.searchParams.set("response_type", "code");
          u.searchParams.set("scope", YT_SCOPE);
          u.searchParams.set("access_type", "offline");
          u.searchParams.set("prompt", "consent");
          u.searchParams.set("state", state);
          return res.redirect(u.toString());
        }
        if (op === "oauth") {
          let st = {};
          try { st = JSON.parse(Buffer.from(String(req.query.state || ""), "base64url").toString()); } catch {}
          if (st.pw !== TOOL_PASSWORD.value()) return res.status(401).send(page("驗證失敗", "請重新從程式發起授權。"));
          if (req.query.error) return res.status(400).send(page("授權取消", String(req.query.error)));
          const client = await ytClient(db);
          const body = new URLSearchParams({ code: String(req.query.code || ""), client_id: client.client_id, client_secret: client.client_secret, redirect_uri: SELF_URL + "?op=oauth", grant_type: "authorization_code" });
          const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
          const j = await r.json();
          if (!j.refresh_token) return res.status(400).send(page("沒有拿到長期授權", "請到 <a href='https://myaccount.google.com/permissions'>Google 帳戶的第三方存取</a> 移除這個應用程式後，再授權一次。<br><small>" + JSON.stringify(j).slice(0, 200) + "</small>"));
          // 查頻道名稱
          let channel = "";
          try {
            const c = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: "Bearer " + j.access_token } });
            const cj = await c.json();
            channel = (((cj.items || [])[0] || {}).snippet || {}).title || "";
          } catch {}
          await db.ref("/youtube/token").set({ refresh_token: j.refresh_token, channel, at: Date.now() });
          return res.send(page("YouTube 授權完成", `已連結頻道：<b>${channel || "(未知)"}</b><br>可以關掉這個分頁，回到程式。`));
        }
        if (op === "version") return res.json({ reels: "2026-10-29a" });
        return res.status(404).send(page("VV Reels", "這是程式後端。"));
      } catch (e) {
        console.error(e);
        return res.status(500).send(page("發生錯誤", String(e.message || e)));
      }
    }

    // ---------- LINE webhook（機器人被加進群組／好友時記下對象） ----------
    if (req.query.op === "line") {
      if (req.method !== "POST") return res.status(200).send("ok");
      try {
        const secS = await db.ref("/config/lineSecret").get();
        const secret = secS.exists() ? secS.val() : "";
        if (secret) {
          const crypto = require("crypto");
          const sig = crypto.createHmac("sha256", secret).update(req.rawBody || Buffer.from("")).digest("base64");
          if (sig !== req.get("x-line-signature")) return res.status(403).send("bad signature");
        }
        for (const ev of (req.body || {}).events || []) {
          const src = ev.source || {};
          const id = src.groupId || src.roomId || src.userId;
          if (!id) continue;
          if (ev.type === "leave" || ev.type === "unfollow") await db.ref(`/line/targets/${id}`).remove();
          else if (["join", "follow", "message", "memberJoined"].includes(ev.type)) await db.ref(`/line/targets/${id}`).set({ type: src.type || "", at: Date.now() });
        }
      } catch (e) { console.error("line webhook", e); }
      return res.status(200).send("ok");
    }

    // ---------- 程式呼叫 ----------
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    const pw = req.get("X-Tool-Password") || "";
    if (!pw || pw !== TOOL_PASSWORD.value()) return res.status(401).json({ error: "密碼錯誤" });
    const token = SHOPLINE_TOKEN.value();
    const { action } = req.body || {};
    try {
      switch (action) {
        case "ping": {
          const tk = await db.ref("/youtube/token").get();
          const client = await ytClient(db);
          const keyS = await db.ref("/config/anthropicKey").get();
          const todoS = await db.ref("/config/todoUrl").get();
          return res.json({ ok: true, youtube: tk.exists() ? { channel: tk.val().channel, at: tk.val().at } : null, client_ready: !!client, ai_ready: keyS.exists() && !!keyS.val(), todo_url: todoS.exists() ? todoS.val() : "" });
        }

        case "ytSetup": {
          // 存 OAuth 用戶端（只做一次）
          const { clientId, clientSecret, anthropicKey, todoUrl } = req.body;
          if (clientId && clientSecret) await db.ref("/youtube/client").set({ client_id: clientId.trim(), client_secret: clientSecret.trim(), at: Date.now() });
          if (typeof anthropicKey === "string") await db.ref("/config/anthropicKey").set(anthropicKey.trim());
          if (typeof todoUrl === "string") await db.ref("/config/todoUrl").set(todoUrl.trim());
          return res.json({ ok: true, authUrl: `${SELF_URL}?op=auth&pw=${encodeURIComponent(pw)}` });
        }

        case "ytAuthUrl": {
          return res.json({ url: `${SELF_URL}?op=auth&pw=${encodeURIComponent(pw)}` });
        }

        case "ytAccessToken": {
          // 桌面程式拿短期權杖，直接把影片續傳到 YouTube（影片不經過這裡）
          const t = await ytAccessToken(db);
          return res.json(t);
        }

        case "ytLog": {
          // 上傳完成的紀錄
          const { videoId, title, product, sku, by } = req.body;
          await db.ref(`/reels/${videoId}`).set({ title, product, sku: sku || "", by: by || "", at: Date.now() });
          return res.json({ ok: true });
        }

        case "aiTitle": {
          const titles = await aiTitle(db, req.body || {}, token);
          return res.json({ titles, ai_error: AI_LAST_ERROR || undefined });
        }

        case "lineSetup": {
          const { lineToken, lineSecret } = req.body;
          if (typeof lineToken === "string" && lineToken.trim()) await db.ref("/config/lineToken").set(lineToken.trim());
          if (typeof lineSecret === "string") await db.ref("/config/lineSecret").set(lineSecret.trim());
          const tgS = await db.ref("/line/targets").get();
          return res.json({ ok: true, targets: tgS.exists() ? tgS.numChildren() : 0, webhook: `${SELF_URL}?op=line` });
        }

        case "linePing": {
          const tkS = await db.ref("/config/lineToken").get();
          const tgS = await db.ref("/line/targets").get();
          const info = { has_token: tkS.exists() && !!tkS.val(), targets: tgS.exists() ? tgS.numChildren() : 0, webhook: `${SELF_URL}?op=line` };
          if (!req.body.send) return res.json({ ok: true, ...info });
          const r = await linePush(db, req.body.text || `✅ VV 實穿草稿產生器 已連上 LINE（${new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}）`);
          return res.json({ ...info, ...r });
        }

        case "lineSummaryNow": {
          const text = await buildDailySummary(db);
          const r = await linePush(db, text);
          return res.json({ ...r, text });
        }

        case "event": {
          // 程式回報動作（產草稿／匯出／上傳），每日摘要用
          const b = req.body || {};
          await db.ref("/reels_events").push({ ts: Date.now(), kind: String(b.kind || "").slice(0, 20), name: String(b.name || "").slice(0, 120),
            by: String(b.by || "").slice(0, 40), layout: String(b.layout || "").slice(0, 20), extra: String(b.extra || "").slice(0, 200) });
          if (Math.random() < 0.05) {   // 偶爾清 30 天前的
            const old = await db.ref("/reels_events").orderByChild("ts").endAt(Date.now() - 30 * 86400000).get();
            const upd = {}; old.forEach((c) => { upd[c.key] = null; });
            if (Object.keys(upd).length) await db.ref("/reels_events").update(upd);
          }
          return res.json({ ok: true });
        }

        case "errorReport": {
          // 程式出錯自動回報（同事那邊不用截圖）；只留最近 200 筆
          const b = req.body || {};
          const rec = { ts: Date.now(), at: new Date().toISOString(), version: String(b.version || ""), computer: String(b.computer || ""), user: String(b.user || ""),
            context: String(b.context || "").slice(0, 200), error: String(b.error || "").slice(0, 600), trace: String(b.trace || "").slice(0, 4000), log: String(b.log || "").slice(0, 8000) };
          await db.ref("/reels_errors").push(rec);
          linePush(db, `⚠ 實穿草稿產生器出錯\n${rec.computer || rec.user}（v${rec.version}）\n${rec.context}\n${rec.error.slice(0, 200)}`).catch(() => {});
          const all = await db.ref("/reels_errors").orderByChild("ts").limitToFirst(50).get();
          const cnt = (await db.ref("/reels_errors").get()).numChildren();
          if (cnt > 200 && all.exists()) { const upd = {}; let k = cnt - 200; all.forEach((c) => { if (k-- > 0) upd[c.key] = null; }); await db.ref("/reels_errors").update(upd); }
          return res.json({ ok: true });
        }

        case "errorList": {
          const snap = await db.ref("/reels_errors").orderByChild("ts").limitToLast(Number(req.body.n) || 30).get();
          const items = [];
          snap.forEach((c) => { const v = c.val(); items.push({ id: c.key, ...v, log: undefined, trace: (v.trace || "").slice(-1500) }); });
          items.sort((a, b) => b.ts - a.ts);
          return res.json({ ok: true, items });
        }

        case "upcoming": {
          // 待製作清單：直接從 Shopline 抓最近建立的商品，依「排程上架時間」分檔期（取代上架排程試算表）
          const days = Math.max(14, Math.min(365, Number(req.body.days) || 90));
          const since = Date.now() - days * 86400000;
          const raw = [];
          for (let page = 1; page <= 8; page++) {
            const qs = `sort_by=desc&per_page=250&page=${page}&fields[]=items.id&fields[]=items.title_translations&fields[]=items.status&fields[]=items.sku&fields[]=items.created_at&fields[]=items.schedule_publish_at&fields[]=items.available_start_time&fields[]=items.tags&fields[]=items.variations`;
            const r = await slFetchR(token, `/products?${qs}`);
            const items = r.body.items || [];
            if (!items.length) break;
            let stop = false;
            for (const it of items) {
              if (new Date(it.created_at || 0).getTime() < since) { stop = true; break; }
              raw.push(it);
            }
            if (stop || items.length < 250) break;
          }
          const tw = (iso) => { if (!iso) return null; const d = new Date(new Date(iso).getTime() + 8 * 3600000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
          // 檔期用貨號分：26AU0614 ＝ 年 26＋季 AU＋上架次序 06＋排列 14 → 同一次上架的全部在 26AU06；ST 是門市獨賣不列。
          // 沒有照規則的貨號才退回用開賣日分。
          const groups = {};
          for (const it of raw) {
            const title = ((it.title_translations || {})["zh-hant"] || "").trim();
            if (!title) continue;
            const mm = title.match(/^(.*?)[-－—–]\s*([^-－—–]{1,8})$/);
            const base = (mm ? mm[1] : title).trim();
            const color = mm ? mm[2].trim() : "";
            const sizes = [];
            let sku = it.sku || "";
            (it.variations || []).forEach((v) => {
              if (!sku && v.sku) sku = v.sku;
              (v.fields || []).forEach((f) => {
                const val = String(((f.name_translations || {})["zh-hant"]) || f.name || "").trim();
                if (/^(F|FREE|S|M|L|XL|SM|ML|XL2L|3L4L|5L6L|2L|3L|4L|5L|6L|2XL|3XL|4XL)$/i.test(val) && !sizes.includes(val)) sizes.push(val);
              });
            });
            const sm = String(sku).toUpperCase().match(/^(\d{2})(SP|SU|AU|WI|ST)(\d{2})(\d{2})/);
            if (sm && sm[2] === "ST") continue;                       // 門市獨賣不列
            const skuBase = sm ? sm[0] : ((sku.match(/^([A-Z0-9]{6,10})/i) || [])[1] || "");
            const when = tw(it.available_start_time || it.schedule_publish_at || it.created_at);
            const dayKey = when ? `${when.y}-${String(when.m).padStart(2, "0")}${String(when.d).padStart(2, "0")}` : "";
            const tabKey = sm ? `${sm[1]}${sm[2]}${sm[3]}` : (dayKey || "未排程");
            const g = groups[tabKey] = groups[tabKey] || { key: tabKey, bySku: !!sm, year: sm ? 2000 + Number(sm[1]) : (when ? when.y : 0), season: sm ? sm[2] : "", order: sm ? Number(sm[3]) : 0, days: {}, items: {} };
            if (dayKey) g.days[dayKey] = (g.days[dayKey] || 0) + 1;
            const p = g.items[base] = g.items[base] || { name: base, sku: skuBase.toUpperCase(), colors: [], specs: [], features: [], category: "", models: [], product_ids: [], statuses: [], tags: [], created_at: it.created_at };
            if (color && !p.colors.includes(color)) p.colors.push(color);
            sizes.forEach((x) => { if (!p.specs.includes(x)) p.specs.push(x); });
            (it.tags || []).forEach((t) => { if (t && !p.tags.includes(t)) p.tags.push(t); });
            if (!p.sku && skuBase) p.sku = skuBase.toUpperCase();
            p.product_ids.push(it.id);
            p.statuses.push(it.status);
            if (it.created_at < p.created_at) p.created_at = it.created_at;
          }
          const tabs = Object.values(groups).map((g) => {
            // 這檔的日期＝這群商品最多人設定的開賣日
            const day = Object.entries(g.days).sort((a, b) => b[1] - a[1])[0];
            const dk = day ? day[0] : "";
            const y = dk ? Number(dk.slice(0, 4)) : g.year, m = dk ? Number(dk.slice(5, 7)) : 0, d = dk ? Number(dk.slice(7, 9)) : 0;
            const code = g.key;      // 介面用來勾選的識別，必須唯一
            const tab = (dk ? `${m}/${d} 上架` : "未排程") + (g.bySku ? `・${g.key}` : "");
            const items = Object.values(g.items).map((p) => ({ ...p, status: p.statuses.every((x) => x === "active") ? "已上架" : (p.statuses.some((x) => x === "active") ? "部分上架" : "未上架"), features: p.tags }))
              .sort((a, b) => (a.sku < b.sku ? -1 : 1));
            return { tab, code, key: g.key, year: y, month: m, day: d, items };
          }).sort((a, b) => (b.year - a.year) || (b.month - a.month) || (b.day - a.day) || (b.key < a.key ? -1 : 1));
          return res.json({ ok: true, updated: new Date().toISOString(), days, total: raw.length, tabs });
        }

        case "findProducts": {
          // 用組頭名稱找出所有顏色的商品
          const name = String(req.body.name || "").trim();
          if (!name) return res.status(400).json({ error: "缺少名稱" });
          const q = encodeURIComponent(name);
          const r = await slFetchR(token, `/products/search?query=${q}&per_page=30&fields[]=items.id&fields[]=items.title_translations&fields[]=items.status&fields[]=items.sku&fields[]=items.variations&fields[]=items.description_translations&fields[]=items.medias`);
          const base = name.replace(/\s+/g, "");
          // 搜尋結果不一定帶描述：同名的前 8 筆逐一補撈描述與變體
          const list = (r.body.items || []);
          const descMap = {};
          const needDesc = list.filter((it) => (((it.title_translations || {})["zh-hant"] || "").replace(/\s+/g, "").startsWith(base))).slice(0, 8);
          await Promise.all(needDesc.map(async (it) => {
            try {
              const d = await slFetchR(token, `/products/${it.id}?fields[]=description_translations&fields[]=variations`);
              descMap[it.id] = d.body || {};
            } catch (e) { descMap[it.id] = {}; }
          }));
          const items = list.map((it) => {
            const title = (it.title_translations || {})["zh-hant"] || "";
            const full = descMap[it.id] || {};
            if (full.variations && full.variations.length) it.variations = full.variations;
            const desc = (((full.description_translations || it.description_translations) || {})["zh-hant"]) || "";
            const m = desc.match(new RegExp(`class="${EMBED_MARK}" data-video="([^"]+)"`));
            // 從商品描述的尺寸表抓每位模特的著用尺碼：Model-VV 154cm/92kg   著 3L4L 舒適
            const plain = desc.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
            const models = [];
            const chartSizes = [];
            // 格式一：官網批次中心產生的表格（MODEL｜穿著｜身高｜體重｜…｜感受）＋ SIZE CHART 表頭
            const cellText = (tr) => (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map((td) => td.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim());
            (desc.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []).forEach((tr) => {
              const c = cellText(tr);
              if (c.length >= 4 && /^\d+(\.\d+)?$/.test(c[2]) && /^\d+(\.\d+)?$/.test(c[3]) && c[0] && !/MODEL/i.test(c[0])) {
                models.push({ name: c[0] === "VV" ? "VVN" : c[0], height: c[2], weight: c[3], size: c[1] || "", fit: c[c.length - 1] || "" });
              }
              if (c.length >= 2 && /^SIZE/i.test(c[0])) c.slice(1).forEach((x) => { if (x && !chartSizes.includes(x)) chartSizes.push(x); });
            });
            // 格式二：純文字「Model-VV 154cm/92kg   著 3L4L 舒適」
            if (!models.length) {
              const re = /Model-\s*([^\s<]+)\s+(\d+)cm\/(\d+)kg\s+(?:著\s*([^\s<]+)\s+)?([^\s<]+)/g;
              let mm;
              while ((mm = re.exec(plain)) !== null) models.push({ name: mm[1] === "VV" ? "VVN" : mm[1], height: mm[2], weight: mm[3], size: mm[4] || "", fit: mm[5] || "" });
            }
            // 規格（尺寸）：從變體欄位抓，F／ML／3L4L 這類
            const sizes = chartSizes.slice();
            (it.variations || []).forEach((v) => {
              (v.fields || []).forEach((f) => {
                const val = ((f.name_translations || {})["zh-hant"]) || f.name || "";
                if (/^(F|FREE|S|M|L|XL|SM|ML|XL2L|3L4L|5L6L|2L|3L|4L|5L|6L|2XL|3XL|4XL)$/i.test(String(val).trim()) && !sizes.includes(val)) sizes.push(String(val).trim());
              });
            });
            return {
              id: it.id, title, status: it.status, models, sizes,
              sku: it.sku || ((it.variations || [])[0] || {}).sku || "",
              color: title.replace(/\s+/g, "").startsWith(base) ? title.replace(/\s+/g, "").slice(base.length).replace(/^[-－—–_ ]+/, "") : "",
              exact: title.replace(/\s+/g, "").startsWith(base),
              thumb: (((it.medias || [])[0] || {}).images || {}).original ? it.medias[0].images.original.url : "",
              embedded: m ? m[1] : null,
            };
          }).sort((a, b) => (b.exact - a.exact));
          return res.json({ status: r.status, items });
        }

        case "embedVideo": {
          // 把 YouTube 影片放到每個顏色商品的描述最前面（先備份舊描述）
          const { productIds, videoId, title, by } = req.body;
          if (!productIds || !productIds.length || !videoId) return res.status(400).json({ error: "參數不足" });
          const out = [];
          for (const pid of productIds) {
            try {
              const cur = await slFetchR(token, `/products/${pid}?fields[]=description_translations&fields[]=title_translations`);
              const old = ((cur.body && cur.body.description_translations) || {})["zh-hant"] || "";
              const ptitle = ((cur.body && cur.body.title_translations) || {})["zh-hant"] || "";
              if (old) await db.ref(`/backups/${pid}/description`).push({ html: old, at: Date.now(), by: by || "reels" });
              const html = embedHtml(videoId, title) + stripEmbed(old);
              const r = await slFetchR(token, `/products/${pid}`, { method: "PUT", json: { description_translations: { "zh-hant": html } } });
              const ok = r.status === 200 || r.status === 201;
              if (ok) await db.ref(`/descUpdates/${pid}`).set({ title: ptitle, len: html.length, at: Date.now(), by: by || "reels", video: videoId });
              out.push({ id: pid, title: ptitle, ok, error: ok ? null : JSON.stringify(r.body).slice(0, 200) });
            } catch (e) { out.push({ id: pid, ok: false, error: String(e.message || e) }); }
          }
          return res.json({ results: out, failed: out.filter((x) => !x.ok).length });
        }

        case "removeVideo": {
          // 從商品頁描述拿掉嵌入的影片（只動嵌入區塊，其餘描述不變）
          const { productIds, videoId, by } = req.body;
          if (!productIds || !productIds.length) return res.status(400).json({ error: "參數不足" });
          const out = [];
          for (const pid of productIds) {
            try {
              const cur = await slFetchR(token, `/products/${pid}?fields[]=description_translations&fields[]=title_translations`);
              const old = ((cur.body && cur.body.description_translations) || {})["zh-hant"] || "";
              const ptitle = ((cur.body && cur.body.title_translations) || {})["zh-hant"] || "";
              const hasIt = videoId ? old.includes(`data-video="${videoId}"`) : new RegExp(`class="${EMBED_MARK}"`).test(old);
              if (!hasIt) { out.push({ id: pid, title: ptitle, ok: true, skipped: true }); continue; }
              await db.ref(`/backups/${pid}/description`).push({ html: old, at: Date.now(), by: by || "reels-remove" });
              const html = stripEmbed(old);
              const r = await slFetchR(token, `/products/${pid}`, { method: "PUT", json: { description_translations: { "zh-hant": html } } });
              const ok = r.status === 200 || r.status === 201;
              out.push({ id: pid, title: ptitle, ok, error: ok ? null : JSON.stringify(r.body).slice(0, 200) });
            } catch (e) { out.push({ id: pid, ok: false, error: String(e.message || e) }); }
          }
          return res.json({ results: out, failed: out.filter((x) => !x.ok).length });
        }

        case "ytStatus": {
          // 改影片公開狀態：public／private／unlisted；private + publishAt＝定時公開（YouTube 自己到時間切公開）
          const { videoId, privacy, publishAt } = req.body;
          if (!videoId) return res.status(400).json({ error: "缺少 videoId" });
          const t = await ytAccessToken(db);
          const status = { privacyStatus: publishAt ? "private" : (privacy || "public"), selfDeclaredMadeForKids: false };
          if (publishAt) status.publishAt = new Date(publishAt).toISOString();
          const r = await fetch("https://www.googleapis.com/youtube/v3/videos?part=status", {
            method: "PUT", headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ id: videoId, status }),
          });
          const body = await r.text();
          if (!r.ok) return res.json({ ok: false, status: r.status, error: body.slice(0, 300) });
          return res.json({ ok: true, status: JSON.parse(body).status });
        }

        case "ytDelete": {
          // 刪除 YouTube 影片（需要 youtube.force-ssl 權限；舊授權沒有的話要重新授權一次）
          const { videoId } = req.body;
          if (!videoId) return res.status(400).json({ error: "缺少 videoId" });
          const t = await ytAccessToken(db);
          const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(videoId)}`, {
            method: "DELETE", headers: { Authorization: `Bearer ${t.access_token}` },
          });
          if (r.status === 204) { await db.ref(`/reels/${videoId}`).remove(); return res.json({ ok: true }); }
          const body = await r.text();
          const needAuth = r.status === 403 && /insufficient|scope|forbidden/i.test(body);
          return res.json({ ok: false, status: r.status, needAuth, error: needAuth ? "目前的 YouTube 授權不能刪影片，請到設定重新授權一次" : body.slice(0, 300) });
        }

        default:
          return res.status(400).json({ error: "未知 action" });
      }
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }
);
