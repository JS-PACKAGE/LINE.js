# LINE.js 本機 LINE 網頁客戶端 企劃書 v1.11

一句話：以 **WebSocket** 為即時通道、以 **@evex/linejs v3.4.2** 為 LINE 連線核心的本機 TypeScript 網頁客戶端（**LINE.js**）——Node 後端以 QR 掃碼登入 LINE，將訊息與頻道清單經 ws 推送到監聽 `127.0.0.1:3789` 的網頁前端。

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
| 消費套件 | **@evex/linejs v3.4.2**＋**@evex/linejs-types v3.4.2**（JSR，MIT） |
| 套件倉庫 | https://github.com/evex-dev/linejs（tag `v3.4.2`，commit `ef6c3d9`） |
| 套件文件 | https://linejs.evex.land/（2026-10-08 驗證可連） |
| 套件授權 | MIT（授權宣告列入 `README.md`） |

---

## 〇、專案概述

### 目標
- 以 TypeScript 本地開發 LINE 網頁客戶端 **LINE.js**：Node 後端經 @evex/linejs v3.4.2 連線 LINE（Thrift／LEGY／PUSH／E2EE）。
- 後端預設監聽 **127.0.0.1:3789**（PORT 由本文件定案；host 與 PORT 值入 `config.yaml`，v1.11 起 host 以設定檔為準），以 **ws** 將 LINE 訊息與頻道清單推送到網頁客戶端。
- 第一版全功能：頻道清單、即時訊息串流、歷史載入、網頁端發送**文字／圖片／貼圖**、圖片／貼圖顯示。
- 登入採 **QR 掃碼**（免帳密）；session 持久化，重啟優先復用、失效才重掃。
- 交付必要文件四件（README／AGENTS／CLAUDE／PLAN）後才收尾實作。

### 範圍外
- 公開部署、對外網址、HTTPS／網域（預設僅監聽 127.0.0.1；host 可由 `config.yaml` 改，但不提供也不負責對外部署）。
- 套件發布（npm／JSR）：裁示為**只開源倉庫供 clone，不發套件**。
- 多帳號、多使用者、帳號系統與權限。
- 檔案（FILE）的下載與播放（僅顯示類型佔位與基本資訊）。
- 網頁端發送檔案、發送影片／語音；訊息編輯送出（linejs 僅支援接收 `message:edit`）、收回他人訊息。
- 通話（linejs 具 call 能力但不在範圍）、社群管理操作（邀請／踢人／公告）、Timeline／Moa 相簿、貼圖商店、自動回覆／AI Agent 整合。

### 硬性要求

| 編號 | 要求 |
|---|---|
| R1 | TypeScript 本地開發；執行環境 Node.js ≥ **v22**（本機 v26.10.0） |
| R2 | 消費套件釘選 **@evex/linejs@3.4.2**、**@evex/linejs-types@3.4.2**（JSR），不追 main；升版需人工裁示 |
| R3 | 後端預設監聽 **127.0.0.1**，PORT 預設 **3789**，主機與 PORT 值入 `config.yaml` 且以設定為準（v1.11 裁示：不再強制本機迴路），程式不得寫死 |
| R4 | 以 **ws（WebSocket）** 將 LINE 訊息與頻道清單推送到網頁客戶端；同埠 HTTP 提供靜態前端與 `GET /media/:mediaId` 媒體位元組 |
| R5 | 登入＝**QR 掃碼**（免帳密）；session（cert／refreshToken／authToken）持久化於 `session.json`，重啟優先復用、失效才重掃；QR URL 與 PIN 僅一次性顯示、不入日誌 |
| R6 | 第一版功能：①頻道清單（好友／群組／聊天室／社群）②即時訊息串流（含 `square:message`、`message:edit`）③歷史載入（預設最近 50 則）④網頁端發送文字、圖片、貼圖（機制見「四、通訊協定」）⑤圖片／貼圖顯示 |
| R7 | 媒體：收到的圖片／GIF／影片／語音經 adapter 取得（E2EE 於後端解密）後由 HTTP 內嵌供網頁顯示與播放，貼圖與大頭照由 LINE CDN 經後端代取；檔案僅佔位（v1.6 裁示：影片、語音、GIF 納入顯示） |
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
[LINE 伺服器] ⇄ @evex/linejs v3.4.2（Thrift／LEGY／PUSH／E2EE）
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

## 三、外部 API 介接（@evex/linejs v3.4.2 ＋ LINE 服務，皆經 adapter）

> 本節為**本系統需要的最小契約**，已對照 v3.4.2 原始碼（`packages/linejs/client/`）逐項驗證；若實測與契約衝突，**以套件實際行為為準，只改 adapter**，不動核心狀態機。

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

### Server → Client

| type | 負載 |
|---|---|
| `hello` | `{ protocol: 2, serverVersion }` |
| `update:available` | `{ version, current, url }`（url 僅限本專案 GitHub Release 頁） |
| `auth:state` | `{ state: "restoring"｜"idle"｜"authenticating"｜"ready"｜"error" }`（連線即送、變動廣播；不含祕密） |
| `auth:qr` | `{ url }`（一次性；只送給發起 `auth:start` 的連線） |
| `auth:pin` | `{ code }`（一次性；僅畫面顯示） |
| `auth:ready` | `{ profile }` |
| `channels` | `{ channels: Channel[] }`（snapshot，連線即送、變動重送） |
| `messages` | `{ chatId, messages: Message[] }`（連線時快照，每個聊天室一個影格；舊訊息，不計未讀） |
| `message` | `{ message: Message }`（即時新訊息） |
| `message:edit` | `{ message: Message }` |
| `message:unsend` | `{ chatId, messageId }`（訊息已收回；快照與歷史中以 `Message.unsent: true` 佔位呈現） |
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
| `channels:refresh` | `{}` |
| `api:token:create` / `api:token:revoke` | `{}`（產生或撤銷機器人 Token，並中斷所有機器人連線） |
| `ping` | `{}` |

### 機器人 API（`/api/ws`）
- 升級條件：`api.enabled`、**無 `Origin`**、`Authorization: Bearer linejs_…` 符合目前 Token；否則 403（同時超過 4 個連線回 429）。`Host` 不限制（同網頁）。
- 連線時收到 `hello`、`auth:state`、`status`、`auth:ready`、僅含 `api.chats` 的 `channels`；之後只有這些聊天室的 `message`／`message:edit`。不重播、不給 `read`／`update:available`／`api:state`。
- 可送：`message:send`（`requestId`、`chatId`、`text`、可選 `mentions`／`replyTo`；`mediaId`／`sticker` 回 `INVALID_REQUEST`）、`history:fetch`、`ping`；其餘 `UNKNOWN_TYPE`；`api.chats` 以外的聊天室回 `UNKNOWN_CHAT`。
- 限制：每連線 `limits.sendsPerSecond`，且全部機器人合計 `api.sendsPerMinute`（預設 20，≤120）。

### HTTP
- `GET /`：前端 SPA。
- `GET /media/:mediaId`：貼圖（`sticker-*`）、大頭照（`avatar-p|o-*`，原圖 `avatarfull-*`）、收到的圖片／影片／語音（`msg-*`）與已上傳媒體位元組（200／206／404／416）；需瀏覽器 cookie，訊息媒體 `Cache-Control: private, no-store`。
- `POST /media/upload`：媒體上傳（以內容判斷：圖片 PNG／JPEG／GIF ≤ 10MB；影片 MP4／MOV ≤ `limits.uploadVideoMaxBytes`，預設 50MB）→ `{ mediaId }`；發送時以 `mediaId` 引用。

### 限制
- frame ≤ 256KB（媒體一律走 HTTP）；`message:send` ≤ 5/秒/連線；`POST /media/upload` 圖片 ≤ 10MB/檔、影片 ≤ 50MB/檔、≤ 5 次/分鐘/連線；單一收到的媒體下載 ≤ `limits.downloadMaxBytes`（預設 50MB）；text ≤ 8000 字；`packageId`／`stickerId` 限正整數；未知 type 忽略並回 `error`。

---

## 五、資料模型

```
Channel { channelId, kind: "user"｜"group"｜"room"｜"square", name,
          pictureId?, unreadCount?, memberCount?, lastMessageAt? }
Message { messageId, channelId, channelKind, senderId, senderName, senderPictureId?, senderRole?,
          text?, contentType, createdAt, editedAt?, mediaId?, replyTo?,
          mentions?: { start, end, userId? }[],   // 收到的 @ 提及；無 userId 為 @All
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
| linejs API／LINE 協定變動 | 解析失敗 | 釘 3.4.2；adapter 隔離；升版人工裁示 |
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
5. linejs 契約以 3.4.2 原始碼為準（`fetchJoinedChats`／`chat.fetchMessages`／`message.getData`／`chat.sendMessage`／`obs.uploadObjTalk`／`uploadMediaByE2EE` 已驗證）；圖片／貼圖的 `sendMessage` payload 形狀於 Phase 3 實測，衝突只改 adapter。
6. 歷史預設 **50 則**（`config.yaml` 可調）；`before` 分頁行為於 Phase 3 實測定案，不影響其他實作。
7. 媒體範圍＝**圖片／GIF／影片／語音＋貼圖**（v1.6 裁示擴大）；檔案佔位為範圍外。影片點擊後才載入、語音按播放才載入。
8. 發送範圍＝**文字＋圖片＋貼圖**（2026-10-08 裁示，v1.1 起）；貼圖以 `packageId`／`stickerId` 指定，貼圖選單 UI（列舉帳號貼圖）列延伸項目，待 Phase 3 查 linejs 貼圖 API 後另裁。
9. UI 語言繁體中文；QR 圖由前端 `qrcode` 套件產生（linejs 不內建 QR 圖產生）。
10. 本作品授權 Apache-2.0 依倉庫 `LICENSE` 為準，**不**沿用消費套件的 MIT；MIT 授權宣告列入 `README.md`。

---

開始執行。
