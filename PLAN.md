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
- 通話（linejs 具 call 能力但不在範圍）、社群管理操作（邀請／踢人／公告）、Timeline／Moa 相簿、貼圖商店、自動回覆／AI Agent 整合（v1.15 的詐騙機率分析只在使用者點選或機器人明確請求時估計單則訊息，服務本身不自動處理訊息，不屬此項）。

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
- LINE 服務失敗：ws 推 `error`（generic code），內部原因只入本地日誌；不自動循環重試（QR 重新產生需使用者動作）。
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

### Server → Client

| type | 負載 |
|---|---|
| `hello` | `{ protocol: 2, serverVersion, capabilities? }`（僅 `/api/ws` 宣告 `capabilities: ["chat:admins"]`） |
| `update:available` | `{ version, current, url }`（url 僅限本專案 GitHub Release 頁） |
| `auth:state` | `{ state: "restoring"｜"idle"｜"authenticating"｜"ready"｜"error" }`（連線即送、變動廣播；不含祕密） |
| `auth:qr` | `{ url }`（一次性；只送給發起 `auth:start` 的連線） |
| `auth:pin` | `{ code }`（一次性；僅畫面顯示） |
| `auth:ready` | `{ profile }` |
| `profile` | `{ requestId, profile }`（回應 `profile:get`；只送給要求的連線） |
| `chat:admins` | `{ requestId, chatId, ownMemberId, admins: ChatAdmin[] }`（只回要求的機器人連線） |
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
| `scam:state` | `{ enabled }`（是否設定 `jev.token`；只給網頁，不含金鑰） |
| `scam:result` | `{ requestId, chatId, messageId, analysis: { probability, tactic?: { kind, confidence } } }`（只送給發起 `scam:check` 的連線） |
| `error` | `{ requestId?, code, message }`（generic） |
| `status` | `{ state: "starting"｜"listening"｜"reconnecting" }` |

### Client → Server

| type | 負載 |
|---|---|
| `auth:start` | `{}`（開始 QR 登入；僅 `idle`／`error` 有效） |
| `history:fetch` | `{ requestId, chatId, limit?, before? }` |
| `message:send` | `{ requestId, chatId, text?, mediaId?, sticker?: { packageId, stickerId } }` |
| `message:react` | `{ requestId, chatId, messageId, reaction: "NICE"｜"LOVE"｜"FUN"｜"AMAZING"｜"SAD"｜"OMG"｜null }`（僅網頁，與 `message:send` 共用頻率上限） |
| `scam:check` | `{ requestId, chatId, messageId }`（網頁每連線每分鐘 10 次；機器人限 `api.chats`、所有機器人合計每分鐘 10 次；只接受別人傳來、已顯示、未收回的文字訊息） |
| `profile:get` | `{ requestId }`（自己的 `profile`；網頁與機器人皆可，不呼叫 LINE） |
| `chat:admins:get` | `{ requestId, chatId }`（僅機器人 API；指定社群聊天室的全部管理員與共同管理員） |
| `channels:refresh` | `{}` |
| `api:token:create` / `api:token:revoke` | `{}`（產生或撤銷機器人 Token，並中斷所有機器人連線） |
| `ping` | `{}` |

### 機器人 API（`/api/ws`）
- 升級條件：`api.enabled`、**無 `Origin`**、`Authorization: Bearer linejs_…` 符合目前 Token；否則 403（同時超過 4 個連線回 429）。`Host` 不限制（同網頁）。
- 連線時收到 `hello`、`auth:state`、`status`、`auth:ready`、僅含 `api.chats` 的 `channels`；之後只有這些聊天室的 `message`／`message:edit`。不重播、不給 `read`／`update:available`／`api:state`。
- 可送：`message:send`（`requestId`、`chatId`、`text`、可選 `mentions`／`replyTo`；`mediaId`／`sticker` 回 `INVALID_REQUEST`）、`history:fetch`、`scam:check`（v1.16，回 `scam:result`）、`profile:get`（v1.17，回 `profile`）、`chat:admins:get`（v1.18，回 `chat:admins`）、`ping`；其餘 `UNKNOWN_TYPE`；`api.chats` 以外的聊天室回 `UNKNOWN_CHAT`。
- 限制：每連線 `limits.sendsPerSecond`，且全部機器人合計 `api.sendsPerMinute`（預設 20，≤120）。

### HTTP
- `GET /`：前端 SPA。
- `GET /media/:mediaId`：貼圖（`sticker-*`）、LINE 表情貼（`emoji-<productId>-<sticonId>`，靜態圖）、大頭照（`avatar-p|o-*`，原圖 `avatarfull-*`）、收到的圖片／影片／語音（`msg-*`）與已上傳媒體位元組（200／206／404／416）；需瀏覽器 cookie，訊息媒體 `Cache-Control: private, no-store`。
- `POST /media/upload`：媒體上傳（以內容判斷：圖片 PNG／JPEG／GIF ≤ 10MB；影片 MP4／MOV ≤ `limits.uploadVideoMaxBytes`，預設 50MB）→ `{ mediaId }`；發送時以 `mediaId` 引用。

### 限制
- frame ≤ 256KB（媒體一律走 HTTP）；`message:send` ≤ 5/秒/連線；`POST /media/upload` 圖片 ≤ 10MB/檔、影片 ≤ 50MB/檔、≤ 5 次/分鐘/連線；單一收到的媒體下載 ≤ `limits.downloadMaxBytes`（預設 50MB）；text ≤ 8000 字；`packageId`／`stickerId` 限正整數；未知 type 忽略並回 `error`。

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
8. 對外一律 generic 錯誤；內部錯誤只入本地日誌。
9. 依賴釘選版本；`npm audit` 無 high 以上（Gate 4 驗收）。
10. 解密／解析失敗 **fail-closed**：顯示佔位，不降級猜測內容。
11. 機器人 API（v1.11）：預設關閉；Bearer Token（只存雜湊、一次性顯示）、不得帶 `Origin`、影格白名單、`api.chats` 範圍、全域每分鐘發送上限、最多 4 連線、換／撤銷 Token 立即斷線。
12. 詐騙機率分析（v1.15、v1.16）：`jev.token` 有值才啟用；金鑰只作為送往 TypeSafe 的 Bearer 標頭、不送網頁、不入日誌；只在使用者點選或機器人請求時送出伺服器快取的那一則他人文字；網頁每連線每分鐘 10 次，機器人限 `api.chats`、合計每分鐘 10 次；回應 fail-closed、錯誤 generic。

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
