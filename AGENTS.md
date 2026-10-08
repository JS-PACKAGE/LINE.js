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

以下為定案結構；目前已建立設定、session、LineProvider、同埠 HTTP（靜態頁、`/media`、圖片與影片上傳）、WS hub（登入、登出、頻道、即時與歷史訊息、發送、已讀）、訊息快取與聊天網頁（大頭照、貼圖、收到的圖片／GIF／影片／語音內嵌顯示、輸入框、自製確認對話框）。

| 路徑 | 職責 |
|---|---|
| `src/line/` | LineProvider、QR 登入、session、LINE 事件、歷史、發送、媒體下載 |
| `src/ws/` | WS 協定、snapshot、增量、單序廣播佇列、限流 |
| `src/http/` | 同埠 HTTP、靜態網頁、媒體上傳（圖片／影片）與媒體位元組 |
| `src/model/` | Channel／Message／Media DTO、正規化、去重與記憶體快取 |
| `web/` | 繁體中文登入畫面、頻道列表、訊息、歷史、文字／圖片／貼圖輸入 |
| `dist/` / `dist/web/` | 後端／前端建置輸出，不提交 |
| `config.example.yaml` | 可提交的預設設定 |
| `config.yaml` / `session.json` | 本機設定／敏感憑證，不提交 |

## 建置與驗證

目前 Phase 1 已提供下列命令。缺少 `config.yaml` 時首次啟動自動建立；已有個人設定時不要用範本覆寫：

```sh
npm install
npm run typecheck
npm run build
npm test
npm audit
npm start
```

後端 `tsc` 建置，前端 Vite 建置；`npm test` 使用 `node --test` 與 Mock Provider。修改後做針對性驗證並啟動實際程序或操作瀏覽器，不可只憑型別檢查宣告完成。測試應驗證消費者可見行為、邊界、轉移與錯誤，不測程式字串或單純 wiring。

Gate 依 [PLAN.md](PLAN.md) 逐關驗收，不跳關；Gate 0 遠端需存在四件必要文件及前置根檔。Gate 1 必須用**次要帳號** QR 掃碼，60 秒內接收真實訊息並驗證 session 權限。未經實測不得宣稱 Gate 通過。

登入完全經 WS：QR／PIN 只可送給發起 `auth:start` 的連線，`auth:state` 等廣播不得含祕密；不得新增 HTTP 登入端點或把祕密放進任何共享狀態。WS 升級必須同時驗證路徑、Host、Origin 與瀏覽器 cookie。每個 ws 連線必須掛 `error` 處理（超大 frame 會觸發 error，未處理會使程序崩潰）。登入 helper 無法在登入前附加 token 監聽，因此 adapter 使用等價 BaseClient 流程；token listener 必須先註冊。SessionStorage 沿用 FileStorage 契約但覆寫原子持久化，不能吞寫入錯誤。Thrift 以 override 固定修補版 `0.23.0`，不得解除修補而引入已知 high 漏洞。linejs 3.4.2 的 `fetchUsers()` 一次送出全部好友 mid，超過 LINE 上限 100 會失敗，因此 adapter 自行分批取得好友。

## 安全性架構（硬規則）

1. 僅綁定 **127.0.0.1**；`config.yaml` 改 host 需明示裁示，預設值不得為 `0.0.0.0`。
2. QR URL 與 PIN **一次性顯示、不入日誌、不落盤**。
3. `session.json` 含憑證與 E2EE key material：chmod **600**、列入 `.gitignore`、不入日誌、不分享。
4. WS `Origin` 限 localhost 來源；非 localhost 拒絕升級。
5. 每連線頻率限制：`message:send` ≤ 5/秒；`POST /media/upload` 圖片 ≤ 10MB/檔、影片 ≤ 50MB/檔（`limits.uploadVideoMaxBytes`）、≤ 5 次/分鐘；frame ≤ 256KB。
6. 媒體快取上限預設 200MB（LRU）；收到的媒體只能請求已見過的訊息（`msg-<id>`），單檔上限 `limits.downloadMaxBytes`（預設 50MB），類型一律以位元組內容判斷且不供應 SVG／HTML；訊息媒體不得被瀏覽器快取。
7. 輸入驗證：`chatId` 格式（`u／c／r／s／m` 開頭；OpenChat 為 `m`）、`text` ≤ 8000 字、`limit` ≤ 100、`packageId`／`stickerId` 限正整數、上傳媒體以內容判斷（圖片 PNG／JPEG／GIF；影片 MP4／MOV，以 `ftyp` 品牌辨識，聲稱的 Content-Type 只用來選擇大小上限；影片長度取自 `moov/mvhd`，不採用瀏覽器給的值）。
8. 對外一律 generic 錯誤；內部錯誤只入本地日誌。
9. 依賴釘選版本；`npm audit` 無 high 以上（Gate 4 驗收）。
10. 解密／解析失敗 **fail-closed**：顯示佔位，不降級猜測內容。

內部日誌也不得包含憑證、token、QR URL、PIN 或 key material；不得直接 dump 套件錯誤物件、session 或登入 payload。圖片／貼圖／影片／語音位元組一律走 HTTP，WS 不傳位元組；檔案僅佔位。訊息不落盤；每頻道最多 500 則，同 messageId 去重，編輯覆寫快取。LINE listen 失效採退避重啟；QR 失敗不自動循環，須由使用者動作重新產生。

其他 adapter 注意事項：OpenChat 歷史無「最新 N 則」查詢，只能由最舊事件向前走完再於記憶體分頁（快取 60 秒）；talk 歷史游標為 `deliveredTime:messageId` 且上界含端點，需多取一則並剔除錨點；非好友的群組成員名稱與大頭照以 `getContactsV2`／`getSquareMember` 補查（限時、限量、失敗退避），社群管理員角色同樣來自 `getSquareMember`；他人已讀位置來自 `getMessageReadRange` 與 `NOTIFIED_READ_MESSAGE`。**回報自己的已讀**（`sendChatChecked`／OpenChat `markAsRead`）會改變真實帳號狀態（對方看到「已讀」），因此只在小語要求下啟用：由網頁在聊天開啟且頁面可見時送 `chat:read`，伺服器只接受已顯示過的訊息、每個位置只送一次，並可用 `chat.sendReadReceipts: false` 關閉；驗證時不得對真實聯絡人的聊天室測試。已擁有貼圖包來自商店服務 `getOwnedProductSummaries`（linejs 3.4.2 未接線，經 `base.request.request` 呼叫 `/TSHOP4`），貼圖 id 與標題來自公開 CDN 的 `productInfo.meta`，失敗時退回 LINE 回傳的 id 區間。

PWA 注意事項：`web/public/sw.js` 只可快取公開靜態檔（`/`、`/assets/*`、`/icons/*`、manifest、favicon）；`/media/*`、`/ws` 與非 GET 請求絕不經手，避免私人內容在登出後殘留於 Cache Storage。新增靜態副檔名須同步 `src/http/server.ts` 的 mime 表。未讀數以 LINE 的 `unreadCount` 為準（talk `getMessageBoxes`、社群 `getSquareChatStatus`，盡力而為），快照重播的訊息不計未讀。

## 文件維護

README 描述目前可執行的指令與驗證限制；未實作的契約須明示狀態。CLAUDE 僅引用本檔，不複製規範。PLAN 保留企劃全文，裁示變更需同步更新，不把假設寫成實測結果。
