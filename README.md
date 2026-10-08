# LINE.js

本機 TypeScript LINE 網頁客戶端，以釘選的 [@evex/linejs v3.4.2](https://github.com/evex-dev/linejs/tree/v3.4.2) 連線 LINE，使用 WebSocket 同步頻道與訊息；同埠 HTTP 提供網頁及圖片／貼圖。

> 開發狀態：Gate 0 已完成；Phase 1 已建立釘選依賴、TypeScript 工具鏈與本機設定。登入程式交付前，尚不能執行 `npm start`。Gate 必須依 [PLAN.md](PLAN.md) 順序通過。

## 用途與範圍

QR 掃碼登入、session 復用、好友／群組／聊天室／社群清單、即時訊息及編輯事件、歷史分頁、文字／圖片／貼圖發送與顯示。影片、語音、檔案僅顯示佔位。不提供公開部署、多帳號、通話或套件發布。

本作品使用非官方 LINE API，可能造成帳號限制或封鎖。**請先用次要帳號驗證**，不要直接以主帳號測試。

## 系統架構

```mermaid
flowchart LR
    LINE[LINE 服務] <--> Provider[LineProvider adapter\n@evex/linejs 3.4.2]
    Provider <--> Backend[Node TypeScript 後端\nsession 與記憶體快取]
    Backend <-->|WebSocket 訊息與頻道| Browser[Vite / vanilla TypeScript 網頁]
    Backend <-->|同埠 HTTP 靜態頁與媒體| Browser
```

後端僅綁定 `127.0.0.1`，預設埠 `3789`。後端 `tsc` 建置至 `dist/`；前端 Vite 建置至 `dist/web/`。訊息只存記憶體，每頻道最多 500 則；媒體使用容量受限的 LRU，不使用資料庫。

## 環境需求

- Node.js **≥ 22** 與 npm。
- 可連線至 JSR、npm 與 LINE 的網路。
- 能掃描 QR 並確認 PIN 的 LINE 次要帳號。
- `@evex/linejs` 與 `@evex/linejs-types` 均固定 **3.4.2**（JSR）；其餘直接依賴也須釘選版本。

上游 3.4.2 的 Thrift 依賴包含 high 漏洞，本專案以 `overrides` 釘選修補版 `thrift@0.23.0`，不更動 LINE 套件版本。修補依據：[CVE-2026-41636](https://github.com/advisories/GHSA-r67j-r569-jrwp)。升版仍需驗證實際 LINE 登入相容性。

## 安裝與啟動（程式交付後使用）

```sh
git clone https://github.com/JS-PACKAGE/LINE.js.git
cd LINE.js
npm install
cp config.example.yaml config.yaml
npm run build
npm start
```

開啟 `http://127.0.0.1:3789`，用次要帳號掃描畫面 QR、確認 PIN。QR URL 與 PIN 僅在網頁一次性顯示；不得複製至日誌。重啟優先復用 `session.json`，失效才重新掃碼。登入失败後重新產生 QR 必須由使用者操作，不自動循環。

`session.json` 包含憑證與 E2EE key material，必須以權限 `600` 保存，不得分享或提交。`config.yaml` 為個人設定，不入版本控制。

## 設定

`config.example.yaml` 已附逐項繁體中文說明。首次啟動若缺少 `config.yaml`，會以不覆寫既有檔案的方式自動建立；有個人設定時優先使用個人設定。欄位分為 `server`、`line`、`history`、`cache`、`limits`。目前先驗證全部欄位；歷史、訊息與媒體限制於後續 Gate 實作套用。

- 監聽 host：`127.0.0.1`；不得改成 `0.0.0.0` 或對外提供服務。
- port：預設 `3789`，可調整；host 與 port 從 `config.yaml` 讀取，程式不得寫死。
- LINE 裝置：預設 `ANDROIDSECONDARY`。
- 歷史筆數：預設 50，單次最多 100。
- 每頻道訊息快取：最多 500 則；媒體 LRU：預設 200MB。
- WS frame：最多 256KB；文字：最多 8000 字。
- 發送：每 WS 連線最多每秒 5 次；圖片上傳：每檔最多 10MB、每連線每分鐘最多 5 次。

## WebSocket 與 HTTP 協定摘要

`ws://127.0.0.1:3789` 使用 JSON frames。完整負載定義見 [PLAN.md 第四節](PLAN.md#四通訊協定ws1270013789json-frames)。

| 方向 | type | 用途 |
|---|---|---|
| Server → Client | `hello` | 協定版本 1 與伺服器版本 |
| Server → Client | `auth:qr` / `auth:pin` / `auth:ready` | 一次性登入畫面與帳號就緒 |
| Server → Client | `channels` | 連線與重連的頻道 snapshot |
| Server → Client | `message` / `message:edit` | 即時訊息與覆寫既有訊息 |
| Server → Client | `history` / `sent` | 對應 `requestId` 的歷史及發送結果 |
| Server → Client | `error` / `status` | generic 錯誤與監聽狀態 |
| Client → Server | `history:fetch` | `requestId`、`chatId`、`limit?`、`before?` |
| Client → Server | `message:send` | `requestId`、`chatId`，文字／`mediaId`／貼圖其一 |
| Client → Server | `channels:refresh` / `ping` | 更新頻道與連線保活 |

HTTP：`GET /` 提供網頁；`GET /media/:mediaId` 提供圖片／貼圖；`POST /media/upload` 接收 `image/*` 並回傳 `{ mediaId }`。WS 不傳媒體位元組，非 localhost Origin 拒絕升級。

## 建置與驗證契約

工具鏈已提供 `typecheck`、`build` 與 `test`；前端建置與啟動指令隨登入功能交付。

```sh
npm run typecheck
npm run build
npm test
npm audit
```

測試使用 `node --test` 與 Mock Provider；Mock 不代替真實 LINE 驗收。Gate 1 需要次要帳號掃碼後 60 秒內收到一則真實訊息，Gate 2–4 另驗證網頁同步、歷史、發送與媒體。全部 Gate 及驗收條件見 [PLAN.md](PLAN.md)。

## 開發規範與授權

工程與安全規範見 [AGENTS.md](AGENTS.md)，定案企劃全文見 [PLAN.md](PLAN.md)。依功能分批提交，不混入個人設定或憑證；不得改寫既有 `LICENSE`、`.nojekyll`。

本作品 **LINE.js** 採 **Apache-2.0**，以根目錄 [LICENSE](LICENSE) 為準。消費套件 **@evex/linejs** 與 **@evex/linejs-types** 採 **MIT**，其授權獨立於本作品，詳見 [上游授權](https://github.com/evex-dev/linejs/blob/v3.4.2/LICENSE)。本倉庫僅供 clone，不發布 npm／JSR 套件。
