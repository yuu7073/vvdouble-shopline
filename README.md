# VV DOUBLE · 官網批次中心

Shopline 批次工具：新品放圖 ｜ 文案／尺寸表 ｜ 活動設定（含自動收尾）。

- 網頁：https://vvdouble-shopline.web.app （Firebase Hosting，`web/index.html`）
- 中間站：Cloud Functions `functions/index.js`（Token 與密碼存於 Secret Manager）
- 推上 `main` 後由 GitHub Actions 自動部署（`.github/workflows/deploy.yml`）
