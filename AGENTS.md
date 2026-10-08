# LINE.js 工程規範

## 語言與開發方式

- 與使用者溝通、文件及 UI 使用繁體中文；技術名詞與程式識別字可保留英文。
- 使用 TypeScript、Node.js ≥22、Node ESM；前端 Vite＋vanilla TypeScript。不得擅自替換框架或最低執行版本。
- 先讀 [PLAN.md](PLAN.md) 與相關實作、驗證套件 API，再修改；採最小完整修改，不做無關重構或增加不必要依賴。
- `@evex/linejs` 與 `@evex/linejs-types` 必須釘選 JSR **3.4.2**。不得追蹤 main，升版必須取得人工裁示。
- **所有 LINE 外部 API 一律經 LineProvider adapter**，核心狀態、HTTP、WS 與前端不得直接呼叫套件。API 衝突以 v3.4.2 實際原始碼為準，只改 adapter。
- MockLineProvider 僅供隔離測試，不能冒充真實 LINE 功能或代替 Gate 驗收。
- 依功能分批提交；先檢查 diff，僅納入該功能相關檔案。未經明示授權不得 push、發布或部署。保留使用者既有修改。
- 不改寫根目錄 `LICENSE`（Apache-2.0）與 `.nojekyll`；不發布 npm／JSR 套件。

## 結構對應

以下為定案目標結構，依 Gate 順序建立，非現有程式清單：

| 路徑 | 職責 |
|---|---|
| `src/line/` | LineProvider、QR 登入、session、LINE 事件、歷史、發送、媒體下載 |
| `src/ws/` | WS 協定、snapshot、增量、單序廣播佇列、限流 |
| `src/http/` | 同埠 HTTP、靜態網頁、圖片上傳與媒體位元組 |
| `src/model/` | Channel／Message／Media DTO、正規化、去重与記憶體快取 |
| `web/` | 繁體中文登入畫面、頻道列表、訊息、歷史、文字／圖片／貼圖輸入 |
| `dist/` / `dist/web/` | 後端／前端建置輸出，不提交 |
| `config.example.yaml` | 可提交的預設設定 |
| `config.yaml` / `session.json` | 本機設定／敏感憑證，不提交 |

## 建置與驗證

Phase 0 僅文件；以下命令為後續階段交付契約，在 scripts 建立前不能執行：

```sh
npm install
cp config.example.yaml config.yaml
npm run typecheck
npm run build
npm test
npm audit
npm start
```

後端 `tsc` 建置，前端 Vite 建置；`npm test` 使用 `node --test` 與 Mock Provider。修改後做針對性驗證並啟動實際程序或操作瀏覽器，不可只憑型別檢查宣告完成。測試應驗證消費者可見行為、邊界、轉移與錯誤，不測程式字串或單純 wiring。

Gate 依 [PLAN.md](PLAN.md) 逐關驗收，不跳關；Gate 0 遠端需存在四件必要文件及前置根檔。Gate 1 必須用**次要帳號** QR 掃碼，60 秒內接收真實訊息並驗證 session 權限。未經實測不得宣稱 Gate 通過。

## 安全性架構（硬規則）

1. 僅綁定 **127.0.0.1**；`config.yaml` 改 host 需明示裁示，預設值不得為 `0.0.0.0`。
2. QR URL 與 PIN **一次性顯示、不入日誌、不落盤**。
3. `session.json` 含憑證與 E2EE key material：chmod **600**、列入 `.gitignore`、不入日誌、不分享。
4. WS `Origin` 限 localhost 來源；非 localhost 拒絕升級。
5. 每連線頻率限制：`message:send` ≤ 5/秒；`POST /media/upload` ≤ 10MB/檔、≤ 5 次/分鐘；frame ≤ 256KB。
6. 媒體快取上限預設 200MB（LRU）；`getData(preview)` 優先，避免大檔。
7. 輸入驗證：`chatId` 格式（`u...／c...／s...`）、`text` ≤ 8000 字、`limit` ≤ 100、`packageId`／`stickerId` 限正整數、上傳 MIME 限 `image/*`。
8. 對外一律 generic 錯誤；內部錯誤只入本地日誌。
9. 依賴釘選版本；`npm audit` 無 high 以上（Gate 4 驗收）。
10. 解密／解析失敗 **fail-closed**：顯示佔位，不降級猜測內容。

內部日誌也不得包含憑證、token、QR URL、PIN 或 key material；不得直接 dump 套件錯誤物件、session 或登入 payload。圖片／貼圖走 HTTP，WS 不傳位元組；影片／語音／檔案僅佔位。訊息不落盤；每頻道最多 500 則，同 messageId 去重，編輯覆寫快取。LINE listen 失效採退避重啟；QR 失敗不自動循環，須由使用者動作重新產生。

## 文件維護

README 描述目前可執行的指令與驗證限制；未實作的契約須明示狀態。CLAUDE 僅引用本檔，不複製規範。PLAN 保留企劃全文，裁示變更需同步更新，不把假設寫成實測結果。
