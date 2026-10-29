# LINE.js 本機 LINE 網頁客戶端 企劃書 v1.16

一句話：以 **WebSocket** 為即時通道、以 **@evex/linejs v3.5.0** 為 LINE 連線核心的本機 TypeScript 網頁客戶端（**LINE.js**）——Node 後端以 QR 掃碼登入 LINE，將訊息與頻道清單經 ws 推送到監聽 `127.0.0.1:3789` 的網頁前端。

### 基本資料

| 欄位 | 內容 |
|---|---|
| 本作品名稱 | **LINE.js**（本機 LINE 網頁客戶端） |
| 程式語言 | **TypeScript**（本地開發） |
| 執行環境 | **Node.js ≥ v22**（裁示最低版本；本機實測 `node -v` = v26.10.0、`npm -v` = 11.19.1，2026-10-08） |
| 通訊/介面 | **ws://127.0.0.1:3789**（WebSocket）＋同埠 HTTP（靜態前端、媒體位元組） |
| 本作品倉庫 | https://github.com/JS-PACKAGE/LINE.js（main） |
| 本作品授權 | **Apache-2.0**（以倉庫根 `LICENSE` 為準，實作不得改寫） |
| 前置檔案 | `LICENSE`、`.nojekyll` **已在 main**（2026-10-08 經 GitHub API 驗證，見 Gate 0） |
| 消費套件 | **@evex/linejs v3.5.0**＋**@evex/linejs-types v3.5.0**（JSR，MIT；本次升級已獲使用者明示授權） |
| 套件倉庫 | https://github.com/evex-dev/linejs（原始 3.4.2 調查對應 tag `v3.4.2`、commit `ef6c3d9`；不作為 3.5.0 的驗證證據） |
| 套件文件 | https://linejs.evex.land/（2026-10-08 驗證可連） |
| 套件授權 | MIT（授權宣告列入 `README.md`） |

本次由 3.4.2 升至 3.5.0，維持 Node.js ≥22、LineProvider adapter 邊界與 `overrides` 的 `thrift@0.23.0`，不新增通話功能。本次未使用真實 LINE 帳號驗證，3.5.0 的真實 LINE Gate 尚未驗收；下文註明 3.4.2 的來源調查與既有實測僅保留為歷史紀錄，不代表 3.5.0 已通過驗證。

3.5.0 PUSH 相容處理：上游 `fetchMyEvents` 失敗後仍保留連線，留待下一個 square push 重試；adapter 遇到 `[LEGY/PUSH] fetchMyEvents failed` 即作廢 OpenChat 歷史快取（含進行中的查詢），避免沿用可能漏事件的歷史。不轉送上游 log payload 或憑證、不另增重試；此為來源與 adapter 行為說明，不是真實 LINE Gate 驗證結果。

本次隔離驗證：`npm run typecheck`、`npm test`（含 build，306 項通過）與 `npm audit --audit-level=high`（0 漏洞）完成。實際執行 3.5.0 `BaseClient`／`ConnManager`，以隔離上游錯誤確認 noop 與 square PUSH 拒絕不終止程序、square 失敗立即清除歷史快取且保留 sync token；另以正式 HTTP／WS 與 adapter 驗證管理員分頁、同連線 mention 授權及重新查詢撤權。未連接真實 LINE、不取代 Gate 驗收。

---

## 〇、專案概述

### 目標
- 以 TypeScript 本地開發 LINE 網頁客戶端 **LINE.js**：Node 後端經 @evex/linejs v3.5.0 連線 LINE（Thrift／LEGY／PUSH／E2EE）。
- 後端預設監聽 **127.0.0.1:3789**（PORT 由本文件定案；host 與 PORT 值入 `config.yaml`，v1.11 起 host 以設定檔為準），以 **ws** 將 LINE 訊息與頻道清單推送到網頁客戶端。
- 第一版全功能：頻道清單、即時訊息串流、歷史載入、網頁端發送**文字／圖片／貼圖**、圖片／貼圖顯示。
- 登入採 **QR 掃碼**（免帳密）；session 持久化，重啟優先復用、失效才重掃。
- 交付必要文件四件（README／AGENTS／CLAUDE／PLAN）後才收尾實作。

### 範圍外
- 公開部署、對外網址、HTTPS／網域（預設僅監聽 127.0.0.1；host 可由 `config.yaml` 改，但不提供也不負責對外部署）。
- 套件發布（npm／JSR）：裁示為**只開源倉庫供 clone，不發套件**。
- 多帳號、多使用者、帳號系統與權限。
- 檔案（FILE）的預覽與播放（v1.14 裁示：可下載，見下）。
- 網頁端發送檔案、發送影片／語音；訊息編輯送出（linejs 僅支援接收 `message:edit`）、收回他人訊息。
- 通話（linejs 具 call 能力但不在範圍）、社群管理操作（邀請／踢人／公告）、Timeline／Moa 相簿、貼圖商店、自動回覆／AI Agent 整合。

### 硬性要求

| 編號 | 要求 |
|---|---|
| R1 | TypeScript 本地開發；執行環境 Node.js ≥ **v22**（本機 v26.10.0） |
| R2 | 消費套件釘選 **@evex/linejs@3.5.0**、**@evex/linejs-types@3.5.0**（JSR），不追 main；本次升版已獲人工明示裁示，後續升版仍須人工裁示 |
| R3 | 後端預設監聽 **127.0.0.1**，PORT 預設 **3789**，主機與 PORT 值入 `config.yaml` 且以設定為準（v1.11 裁示：不再強制本機迴路），程式不得寫死 |
| R4 | 以 **ws（WebSocket）** 將 LINE 訊息與頻道清單推送到網頁客戶端；同埠 HTTP 提供靜態前端與 `GET /media/:mediaId` 媒體位元組 |
| R5 | 登入＝**QR 掃碼**（免帳密）；session（cert／refreshToken／authToken）持久化於 `session.json`，重啟優先復用、失效才重掃；QR URL 與 PIN 僅一次性顯示、不入日誌 |
| R6 | 第一版功能：①頻道清單（好友／群組／聊天室／社群）②即時訊息串流（含 `square:message`、`message:edit`）③歷史載入（預設最近 50 則）④網頁端發送文字、圖片、貼圖（機制見「四、通訊協定」）⑤圖片／貼圖顯示 |
| R7 | 媒體：收到的圖片／GIF／影片／語音經 adapter 取得（E2EE 於後端解密）後由 HTTP 內嵌供網頁顯示與播放，貼圖與大頭照由 LINE CDN 經後端代取；檔案只以附件下載（v1.6 裁示：影片、語音、GIF 納入顯示；v1.14 裁示：檔案可下載） |
| R8 | 安全：預設鎖定 127.0.0.1（可由設定改，非迴路時警告）；`session.json` 權限 600 且不入版本控制；憑證／QR／PIN 不入日誌；網頁 WS 須 Origin 等於 Host 並帶瀏覽器 cookie；機器人 API 以 Bearer Token；每連線頻率、frame 與上傳大小上限 |
| R9 | 必要文件四件：`README.md`／`AGENTS.md`／`CLAUDE.md`／`PLAN.md` |
| R10 | 實作順序：Gate 0（倉庫根檔＋必要文件）達成後才寫程式 |

---

## 一、需求總表

| 面向 | 需求 |
|---|---|
| 連線 | QR 登入；session 持久化復用；`update:authtoken` 隨手寫入；LINE 側 listen 失效以退避重啟 `client.listen()` |
| 驗證 | QR URL／PIN 只在網頁一次性顯示；不寫入任何日誌或檔案 |
| 核心功能 | 頻道清單、即時訊息、歷史載入、發送文字／圖片／貼圖、圖片／貼圖顯示（詳 R6） |
| 即時同步 | ws 連線即送 snapshot（`channels`＋`auth:ready`），增量以 `message`／`message:edit` 推送；斷線自動重連並重送 snapshot |
| 媒體 | `GET /media/:mediaId` 位元組供應、`POST /media/upload` 上傳（≤ 10MB）；快取上限（預設 200MB，LRU）；ws 不傳位元組 |
| 安全性 | 全部依 R8；細則見「六、安全性架構」 |
| 專案文件 | 四件必要文件（R9）；安全性章節完整寫入 `AGENTS.md` |
| 部署 | 本機程序：`npm install → npm run build → npm start`（或 `./linejs.sh start`／`.\linejs.ps1 start`）；預設僅 127.0.0.1，無對外 |

---

## 二、系統架構

```
[LINE 伺服器] ⇄ @evex/linejs v3.5.0（Thrift／LEGY／PUSH／E2EE）
                       │
          [LINE.js 後端｜Node ≥22｜TypeScript｜127.0.0.1:3789]
          ├─ src/line/    LineProvider adapter：QR 登入、事件、歷史、發送、媒體
          ├─ src/ws/      ws 伺服器：連線管理、snapshot＋增量、限流
          ├─ src/http/    同埠 HTTP：靜態前端、GET /media/:mediaId、POST /media/upload
          ├─ src/model/   Channel／Message／Media DTO 與正規化
          └─ config.yaml  host／port／預設值（程式不得寫死）
[瀏覽器｜網頁客戶端 web/] ⇄ ws://127.0.0.1:3789
          ├─ 登入頁：QR 圖（以 qrcode 產生）＋PIN 一次性顯示
          ├─ 主畫面：左欄頻道清單、右欄訊息視圖、輸入框（文字、圖片、貼圖）
          └─ Vite＋vanilla TypeScript（見假設 3）
```

- **語言與建置**：後端 `tsc` → `dist/`（Node ESM，目標 Node ≥22）；前端 Vite build → `dist/web/` 由同埠靜態服務。`npm run typecheck`（`tsc --noEmit`）、`npm test`（`node --test`＋Mock Provider）。
- **依賴策略**：最少相依＝@evex/linejs＋@evex/linejs-types（JSR）＋ws＋yaml＋前端 qrcode；其餘為 dev（typescript、vite）。全部釘選版本。
- **狀態儲存**：`session.json`（linejs `FileStorage`）＋記憶體訊息快取（每頻道 ≤ 500 則）＋媒體快取（LRU）。不引入資料庫（範圍外）。
- **部署形態**：本機程序，預設僅 127.0.0.1（見「八、倉庫與部署」）。

---

## 三、外部 API 介接（@evex/linejs v3.5.0 ＋ LINE 服務，皆經 adapter）

> 本節為**本系統需要的最小契約**；原始逐項驗證依據為 v3.4.2 原始碼（`packages/linejs/client/`），並非 3.5.0 的實測紀錄。升級後若與契約衝突，**以目前釘選套件的實際行為為準，只改 adapter**，不動核心狀態機；隔離驗證不能取代真實 LINE Gate。

### 3.1 LineProvider 介面（實作含 MockLineProvider，無 LINE 帳號可開發測試）

| 契約方法 | 對應 linejs（已驗證） |
|---|---|
| `loginQR({ onQRUrl, onPinCode })` | `loginWithQR({ onReceiveQRUrl, onPincodeRequest }, { device: "ANDROIDSECONDARY" })` |
| `restoreSession()` | `loginWithAuthToken(storage.get("userAuthToken"))`；失敗回退 QR。監聽 `update:authtoken` 於 login **前**附加並持久化 |
| `onMessage(cb)`／`onMessageEdit(cb)`／`onSquareMessage(cb)` | `client.on("message"｜"message:edit"｜"square:message")`＋`client.listen()` |
| `fetchChannels()` | `client.fetchJoinedChats()`＋`client.fetchUsers()`＋`client.fetchJoinedSquares()`／`fetchJoinedSquareChats()` 彙整 |
| `fetchHistory(chatId, limit, before?)` | `chat.fetchMessages(limit)`；`before` 依 MessageFetcher `endMessageId` 分頁（不支援時退化為最近 N 則） |
| `sendText(chatId, text)` | `chat.sendMessage(...)`（Talk）／Square 發送路徑 |
| `sendImage(chatId, blob)` | `obs.uploadObjTalk`／`uploadMediaByE2EE` 產出 objId 後 `chat.sendMessage(...)` 圖片訊息 |
| `sendSticker(chatId, packageId, stickerId)` | `chat.sendMessage(...)` 貼圖 contentMetadata（STKID／STKPKGID） |
| `downloadMedia(message)` | `message.getData()`（內部 `downloadMediaByE2EE`／`downloadMessageData`）→ Blob |
| `getProfile()` | `client.getMyProfile()` |

### 3.2 失敗行為
- 解密失敗／不支援內容：訊息標記 `decryptFailed` 與 `contentType` 佔位，**fail-closed 不冒充內容**。
- LINE 服務失敗：ws 推 `error`（generic code），本地日誌只記固定操作錯誤碼，不記上游錯誤名稱、訊息或物件；不自動循環重試（QR 重新產生需使用者動作）。
- 上傳／發送失敗：回 `error` 對應 `requestId`，前端保留草稿可重試；不半套送出（fail-closed）。

---

## 四、通訊協定（ws://127.0.0.1:3789/ws，JSON frames）

> v1.5：登入互動併入 ws（新增 `auth:state`、`auth:start`），不另設 HTTP 登入端點。ws 升級須帶本機 `Origin` 與首頁下發的 HttpOnly／SameSite=Strict cookie。
> v1.6：新增 `history.cursor`、`read`（已讀位置）；頻道與訊息帶 `pictureId`／`senderPictureId`（大頭照）；OpenChat 聊天 id 以 `m` 開頭；收到的圖片／影片／語音以 `msg-<messageId>` 媒體 id 提供（支援 Range）。
> v1.7：新增 `stickers:list`／`stickers`（已擁有貼圖包）、`chat:read`（已讀回報，受 `chat.sendReadReceipts` 控制）；`Message.senderRole`（社群管理員徽章）；媒體 id 新增 `stickerpack-<id>`；網頁可貼上／拖入圖片再送出；時間顯示 24 小時制並置於訊息後。
> v1.8：`channels` 的頻道帶 `unreadCount`（LINE 端未讀數，連線時載入）；`message` 影格在連線快照重播時帶 `replay: true`（前端不計未讀）；`message:send` 新增 `mentions`（@ 提及，僅群組／聊天室／社群）與 `replyTo`（回覆）；`Message.replyTo`；發送圖片同樣即時回顯；媒體 id 新增 `avatarfull-(p|o)-<hash>`（大頭照原圖，點擊放大）；已讀人數標示於每則自己的訊息；新增 PWA（manifest、service worker、favicon，僅快取公開靜態檔，不快取 /media、/ws）；網頁鎖定瀏覽器原生右鍵選單（文字欄位除外）。
> v1.9：上傳由「圖片」擴充為「媒體」：`POST /media/upload` 另接受 MP4／MOV 影片（以位元組內容判斷；錯誤碼 `INVALID_IMAGE` 改為 `INVALID_MEDIA`），影片上限 `limits.uploadVideoMaxBytes`（預設 50MB）；`message:send` 的 `mediaId` 可引用圖片或影片，伺服器依上傳內容決定送出型別。
> v1.10：新增 `update:available`（`{ version, current, url }`，GitHub 有較新 Release 時對所有連線廣播、新連線於 `hello` 後立即補送；僅公開資訊，登入前也會收到）；`hello.protocol` 由前端與自身常數比對，不相容即重新載入。前端以 build 時注入的版本與 `hello.serverVersion` 比對，不同則提示重新整理；服務重啟後 cookie 失效，舊分頁連線連續被拒三次且服務可連時自動重新載入。版本檢查由 `update.check`（預設 true）控制；更新由使用者執行 `npm run update`，不提供網頁觸發。

> v1.11：新增**機器人 API** `ws://<host>:<port>/api/ws`（`api.enabled`，預設關閉；Bearer Token、不得帶 `Origin`；只開放 `message:send`（僅文字）、`history:fetch`、`ping`；只能存取 `api.chats`；連線不重播舊訊息）。新增 `api:state`／`api:token`（Server → 網頁）與 `api:token:create`／`api:token:revoke`（網頁 → Server）：Token 由網頁或 CLI（`npm run cli -- token`）產生，只顯示一次，伺服器只存 SHA-256（`api-token.json`）。新增終端機介面 `npm run cli -- login｜logout｜token`（經執行中的服務，登入時在終端機畫出 QR）。根目錄新增管理腳本 `linejs.sh`／`linejs.ps1`（`start｜stop｜restart｜update｜login｜logout｜token`，僅為既有指令的捷徑；服務啟動時寫 `linejs.pid`，`stop`／`restart` 只終止命令列為本專案 `dist/main.js` 的程序）。**裁示**：`server.host` 不再強制 127.0.0.1，以 `config.yaml` 為準（預設與範本仍為 127.0.0.1，非本機迴路啟動時印警告）。

> v1.12（協定版本 2）：連線時的訊息快照改為每個聊天室一個 `messages` 影格（`{ chatId, messages }`），取代逐則帶 `replay: true` 的 `message`；`message` 只用於即時新訊息。前端合併後一次重繪，重連不再逐則重建畫面。新增 `message:unsend`（`{ chatId, messageId }`）：talk 的 `NOTIFIED_DESTROY_MESSAGE`／`DESTROY_MESSAGE` 與 OpenChat 的 `NOTIFIED_DESTROY_MESSAGE` 收回訊息時，快取改為只留寄件者與時間的佔位（`Message.unsent: true`），並停止供應該訊息的媒體；只處理伺服器已見過的訊息 id，通知早於訊息到達時以墓碑記住。`Message.mentions`：收到的文字中被 @ 的範圍（解析 `MENTION` metadata，範圍不合即丟棄），網頁以強調色標示，@ 自己或 @All 另以底色標出。

> v1.12（續）：`Message.card`：位置（`Message.location` 的名稱、地址、座標）、聯絡人（metadata `displayName`）、檔案（`FILE_NAME`／`FILE_SIZE`，不提供下載）、卡片訊息（`ALT_TEXT`）以文字小卡顯示；欄位缺漏或格式不合即不產生小卡，維持類型佔位。數字型 `contentType`（0–22）一律轉為名稱。通話的 metadata 未見於 linejs 3.4.2，只顯示「［通話］」。

> v1.12（續）：新增 Client → Server `message:unsend`（`{ requestId, chatId, messageId }`，僅網頁、與 `message:send` 共用頻率上限）：只接受伺服器已顯示、且為本帳號所發的訊息（talk 以帳號 mid；OpenChat 以本服務送出訊息時 LINE 回傳的成員 id），經 adapter 呼叫 `talk.unsendMessage`／`square.unsendMessage`；失敗回 generic `UNSEND_FAILED`。

> v1.13（協定版本仍為 2：只新增影格與選用欄位，舊頁面忽略未知影格）：`Channel.lastMessage`（清單預覽；載入時取自 LINE 摘要——talk `getMessageBoxes` 的 `lastMessages`（`lastMessagesPerMessageBoxCount: 1`，E2EE 每則只解密一次）、社群 `getSquareChatStatus.lastMessage`——之後隨即時訊息、編輯、收回更新；預覽不登記媒體，不能藉此下載）；`lastMessageAt` 另採 `lastDeliveredMessageId.deliveredTime`。新增 Server → Client `channel`（`{ channel }`，單一頻道變動，只給網頁）、`chat:checked`（`{ chatId }`，此帳號在其他裝置讀過，網頁清除未讀；來源為 LINE `SEND_CHAT_CHECKED`，只採用 `param1` 且須為伺服器已知聊天室）、`pong`（回應 `ping`）。心跳：網頁每 30 秒 `ping`、10 秒無 `pong` 即重連，回到前景立即探測；伺服器以 WebSocket 協定層 Ping 每 30 秒檢查，連續兩輪未回應即關閉。群組／個人資料／聊天室成員變動的 operation 不解析參數，只觸發頻道清單重新整理（同一波 3 秒內合併，最多每 30 秒一次）。

> v1.14（小語裁示：檔案可下載）：收到的檔案訊息由 adapter 登記為 `file-<id>`（與 `msg-<id>` 同為「已顯示才可取得」、同受 `limits.downloadMaxBytes` 限制，E2EE 社群檔案不支援），放在 `Message.card.fileId`；`/media/file-<id>` 一律回 `application/octet-stream`＋`Content-Disposition: attachment`（檔名 RFC 5987 編碼、去除控制字元與路徑分隔）、`no-store`，不嗅探、不內嵌；收回後一併自快取移除。

> v1.14（續，小語裁示：回應）：`Message.reactions`（talk 取自 `Message.reactions`，社群取自歷史事件的 `messageReactionStatus` 與即時 `NOTIFIED_UPDATE_MESSAGE_STATUS`；後者在 linejs 為未具型別結構，依 thrift 欄位編號解析，不符即忽略）。新增 `message:react`／`message:reactions`：經 adapter 呼叫 `talk.react`／`talk.cancelReaction`／`square.reactToMessage`（取消用 `UNDO`）；伺服器只接受已顯示、未收回的訊息，成功後於本機更新人數並廣播。talk 的即時回應通知（op 139／140）參數格式未經實測，暫不解析。

> 實作補完（協定版本仍為 2）：登出／換帳號以 session generation 作廢歷史、發送、回應、收回、已讀與頻道查詢的舊結果；歷史重新載入也同步清除已取消的回應。OpenChat 歷史採同聊天室 single-flight、時間＋訊息 id 錨點，快取最多 5 個聊天室各 5000 則、10 分鐘，合併即時訊息與狀態，過期時重新取得回應，僅已提供頁面的訊息授權媒體。網頁搜尋維持即時更新並跨聊天室依時間排序；初次歷史失敗可重試，回應更新不重建媒體 DOM，登出清除搜尋、私人畫面與通知。隔離測試與無頭靜音瀏覽器已驗證；尚未對本次變動重新進行真實 LINE Gate 驗收。

> v1.15（小語裁示：JEV 詐騙分析，協定版本仍為 2）：`config.yaml` 新增選用區段 `jev`（`token`：TypeSafe API 金鑰，有值才啟用；`model`：預設 `jev-1.13.0`）。新增 Server → Client `scam:state`（`{ enabled }`，連線即送、只給網頁，不含金鑰）與 `scam:result`（`{ requestId, chatId, messageId, analysis: { probability, tactic?: { kind, confidence } } }`，只送給要求的連線），Client → Server `scam:check`（`{ requestId, chatId, messageId }`，僅網頁、每連線每分鐘 10 次）。伺服器只接受已顯示、非本帳號、未收回、已解密、非系統訊息的文字訊息，以自己快取的文字經 `src/jev/` 呼叫 `POST https://api.typesafe.ai/v1/systemone`（Noul 題問是否為詐騙、Choice 題問最接近的手法；題目用英文，因官方說明英文準確度最佳），回應 fail-closed；未設定金鑰回 `SCAM_CHECK_UNAVAILABLE`，失敗回 `SCAM_CHECK_FAILED`。網頁對別人的文字訊息右鍵出現「詐騙機率分析」，以官方範例門檻分級（> 0.8 高度疑似、≤ 0.2 不太像、其間無法確定）並註明為模型估計、文字已送至 TypeSafe。尚未以有效金鑰實測真實分析結果。

> v1.16（小語裁示：JEV 開放給機器人 API，協定版本仍為 2；MCP 入口裁示不做）：機器人連線新增 `scam:check`（`{ requestId, chatId, messageId }`），規則同網頁——只接受伺服器已顯示、非本帳號、未收回、已解密、非系統訊息的文字訊息，送伺服器快取的文字——另限 `api.chats` 內的聊天室（其餘 `UNKNOWN_CHAT`），所有機器人連線合計每分鐘 10 次（與網頁各連線的額度分開）；成功回 `scam:result`，未設定金鑰回 `SCAM_CHECK_UNAVAILABLE`。機器人不收 `scam:state`。不接受機器人傳任意文字。

> v1.17（小語裁示：取得個人 ID，協定版本仍為 2）：新增 Client → Server `profile:get`（`{ requestId }`），網頁與機器人連線皆可用，回 `profile`（`{ requestId, profile }`，內容同 `auth:ready` 的 `profile`：`userId`、`displayName`、`pictureId?`），只送給要求的連線；只讀伺服器登入時取得的資料、不呼叫 LINE，未登入或缺 `requestId` 回 `INVALID_REQUEST`，與歷史共用每連線每秒 10 次的額度。機器人不受 `api.chats` 限制（不涉及任何聊天室）。網頁在左上角自己的名稱列右鍵（觸控長按）可顯示並複製自己的 ID。

> v1.18（小語裁示：僅機器人 API 查詢管理員，協定版本仍為 2；依 NekoGuard 契約修正）：請求為 `chat:admins:get { requestId, chatId }`，不保留舊 `chat:admins` 請求別名；只給 `/api/ws`，`/ws` 回 `UNKNOWN_TYPE`。機器人 `hello` 保留 `serverVersion`、數字 `protocol: 2`，新增 `capabilities: ["chat:admins"]`。指定聊天室須已知、已登入且位於 `api.chats`，否則回 `UNKNOWN_CHAT`；非社群回 `CHAT_ADMINS_UNSUPPORTED`。adapter 經 linejs 3.4.2 `getSquareChatMembers` 完整分頁，以 `ADMIN`／`CO_ADMIN` 篩選現任管理員（含未發言者），再以 `getSquareChat.squareChatMember` 取得自己的成員 ID。回要求者 `chat:admins { requestId, chatId, ownMemberId, admins: [{ userId, displayName, role: "admin"｜"coAdmin", pictureId? }] }`；兩種成員 ID 須符合 `/^p[A-Za-z0-9]{10,64}$/`，`displayName` 是字串。查詢／分頁／成員 ID 驗證失敗皆回 generic `CHAT_ADMINS_FAILED`，不回部分名單；與歷史／profile 共用每連線每秒 10 次額度。不新增網頁 UI。

> v1.18（續）：查詢成功僅授予同一機器人連線、同一聊天室以 `message:send.mentions` 標記該名單未發言管理員的權限，不寫入共享訊息快取。新查詢開始即撤銷舊授權，包含限流或後續失敗；只有最新查詢結果可授權，過期並行查詢回 `CHAT_ADMINS_FAILED`。斷線、登出／換帳號清除授權及舊結果；已顯示訊息寄件者仍依原規則可被標記。OpenChat 機器人排除自己訊息須用 `ownMemberId`，不是一般帳號 `profile.userId`。

> v1.19（2026-10 小語裁示：聊天室一次性管理員權杖，協定版本仍為 2）：新增 `chat:admin-token:get { requestId, chatId }` → `chat:admin-token { requestId, chatId, token, createdAt }`。網頁從聊天室標頭「搜尋」旁的「管理員權杖」取得；小語另裁示權杖資訊必須經 `/api/ws` 告知連入的外掛：連線、登入完成、頻道清單更新與每次成功兌換後，主動推送 `api.chats` 內已知聊天室的 `chat:admin-token { chatId, token, createdAt }`（無 `requestId`），外掛也可主動查詢。每個聊天室以 32-byte 安全亂數產生 `chatadm_` 權杖，只存記憶體，登出／換帳號／重啟／聊天室移除即失效（外掛收 `chat:admin-token:changed { chatId }` 或非 `ready` 的 `auth:state`）。機器人限定 `chat:admin-token:consume { requestId, chatId, token }`：格式不合回 `INVALID_REQUEST`，錯誤或已用回 `CHAT_ADMIN_TOKEN_INVALID`；成功時同步替換為不同的新權杖、回 `chat:admin-token:consumed { requestId, chatId }`（不含新值），再把新權杖推送給所有外掛，網頁收不含祕密的 `chat:admin-token:changed` 後重新取得。成功由機器人自行決定授權，不改 LINE 管理員、不授予 API／mention 權限；因 API 可讀明文，不能證明曾使用 WEB 或具 LINE 管理員身分。

> issue #2 修正（2026-10）：adapter 禁止 linejs 在 LINE 未發下群組金鑰時自行註冊（`tryRegisterE2EEGroupKey`），避免與官方 App 的新世代並存；代價是成員剛變動、LINE 尚未發下新金鑰時傳送失敗、訊息顯示佔位，待官方 App 建立新金鑰後恢復。即時訊息解密失敗不再被 linejs 靜默丟棄，改為「無法解密」佔位。驗證：以真實 linejs E2EE 程式碼與隔離 LINE 回應（群組金鑰 `NOT_FOUND`）確認傳送、歷史與即時路徑皆不註冊金鑰（修正前發出 2 次註冊流程，即時訊息被丟棄）。根因為推論：issue 回報的同世代雙金鑰與自行註冊吻合，但未以真實帳號重現 LINE 伺服器端行為；既有已損壞的世代無法由本修正修復，需由新成員加入觸發換代。

> v1.20（2026-10 小語裁示：社群成員加入通知，協定版本仍為 2）：`NOTIFIED_JOIN_SQUARE_CHAT` 有型別化負載（`squareChatMid`、`joinedMember`），但 LINE 只在各社群自己的 `fetchSquareChatEvents` 事件串回報（linejs `SquareChat.listen` 亦是逐聊天室輪詢），不在 `listen` 的全域推播串；初版誤聽全域串，實際部署未出現紀錄。改為 adapter 讀取 `api.chats` 內社群的事件串（小語裁示：每收到一次全帳號社群推播 `fetchMyEvents`（任何類型）就立即讀全部，不設計時器；每聊天室同時一個請求；登入後先讀到最新位置，之前的加入不報），驗證格式後記住成員名稱／大頭照，並由 hub 以 `chat:member-joined { chatId, member: { userId, displayName, pictureId?, pictureUrl? } }` 推送給所有機器人連線（限 `api.chats`、已登入、不重播、網頁不收），`hello.capabilities` 加入 `chat:member-joined`。服務日誌記錄 `LINE 社群成員加入：chat=… member=… name="…" picture=https://obs.line-scdn.net/…`（小語裁示：含暱稱與大頭貼網址）。一般群組不在範圍：其成員變動 operation 參數未記載，依規範不猜測。驗證：以正式 adapter、HTTP／`/api/ws` 隔離環境確認登入前的加入不推送、任一社群推播立即讀取並推送、日誌含暱稱與大頭貼網址，同時推送給所有已連入的 `/api/ws` 客戶端；尚未以真實 LINE 帳號確認事件實際送達。

> 社群加入大頭照修正（2026-10）：小語回報有照片的成員加入時日誌為 `picture=-`。加入事件未提供有效照片時，adapter 不再將該成員視為已完整查詢，改用既有 `getSquareMember` 查詢流程（沿用限時、併發上限與失敗退避）補取，再推送加入通知；查詢失敗仍推送不帶照片的通知。等待期間換帳號或移除監看則丟棄結果。typecheck、build、102 項 provider 測試及編譯後 adapter 隔離 smoke 通過；尚未以真實 LINE 帳號確認補查照片結果。

> 社群加入照片排查（2026-10）：小語實測補查後仍為 `picture=-`，根因尚未確認。僅在加入事件缺少有效照片時新增 `LINE 社群加入照片` 診斷：事件／補查回應的照片欄位型別、長度、字元與格式驗證結果，以及請求、共用查詢、退避、逾時／取消、請求或解析失敗階段；不輸出原始 hash、回應或錯誤內容，不恢復普通訊息日誌。typecheck、build 與編譯後 adapter 隔離 smoke 已驗證空照片、格式不符、查詢失敗及有效照片四種情況。此為排查補強，不宣稱真實 LINE 照片問題已修復。

> 社群加入照片最終路徑修正（2026-10）：小語確認為自行上傳且服務帳號在官方 App 可見；加入事件及 `getSquareMember` 都回空 hash。參考 [CHRLINE 的 OBS 成員圖片路徑](https://github.com/DeachSword/CHRLINE/blob/master/CHRLINE/object.py)，實際讀取回報成員的 `https://obs.line-scdn.net/r/g2/member/<memberId>`，成功取得 WebP 圖片。修正「無 hash 就不給網址」的假設：有有效 hash 沿用原網址，否則使用已驗證格式的成員 ID 路徑；`pictureId` 可缺省。移除前述加入照片補查與臨時診斷；它們的紀錄保留為排查歷史。未宣稱 NekoGuard 聯測或真實 LINE Gate 通過。

> 驗證：typecheck、build、360 項測試通過；編譯後正式 adapter 接收空 hash 的加入資料，輸出的 `pictureUrl` 實際 GET 回 HTTP 200，內容以位元組確認為 JPEG（115353 bytes）。讀取工具曾取得 WebP，故不假設此端點只有單一圖片格式。未使用真實帳號觸發新的加入事件或完成外掛顯示聯測。

> v1.23（小語裁示：開放 `/api/ws` 上傳文字檔、PDF、圖片、影片、聲音檔，協定版本仍為 2）：新增 `POST /api/media/upload`，認證同 `/api/ws`（`api.enabled`、Bearer Token、不得帶 `Origin`），位元組只走 HTTP；回 `{ mediaId }` 後由機器人 `message:send { mediaId }` 送到 `api.chats` 內的聊天室，`hello.capabilities` 加入 `media:upload`。類型一律以位元組判斷：PNG／JPEG／GIF 圖片、MP4／MOV 影片、M4A 語音訊息（須讀得到 `moov/mvhd` 長度，否則 `INVALID_MEDIA`），MP3、PDF、UTF-8 文字以檔案附件送出（MP3 不當語音訊息，因 LINE 語音以 M4A 為主且 MP3 長度需估算）；附件名稱取自 percent-encoding 的 `X-File-Name`，去除控制字元與路徑分隔、≤255 字、副檔名依內容補上。新設定 `limits.uploadFileMaxBytes`（預設 50MB、上限 200MB）；全部機器人共用一份 `limits.uploadsPerMinute`，與網頁分開。上傳 ID 綁定擁有者（網頁／機器人互不可用）。adapter 以 linejs `uploadObjTalk` 的 `audio`／`file` 類型上傳（E2EE 聊天室退回 `uploadMediaByE2EE`）。網頁上傳不變。驗證見下；尚未以真實 LINE 帳號確認檔案與語音實際送達、OpenChat／E2EE 聊天室的行為與 E2EE 語音長度顯示。

> v1.23 驗證：typecheck、build 與全部測試通過（含上傳認證、類型判斷、檔名、大小、額度、擁有者隔離與 adapter 上傳參數）；另以實際 HTTP＋`/api/ws`（Bearer Token）連到正式 adapter，上傳 PDF 與文字檔後 `message:send` 回 `sent`，linejs `uploadObjTalk` 收到 `file` 類型與 `月報.pdf`、`名單.txt` 檔名（LINE 網路呼叫為替身）。未呼叫真實 LINE。

> 日誌降噪（2026-10 小語裁示）：`NOTIFIED_UPDATE_SQUARE_CHAT_STATUS`（社群聊天室狀態：成員數、未讀數、已讀位置等，幾乎每次聊天室變動都會送）不再記 `LINE 未處理社群事件`；其他未處理事件照舊記類型。此事件仍與其他推播一樣觸發 `api.chats` 社群事件讀取（成員加入偵測不變）。

> v1.21（小語裁示：詐騙機率分析移交 NekoGuard，協定版本仍為 2）：移除 `jev` 設定區段、`src/jev/`、`scam:check`／`scam:state`／`scam:result` 與相關錯誤碼、網頁右鍵選單「詐騙機率分析」；舊設定檔的 `jev` 區段會被忽略。v1.15、v1.16 與詐騙分析加速的紀錄僅保留為歷史。驗證：typecheck、build 與 346 項測試通過；以含舊 `jev` 區段的設定啟動實際 `dist/main.js`，服務正常啟動、網頁連線不再收到 `scam:state`，`scam:check` 回 `UNKNOWN_TYPE`（機器人連線同樣由測試確認）。

> v1.22（小語裁示：群組與社群記事本發文推送給機器人，並抓完整文章，協定版本仍為 2）：LINE 以 `POSTNOTIFICATION` 訊息通知記事本發文；依其他用戶端的實測紀錄，群組為 `serviceType: GB`、`postEndUrl` 為 `…/group/home/posts/post?homeId=c…&postId=…`，社群為 `serviceType: SN`、`line://square/post?squareMid=s…&postId=…`（相簿 `AB`、分享 VOOM `MH` 同類型，不處理）。`src/line/notes.ts` 只接受完全符合的格式，訊息帶 `card: { kind: "note", postId, preview? }`（網頁以「記事本」小卡顯示摘要）。`api.chats` 內的即時新訊息，在已登入且有機器人連線時，由 adapter `fetchNoteText` 以 linejs `base.timeline.getPost` 取全文（首次使用核發 LINE Timeline 頻道權杖），只讀自己看過通知的貼文，群組 `homeId` 須等於該群組、社群 `squareMid` 須等於 `getSquareChat` 的所屬社群，回應須含所要求的 `postId`；逾時 15 秒、全體每分鐘 20 次。hub 以 `chat:note-posted { chatId, messageId, postId, senderId, senderName, createdAt, preview?, text | error: "NOTE_FETCH_FAILED" }` 只推給機器人，`hello.capabilities` 加入 `chat:note-posted`。驗證：typecheck、build 與 355 項測試通過；以正式 adapter、hub、HTTP 與 `/api/ws` 的隔離環境確認群組與社群通知各推送全文給兩個機器人連線、指向其他群組的偽造通知不呼叫 LINE 並回 `NOTE_FETCH_FAILED`、網頁不收；瀏覽器確認「記事本」小卡與聊天列表預覽。尚未以真實 LINE 帳號確認通知格式、記事本 API 的端點與回應格式，也未確認分享記事本是否產生相同通知。

> v1.22.1（小語回報實際部署沒有抓到記事本，要求輸出日誌排查）：加入排查日誌，不含內文：可能是記事本的即時訊息（`POSTNOTIFICATION`／`GROUPBOARD` 或帶 `postEndUrl`）記 `LINE 記事本通知：…`（類型、`serviceType`、`locKey`、`postEndUrl`、metadata 欄位名稱、摘要長度、是否辨識）；hub 記 `記事本通知略過：… reason=…`、`記事本全文已推送：…` 與 `NOTE_FETCH_FAILED … reason=…`（含 LINE 狀態碼與簡短訊息）；未處理的 LINE operation 與社群事件記 `LINE 未處理事件：op=…`／`LINE 未處理社群事件：type=…`（只有類型）。目的在確認記事本通知實際走哪個事件、格式為何；原因尚未查明。

> 日誌降噪（2026-10 小語裁示）：逐則 `LINE 訊息收到：id=… type=… kind=…` 資訊日誌只保留 `IMAGE` 圖片類型，普通文字不記錄，訊息處理及推送不變；保留收回、社群加入、記事本排查與錯誤日誌。

> v1.22.2（小語實測日誌：社群張貼記事本時只出現 `LINE 未處理社群事件：type=NOTIFIED_UPDATE_SQUARE_NOTE_STATUS`，沒有聊天訊息）：該事件只含 `squareMid`、`noteCount`、`latestCreatedAt`。adapter 改為在最新建立時間晚於登入或上次處理時間、且 `api.chats` 有屬於該社群的聊天室時，以 linejs `base.timeline.listPost` 讀社群記事本列表找出新貼文，再以 `getPost` 取全文，hub 對該社群在 `api.chats` 內的聊天室推 `chat:note-posted`（`messageId` 改為選填，作者取自列表；列表讀不到時送不含 `postId` 的 `NOTE_FETCH_FAILED`）。日誌新增 `LINE 社群記事本狀態`、`社群記事本略過`、`社群記事本列表`、`社群記事本全文已推送`。驗證：typecheck、build 與 359 項測試通過（正式 adapter 搭配模擬的 LINE 回應）；尚未確認 `/sn/` 記事本列表與內文 API 在真實帳號可用及其回應格式。

> 本次驗證：typecheck、build 與 262 項測試通過；已以隔離 LINE 回應、實際 HTTP／WS Token 認證及正式 adapter 驗證 capability 握手、完整分頁、`ownMemberId`、未發言管理員的 MENTION metadata、跨連線拒絕與重新查詢撤銷。回歸測試另涵蓋聊天室／網頁隔離、空名單、失敗、限流、回應順序顛倒、斷線、登出／換帳號。尚未以真實 LINE 帳號或 NekoGuard 程序完成聯測，不宣稱通過 Gate。

> 詐騙分析加速（協定版本仍為 2）：同一登入期間，網頁與 API 在完成既有資格／聊天室權限／限流驗證後，以 UTF-16 完整文字的 SHA-256 合併同內容的進行中請求，並重用成功結果（完成起有效 5 分鐘，命中不延長）；記憶體 LRU 最多 256 筆含進行中請求，不另存原文、不落盤。失敗不快取，登出／換帳號／關閉服務清除；等待期間文字變更、收回或移出訊息快取回 `INVALID_REQUEST`，舊帳號請求不得回填新快取。模型、完整文字、Noul／Choice 題目、回應格式及每分鐘限額不變，不新增自動分析或付費預熱；分析錯誤只記固定代碼。首次分析仍受真實上游及網路延遲限制。

> 加速驗證：typecheck、build 與 273 項測試通過；正式 JevClient 搭配固定 200ms 隔離上游，經實際 HTTP／WS cookie 與 Token 認證，網頁／API 同內容同時查詢後重查，上游請求由 3 次減為 1 次、重查由約 203ms 降為 0.46ms。測試涵蓋精確文字、不同內容並行、到期、LRU、失敗、權限、限流、編輯／收回／淘汰及登出／換帳號競態。未呼叫付費 TypeSafe API，數字非真實上游效能，未操作真實 LINE 帳號或宣稱 Gate 通過。

> 封包處理優化（協定版本仍為 2）：網頁與 API 共享同一份廣播的 JSON／UTF-8 編碼，明確以文字影格送出；資料只在該次廣播共用，不建立跨訊息或跨帳號的序列化快取。只有 `api.chats` 內的訊息／編輯／收回可同時送兩組連線，私人回覆仍只送要求者。頻道快照排序一次再依 API 權限篩選；不合併事件、不改順序、輸入驗證、限流或背壓保護。

> 封包驗證：typecheck、build 與 277 項測試通過，涵蓋純網頁／純 API／混合連線、Unicode、連續訊息／編輯／收回、去重及聊天室隔離。正式 HTTP／WS hub 與隔離 provider 經實際 cookie／Token 認證，以 1 網頁協定連線＋4 機器人、每輪 4000 則、暖機後 5 輪中位數量測，完整方法與結果見 README〈建置與驗證〉。無真實 LINE 帳號操作，不含上游延遲、AI 推論或瀏覽器繪製，不代表 Gate 通過。

> API 頻道同步優化：API 連線先依 `api.chats` 篩選再排序，保留同時間／同名的原順序；純 API 服務不建立無人接收的完整網頁快照，混合連線仍共用網頁排序結果。不更動傳輸欄位、大小、權限、限流或協定，不新增快取。typecheck、build 與 279 項測試通過；正式 HTTP／WS hub、Token 認證、隔離 provider 的 5000 聊天室／3 個授權聊天室連線與資料準備量測見 README。不宣稱頻寬改善、真實 LINE 延遲或 Gate 通過。

> 效能自查修正（協定與安全規則不變）：成員查詢依來源／ID single-flight，提前預查、聊天室各自保序，全域實際請求最多 5 個；逾時槽位保留至上游完成，過期排隊工作取消，晚到或舊帳號結果不得回填。OpenChat 增加 ID 索引、二分游標與插入，維持事件優先權、收回及快取上限。API 直接查授權聊天室 ID 並保留穩定排序。前端合併 animation frame 重繪、保留 ID 索引與日期／搜尋／已讀排序快取、重用搜尋節點，以訊息 ID 固定歷史插入的可見位置；事件、未讀與順序不省略。媒體只減少單 chunk 複製及多 chunk 長度重算，E2EE、內容辨識、大小限制與 Range 不變，不改為串流下載。

> 本次驗證：typecheck、build、285 項測試通過；正式 adapter 的隔離 80ms 上游量測、正式 HTTP／WS Token 認證與 5000／3 聊天室量測，以及 Chromium 突發訊息／歷史／搜尋／媒體 DOM／編輯與回應／已讀／送出／切換／登出與圖片上傳驗證，方法及數據見 README。歷史與新訊息同時到達的跳動已先重現再修正確認；可見性僅在瀏覽器主執行環境模擬，不宣稱全面驗證背景節流。未操作真實 LINE 帳號或付費 AI API，不代表 Gate 通過。

> 第二輪效能自查（小語裁示全部實作，協定仍為 2）：網頁連線快照按聊天室以 256KiB 為目標分批，傳送完成才推進，即時增量保序排於快照後；待送增量與 socket 緩衝共用 8MiB 上限，單次傳送停滯 30 秒關閉。單則訊息不拆分，超過目標時獨立成批，仍受 8MiB 保護；機器人不回放。登出／換帳號／斷線／關閉作廢舊工作。媒體取得全域最多 4 個實際工作、64 個 FIFO 等待，相同 ID 合併，滿載回既有 404；收回或清除立即取消等待、拒絕舊結果，進行中上游完成前不釋放槽位。

> 前端以可變高度虛擬列表顯示完整搜尋結果；訊息每聊天室保留最多 500 則、全域 10,000 則，淘汰非目前聊天室的 LRU，畫面明示搜尋範圍、容量與移出數。歷史維持連續滑動窗口，可繼續往舊翻；回最新或離開歷史窗口重進時重新載入最新頁，不用過期游標跳過已移出區段。引用跳轉及提及候選只涵蓋保留範圍。已讀只在最新窗口、可見且置底看到最新訊息時回報。

> 驗證：typecheck、build 與 298 項測試通過。正式 HTTP／WS 隔離來源重播 20×500×2KB 訊息全部送達且不斷線，並行編輯／收回正確；30 個媒體 ID 實際並行 4 個。Chromium 驗證 5,000 命中初始僅 13 列 DOM、完整頭中尾／鍵盤跳轉、編輯／收回、手機寬度、2,500 則歷史連續翻頁、歷史期間不誤報已讀、25 聊天室與追加 700 則保持 10,000 上限及登出清除。未操作真實 LINE 或付費 AI，不代表 Gate 通過。

> 第三輪效能自查（小語裁示全部實作，協定仍為 2）：管理員查詢按目前 client／聊天室合併進行中工作，完成或失敗即移除，不快取完成名單；換帳號與 teardown 作廢舊工作，晚到清理不影響新查詢。hub 仍逐連線驗證與限流、重新查詢立即撤權、只採最新結果，授權不共享。頻道摘要的 talk 分頁與社群狀態並行，社群每次更新最多 5 個 worker，空槽即接下一筆；部分失敗盡力顯示，換帳號停止舊工作繼續排程。前端只在繪製時對待排序頻道排序，資料與未讀仍逐事件更新，直接繪製及登入生命週期同步處理；同排序鍵保留批次前順序。

> 驗證：typecheck、build 與 305 項測試通過。正式 adapter／HTTP／WS 隔離上游下，4 bot 同聊天室各 3 頁查詢由 12＋4 次上游呼叫降為 3＋1 次；完整回應、MENTION、重連／重新查詢撤權與最新查詢授權保持。固定延遲摘要由約 275ms 降為 182ms，社群並行峰值維持 5。Chromium 5,000 頻道／100 次增量由 100 次排序降為 1 次，累計排序約 47.1ms 降為 0.7ms；順序、預覽、未讀、篩選、分頁、延後繪製期間直接操作、重連及登出重新登入已確認。皆為單次隔離量測，未操作真實 LINE 或付費 AI，不代表效能保證或 Gate 通過。

> 持續效能自查：訊息反應以 `mine` 與六種 count 的值判斷是否改變，移除重複 JSON 序列化；欄位插入順序不同但內容相同不再觸發更新，仍區分未提供反應與空 counts，保留收回、編輯時間及最後訊息預覽語意。靜態檔 HEAD 只查 metadata，不讀取整檔；GET、媒體路徑、realpath 範圍檢查、cookie、安全標頭及快取政策不變。

> 本機隔離量測（同一 Node、相同 fixture，比較修改前後正式編譯模組）：每輪 200,000 次相同反應更新，暖機後 5 輪中位數由 18.25ms 降至 12.17ms；實際 HTTP 對 16MiB 公開 JS 檔送 30 次 HEAD，整檔讀取由 30 次／480MiB 降至 0 次／0 bytes，單輪約 92.65ms 降至 21.77ms。另確認反應順序去重、count 變更同步預覽、收回內容不復活。此數據不代表一般檔案大小、真實 LINE 延遲或整體吞吐保證；未連線真實 LINE。

> 驗證：typecheck、build 與 311 項測試通過，涵蓋反應值變更／去重／收回及 HEAD 的標頭、cookie、目錄／越界 symlink／跨站拒絕。全套執行發現既有 Token 測試在收到 `api:token` 後即讀取尚未更新的 `api:state`；已改成明確等待含 `createdAt` 的後續狀態，不更動正式協定。HTTP fixture 與 throwaway 量測檔已清除。

> 時鐘格式優化：訊息氣泡、搜尋列與今天的頻道時間直接讀本機 Date 時／分，保持 `HH:mm`、午夜 `00:xx` 與無效日期佔位，不快取時區；其餘日期標籤不變。typecheck、build 與 314 項測試通過，新增跨時區及 DST 邊界驗證。Chromium 同條件 5 輪各 5,000 次格式化中位數由約 89.3ms 降至 0.2ms（函式量測，非整頁耗時），正式聊天網頁的列表與氣泡時間及截圖已確認。未使用真實 LINE，未宣稱 Node 22 本機實測。限流器環形佇列方案雖有微量收益，但在現有低頻額度下不足以抵銷複雜度，本輪不改。

> 空白頻道搜尋直接使用目前分頁的新陣列，避免每次重繪仍把所有名稱轉小寫與建立第二份陣列；有關鍵字時維持原篩選。Chromium 5,000 頻道、每輪 200 次、7 輪中位數，空查詢的額外篩選由約 46.1ms 降至計時精度以下；非空查詢約 54.6／53.9ms，未宣稱改善。typecheck／build 通過，正式網頁確認 5,000 列、指定查詢 11 列、空白還原、好友空分頁及切回聊天，已截圖；不改排序或快取。

> 列表 DOM 完全相同時先依節點身分與順序確認後返回，省去 Set 與 childNodes 陣列；有增刪／排序時仍走原本 reconciliation，保持媒體節點身分。Chromium 5,000 節點、每輪 100 次、7 輪中位數，由約 44.1ms 降至 6.4ms（只量測不變列表）。typecheck／build 通過，實際函式以 11 組空列表、混合節點、增刪及排序案例確認結果，不變列表為零 childList mutation；正式網頁亦確認 100 則隔離即時訊息引發頻道重排、訊息開啟、搜尋刪減及還原，已截圖。

> 長頻道列表採原生 `content-visibility: auto`，只略過離屏列的內容 layout／paint，保留全部 DOM 與原有鍵盤、搜尋流程；以估計高度佔位，瀏覽器記住實際高度，首次顯示不同字型／好友列時可調整捲動範圍。不支援的瀏覽器維持原本呈現。Chromium 5,000 列、每輪 20 次寬度切換、7 輪中位數約 613.6ms → 123.2ms；正式建置頁確認初始僅 30 列內容需呈現，5,000 聊天／5,000 好友的離屏 focus＋Enter、捲至底部、搜尋及 390px 視窗均已操作／截圖，瀏覽器文字搜尋仍能找到離屏名稱。build 通過；未實測 Safari／Firefox，也未宣稱整頁載入時間。語義依 [MDN content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility)。

> OpenChat 自己的反應更新直接查既有 `byId` 索引，不再額外線性掃描最多 5,000 則歷史；索引本就隨增刪、收回及快取重建同步維護。隔離上游、實際 adapter 7 輪各 10,000 次反應切換，中位數約 89.2ms → 3.2ms；確認加入／取消反應、未知訊息、已收回訊息及陣列／索引一致。typecheck、build 與 314 項測試通過；此為本機處理成本，不含真實 LINE 往返，未宣稱外部 API 延遲改善。

> 舊聊天室日期直接組成本機 Gregorian 數字年月日，保留同年省略年份、昨天／今天優先、無效日期及 era year 行為；不快取時區，訊息日期分隔標籤不變。Chromium 52 組邊界結果與原 formatter 相同，7 輪各 5,000 次舊日期格式化中位數約 88.0ms → 2.6ms。typecheck／build、9 項格式化測試通過（含閏日、跨年與動態時區）；正式網頁 5,000 列的今天／同年／跨年日期逐一對照 native formatter，零差異並已截圖。數字為局部函式量測，非整頁或 LINE 網路延遲。

> CDN 圖片下載重用一般訊息媒體的串流限額讀取器：大頭照、貼圖、貼圖包圖示與 LINE emoji 維持既有 2 MiB 上限，但不再先讀完整回應才拒絕；宣告過大先取消，未宣告／低報則於實際串流超限時取消，原有格式檢查與 generic 失敗不變。32 MiB 隔離串流原本全部讀完，現在有宣告時消費 0 bytes，無宣告時消費 2 MiB＋64 KiB 的首個超限 chunk 即停止。實際雙 HTTP 服務驗證：宣告超大僅上游送出 64 KiB 即取消、chunked 超大送出 2 MiB＋64 KiB 即取消，兩者仍回 502 `MEDIA_UNAVAILABLE`；剛好 2 MiB 正常回 200。typecheck、build、321 項測試通過，含四個 CDN 入口的宣告／低報／缺少長度、精確邊界與空 body。無真實 LINE/CDN 請求；實際網路可能預取額外資料，不將消費量當作絕對傳輸上限。

> 貼圖 metadata、Jev 與 Release JSON 回應共用漸進 UTF-8 解碼，在串流中依既有 UTF-16 字數上限取消超大回應，不再先累積完整內容；原本的 Content-Length 前置檢查、模型／題目、metadata fallback 與 generic 錯誤均保留。隔離 32 MiB ASCII 串流原本無宣告時全數讀完，現在分別於 1,015,808／81,920／1,064,960 bytes 的首個超限 chunk 停止；Jev／Release 宣告超大也會取消 body。實際 HTTP 驗證三個入口提早關閉上游，並以剛好字數上限的多位元組中文 JSON 驗證正常解析，不誤改成 byte 上限。typecheck、build、325 項測試通過，新增跨 chunk BOM／多位元組／EOF 不完整 UTF-8、精確上限、取消與中斷回應不得回傳部分 JSON 的回歸。未呼叫真實 LINE、付費模型或 GitHub API；上游實際傳輸可含預取資料。

> 不使用的外部 HTTP 回應（非成功狀態、貼圖錯誤 MIME、既有宣告超限）主動取消 body，不等待 runtime 回收，也不為了重用連線把無用內容全部讀完。保留 403／404／410 的缺件或替代圖流程與既有錯誤碼；body 已失敗時，清理錯誤不得取代 status 所決定的錯誤／fallback 或曝露上游訊息。32 MiB 401 上游的單次隔離 HTTP 觀察，回報錯誤當下皆只送 16 KiB，100ms 內總傳輸由 368 KiB 降至 32 KiB；不是吞吐量保證，仍可能有在途資料。另以真實 HTTP 驗證 10 種拒絕情境均取消上游（本次只送 16–32 KiB），動畫貼圖與貼圖包仍取得替代 PNG；更新 404 不誤記失敗，其他錯誤僅固定碼。typecheck、build、326 項測試通過，含替代圖前先釋放缺件回應、不得讀取錯誤 body、已失敗 body 不洩漏錯誤內容。未使用真實外部服務。

> 頻道列只在值不同時設定 `aria-selected`，保留新列、選取切換及搜尋後復原的可及性狀態，不再每次 render 重寫所有既有列。Chromium 對 5,000 個既有節點重複 100 次的局部量測，7 輪中位數約 18.9ms → 5.9ms；非整頁加速比例。正式 HTTP／WS 網頁以 5,000 頻道接收 100 則隔離即時訊息，無選取切換時本次觀察到的 `aria-selected` 異動由 14,899 次降為 0（render 次數依排程而異）。typecheck／build 通過；瀏覽器驗證切換兩個聊天後恰有一列選取、搜尋單一聊天並開啟後清空搜尋恢復 5,000 列且仍只選取該列，已截圖確認高亮與訊息。未連線真實 LINE。

> 前端共用 `channelsById` 索引供通知名稱、聊天標頭、選單、訊息搜尋與已移除列清理查找；完整 snapshot、hello 與登出同步重設，增量更新同步替換索引與陣列的同一物件。保留原排序陣列與 tie 順序，增量更新以舊物件的原生 `indexOf` 定位，不維護易因排序失效的位置索引；搜尋不再逐次建立全頻道 Map。Chromium 局部量測 5,000 頻道、1,000 次更新及名稱查找（含新頻道與重複 ID 更新），7 輪中位數約 25.2ms → 0.2ms，結果與原路徑相同；不含索引初始化、DOM 或網路，非整頁加速比例。typecheck／build 通過；正式網頁驗證 200 則即時更新後新增頻道仍為 5,001 列且 ID 無重複，重新整理後搜尋／標頭／ID 選單使用更新名稱，WS 重連保留正確聊天；登出切換隔離帳號後只剩新帳號三個頻道，舊訊息搜尋為零、新訊息名稱正確並已截圖。無真實 LINE 帳號操作。

> 後端訊息編輯、回應與收回重用 `byId` 既有訊息物件，以原生 `indexOf` 定位陣列中的同一筆資料，不再逐筆比較訊息 ID；編輯亦合併重複的 Map 查找。不建立位置快取，維持晚到插入、同時間排序、淘汰與收回後不可復活的原行為。Node 26.7.0、每頻道 500 則、各 10,000 次操作的局部量測（收回分布於 20 個頻道），7 輪中位數：編輯 7.60ms → 1.18ms、回應 8.30ms → 1.82ms、收回 11.21ms → 5.35ms；非整體 WS 吞吐量。typecheck、build、327 項測試通過，新增插入／淘汰移動位置後連續編輯、回應、收回的回歸。正式 HTTP／WS 程序驗證即時三種異動、新連線快照正確淘汰舊訊息且收回內容／回應已消失，其他編輯與最新預覽不受影響；採隔離 Provider，未使用真實 LINE，未另驗證 Node 22。

> 前端訊息排序與保留窗口裁切共用直接填入 Map 的索引建立函式，不再先產生外層陣列及每則訊息的 `[id, index]` 暫存陣列；維持每次重建取得新 Map 的原有語意。Chromium 對 500 則訊息重建 10,000 次，7 輪中位數約 61.8ms → 38.8ms，查找結果相同；這是索引局部量測，不代表整頁加速比例。typecheck／build 通過；正式網頁驗證滿 500 則後的新訊息淘汰、晚到訊息排序、編輯／回應／收回仍指向正確訊息，載入歷史仍保留 500 個唯一 ID 並維持收回狀態，已截圖確認；按「最新訊息」重新取得最新 100 則且清除舊窗口。未使用真實 LINE，未新增只測索引複製細節的測試。

> 前端合併訊息後依實際筆數判斷是否需要淘汰錨點，不再把重複 ID／編輯的輸入數量誤算成新增筆數；只有確實超過每聊天上限時才讀取文字選取或掃描訊息位置。正式網頁保留 500 則、停在中段接收 100 次編輯，本次訊息列 `getBoundingClientRect` 呼叫由 25,135 降至 245，首個可見訊息與垂直位置完全相同；計數含正常重繪，次數依排程而異，不是耗時比例。typecheck／build 通過；亦重驗新訊息淘汰、晚到排序、回應／收回、歷史窗口及返回最新，另驗證選取最舊訊息文字後收到第 501 則時，選取與閱讀位置不變、保留原 500 則，按最新仍能取得暫未顯示的新訊息。使用隔離 Provider，未操作真實 LINE。

> 保留範圍狀態列只在完整顯示文字變動時寫入 `textContent`，不另存可能失效的狀態副本。正式網頁滿 500 則、閱讀中段收到 100 次編輯時，狀態列的 DOM 異動本次由 101 次降至 0，100 則內容仍完成更新且閱讀位置不動；計數依重繪排程而異。typecheck／build 通過；新訊息淘汰與歷史窗口仍更新說明，返回最新顯示 100 則，透過正式登出按鈕與確認對話框退出隔離帳號後顯示 0 則，已移出數與歷史窗口提示均清除。未操作真實 LINE。

> 聊天重繪的引用查找重用該聊天室既有訊息位置索引，不再每次由完整訊息陣列建立另一個 Map 與 `[id, message]` 暫存陣列；位置 0 明確視為有效，仍以訊息物件是否更換決定引用預覽重繪。Chromium 以 500 則、101 個引用重複查找 10,000 輪，7 次中位數約 73.4ms → 18.5ms，結果相同；不含 DOM、網路或既有索引初建成本。typecheck／build 通過；正式網頁驗證首筆引用、淘汰後停用、晚到排序後編輯預覽更新、點擊引用跳轉、收回佔位、歷史載入及切換聊天室。其他聊天室不能借用仍保留於前一聊天室的原訊息；返回最新窗口時，超出範圍的引用仍為停用佔位，已截圖確認。使用隔離資料，未操作真實 LINE。

> 已讀欄位僅在可見性改變時設定 `hidden`，文字計數更新維持原路徑。正式網頁保留 500 則、收到 100 次編輯時，本次既有已讀欄位的重複屬性異動由 400 次降為 0，100 則編輯仍正確顯示；次數依重繪排程而異。typecheck／build 通過；經正式 WS 注入隔離的「他人已讀」事件，驗證本帳號訊息由隱藏變為「已讀 1」、增加為「已讀 2」，較新訊息另顯示「已讀 1」，他人訊息不誤顯示且較舊回報不倒退，已截圖確認。另以網頁登出、隔離恢復及 500 則新快照驗證舊已讀狀態清空。`chat.sendReadReceipts` 保持關閉，未回報自己的已讀或連線真實 LINE。

> MP4／MOV 長度解析以 big-endian 四位元組值比對 `moov`／`mvhd`，不再為每個掃過的 box 建立 Latin-1 字串；尺寸、父層邊界、extended header 與版本／timescale 驗證不變。Node 26.7.0 的 7 輪局部量測：1,084-byte 樣本解析 100,000 次中位數約 14.58ms → 4.03ms；含 524,288 個空 `free` box 的 4 MiB 樣本單次約 16.17ms → 3.63ms，非實際上傳加速比例。typecheck、build、328 項測試通過，新增 extended／EOF-sized／越過父層範圍的回歸；另比對 2,114 個截短、型別位元組變化、異常尺寸及非零 offset 視圖，前後結果一致。正式 EvexLineProvider 搭配隔離 HTTP 傳輸 fixture 驗證 MP4／MOV 長度參數、E2EE fallback 入口與缺失長度不猜測；未執行真實 LINE 加密或發送。

> 媒體發送快照配置補強（2026-10）：一般 ArrayBuffer-backed Buffer 以包含正確 byteOffset／byteLength 的 view 交給 Blob 建立不可變快照，不再預先複製整份媒體；SharedArrayBuffer 等其他 backing store 仍先複製為一般記憶體，保留相容性。實際 adapter 的 50 MiB 樣本，建立快照時 ArrayBuffer 配置增加量由 100 MiB 降為 50 MiB；隔離 HTTP 實測確認普通及共享記憶體切片都不傳出範圍外位元組，且呼叫端在傳輸前改寫來源不影響快照，一般發送與 E2EE fallback 傳輸分支亦維持原有內容及長度參數。typecheck、build 與 331 項測試通過；此為隔離傳輸驗證，不代表真實 LINE／E2EE Gate 實測。

> 好友列表重繪補強（2026-10）：重用未變動的完整好友排序，搜尋只過濾既有結果；頻道資料更新、重新連線與登出時清除。快取失效且有搜尋條件時仍先過濾再排序，避免窄搜尋反而排序整份名單。Chromium 實際網頁的 5,000 位好友、18 次搜尋修改，暖機後比較次數由 88,643 降至 0；只符合一位好友時收到 100 則即時訊息，亦未觸發額外好友排序比較。typecheck、build 通過；瀏覽器驗證搜尋順序、同名好友活動順序、改名／新增／移除、群組排除、重連快照及登出後更換帳號，不使用真實 LINE。

> 搜尋視窗索引補強（2026-10）：更換查詢時直接初始化預估列高，不建立將被丟棄的舊列高索引，也不計算結果 key；同一查詢更新時逐筆建立索引，並只計算一次舊錨點 key。實際網頁保留 10,000 筆結果時，切換查詢的 key 序列化由 20,000 次降為 0；捲至尾端再編輯訊息的樣本由 39,984 次降為 29,993 次，尾端訊息與更新前後捲動位移保持一致。typecheck、build 與 2 項既有保留範圍／虛擬化測試通過；瀏覽器另驗證窄查詢回到頂端、零結果清空、文字標示與點擊結果跳回原訊息。以上皆為隔離 HTTP／WS fixture，未呼叫真實 LINE。

> 搜尋結果重繪去重（2026-10）：查詢文字、結果順序及每筆訊息／頻道參照都未變時，保留既有搜尋 DOM 與列高索引；仍重新查詢目前快取，不略過訊息更新。關閉搜尋、重連與登出一併清除結果參照。實際網頁的 1,111 筆符合結果在 5 批無關編輯下，移除的結果列由 98 個降為 0，已選文字亦保留。typecheck、build 通過；瀏覽器驗證查詢標示、符合訊息編輯、改為不符合、收回、新結果排序、聊天室改名、關閉重開、重連及登出換帳號。使用隔離 HTTP／WS fixture，未呼叫真實 LINE。

> 社群歷史原位更新補強（2026-10）：同 messageId 且 createdAt 未變時，直接替換原排序位置；時間改變仍重新插入，ID 索引、媒體來源、回應及收回狀態照常更新。實際 adapter 的 5,000 筆快取、每輪 20,000 次同位置更新，7 輪局部量測中位數約 9.39ms → 1.34ms，非 LINE 端到端速度宣稱。typecheck、build 與 331 項測試通過，回歸涵蓋原位更新後再套用回應仍保留新文字。另以正式 adapter 事件管線、隔離 HTTP 上游及 `/api/ws` 驗證最新／較舊分頁、同時間游標、改變排序位置及收回後不復活，歷史僅走訪一次；未呼叫真實 LINE。

> 搜尋非內容更新補強（2026-10）：搜尋列不顯示已讀與回應，因此這兩類封包只更新本機狀態，不排程搜尋重繪；一般聊天仍即時更新。實際網頁保留 10,000 則訊息、搜尋符合 1,111 則時，5 批已讀與 5 批回應各自造成的訊息搜尋快取查詢均由 50,000 次降為 0，回應更新移除的搜尋列由 70 個降為 0，選取文字保留。typecheck、build 與 331 項測試通過；瀏覽器驗證關閉搜尋及點擊結果後顯示最新已讀／回應，並確認一般聊天仍可更新及清除回應。使用隔離 HTTP／WS fixture，未呼叫真實 LINE。

> 寄件者資料查詢補強（2026-10）：訊息正規化一次取得寄件者 profile，名稱、大頭照及角色共用該結果，不再重複查 Map。實際 adapter 以 5,000 個完整 profile 正規化 10,000 則訊息，查詢由 50,000 次降為 10,000 次；每輪 200,000 則、7 輪局部量測中位數約 17.70ms → 15.56ms，非 LINE 端到端速度宣稱。typecheck、build 與 331 項測試通過；正式 adapter 事件管線及 `/api/ws` 歷史驗證完整、缺漏、只有名稱及更新後的 profile，既有預設名稱與省略欄位不變。使用隔離 HTTP 上游，未呼叫真實 LINE。

> 圖片辨識配置補強（2026-10）：PNG／GIF 固定簽章直接讀取原 Buffer，比對規則及長度界線不變。10,000 次混合辨識原先建立的 8,750 個簽章 Buffer、20,000 個切片及 11,250 次字串解碼皆降為 0；每輪 1,000,000 次、7 輪局部量測中位數約 130.64ms → 4.99ms，非下載端到端速度宣稱。105,915 組簽章變體、隨機內容及非零位移切片與舊實作結果一致；typecheck、build 與 332 項測試通過。正式 HTTP 上傳／adapter 下載驗證 PNG、JPEG、GIF87a／GIF89a 簽章及原位元組，拒絕 SVG、HTML、截短及空內容，cookie／Origin／上傳限流維持有效。使用隔離 HTTP 上游，未呼叫真實 LINE。

> 重複已讀重繪補強（2026-10）：網頁仍逐筆解析、保留單調前進的已讀位置，但只有新增讀者或位置前進才排程聊天重繪；相同及較舊位置不再掃描既有訊息。實際 500 則聊天中，5 次相同位置與 5 次較舊位置各自引起的訊息日期快取查詢均由 4,995 次降為 0，封包內的位置解析仍執行。typecheck、build 通過；瀏覽器驗證前進位置涵蓋後續新訊息、第二位讀者的已讀分界、同一快照混合前進與未變位置，以及較舊事件不造成倒退。使用隔離 HTTP／WS fixture，未回報真實 LINE 已讀。

> 標記授權查核補強（2026-10）：只為未被同連線、同聊天室管理員授權涵蓋的標記對象建立待查 Set（最多 20 人），掃描目前快取找到全部對象即停止，不再先複製全部發言者。正式 `/api/ws`、500 則快取實測：已授權管理員的掃描及 Set 加入均由 500 降為 0；首筆發言者及混合管理員／首筆發言者均由 500 降為 1；尾端發言者與拒絕案例仍掃描 500 則，但 Set 加入只需 1 次。typecheck、build 與 333 項測試通過，涵蓋混合標記須全部有權限、同人重複標記、發言者淘汰後失去權限、跨連線隔離及重新查詢撤權。未新增持久授權快取；使用隔離 provider，未對真實 LINE 發送訊息。

> 標記選單候選處理補強（2026-10）：直接反向讀取已排序訊息，不再複製後反轉；名稱篩選湊滿 8 個符合者即停止，空查詢不轉換名稱大小寫，較舊成員仍可完整搜尋。實際瀏覽器以 500 位發言者連續輸入 `@`、`@候`、`@候選`、`@候選0`，候選名稱及查詢字串的大小寫轉換合計由 2,002 次降為 26 次，反轉陣列處理的訊息合計由 2,000 筆降為 0。typecheck、build 與 333 項測試通過；瀏覽器驗證最新優先、最多 8 人、縮小搜尋保留鍵盤選取、最舊成員、無符合者及 Enter 選取後經正式 WS 發送正確 ID／UTF-16 範圍。使用隔離 provider，未對真實 LINE 發送訊息。

> 標記選單鍵盤切換補強（2026-10）：上下方向鍵只更新新舊選項的 `aria-selected` 與輸入框的 `aria-activedescendant`，保留既有節點、大頭照及滑鼠事件；只有一個候選者時不重繪。實際瀏覽器 8 人選單、12 次方向鍵操作的新增及移除選項各由 96 個降為 0。typecheck、build 與 333 項測試通過；瀏覽器驗證首尾循環、焦點與 ARIA 選取狀態、單一候選者、Enter／Tab 選取、模擬 IME 組字事件不切換、Escape 關閉，以及鍵盤移動後滑鼠選取經正式 WS 發送正確標記。使用隔離 provider，未對真實 LINE 發送訊息。

> 頻道搜尋名稱處理補強（2026-10）：以頻道物件為 WeakMap key 重用小寫搜尋名稱；完整及增量頻道影格替換物件時自然重新轉換，登出及重新連線時清空。實際瀏覽器以 5,000 個頻道連續搜尋三個關鍵字，名稱大小寫轉換合計由 15,000 次降為 5,000 次，後兩次搜尋不重複轉換。typecheck、build 與 333 項測試通過；瀏覽器驗證聊天／好友搜尋結果、完整快照及增量改名立即生效、舊名稱不再命中，以及登出後換帳號只搜尋新帳號資料。使用隔離 HTTP／WS provider，未呼叫真實 LINE。

> 收到媒體的固定簽章補強（2026-10）：WEBP、`ftyp`、M4A／M4B 品牌及 ID3 直接讀取原 Buffer，不再為固定簽章建立 Latin-1 字串；既有 MIME 分類、優先順序及上傳品牌限制不變。10,000 次混合辨識的字串解碼由 23,000 次降為 0；每輪 1,000,000 次、7 輪局部量測中位數約 86.76ms → 13.18ms，非下載端到端速度宣稱。114,142 組簽章變體、截短、隨機內容及非零位移切片與舊實作結果一致；typecheck、build 與 334 項測試通過。正式 adapter 即時事件及 HTTP 驗證各類最小簽章的 MIME／原位元組、HEAD／Range／快取命中、拒絕 SVG／HTML／截短／空內容，以及未見訊息不下載、cookie 與跨站限制；不代表完整媒體解碼或播放驗證。使用隔離 HTTP 上游，未呼叫真實 LINE。

> 好友排序失效範圍補強（2026-10）：完整頻道快照或涉及個人頻道的增量更新才捨棄好友排序；群組活動仍更新聊天排序、預覽及未讀數，但不重排未變的好友清單。實際瀏覽器保留 5,000 位好友排序後，5 次群組訊息引起的好友 Collator 比較由 24,995 次降為 0。typecheck、build 與 334 項測試通過；瀏覽器驗證群組未讀及最新預覽照常更新、好友增量改名移至正確位置、新好友加入及完整快照移除好友後清單正確。使用隔離 HTTP／WS provider，未呼叫真實 LINE。

> 聊天排序觸發條件補強（2026-10）：增量頻道只有新增、名稱或活動時間改變時才標記重排；未讀數、成員數等資料仍立即更新，且不清除同批較早事件留下的重排需求。實際瀏覽器以 5,000 個頻道驗證，5 次已讀更新的排序比較由 24,995 次降為 0，單次成員數更新由 4,999 次降為 0。typecheck、build 與 334 項測試通過；瀏覽器確認未讀歸零、成員數顯示更新、改名／新活動／新增頻道的排序及總數正確。使用隔離 HTTP／WS provider，未呼叫真實 LINE。

> 訊息快取插入補強（2026-10）：即時訊息追加改用 `push`，超過每聊天室上限時以 `shift` 淘汰唯一多出的最舊訊息，同步刪除 ID 索引；晚到訊息仍使用二分定位及穩定插入。已滿 500 則快取連續追加 10,000 則時，`splice` 回傳的臨時陣列由 20,000 個降為 0；每輪 100,000 則、7 輪局部量測中位數約 12.24ms → 8.04ms，非 LINE 端到端速度宣稱。typecheck、build 與 335 項測試通過，新增滿載下同時間晚到訊息的淘汰／索引邊界測試；實際 `/api/ws` 驗證 501 則即時訊息順序與 UTF-8、無舊訊息重播、重複事件抑制、歷史保留編輯、晚到插入、持續淘汰及收回內容不可復活。使用隔離 provider，未呼叫真實 LINE。

> PWA 雜湊資源快取補強（2026-10）：`/assets/` 命中 Cache Storage 時直接回傳，不再重複背景下載及寫入；首次載入仍取得網路內容，manifest／icons／favicon 照舊背景更新，頁面導覽照舊 network-first 以取得 cookie。回歸測試先重現同資源第二次載入仍發出請求，修正後 typecheck、build 與 336 項測試通過；worker 隔離執行中三次重複載入的 fetch／快取寫入均由 3 次降為 0。實際瀏覽器啟用 service worker，以 `cache: "no-store"` 排除 HTTP 快取後，兩項雜湊資源各載入三次的伺服器請求由 6 次降為 0；確認網頁仍呈現、manifest 仍更新、頁面導覽仍到伺服器，私人媒體、`/ws`、非 GET 及失敗資源未被快取。使用隔離 HTTP／WS provider，未呼叫真實 LINE；完成後移除測試 origin 的 worker 與快取。

> 貼圖包切換補強（2026-10）：切換只更新分頁的選取狀態及目前貼圖格，不再重建全部貼圖包按鈕；重選同一包不重畫，套件清單更新或帳號清理仍完整重建／清空。實際瀏覽器以 100 包、每包 40 張貼圖切換 5 次，分頁節點新增及移除各由 500 個降為 0；重選目前包兩次的貼圖格新增及移除各由 80 個降為 0，並保留原分頁節點及焦點。typecheck、build 與 336 項測試通過；瀏覽器確認唯一 ARIA 選取、切換後 WS 發送正確 packageId／stickerId、切換不重抓清單，登出清空舊節點、換帳號載入新清單後仍發送正確貼圖。使用隔離 HTTP／WS provider 及產生的 PNG，未呼叫真實 LINE。

> 未讀總數補強（2026-10）：只遍歷未讀記錄並查頻道索引，保留「頻道仍存在且屬於聊天」的判斷，不再為加總建立完整聊天陣列。實際瀏覽器以 5,000 個頻道、7 個未讀記錄連續搜尋三次，未讀統計省去額外 15,000 筆全頻道篩選，改為 21 次索引查詢；聊天清單本身的篩選仍保留。typecheck、build 與 336 項測試通過；瀏覽器驗證尚無對話的好友不列入、成為對話後列入、已移除頻道不列入、`99+`、開啟聊天及手機已讀歸零、他人新訊息增加但自己訊息不增加，以及登出／換帳號不沿用舊計數。使用隔離 HTTP／WS provider，未呼叫真實 LINE。

> 通知預覽補強（2026-10）：先確認頁面背景狀態、通知權限與偏好，符合時才呼叫共用的預覽格式化函式；前景訊息也不再讀取通知偏好，沒有新增每訊息 closure。實際瀏覽器經隔離 HTTP／WS 收到 100 則前景訊息、暫停清單繪製以分離成本，未顯示通知的預覽格式化及 localStorage 讀取均由 100 次降為 0；恢復繪製後未讀徽章正確。typecheck、build 與 336 項測試通過；確認停用時不通知、背景通知的私人／群組標題與換行／截斷內容正確、點擊開啟聊天室、登出關閉全部通知但保留偏好。瀏覽器 Notification 使用受控替身，未要求作業系統通知權限或呼叫真實 LINE；不代表原生通知或 Gate 實測。

> 網址尾端解析補強（2026-10）：括號計數只掃描一次，再由尾端移除多餘括號及標點，取代反覆 split／切字串的平方成本；一般網址保留直接回傳的快路徑。含 7,900 個尾端右括號的隔離案例，split 次數由 15,800 降為 0；Node 微量測七輪中位數約 229.59ms → 0.037ms，不代表 LINE 傳輸速度。4,009 組固定案例與原版輸出逐一相同，新增三種括號及長混合尾端的邊界測試，typecheck、build 與 338 項測試通過。實際瀏覽器經隔離 HTTP／WS 收到相同訊息，收到影格到 DOM 呈現約 144ms → 14ms（含排程等待）；確認完整文字、平衡括號連結、`noopener noreferrer` 及非 http(s)／HTML 字串維持純文字。未呼叫真實 LINE。

> 一般文字繪製補強（2026-10）：沒有 mention、LINE 表情貼及搜尋命中時，直接使用既有安全連結產生器，不建立空的裝飾區間再排序；有標記或搜尋時仍走原流程。實際瀏覽器繪製 500 則一般訊息，空陣列 map 呼叫由 1,000 次降為 0、空排序由 500 次降為 0；完整換行文字、連結及安全屬性不變。typecheck、build 與 338 項測試通過；瀏覽器另驗證自身 mention、表情貼 PNG 解碼及載入失敗的文字替代、搜尋命中標記與離開搜尋，以及非 http(s)／HTML 字串仍維持純文字。使用隔離 HTTP／WS provider 及產生的 PNG，未呼叫真實 LINE。

> 搜尋跳轉補強（2026-10）：關閉搜尋並切換聊天室後，以既有 `rendered` 索引定位訊息節點，不再查出全部訊息 DOM、複製陣列再搜尋；仍保留重畫後重試、平滑捲動與閃示。實際瀏覽器連續驗證同聊天室的已編輯訊息、另一聊天室的系統事件，以及返回原聊天室的訊息，三次跳轉省去 3 次 DOM 查詢及 1,001 個節點的收集，目標內容與聊天室皆正確且進入可見範圍。typecheck、build 與 338 項測試通過；使用隔離 HTTP／WS provider，未呼叫真實 LINE。

> OpenChat 歷史索引補強（2026-10）：重建完成後直接沿用已合併歷史與即時訊息的 Map 作為 ID 索引，不再為每則訊息建立 `[id, message]` 配對陣列並複製成另一份 Map；排序、更新套用及 5,000 則上限不變。隔離 HTTP 上游與實際 `/api/ws` 完成首次載入及逾期重建，共 100 頁；兩次索引重建的配對陣列由 5,000／5,001 個均降為 0。typecheck、build 與 338 項測試通過；API 驗證即時內容覆蓋、reaction、收回不復活、重複事件採最後內容、歷史游標與最舊訊息淘汰。未呼叫真實 LINE。

> 成員候選準備補強（2026-10）：沿用 Set 去重，依原順序檢查有效 ID、已完成快取及失敗退避，選滿 100 個候選就停止篩選；去重仍讀取全部輸入，既有進行中查詢共用與全域併發限制不變。隔離 HTTP 上游與實際 `/api/ws` 完成兩次各 5,000 人的歷史載入，候選階段的 profile 查詢由 5,000／5,000 次降為 100／200 次（第二次已有 100 人快取）；上游成員請求仍共 200 次、峰值併發仍為 5。typecheck、build 與 338 項測試通過；邊界測試涵蓋空 ID、重複、已完成快取及退避不占候選額度，API 確認已快取與下一批成員名稱、100 人上限及歷史游標不變。未呼叫真實 LINE，不代表網路延遲降低。

> 發送確認補強（2026-10）：`sent` 影格以既有訊息索引定位 echo，不再遍歷目前聊天室的完整訊息陣列；不存在的訊息仍不設定社群身分，草稿確認與捲動流程不變。實際瀏覽器在保留 500 則訊息的社群連續送出三次，確認階段由 3 次線性搜尋、1,500 筆比較降為 0；保留上限、訊息內容及草稿清空正確，自身社群成員仍不列入 mention 候選。typecheck、build 與 338 項測試通過；使用隔離 HTTP／WS provider，未呼叫真實 LINE。

> Mention 候選來源補強（2026-10）：候選來源改為同步 Iterable，按最新發言順序逐人去重並產生；composer 取得八個匹配者後即可停止來源遍歷，不再先建立完整候選 Map 與陣列，也不新增跨輸入快取。實際瀏覽器以 500 位發言者輸入一般查詢，候選去重檢查由 500 次降為 8 次；加入改名、重複發言、自身與空 ID 後，由 498 次降為 9 次。稀少匹配仍掃描足夠範圍、無匹配仍完整掃描，未縮減可搜尋的人選。typecheck、build 與 338 項測試通過；瀏覽器確認最新名稱與順序、去重、排除自身／空 ID、舊名稱不再提供，並經 WS 實際送出正確 userId 與 mention 範圍。使用隔離 provider，未呼叫真實 LINE。

> 捲動提示補強（2026-10）：「最新訊息／新訊息數」文字只有改變時才更新，不再因每次 scroll 事件重建相同的文字節點；可見性及計數規則不變，也不新增快取狀態。實際瀏覽器連續 20 次捲動，相同提示的文字 DOM 替換由 20 次降為 0；收到新訊息仍顯示正確數量，點擊後回到最新訊息並清除數量，搜尋時仍隱藏提示。typecheck、build 與 338 項測試通過；使用隔離 HTTP／WS provider，未呼叫真實 LINE。

> 歷史提示節點補強（2026-10）：已有訊息時，歷史提示僅在狀態文字改變或重試按鈕尚未掛載時更新，避免無關的訊息／已讀重畫重建相同內容。實際瀏覽器分別在失敗、載入中及完成狀態接收三次已讀更新，提示的 DOM 替換各由 3 次降為 0；失敗狀態的重試按鈕鍵盤焦點由遺失改為保留。另確認手動重試、載入中、完成，以及「仍有更早訊息」的提示與捲動載入轉移。typecheck、build 與 338 項測試通過；使用隔離 HTTP／WS provider 注入一次歷史失敗，未呼叫真實 LINE，也未回報真實帳號已讀。

> 空聊天室提示補強（2026-10）：空狀態沿用單一段落節點及既有 DOM reconcile，不再每次重畫建立段落、清空整個訊息區或重新掛載重試按鈕；提示內容只在改變時更新。實際瀏覽器於空聊天室的失敗、載入中及完成狀態各接收三次已讀更新，段落建立各由 3 次降為 0、DOM 變動由 6／3／3 次降為 0，重試按鈕焦點維持。typecheck、build 與 338 項測試通過；確認失敗→重試→載入→空結果，以及第一則即時訊息到達後移除空提示並正常顯示。使用隔離 HTTP／WS provider，未呼叫真實 LINE 或回報真實帳號已讀。

> 瀏覽器 Cookie 比對補強（2026-10）：保留啟動時產生的 32-byte 隨機 Token，Cookie 仍傳送 64 位小寫 hex；先通過原本的嚴格格式檢查，再解碼為 32-byte 與原始 Token 做 `timingSafeEqual`，不再每次重新編碼固定 Token。隔離程序完成 100 次帶 Cookie 的媒體 GET，Token 編碼 Buffer 由 200 個／12,800 bytes 降為 100 個／3,200 bytes；實際 WS upgrade 由兩個／128 bytes 降為一個／32 bytes。typecheck、build 與 338 項測試通過；補強奇數長度、合法 Token 尾接額外 hex／非 hex、大小寫及非法字元的拒絕測試，原 Origin、Cookie、跨站與 API Token 規則不變。未輸出 Token 或呼叫真實 LINE。

> 聊天室標頭補強（2026-10）：訊息重畫時只在標題或聊天室資訊文字改變後更新節點，直接比對目前 DOM 內容而不額外保存快取，確保暫時顯示的錯誤仍能被下一次正常重畫清除。實際瀏覽器接收三次已讀更新，標題及聊天室資訊的文字替換各由 3 次降為 0；切換聊天室的名稱與人數仍更新，注入 generic WS 錯誤後也能恢復原資訊。typecheck、build 與 338 項測試通過；使用隔離 HTTP／WS provider，未呼叫真實 LINE 或回報真實帳號已讀。

> 搜尋位置索引補強（2026-10）：虛擬搜尋清單重新量測列高或改變寬度時，原地重算前綴位置並重用陣列，不再重建陣列或每列讀取 `.at(-1)`；累加順序、二分定位與捲動錨點不變。實際瀏覽器載入 10,000 則隔離訊息，搜尋後捲動八次並縮窄、還原清單寬度，期間完整位置陣列重建由 15 次降為 0（原本 150,000 次 `push`）；逐次可見訊息、縮放錨點、End／ArrowUp／Home 導覽及縮小為 11 筆結果皆與修改前一致。typecheck、build 與 338 項測試通過；前綴加總仍是線性運算，未宣稱 LINE 網路延遲改善或 Gate 通過。

> 訊息裝飾正規化補強（2026-10）：adapter 僅在文字訊息具備非空 `MENTION`／`REPLACE` metadata 時呼叫對應解析器，其餘以 `undefined` 表示沒有裝飾，不再配置隨即丟棄的空陣列。隔離 HTTP 上游經真實 adapter 走完兩輪各 5,000 則社群歷史，V8 precise coverage 量得 mention／emoji 解析呼叫各由 9,996 次降為 4 次；實際 `/api/ws` 回傳的缺少／空 metadata、合法混合裝飾、損壞 JSON、無法解密佔位及帶裝飾 metadata 的圖片 DTO 與修改前完全一致。typecheck、build 與 338 項測試通過；既有解析驗證與 fail-closed 規則未更動，未呼叫真實 LINE 或宣稱外部延遲改善。

> 訊息節點索引補強（2026-10）：聊天重畫原地維護訊息節點 Map，只更新變動項目，項目數超過目前清單時才清除已淘汰的索引；切換聊天與搜尋照常清空。捲動及保留窗口的錨點統一依實際 DOM 順序尋找，不再依賴 Map 插入順序，避免歷史前插或時間重排後抓到畫面下方的訊息。實際瀏覽器在 500 則訊息接收三次已讀更新，索引寫入由 1,500 次降為 0；既有節點、引用編輯、時間重排後訊息增高的視窗錨點、淘汰、切換與搜尋跳轉皆與修改前一致。另驗證前插 50 則歷史後仍只保留 500 個索引，移除最新端且視窗錨點差異小於 1px。typecheck、build 與 338 項測試通過；使用隔離 HTTP／WS，不呼叫真實 LINE 或回報帳號已讀。

> 已讀數值補強（2026-10）：以訊息物件為弱參照快取已驗證的 BigInt ID，非法 ID 記為 `null`，訊息替換自然重新解析，連線與登入狀態重設時清空；仍只替本帳號的非社群訊息計算已讀，不改用 Number。實際瀏覽器在 500 則訊息暖機後接收三次已讀更新，BigInt 建構由 1,497 次降為 3 次（僅新已讀位置），ID 格式檢查由 1,500 次降為 0；編輯一則訊息後只重新驗證、解析該一則。超過安全整數的相鄰 ID、前置零、非法字元與 21 位數 ID 的已讀顯示皆與修改前一致。typecheck、build 與 338 項測試通過；隔離 HTTP／WS 驗證，未對真實帳號回報已讀。

> 文字裝飾合併補強（2026-10）：依 Message DTO 已排序的 mention／emoji 契約，以雙游標線性合併範圍，免除包裝物件、兩個暫時映射陣列及重新排序；相同起點仍優先 mention，較早 emoji 與後續 mention 重疊時照舊保留較早範圍。實際瀏覽器顯示 500 則混合裝飾訊息，包裝物件由 2,834 個降為 0、排序由 500 次降為 0；一般混合、同起點、跨種類重疊的 HTML 與修改前完全相同，搜尋標記、連結及圖片解碼仍正確。typecheck、build 與 338 項測試通過；圖片由隔離 HTTP provider 提供，不連真實 LINE 或外部 CDN。

> 搜尋媒體捲動修正（2026-10）：聊天與搜尋共用訊息容器，emoji 載入完成原先仍會執行聊天的置底邏輯，導致搜尋跳到最後並額外建立結果列；`keepPinned` 現在只在非搜尋模式置底。實際瀏覽器載入 500 筆含 emoji 的搜尋結果，原生圖片載入造成的置底寫入由 64 次降為 0，第一筆維持最新的第 500 則，不再跳到尾端的第 14 則；不需手動拉回。關閉搜尋後一般聊天仍維持底部（誤差小於 1px）。typecheck、build 與 338 項測試通過，圖片由隔離 HTTP provider 供應。

> 媒體置底合併（2026-10）：圖片、貼圖、emoji 與影片尺寸通知共用每畫面一次的置底排程，執行前重新檢查登入、搜尋及閱讀位置；發送訊息仍立即置底，下一畫面的補正也共用排程。實際瀏覽器重新顯示 500 則混合 emoji 訊息，置底寫入由 1,168 次降為 2 次，最終底部誤差小於 1px。隔離 HTTP 延後供應 400×400 PNG，顯示高度從 60px 增至 320px 後仍貼底；閱讀較早內容、搜尋及切換聊天室時位置不被舊圖片拉走，登出後訊息維持清空；同一次原生圖片 load 事件中開啟搜尋，先前排入的置底回呼也不再寫入。typecheck、build 與 338 項測試通過，未使用真實 LINE 帳號。

> 裝飾解析配置減量（2026-10）：收到的 mention／emoji 直接走訪原始清單的前 100／200 筆，排序後原地壓縮不重疊範圍，不再建立切片及第二個結果陣列；無效項目仍占原始筆數上限，同起點仍保留先出現者。實際 adapter 經隔離 HTTP 兩趟正規化各 5,000 則訊息並透過 `/api/ws` 取得歷史，裝飾切片由 19,980 次降為 0、範圍 push 由 39,960 次降為 19,980 次；缺少／空值／錯誤 metadata、有效裝飾、解密失敗與圖片的邊界 DTO 均與修改前一致。新增 UTF-16、無效項目計數、上限端點及同起點優先順序回歸，typecheck、build 與 339 項測試通過；未連真實 LINE。

> 已讀回報取用優化（2026-10）：從訊息清單尾端直接尋找可回報的數字 ID，不再複製整份清單後反轉；相同或較舊位置在讀取視窗與訊息矩形前即略過。實際瀏覽器對 500 則訊息重複檢查三次，反轉由 3 次降為 0、複製項目由 1,500 筆降為 0、矩形讀取由 6 次降為 0。隔離 provider 啟用已讀回報，確認原始 WS 影格及 provider 收到的位置與修改前完全一致；尾端無效／超過 24 位數 ID 會略過，24 位數 ID 保持精確，閱讀舊內容、搜尋及切換到其他聊天室時不回報，回到最新可見訊息才各回報一次。typecheck、build 與 339 項測試通過；未對真實聯絡人回報已讀。

> 頻道預覽空快取快路徑（2026-10）：尚未保留訊息的聊天室直接使用頻道摘要，不再呼叫排序清單查詢來建立空陣列。實際瀏覽器載入 5,000 個頻道並輸入三次涵蓋全部頻道的篩選，空陣列尾端查詢與不同空陣列參照均由 15,000 次降為 0。初始摘要、空歷史、較新的即時訊息、延遲舊訊息、較新的伺服器摘要及其後的快取更新，預覽優先順序均與修改前一致；摘要訊息仍不會進入聊天訊息清單。typecheck、build 與隔離 HTTP／WS 的實際瀏覽器驗證通過，未連真實 LINE。

> 頻道鍵盤導覽減量（2026-10）：方向鍵直接使用目前列的相鄰元素，Home／End 使用清單首尾元素，不再查詢、複製並搜尋整份頻道列。實際瀏覽器以 5,000 個頻道操作方向鍵、Home／End 與 Tab，整表查詢由 8 次降為 0、收集列數由 40,000 筆降為 0；篩選至 111 個頻道後，三次導覽的查詢／收集亦由 3 次／333 筆降為 0。清單邊界、上移回篩選框、下移進入清單、Enter／空白鍵開啟聊天室及 Tab 的預設焦點移動均維持一致。typecheck、build 與隔離服務上的原生瀏覽器鍵盤操作驗證通過。

> 單一裝飾範圍快路徑（2026-10）：mention／emoji 驗證後不足兩個有效範圍時直接回傳，不建立排序比較器，也不執行不必要的排序及重疊壓縮。實際 adapter 經隔離 HTTP 正規化 10,000 則訊息，單一範圍排序由 19,980 次降為 0；另以空清單及全數無效項目各走完相同流程，三種情境的 `/api/ws` 邊界 DTO 均與修改前一致。多範圍的排序、重疊與原始筆數上限不變；typecheck、build 與 339 項測試通過，未連真實 LINE。

> DOM 前綴更新快路徑（2026-10）：共用 reconcile 已確認前綴相同後，純尾端追加直接附加剩餘節點、純尾端移除直接沿 sibling 移除，不再建立完整成員 Set 與 childNodes 快照；中間插入、替換或重排仍沿用原有路徑。實際瀏覽器把 5,000 個頻道縮至首列再還原，兩次 Set／快照各處理 5,001 個節點的工作降為 0；從 100 則訊息逐次追加三則，三次 Set 的 312 筆與快照的 309 筆亦降為 0。原有節點參照、清空後還原及中間插入的訊息順序均已驗證；typecheck、build 與隔離 HTTP／WS 上的實際瀏覽器驗證通過。

> 成員候選去重補強（2026-10）：resolveMembers 改為逐筆去重，選滿 100 個有效且可查詢的候選後即停止，不再預先把完整輸入加入 Set；候選來源的既有陣列建構不變。兩次各 5,000 人的實際 adapter 歷史載入中，Set 插入由 5,000／5,000 次降為 100／200 次（第二次略過已快取的前 100 人）；隔離 HTTP 上游仍只收到 200 次成員查詢、峰值併發仍為 5，實際 `/api/ws` 的已快取名稱、後續可查詢成員與超額成員結果保持一致。重複、無效、已快取及退避中的 ID 仍不占候選額度；typecheck、build 與 339 項測試通過，未連真實 LINE。

> 成員候選來源串流化（2026-10）：talk／OpenChat 的歷史與頻道預覽共用惰性候選來源，達既有查詢上限後不再投影剩餘訊息，也不預先建立完整來源及 mid 陣列；talk 仍依發言者、事件 actor、targets 的順序選人。兩次各 5,000 則社群歷史的候選 map 投影由 10,000 筆降為 0，原始 sender 讀取由 20,000 次降為 10,300 次；兩次各 1,000 則群組事件預覽的 flatMap 投影由 2,000 筆降為 0，sender／事件參數讀取由各 4,000 次降為 2,298／2,296 次。實際 adapter、隔離 HTTP 上游與 `/api/ws` 已驗證查詢順序、額度、快取名稱、事件預覽及歷史結果不變；typecheck、build 與 339 項測試通過，未連真實 LINE。

> 搜尋查詢正規化共用（2026-10）：搜尋輸入在既有 debounce 完成時統一 trim／轉小寫，匹配、結果快取及標示共用同一查詢，輸入框仍保留原始文字。實際瀏覽器搜尋 500 則訊息，首次查詢的轉小寫／trim 由 15／16 次降為各 1 次；四次虛擬捲動由各 80 次降為 0。只改大小寫及首尾空白時，不再移除 20 列、重建 14 列並跳回頂端，而是保留節點與捲動位置；不同查詢、即時新訊息、無匹配、空白輸入及關閉重開均已驗證。typecheck、build 與隔離 HTTP／WS 上的實際瀏覽器驗證通過。

> 保留範圍摘要快路徑（2026-10）：摘要只在保留數、移出數或歷史窗口狀態改變時重新格式化，不再因已讀等重繪重建相同文字。實際瀏覽器連續五次已讀更新的數字格式化由 10 次降為 0；載入較早訊息、歷史窗口略過即時新訊息、返回最新及登出的五個摘要狀態均與修改前逐字一致。typecheck、build 與隔離 HTTP／WS 上的實際瀏覽器驗證通過，沒有對真實聊天室回報已讀。

> 提及選單關閉快路徑（2026-10）：選單已關閉時不再清空空清單或重設相同的 ARIA／hidden 狀態。實際瀏覽器以 20 次原生 Backspace 編輯一般文字，清單清空與 active-descendant 移除呼叫各由 20 次降為 0，屬性寫入由 40 次降為 0；初始狀態、Escape、無匹配、失焦、換聊天室及登出仍正確關閉。另驗證方向鍵循環、焦點、單一候選、Enter／Tab、模擬 IME 組字事件及滑鼠選取後的實際 WS mention 發送內容；typecheck、build 與隔離 HTTP／WS 上的實際瀏覽器驗證通過。

> 提及候選列重用（2026-10）：重新篩選後，候選 ID、名稱、大頭照與選取位置都相同時保留既有列；仍先更新插入位置，避免游標或前綴改變後使用舊範圍。實際瀏覽器連續四次輸入相同的八人候選前綴，新增／移除列各由 32 個降為 0；移動到含 emoji 的文字前綴後各由 8 個降為 0，實際 WS 發送的 UTF-16 mention 範圍仍為 6–13。改名、大頭照位元組載入、候選排序變動、選取保留、縮至單一候選及完整鍵盤／滑鼠流程均已驗證；typecheck、build 與隔離 HTTP／WS 上的實際瀏覽器驗證通過。

> 提及測試假件修正（2026-10）：假 DOM 的初始隱藏狀態對齊實際 HTML，不再依賴關閉函式重複寫入；保留字中 `@`、IME、選取及發送的原有驗證。測試也完成已捕獲發送的 ack，避免 30 秒逾時計時器留在假件結束後；單獨執行 composer 測試的實測時間由約 30.12 秒降為 0.099 秒，三項測試通過。正式網頁行為未改變。

> Talk 回應清單解析（2026-10）：直接依索引處理上限內的原始筆數，不再先複製整份清單；空清單直接返回。隔離 HTTP 資料源經實際 adapter 正規化 2,100 則訊息並由 `/api/ws` 取得歷史，暫存清單由 2,058 份、127,785 個項目降為 0；六種回應的固定順序、自己的回應、空值及 malformed 資料的 API 結果均與修改前一致。新增原始筆數上限的邊界測試，確認無效項目仍占額度且超出上限的本人回應不會改變結果；typecheck、build 與全套 340 項測試通過。隔離資料驗證不代表真實 LINE Gate 驗收。

> 已讀範圍比較共用（2026-10）：解析同一成員的多個範圍時保留目前最大值的 BigInt，只有出現不同 ID 才進行數值比較；單筆或重複相同 ID 不需轉換。隔離 HTTP→adapter→一般 `/ws` 驗證 500 位成員的遞增、遞減、重複與單筆範圍，共 21 次查詢，BigInt 轉換由 144,000 次降為 55,000 次，單筆路徑仍為 0；全部已讀位置、超過安全整數的精度與原始 ID 的數值等價處理均保持不變。補上前導零、數值相同時保留第一種表示法及 malformed 項目的回歸測試；typecheck、build 與全套 341 項測試通過。未對真實聊天室回報已讀。

> 已讀快照組裝（2026-10）：直接走訪讀取位置 Map 產生回應，不再先展開中間清單；LINE 查詢完成後，已離線或非目前登入期間的要求不再組裝快照，共享查詢結果仍照常保留。隔離 HTTP／一般 `/ws` 的 500 人情境包含兩次開啟、等待期間斷線及重連，中間清單的 2,000 個項目降為 0，已斷線要求的 500 次 ID 格式化降為 0；三份實際收到的快照內容一致，四次歷史要求仍只查詢兩次已讀範圍。typecheck、build 與全套 341 項測試通過，沒有對真實聊天室回報已讀。

> 即時已讀增量去重（2026-10）：只廣播同聊天室、同一成員前進的數值位置；重複、前導零等價及較舊的位置不再重寫快取或傳送無效增量，完整快照維持既有語意。隔離 HTTP 供應 1,000 個刻意混合上述情況的 operation，經實際 adapter 事件解析與一般 `/ws`，傳送由 1,000 個影格、155,990 個 JSON 位元組降為 10 個影格、1,550 個位元組；十次前進位置與 500 人的最終快照完全一致。新增回歸測試確認 0、超過安全整數的相鄰 ID 及不同成員獨立計算，修改前失敗、修改後通過；typecheck、build 與全套 342 項測試通過。

> 群組邀請名單解析（2026-10）：每次解析保留單一、完整驗證過的拆分陣列，不再先複製被邀請者清單後重新組合；顯示仍只取前十位並保留總人數。隔離 HTTP→adapter→`/api/ws` 正規化 2,100 則事件，成員陣列 iterator 的元素走訪由 411,642 次降為 102,900 次，事件文字逐字一致；顯示範圍以外的無效成員仍使整則事件保持佔位，不產生部分結果。新增無效尾端的邊界測試並補上無效邀請者覆蓋；typecheck、build 與全套 343 項測試通過。

> 好友載入生命週期（2026-10）：取得好友 ID 與每波好友資料後，先確認仍為同一登入期間；失效結果不再更新個人資料快取，也不再啟動後續批次。隔離 HTTP→adapter→`/api/ws` 已重現並修正換帳號後的新稱呼被舊好友回覆覆寫；750 位好友的延遲查詢由繼續完成八個批次，改為只讓已送出的三個批次結束，新帳號的稱呼保持正確且無須重新查詢。新增 ID 清單與好友資料兩個等待階段的回歸測試，修改前失敗、修改後通過；typecheck、build 與全套 346 項測試通過。未使用真實 LINE 帳號。

> 好友批次按需建立（2026-10）：只切出即將送出的這一波好友 ID，不再預先建立整份批次清單；每批最多 100 人、同時最多三批與 LINE 原始順序不變。隔離 HTTP／`/api/ws` 的 750 人情境，第一波等待期間複製的 ID 由 750 個降為 300 個，中斷載入不再複製其餘 450 個；完整載入仍以八次查詢回傳全部 750 人，沒有減少或重排結果。typecheck、build 與全套 346 項測試通過，換帳號後的稱呼隔離驗證亦通過；這是配置量改善，不代表真實 LINE 延遲量測。

> 貼圖查詢生命週期（2026-10）：擁有的貼圖清單及每波 CDN metadata 回來後，先檢查登入期間；失效查詢不再解析後續貼圖包或啟動下一波，亦不更新新帳號快取。隔離 HTTP／一般 `/ws` 的 16 包情境，等待擁有清單時換帳號，舊 CDN 查詢由 16 次降為 0；等待首波 metadata 時換帳號，則由 16 次降為已送出的 4 次。正常載入仍完整回傳 16 包及既有 metadata 失敗退回 ID 區間的結果，新帳號連續兩次 WS 要求仍共用正確快取。兩個等待階段的回歸測試修改前失敗、修改後通過；typecheck、build 與全套 349 項測試通過，未連線真實 LINE／CDN。

> 文字加密重試生命週期（2026-10）：明文被要求改用 E2EE，以及加密完成後，均先確認仍為同一登入期間，再進行下一步。已安裝的 linejs 3.5.0 雖會阻擋停用 client 的網路請求，卻在此之前配置並持久化發送序號；隔離實際 SDK、加密運算、本機 HTTP 與 `/api/ws` 已重現舊重試將新帳號序號由 801 覆寫成 42。修正後兩個等待階段都保持 801；尚未開始的舊加密不再執行，已在進行的加密完成後不再嘗試發送。新帳號的明文與 E2EE API 發送仍成功，序號正常推進至 803。新增兩個修改前失敗、修改後通過的回歸情境；typecheck、build 與全套 352 項測試通過。使用記憶體儲存與臨時產生的測試金鑰，未操作真實 LINE 帳號或 session。

### Server → Client

| type | 負載 |
|---|---|
| `hello` | `{ protocol: 2, serverVersion, capabilities? }`（僅 `/api/ws` 宣告 `capabilities: ["chat:admins", "chat:admin-token", "chat:member-joined", "chat:note-posted", "media:upload"]`） |
| `update:available` | `{ version, current, url }`（url 僅限本專案 GitHub Release 頁） |
| `auth:state` | `{ state: "restoring"｜"idle"｜"authenticating"｜"ready"｜"error" }`（連線即送、變動廣播；不含祕密） |
| `auth:qr` | `{ url }`（一次性；只送給發起 `auth:start` 的連線） |
| `auth:pin` | `{ code }`（一次性；僅畫面顯示） |
| `auth:ready` | `{ profile }` |
| `profile` | `{ requestId, profile }`（回應 `profile:get`；只送給要求的連線） |
| `chat:admins` | `{ requestId, chatId, ownMemberId, admins: ChatAdmin[] }`（只回要求的機器人連線） |
| `chat:admin-token` | `{ requestId?, chatId, token, createdAt }`（有 `requestId`：回應要求者；無 `requestId`：主動推送給所有外掛，限 `api.chats`） |
| `chat:admin-token:consumed` | `{ requestId, chatId }`（只回成功兌換的機器人，不含新權杖；新權杖另行推送） |
| `chat:admin-token:changed` | `{ chatId }`（失效通知，不含祕密；網頁重新取得，外掛於 `api.chats` 聊天室移除時收到） |
| `chat:member-joined` | `{ chatId, member: { userId, displayName, pictureId?, pictureUrl? } }`（社群 `NOTIFIED_JOIN_SQUARE_CHAT`；只推給機器人，限 `api.chats`，不重播；日誌含 ID、暱稱與大頭貼網址） |
| `chat:note-posted` | `{ chatId, createdAt, postId?, messageId?, senderId?, senderName?, preview?, text }` 或以 `error: "NOTE_FETCH_FAILED"` 取代 `text`（群組／社群記事本發文：聊天訊息通知帶 `messageId`；社群 `NOTIFIED_UPDATE_SQUARE_NOTE_STATUS` 經列表找出，沒有 `messageId`，列表讀不到時也沒有 `postId`；只推給機器人，限 `api.chats`，不重播；內容不入日誌） |
| `channels` | `{ channels: Channel[] }`（snapshot，連線即送、變動重送） |
| `messages` | `{ chatId, messages: Message[] }`（連線時快照，同聊天室可分多個影格、依 ID 合併；舊訊息，不計未讀） |
| `message` | `{ message: Message }`（即時新訊息） |
| `channel` | `{ channel: Channel }`（單一頻道變動：預覽、活動時間、未讀數；只給網頁） |
| `chat:checked` | `{ chatId }`（此帳號在其他裝置讀過該聊天室；只給網頁） |
| `pong` | `{}`（回應 `ping`） |
| `message:edit` | `{ message: Message }` |
| `message:unsend` | `{ chatId, messageId }`（訊息已收回；快照與歷史中以 `Message.unsent: true` 佔位呈現） |
| `message:reactions` | `{ chatId, messageId, reactions? }`（回應改變；只給網頁） |
| `history` | `{ requestId, chatId, messages: Message[], hasMore, cursor? }`（`cursor` 傳回 `before` 取更早一頁） |
| `read` | `{ chatId, positions: { readerId, messageId }[] }`（他人已讀到哪則；開啟聊天時送快照，之後即時增量；社群無已讀） |
| `sent` | `{ requestId, messageId }` |
| `api:state` | `{ enabled, chats: string[], createdAt? }`（只給網頁連線；`createdAt` 為目前 Token 的建立時間，無 Token 則省略） |
| `api:token` | `{ token }`（新 Token；**只送給發起 `api:token:create` 的連線、僅此一次**，不入日誌） |
| `error` | `{ requestId?, code, message }`（generic） |
| `status` | `{ state: "starting"｜"listening"｜"reconnecting" }` |

### Client → Server

| type | 負載 |
|---|---|
| `auth:start` | `{}`（開始 QR 登入；僅 `idle`／`error` 有效） |
| `history:fetch` | `{ requestId, chatId, limit?, before? }` |
| `message:send` | `{ requestId, chatId, text?, mediaId?, sticker?: { packageId, stickerId } }` |
| `message:react` | `{ requestId, chatId, messageId, reaction: "NICE"｜"LOVE"｜"FUN"｜"AMAZING"｜"SAD"｜"OMG"｜null }`（僅網頁，與 `message:send` 共用頻率上限） |
| `profile:get` | `{ requestId }`（自己的 `profile`；網頁與機器人皆可，不呼叫 LINE） |
| `chat:admins:get` | `{ requestId, chatId }`（僅機器人 API；指定社群聊天室的全部管理員與共同管理員） |
| `chat:admin-token:get` | `{ requestId, chatId }`（網頁可取任何已知聊天室；機器人限 `api.chats`） |
| `chat:admin-token:consume` | `{ requestId, chatId, token }`（僅機器人；成功一次即輪替） |
| `channels:refresh` | `{}` |
| `api:token:create` / `api:token:revoke` | `{}`（產生或撤銷機器人 Token，並中斷所有機器人連線） |
| `ping` | `{}` |

### 機器人 API（`/api/ws`）
- 升級條件：`api.enabled`、**無 `Origin`**、`Authorization: Bearer linejs_…` 符合目前 Token；否則 403（同時超過 4 個連線回 429）。`Host` 不限制（同網頁）。
- 連線時收到 `hello`、`auth:state`、`status`、`auth:ready`、僅含 `api.chats` 的 `channels`，以及這些聊天室的 `chat:admin-token` 推送（v1.19）；之後只有這些聊天室的 `message`／`message:edit` 與權杖推送／失效通知。不重播、不給 `read`／`update:available`／`api:state`。
- 可送：`message:send`（`requestId`、`chatId`，加上 `text`（可選 `mentions`／`replyTo`）或機器人自己上傳的 `mediaId`（v1.23）；`sticker` 回 `INVALID_REQUEST`）、`history:fetch`、`profile:get`（v1.17，回 `profile`）、`chat:admins:get`（v1.18，回 `chat:admins`）、`chat:admin-token:get`／`chat:admin-token:consume`（v1.19）、`ping`；其餘 `UNKNOWN_TYPE`；`api.chats` 以外的聊天室回 `UNKNOWN_CHAT`。
- 限制：每連線 `limits.sendsPerSecond`，且全部機器人合計 `api.sendsPerMinute`（預設 20，≤120）；上傳全部機器人合計 `limits.uploadsPerMinute`（與網頁分開）。

### HTTP
- `GET /`：前端 SPA。
- `GET /media/:mediaId`：貼圖（`sticker-*`）、LINE 表情貼（`emoji-<productId>-<sticonId>`，靜態圖）、大頭照（`avatar-p|o-*`，原圖 `avatarfull-*`）、收到的圖片／影片／語音（`msg-*`）與已上傳媒體位元組（200／206／404／416）；需瀏覽器 cookie，訊息媒體 `Cache-Control: private, no-store`。
- `POST /media/upload`：媒體上傳（以內容判斷：圖片 PNG／JPEG／GIF ≤ 10MB；影片 MP4／MOV ≤ `limits.uploadVideoMaxBytes`，預設 50MB）→ `{ mediaId }`；發送時以 `mediaId` 引用。
- `POST /api/media/upload`（v1.23，僅機器人：Bearer Token、無 `Origin`、`api.enabled`）：另接受 M4A（語音訊息，須有 `moov/mvhd` 長度）、MP3、PDF、UTF-8 文字（檔案附件，檔名取自 percent-encoding 的 `X-File-Name`，副檔名依內容），≤ `limits.uploadFileMaxBytes`（預設 50MB）→ `{ mediaId }`，只能由機器人的 `message:send` 送出。

### 限制
- frame ≤ 256KB（媒體一律走 HTTP）；`message:send` ≤ 5/秒/連線；`POST /media/upload` 圖片 ≤ 10MB/檔、影片 ≤ 50MB/檔、≤ 5 次/分鐘；`POST /api/media/upload` 聲音檔／PDF／文字檔 ≤ 50MB/檔、全部機器人 ≤ 5 次/分鐘；單一收到的媒體下載 ≤ `limits.downloadMaxBytes`（預設 50MB）；text ≤ 8000 字；`packageId`／`stickerId` 限正整數；未知 type 忽略並回 `error`。

---

## 五、資料模型

```
Channel { channelId, kind: "user"｜"group"｜"room"｜"square", name,
          pictureId?, unreadCount?, memberCount?, lastMessageAt?, lastMessage?: Message }
Message { messageId, channelId, channelKind, senderId, senderName, senderPictureId?, senderRole?,
          text?, contentType, createdAt, editedAt?, mediaId?, replyTo?,
          mentions?: { start, end, userId? }[],   // 收到的 @ 提及；無 userId 為 @All
          card?: 位置｜聯絡人｜檔案（名稱、大小、fileId?）｜卡片訊息替代文字,
          reactions?: { counts, mine? },          // LINE 六種預設回應的人數；mine 為本帳號的回應
          decryptFailed?, unsent? }               // unsent：已收回，只留寄件者與時間
Media   { mediaId, mime, size, kind: "image"｜"sticker"｜"video"｜"audio" }
```
- 生命週期：連線 snapshot＋增量；記憶體快取每頻道 ≤ 500 則，**不持久化訊息**（範圍外）。
- 上傳媒體沿用 `Media`（`kind: "image"` 或 `"video"`）；貼圖發送為無位元組引用（`packageId`／`stickerId`），不經 `Media`。
- 併發：每連線單序廣播佇列；同一 `messageId` 以 id 去重（`message:edit` 覆寫既有快取）。

---

## 六、安全性架構（**須完整寫入 `AGENTS.md` 作為撰寫硬規則**）

1. 監聽位址以 `config.yaml` 為準（v1.11 裁示：不強制 127.0.0.1）；預設與範本維持 `127.0.0.1`，不得為 `0.0.0.0`；非本機迴路時啟動警告。`Host` 標頭不檢查（任何 IP／網域皆可；代價是不防 DNS rebinding），Origin／cookie／Token 照常。
2. QR URL 與 PIN **一次性顯示、不入日誌、不落盤**。
3. `session.json` 含憑證與 E2EE key material：chmod **600**、列入 `.gitignore`、不入日誌、不分享。
4. 網頁 WS 升級須 `Origin`（`http`／`https`）的主機部分等於 `Host` 標頭並帶瀏覽器 cookie；其餘來源拒絕升級。
5. 每連線頻率限制：`message:send` ≤ 5/秒；`POST /media/upload` ≤ 10MB/檔、≤ 5 次/分鐘；frame ≤ 256KB。
6. 媒體快取上限預設 200MB（LRU）；收到的媒體須先出現在已見訊息中才可請求，單檔上限預設 50MB，類型以內容判斷（不含 SVG／HTML）。
7. 輸入驗證：`chatId` 格式（`u／c／r／s／m` 開頭，`m` 為 OpenChat）、`text` ≤ 8000 字、`limit` ≤ 100、`packageId`／`stickerId` 限正整數、上傳媒體以內容判斷（圖片 PNG／JPEG／GIF；影片 MP4／MOV）。
8. 對外一律 generic 錯誤；本地日誌只記固定操作錯誤碼，上游錯誤名稱、訊息或物件也可能含憑證，不得寫入。
9. 依賴釘選版本；`npm audit` 無 high 以上（Gate 4 驗收）。
10. 解密／解析失敗 **fail-closed**：顯示佔位，不降級猜測內容。
11. 機器人 API（v1.11）：預設關閉；Bearer Token（只存雜湊、一次性顯示）、不得帶 `Origin`、影格白名單、`api.chats` 範圍、全域每分鐘發送上限、最多 4 連線、換／撤銷 Token 立即斷線。

錯誤日誌修正：移除 WS 各操作與程序例外處理的上游錯誤文字，沿用管理員查詢的固定碼模式。歷史失敗回歸測試確認錯誤名稱與訊息不進日誌；typecheck、build、314 項測試通過。正式 HTTP／WS 隔離失敗回 generic `HISTORY_FAILED`，日誌只有該碼；另在暫存設定、無 session、停用更新的環境啟動實際 `dist/main.js`，未處理 rejection 後仍可接受 HTTP，未捕捉 exception 記固定碼後 exit 1 並移除 pid，兩者均未輸出注入的假敏感文字。不接觸真實帳號，也不改既有錯誤回應或關閉流程。

---

## 七、必要文件規格

| 檔案 | 內容要求 |
|---|---|
| `README.md` | 用途、系統架構圖、需求（Node ≥22）、安裝啟動、ws 協定摘要、`config.yaml` 說明、測試指令、授權宣告（Apache-2.0 本作品＋消費套件 MIT 併陳） |
| `AGENTS.md` | 撰寫方式：語言規範、建置測試指令、結構對應、**安全性章節＝第六節全部規則逐條編號**、外部 API 一律經 LineProvider adapter |
| `CLAUDE.md` | 僅**引用 `AGENTS.md`**（一行指向＋摘要），不重複內容 |
| `PLAN.md` | **本企劃書全文匯入之定案稿**（更新時同步） |

---

## 八、倉庫與部署

- **前置檔案**：`LICENSE`（Apache-2.0）、`.nojekyll`——**已在 main**（2026-10-08 經 GitHub API 驗證；倉庫具 admin／push 權限）。兩檔不得改寫。
- **倉庫**：https://github.com/JS-PACKAGE/LINE.js（main）——**公開開源供 clone（裁示），不發布 npm／JSR 套件**；必要文件與程式碼入庫；`session.json` 與 `config.yaml` 個人值不入庫（`config.example.yaml` 入庫）。
- **服務部署**：本機 `npm install && npm run build && npm start` → `http://127.0.0.1:3789`；開頁見 QR → LINE 掃碼 → 進入主畫面。
- **介紹頁**：無公開網址（範圍外）。

---

## 九、風險與因應

| 風險 | 影響 | 因應 |
|---|---|---|
| LINE 風控／帳號限制（非官方 API） | 封號、功能失效 | QR 登入（裁示）；低頻操作；**次要帳號先行驗證**（裁示），穩定後再切主帳號 |
| linejs API／LINE 協定變動 | 解析失敗 | 釘 3.5.0；adapter 隔離；本次升版已獲人工裁示，後續升版仍須人工裁示 |
| E2EE 群組需 decrypt key | 群組訊息不可讀 | `FileStorage` 持久化 key；缺 key 顯示「無法解密」佔位 |
| ws 中斷／後端 listen 失效 | 資料斷流 | 前端自動重連＋snapshot 重送；後端退避重啟 `client.listen()` |
| 媒體流量／記憶體 | 記憶體膨脹 | 快取上限＋LRU；preview 優先；ws 不傳位元組 |
| QR 過期／登入中斷 | 無法登入 | 重新產生 URL 由使用者動作觸發；不自動循環重試 |

---

## 十、里程碑與 Gate（逐關通過才進下一階段）

### Phase 0 — 前置交付
倉庫根檔（**已達成**：`LICENSE`＋`.nojekyll`）＋必要文件四件。
**Gate 0**：`gh api repos/JS-PACKAGE/LINE.js/contents/` 含 `README.md／AGENTS.md／CLAUDE.md／PLAN.md／LICENSE／.nojekyll`，且 `LICENSE` 仍為 Apache-2.0。

### Phase 1 — 專案骨架＋登入 spike
npm 專案（TS、Node ≥22）、JSR 釘選安裝、QR 登入（**次要帳號**，裁示）、console 收一則真實訊息。
**Gate 1**：`npm run typecheck` 通過；混合驗收（執行 Agent 驗輸出、使用者以**次要帳號**掃碼）掃碼後 60 秒內 console 出現一則真實 LINE 訊息；`session.json` 權限 600。

### Phase 2 — ws＋頻道清單＋即時串流＋最小前端
ws 伺服器、`channels`／`message` 協定、登入頁＋主畫面最小版。
**Gate 2**：瀏覽器開 `http://127.0.0.1:3789` 見頻道清單；於 LINE 手機發一則訊息，2 秒內出現在網頁；`npm test`（Mock Provider）通過。

### Phase 3 — 歷史＋發送＋媒體
`history:fetch`、`message:send`、`GET /media/:mediaId`、`POST /media/upload`、圖片／貼圖顯示、貼圖發送、佔位渲染。
**Gate 3**：點開頻道載入 ≥ 50 則歷史且可往上翻；網頁發送文字、圖片、貼圖各一則於 LINE 手機驗證收到；收到圖片與貼圖在網頁正確顯示；影片／語音／檔案顯示佔位。

### Phase 4 — 安全加固＋文件＋回歸
**Gate 4（交付關）**：①乾淨 clone → install → build → start → 走完登入→看訊息→翻歷史→發訊息→看圖 ②`git status` 不含 `session.json` ③`npm audit` 無 high ④`AGENTS.md` 安全節對照第六節逐條存在 ⑤刪除 `session.json` 後重啟可 QR 重登入成功 ⑥`README.md` 指令逐條可複製執行。

---

## 十一、已知假設與未定項

1. Node 最低 **v22** 為裁示；本機實測 v26.10.0（2026-10-08）；建置以 `tsc` 保守編譯相容 v22。
2. **PORT 3789** 為本文件定案（授權由本文件決定）；值入 `config.yaml`，可調整。
3. 前端 **vanilla TypeScript＋Vite**（2026-10-08 裁示）；若改框架，同步更新「二、依賴策略」與本條並升版。
4. 登入仿照裝置 `ANDROIDSECONDARY`（QR 範例預設）；型別入 `config.yaml` 可調。
5. linejs 契約原始調查以 3.4.2 原始碼為據（當時已驗證 `fetchJoinedChats`／`chat.fetchMessages`／`message.getData`／`chat.sendMessage`／`obs.uploadObjTalk`／`uploadMediaByE2EE`）；目前釘選 3.5.0，不能把原始調查視為新版實測。圖片／貼圖的 `sendMessage` payload 形狀仍以實際套件行為為準，衝突只改 adapter。
6. 歷史預設 **50 則**（`config.yaml` 可調）；`before` 分頁行為於 Phase 3 實測定案，不影響其他實作。
7. 媒體範圍＝**圖片／GIF／影片／語音＋貼圖**（v1.6 裁示擴大）；檔案佔位為範圍外。影片點擊後才載入、語音按播放才載入。
8. 發送範圍＝**文字＋圖片＋貼圖**（2026-10-08 裁示，v1.1 起）；貼圖以 `packageId`／`stickerId` 指定，貼圖選單 UI（列舉帳號貼圖）列延伸項目，待 Phase 3 查 linejs 貼圖 API 後另裁。
9. UI 語言繁體中文；QR 圖由前端 `qrcode` 套件產生（linejs 不內建 QR 圖產生）。
10. 本作品授權 Apache-2.0 依倉庫 `LICENSE` 為準，**不**沿用消費套件的 MIT；MIT 授權宣告列入 `README.md`。

---

開始執行。
