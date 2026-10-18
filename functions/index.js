// VV DOUBLE · Shopline 批次上圖 · Cloud Function 中間站
// 網頁 → 這裡（Token 存在 Secret）→ Shopline Open API
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { GoogleAuth } = require("google-auth-library");

admin.initializeApp();

const SHOPLINE_TOKEN = defineSecret("SHOPLINE_TOKEN");
const TOOL_PASSWORD = defineSecret("TOOL_PASSWORD");

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
    console.log("cleanup ran:", JSON.stringify(ran));
  }
);

exports.shopline = onRequest(
  {
    region: "asia-east1",
    memory: "512MiB",
    timeoutSeconds: 120,
    secrets: [SHOPLINE_TOKEN, TOOL_PASSWORD],
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
          return res.json({ status: r.status, ok, saved, error: ok ? null : r.body });
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
            const r = await slFetch(token, `/categories?page=${page}&per_page=100&fields[]=items.id&fields[]=items.name_translations&fields[]=items.status&fields[]=items.parent_id`);
            const items = (r.body && r.body.items) || [];
            items.forEach((c) => out.push({ id: c.id, name: (c.name_translations || {})["zh-hant"] || (c.name_translations || {}).en || "", status: c.status, parent: c.parent_id || null }));
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
