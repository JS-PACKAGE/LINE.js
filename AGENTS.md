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
| `src/update/` | 版本比較與 GitHub Release 檢查器（只通知） |
| `scripts/update.mjs` | `npm run update`：使用者主動執行的 fast-forward 更新 |
| `src/cli.ts` / `scripts/cli.mjs` | `npm run cli -- login｜logout｜token`：經正在執行的服務（同一個 WS）登入（終端機 QR）、登出、重新產生機器人 Token；不直接讀寫 session |
| `linejs.sh` / `linejs.ps1` | 根目錄管理腳本（POSIX sh／PowerShell，功能相同）：`start｜stop｜restart｜update｜login｜logout｜token｜help`；只是 `node dist/main.js`、`scripts/service.mjs`（依 `linejs.pid` 停止服務，只終止命令列為本專案 `dist/main.js` 的程序）、`scripts/update.mjs`、`scripts/cli.mjs` 的捷徑，不得加入額外權限或繞過 CLI／服務的檢查。`linejs.ps1` 必須保留 UTF-8 BOM 與主控台 UTF-8 設定（Windows PowerShell 5.1 否則中文亂碼），兩支腳本的指令與行為要同步修改 |
| `src/http/apiToken.ts` | 機器人 Token：只存 SHA-256（`api-token.json`，0600），明文只在產生當下出現一次 |
| `src/cli.ts`（`token`／`token --revoke`） | 機器人 Token 的唯一產生／撤銷入口（2026-10 裁示：網頁不提供 API 視窗，前端不得再加入 Token 管理 UI） |
| `SECURITY.md` / `.github/SECURITY.md` | 安全政策（英文）／GitHub 偵測用指標檔 |
| `web/` | 繁體中文登入畫面、頻道列表、訊息、歷史、文字／圖片／貼圖輸入 |
| `dist/` / `dist/web/` | 後端／前端建置輸出，不提交 |
| `config.example.yaml` | 可提交的預設設定 |
| `config.yaml` / `session.json` | 本機設定／敏感憑證，不提交 |

## 建置與驗證

目前提供下列命令。缺少 `config.yaml` 時首次啟動自動建立；已有個人設定時不要用範本覆寫：

```sh
npm install
npm run typecheck
npm run build
npm test
npm audit
npm start
npm run update
npm run cli -- login|logout|token
./linejs.sh start|stop|restart|update|login|logout|token   # Windows：.\linejs.ps1 <同樣指令>
```

後端 `tsc` 建置，前端 Vite 建置；`npm test` 使用 `node --test` 與 Mock Provider。修改後做針對性驗證並啟動實際程序或操作瀏覽器，不可只憑型別檢查宣告完成。測試應驗證消費者可見行為、邊界、轉移與錯誤，不測程式字串或單純 wiring。`.github/workflows/ci.yml` 於 push／PR 以 Node 22 乾淨安裝執行 typecheck、test 與 `npm audit --audit-level=high`（唯讀權限、不用任何 secret）；CI 通過不代替實際程序或瀏覽器驗證，也不代替 Gate 實測。

Gate 依 [PLAN.md](PLAN.md) 逐關驗收，不跳關；Gate 0 遠端需存在四件必要文件及前置根檔。Gate 1 必須用**次要帳號** QR 掃碼，60 秒內接收真實訊息並驗證 session 權限。未經實測不得宣稱 Gate 通過。

登入完全經 WS：QR／PIN 只可送給發起 `auth:start` 的連線，`auth:state` 等廣播不得含祕密；不得新增 HTTP 登入端點或把祕密放進任何共享狀態。WS 升級必須同時驗證路徑、Host、Origin 與瀏覽器 cookie。每個 ws 連線必須掛 `error` 處理（超大 frame 會觸發 error，未處理會使程序崩潰）。登入 helper 無法在登入前附加 token 監聽，因此 adapter 使用等價 BaseClient 流程；token listener 必須先註冊。SessionStorage 沿用 FileStorage 契約但覆寫原子持久化，不能吞寫入錯誤。Thrift 以 override 固定修補版 `0.23.0`，不得解除修補而引入已知 high 漏洞。linejs 3.4.2 的 `fetchUsers()` 一次送出全部好友 mid，超過 LINE 上限 100 會失敗，因此 adapter 自行分批取得好友。

## 安全性架構（硬規則）

1. 監聽位址以 `config.yaml` 為準（2026-10 裁示：不再強制 127.0.0.1，可設主機名稱、IPv4、IPv6），**預設值與範本維持 `127.0.0.1`，不得改成 `0.0.0.0`**。非本機迴路位址啟動時須印警告；網頁無帳號密碼，改 host 等於把已登入帳號開放給該網路。**不檢查 `Host` 標頭**（裁示：不論監聽位址，任何 IP／網域皆可連入；代價是不防 DNS rebinding），其餘 Origin／cookie／Token／`Sec-Fetch-Site: cross-site` 檢查不變。
2. QR URL 與 PIN **一次性顯示、不入日誌、不落盤**。
3. `session.json` 含憑證與 E2EE key material：chmod **600**、列入 `.gitignore`、不入日誌、不分享。
4. 網頁 WS 升級須 `Origin`（`http`／`https`，後者供 TLS 反向代理／自訂網域）的主機部分等於 `Host` 標頭並帶瀏覽器 cookie；其餘來源拒絕升級。
5. 每連線頻率限制：`message:send` ≤ 5/秒（收回 `message:unsend` 共用此額度，且只接受伺服器已顯示、本帳號所發的訊息，機器人不可用）；`POST /media/upload` 圖片 ≤ 10MB/檔、影片 ≤ 50MB/檔（`limits.uploadVideoMaxBytes`）、≤ 5 次/分鐘；frame ≤ 256KB。
6. 媒體快取上限預設 200MB（LRU）；收到的媒體只能請求已見過的訊息（`msg-<id>`），單檔上限 `limits.downloadMaxBytes`（預設 50MB），類型一律以位元組內容判斷且不供應 SVG／HTML；訊息媒體不得被瀏覽器快取。
7. 輸入驗證：`chatId` 格式（`u／c／r／s／m` 開頭；OpenChat 為 `m`）、`text` ≤ 8000 字、`limit` ≤ 100、`packageId`／`stickerId` 限正整數、上傳媒體以內容判斷（圖片 PNG／JPEG／GIF；影片 MP4／MOV，以 `ftyp` 品牌辨識，聲稱的 Content-Type 只用來選擇大小上限；影片長度取自 `moov/mvhd`，不採用瀏覽器給的值）。
8. 對外一律 generic 錯誤；內部錯誤只入本地日誌。
9. 依賴釘選版本；`npm audit` 無 high 以上（Gate 4 驗收）。
10. 解密／解析失敗 **fail-closed**：顯示佔位，不降級猜測內容。
11. 機器人 API（`/api/ws`，預設關閉，`api.enabled`）：Bearer Token 認證（只存雜湊、比對用 `timingSafeEqual`、產生後只顯示一次、不入日誌）；升級**不得帶 `Origin`**（網頁不可用此入口），`Host` 不檢查；只開放 `message:send`（僅文字）、`history:fetch`、`ping`，其餘一律 `UNKNOWN_TYPE`；只能存取 `api.chats` 清單內的聊天室（空清單視為設定錯誤，未列出者一律 `UNKNOWN_CHAT`）；不給 `chat:read`、登入／登出、`channels:refresh`、媒體與貼圖發送；連線不重播舊訊息、不收 `read`；所有機器人合計 `api.sendsPerMinute`（≤120/分鐘）加每連線 `limits.sendsPerSecond`；同時最多 4 個連線；重新產生／撤銷 Token 立即中斷所有機器人連線。Token 的產生與撤銷只接受一般 `/ws` 連線（實務上只有取得瀏覽器 cookie 的本機 CLI 會送；網頁不提供此 UI），機器人連線無此權限。

內部日誌也不得包含憑證、token、QR URL、PIN 或 key material；不得直接 dump 套件錯誤物件、session 或登入 payload。圖片／貼圖／影片／語音位元組一律走 HTTP，WS 不傳位元組；收到的檔案只以 `file-<id>` 附件下載（`Content-Disposition: attachment`、`application/octet-stream`，不嗅探、不內嵌），規則同收到的媒體。訊息不落盤；每頻道最多 500 則，同 messageId 去重，編輯覆寫快取。LINE listen 失效採退避重啟；QR 失敗不自動循環，須由使用者動作重新產生。

版本更新（`src/update/`、`scripts/update.mjs`）：只通知、不自動下載或執行；檢查器僅匿名 GET 本專案 Release、只採 `X.Y.Z` tag、連結限本專案 `/releases/`、不轉送 Release 內文、不跟隨重新導向，失敗只記 `UPDATE_CHECK_FAILED`。不得新增網頁／WS 觸發更新的入口。`npm run update` 只 fast-forward 至 tag，工作樹不乾淨即中止。完整安全政策與回報流程見 [SECURITY.md](SECURITY.md)（英文）；變動其中任一硬規則須同步更新該檔。

其他 adapter 注意事項：OpenChat 歷史無「最新 N 則」查詢，只能由最舊事件向前走完再於記憶體分頁（快取 10 分鐘，期間以即時訊息與自己送出的訊息補上；LINE 監聽出錯即整個捨棄）；talk 歷史游標為 `deliveredTime:messageId` 且上界含端點，需多取一則並剔除錨點；非好友的群組成員名稱與大頭照以 `getContactsV2`／`getSquareMember` 補查（限時、限量、失敗退避），社群管理員角色同樣來自 `getSquareMember`；他人已讀位置來自 `getMessageReadRange` 與 `NOTIFIED_READ_MESSAGE`。**回報自己的已讀**（`sendChatChecked`／OpenChat `markAsRead`）會改變真實帳號狀態（對方看到「已讀」），因此只在小語要求下啟用：由網頁在聊天開啟且頁面可見時送 `chat:read`，伺服器只接受已顯示過的訊息、每個位置只送一次，並可用 `chat.sendReadReceipts: false` 關閉；驗證時不得對真實聯絡人的聊天室測試。已擁有貼圖包來自商店服務 `getOwnedProductSummaries`（linejs 3.4.2 未接線，經 `base.request.request` 呼叫 `/TSHOP4`），貼圖 id 與標題來自公開 CDN 的 `productInfo.meta`，失敗時退回 LINE 回傳的 id 區間。即時事件依聊天室各自排序處理：一個聊天室的成員查詢變慢不會拖住其他聊天室；好友資料以每批 100 人、最多 3 批同時查詢。

LINE operation 與連線注意事項：linejs 未記載多數 operation 的參數排列，`SEND_CHAT_CHECKED`（手機已讀）只取 `param1` 且須為伺服器已知聊天室；群組／個人資料／聊天室成員變動不解析參數，只觸發節流的頻道清單重新整理（3 秒合併、最多每 30 秒一次），不得改成依參數猜測內容。頻道清單的最後一則訊息（`Channel.lastMessage`）是預覽，不登記媒體來源，不能藉此下載。WS 心跳：伺服器以協定層 Ping 每 30 秒檢查、兩輪無回應即關閉；網頁 `ping` 需 10 秒內收到 `pong`，回到前景立即探測。斷線記錄（網頁主控台、服務日誌 `WS_CLOSED`）只可含時間、close code、截短的 reason 與前後景狀態，不得含標頭、cookie 或 Token。

PWA 注意事項：`web/public/sw.js` 只可快取公開靜態檔（`/`、`/assets/*`、`/icons/*`、manifest、favicon）；`/media/*`、`/ws` 與非 GET 請求絕不經手，避免私人內容在登出後殘留於 Cache Storage。新增靜態副檔名須同步 `src/http/server.ts` 的 mime 表。未讀數以 LINE 的 `unreadCount` 為準（talk `getMessageBoxes`、社群 `getSquareChatStatus`，盡力而為），連線時的訊息快照（`messages` 影格）不計未讀。

## 文件維護

README 描述目前可執行的指令與驗證限制；未實作的契約須明示狀態。README 以三種語言維護：`README.md`（繁體中文，正本）、`README.en.md`（English）、`README.ja.md`（日本語），三份章節結構與內容必須同步，修改其中一份須同步其餘兩份，且頂端的語言切換連結要保留。CLAUDE 僅引用本檔，不複製規範。PLAN 保留企劃全文，裁示變更需同步更新，不把假設寫成實測結果。
