// VV DOUBLE · 實穿草稿產生器 後端：YouTube 上傳授權 + AI 標題 + 嵌入商品頁
// 桌面程式 → 這裡（Shopline Token / YouTube 授權 存在雲端）→ YouTube / Shopline
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

const SHOPLINE_TOKEN = defineSecret("SHOPLINE_TOKEN");
const TOOL_PASSWORD = defineSecret("TOOL_PASSWORD");

const SL = "https://open.shopline.io/v1";
const SELF_URL = "https://asia-east1-vvdouble-shopline.cloudfunctions.net/reels";
const YT_SCOPE = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
const EMBED_MARK = "vv-reel-embed";

async function slFetch(token, path, opt = {}) {
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
  (p) => `同一件，${p.models || "大尺碼和中尺碼"}各自的穿法｜VV Double`,
  (p) => `穿上就知道的舒服，看看實穿怎麼動｜VV Double`,
];

async function aiTitle(db, p) {
  const keyS = await db.ref("/config/anthropicKey").get();
  const key = keyS.exists() ? keyS.val() : "";
  const ctx = [
    p.category ? `類別：${p.category}` : "",
    (p.features || []).length ? `拍攝特點：${p.features.join("、")}` : "",
    (p.colors || []).length ? `顏色：${p.colors.join("、")}` : "",
    p.models ? `出鏡模特：${p.models}` : "",
    p.extra ? `補充：${p.extra}` : "",
  ].filter(Boolean).join("\n");
  if (key) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 200,
          system: "你是台灣大尺碼女裝品牌 VV DOUBLE 的社群小編。寫 YouTube Shorts 標題：一句繁體中文、18 字以內、口語自然、像朋友推薦；只描述穿起來的感覺、版型或場合，絕對不要出現商品名稱、品牌名、引號、井字標籤或 emoji。只輸出標題本身。",
          messages: [{ role: "user", content: `請給 ${p.n || 3} 個不同角度的標題，一行一個，不要編號。\n${ctx}` }],
        }),
      });
      const j = await r.json();
      const text = ((j.content || [])[0] || {}).text || "";
      const lines = text.split(/\r?\n/).map((x) => x.replace(/^[\d\.\-\s、]+/, "").replace(/[「」"'#]/g, "").trim()).filter(Boolean);
      if (lines.length) return lines.map((l) => (l.endsWith("｜VV Double") ? l : l.replace(/[｜|].*$/, "").trim() + "｜VV Double"));
    } catch (e) { console.error("aiTitle", e); }
  }
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
        return res.status(404).send(page("VV Reels", "這是程式後端。"));
      } catch (e) {
        console.error(e);
        return res.status(500).send(page("發生錯誤", String(e.message || e)));
      }
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
          const titles = await aiTitle(db, req.body || {});
          return res.json({ titles });
        }

        case "findProducts": {
          // 用組頭名稱找出所有顏色的商品
          const name = String(req.body.name || "").trim();
          if (!name) return res.status(400).json({ error: "缺少名稱" });
          const q = encodeURIComponent(name);
          const r = await slFetch(token, `/products/search?query=${q}&per_page=50&fields[]=items.id&fields[]=items.title_translations&fields[]=items.status&fields[]=items.sku&fields[]=items.variations&fields[]=items.description_translations&fields[]=items.medias`);
          const base = name.replace(/\s+/g, "");
          const items = (r.body.items || []).map((it) => {
            const title = (it.title_translations || {})["zh-hant"] || "";
            const desc = ((it.description_translations || {})["zh-hant"]) || "";
            const m = desc.match(new RegExp(`class="${EMBED_MARK}" data-video="([^"]+)"`));
            return {
              id: it.id, title, status: it.status,
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
              const cur = await slFetch(token, `/products/${pid}?fields[]=description_translations&fields[]=title_translations`);
              const old = ((cur.body && cur.body.description_translations) || {})["zh-hant"] || "";
              const ptitle = ((cur.body && cur.body.title_translations) || {})["zh-hant"] || "";
              if (old) await db.ref(`/backups/${pid}/description`).push({ html: old, at: Date.now(), by: by || "reels" });
              const html = embedHtml(videoId, title) + stripEmbed(old);
              const r = await slFetch(token, `/products/${pid}`, { method: "PUT", json: { description_translations: { "zh-hant": html } } });
              const ok = r.status === 200 || r.status === 201;
              if (ok) await db.ref(`/descUpdates/${pid}`).set({ title: ptitle, len: html.length, at: Date.now(), by: by || "reels", video: videoId });
              out.push({ id: pid, title: ptitle, ok, error: ok ? null : JSON.stringify(r.body).slice(0, 200) });
            } catch (e) { out.push({ id: pid, ok: false, error: String(e.message || e) }); }
          }
          return res.json({ results: out, failed: out.filter((x) => !x.ok).length });
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
