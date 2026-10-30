# LINE.js 工程規範

## 語言與開發方式

- 與使用者溝通、文件及 UI 使用繁體中文；技術名詞與程式識別字可保留英文。
- 使用 TypeScript、Node.js ≥22、Node ESM；前端 Vite＋vanilla TypeScript。不得擅自替換框架或最低執行版本。
- 先讀 [PLAN.md](PLAN.md) 與相關實作、驗證套件 API，再修改；採最小完整修改，不做無關重構或增加不必要依賴。
- `@evex/linejs` 與 `@evex/linejs-types` 必須釘選 JSR **3.5.0**。本次由 3.4.2 升版已獲使用者明示授權；不得追蹤 main，後續升版仍必須取得人工裁示。
- **所有 LINE 外部 API 一律經 LineProvider adapter**，核心狀態、HTTP、WS 與前端不得直接呼叫套件。API 衝突以目前釘選 v3.5.0 的實際原始碼為準，只改 adapter。
- MockLineProvider 僅供隔離測試，不能冒充真實 LINE 功能或代替 Gate 驗收。
- 依功能分批提交；先檢查 diff，僅納入該功能相關檔案。未經明示授權不得 push、發布或部署。保留使用者既有修改。
- 不改寫根目錄 `LICENSE`（Apache-2.0）與 `.nojekyll`；不發布 npm／JSR 套件。

## 結構對應

以下為定案結構；目前已建立設定、session、LineProvider、同埠 HTTP（靜態頁、`/media`、圖片與影片上傳）、WS hub（登入、登出、頻道、即時與歷史訊息、發送、已讀）、訊息快取與聊天網頁（大頭照、貼圖、LINE 表情貼（收到的，經 `/media/emoji-*` 代取靜態圖）、收到的圖片／GIF／影片／語音內嵌顯示、記事本通知小卡、輸入框、自製確認對話框）。

| 路徑 | 職責 |
|---|---|
| `src/line/` | LineProvider、QR 登入、session、LINE 事件、歷史、發送、媒體下載、記事本通知解析與全文（`notes.ts`） |
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

本次 3.5.0 升級未使用真實 LINE 帳號驗證，不得宣稱新版通過真實 LINE Gate。下列註明 linejs 3.4.2 的 workaround 是當時的來源觀察，不得改寫成 3.5.0 的驗證證據；新版是否仍需沿用，應對照目前原始碼與隔離測試確認，不能僅因升版就移除安全或相容性處理。

登入完全經 WS：QR／PIN 只可送給發起 `auth:start` 的連線，`auth:state` 等廣播不得含祕密；不得新增 HTTP 登入端點或把祕密放進任何共享狀態。WS 升級必須同時驗證路徑、Host、Origin 與瀏覽器 cookie。每個 ws 連線必須掛 `error` 處理（超大 frame 會觸發 error，未處理會使程序崩潰）。登入 helper 無法在登入前附加 token 監聽，因此 adapter 使用等價 BaseClient 流程；token listener 必須先註冊。SessionStorage 沿用 FileStorage 契約但覆寫原子持久化，不能吞寫入錯誤。Thrift 以 override 固定修補版 `0.23.0`，不得解除修補而引入已知 high 漏洞。linejs 3.4.2 的 `fetchUsers()` 一次送出全部好友 mid，超過 LINE 上限 100 會失敗，因此 adapter 自行分批取得好友。

## 安全性架構（硬規則）

1. 監聽位址以 `config.yaml` 為準（2026-10 裁示：不再強制 127.0.0.1，可設主機名稱、IPv4、IPv6），**預設值與範本維持 `127.0.0.1`，不得改成 `0.0.0.0`**。非本機迴路位址啟動時須印警告；網頁無帳號密碼，改 host 等於把已登入帳號開放給該網路。**不檢查 `Host` 標頭**（裁示：不論監聽位址，任何 IP／網域皆可連入；代價是不防 DNS rebinding），其餘 Origin／cookie／Token／`Sec-Fetch-Site: cross-site` 檢查不變。
2. QR URL 與 PIN **一次性顯示、不入日誌、不落盤**。
3. `session.json` 含憑證與 E2EE key material：chmod **600**、列入 `.gitignore`、不入日誌、不分享。
4. 網頁 WS 升級須 `Origin`（`http`／`https`，後者供 TLS 反向代理／自訂網域）的主機部分等於 `Host` 標頭並帶瀏覽器 cookie；其餘來源拒絕升級。
5. 每連線頻率限制：`message:send` ≤ 5/秒（收回 `message:unsend` 共用此額度，且只接受伺服器已顯示、本帳號所發的訊息，機器人不可用；回應 `message:react` 也共用此額度，只接受伺服器已顯示、未收回的訊息，機器人不可用）；`POST /media/upload` 圖片 ≤ 10MB/檔、影片 ≤ 50MB/檔（`limits.uploadVideoMaxBytes`）、≤ 5 次/分鐘；機器人 `POST /api/media/upload` 另有所有機器人共用的 ≤ 5 次/分鐘額度（`limits.uploadsPerMinute`），聲音檔／PDF／文字檔 ≤ 50MB/檔（`limits.uploadFileMaxBytes`）；frame ≤ 256KB。
6. 媒體快取上限預設 200MB（LRU）；收到的媒體只能請求已見過的訊息（`msg-<id>`），單檔上限 `limits.downloadMaxBytes`（預設 50MB），類型一律以位元組內容判斷且不供應 SVG／HTML；訊息媒體不得被瀏覽器快取。
7. 輸入驗證：`chatId` 格式（`u／c／r／s／m` 開頭；OpenChat 為 `m`）、`text` ≤ 8000 字、`limit` ≤ 100、`packageId`／`stickerId` 限正整數、上傳媒體以內容判斷（圖片 PNG／JPEG／GIF；影片 MP4／MOV，以 `ftyp` 品牌辨識，聲稱的 Content-Type 只用來選擇大小上限；影片長度取自 `moov/mvhd`，不採用瀏覽器給的值；機器人另可上傳 M4A（`ftyp` 品牌 `M4A `，須讀得到 `moov/mvhd` 長度，送語音訊息）、MP3（ID3 或合法 Layer III frame）、PDF（`%PDF-` 加版本數字）與 UTF-8 文字（不含 NUL 等控制字元），後三者以檔案附件送出，檔名取自 percent-encoding 的 `X-File-Name`，去除控制字元與路徑分隔、≤255 字，副檔名由內容決定）。
8. 對外一律 generic 錯誤；內部錯誤只入本地日誌。
9. 依賴釘選版本；`npm audit` 無 high 以上（Gate 4 驗收）。
10. 解密／解析失敗 **fail-closed**：顯示佔位，不降級猜測內容。
11. 機器人 API（`/api/ws`，預設關閉，`api.enabled`）：Bearer Token 認證（只存雜湊、比對用 `timingSafeEqual`、產生後只顯示一次、不入日誌）；升級**不得帶 `Origin`**（網頁不可用此入口），`Host` 不檢查；只開放 `message:send`（文字，或機器人自己經 `POST /api/media/upload` 上傳的檔案）、`history:fetch`、`profile:get`（只回本帳號自己的 profile，不呼叫 LINE）、`chat:admins:get`（僅 API；完整分頁取得指定社群聊天室的現任管理員與共同管理員，回 `chat:admins { requestId, chatId, ownMemberId, admins }`；`ownMemberId` 來自 `getSquareChat.squareChatMember`，自身與管理員 ID 皆須符合 `/^p[A-Za-z0-9]{10,64}$/`；與歷史共用每連線每秒 10 次，非社群回 `CHAT_ADMINS_UNSUPPORTED`，失敗回 `CHAT_ADMINS_FAILED`，不回部分結果）、`chat:admin-token:get`／`chat:admin-token:consume`（見第 12 條）、`chat:membership:get`／`chat:member:remove`（見第 13 條）、`ping`，其餘一律 `UNKNOWN_TYPE`；`hello` 保留數字 `protocol: 2` 與版本，僅 API 以 `capabilities: ["chat:admins", "chat:admin-token", "chat:members", "chat:member-joined", "chat:note-posted", "media:upload"]` 宣告。機器人上傳（小語裁示：文字檔、PDF、圖片、影片、聲音檔）：`POST /api/media/upload` 與 `/api/ws` 相同認證（Bearer Token、不得帶 `Origin`、`api.enabled`），位元組只走 HTTP；上傳 ID 綁定「機器人」擁有者，網頁不能送機器人的上傳、機器人也不能送網頁的上傳，送出一次即失效、10 分鐘過期；發送仍受 `api.chats`、每連線與全部機器人的發送額度限制。社群成員加入（`NOTIFIED_JOIN_SQUARE_CHAT`，2026-10 小語裁示；LINE 只在各社群自己的 `fetchSquareChatEvents` 事件串回報，全域推播串沒有。adapter 只讀 `api.chats` 內的社群，每個聊天室同時只有一個請求，每收到一次全帳號社群推播（`fetchMyEvents`，任何類型）就立即讀全部，不設計時器；登入後先讀到最新位置，之前的加入不報）以 `chat:member-joined { chatId, member: { userId, displayName, pictureId?, pictureUrl? } }` 推送給所有機器人連線，只限 `api.chats` 且已登入，不重播、網頁不收；格式不符即丟棄，不授予額外 mention 權限；服務日誌記錄聊天室與成員 ID、暱稱（JSON 字串化，維持單行）與 `obs.line-scdn.net` 公開大頭貼網址（小語裁示）。一般群組的成員變動 operation 參數未記載，不得依參數猜測後推送。記事本發文（小語裁示：群組與社群，抓完整文章）：`POSTNOTIFICATION` 只有 `serviceType` 為 `GB`（`postEndUrl` 為 `…/group/home/posts/post?homeId=c…&postId=…`）或 `SN`（`line://square/post?squareMid=s…&postId=…`）且完全符合時才成為 `note` 卡片，其他（相簿 `AB`、分享 VOOM `MH`）維持佔位；格式取自其他用戶端的實測紀錄，尚未以真實帳號確認。只有 `api.chats` 內、已登入且至少一個機器人連線時的**即時新訊息**才經 adapter `fetchNoteText` 以 linejs `base.timeline.getPost` 抓全文（首次使用會核發 LINE Timeline 頻道權杖；回應失敗時清掉 linejs 快取的權杖以便重新核發）；adapter 只讀自己看過通知的貼文（最多記 100 則），群組的 `homeId` 必須等於該群組、社群的 `squareMid` 必須等於 `getSquareChat` 回報的所屬社群，回應須含所要求的 `postId`、文字 ≤20000 字，逾時 15 秒，所有聊天室合計每分鐘 20 次；以 `chat:note-posted { chatId, messageId, postId, senderId, senderName, createdAt, preview?, text | error: "NOTE_FETCH_FAILED" }` 只推給機器人，不重播、換帳號即丟棄，內容不入日誌或落盤。管理員查詢成功可授予同連線、同聊天室標記未發言管理員的額外 mention 權限；重新查詢開始即撤銷（限流／失敗亦同）、只採最新結果，斷線／登出／換帳號清除，不能污染共享快取或授權其他連線。只能存取 `api.chats` 清單內的聊天室（空清單視為設定錯誤，未列出者一律 `UNKNOWN_CHAT`）；不給 `chat:read`、登入／登出、`channels:refresh`、貼圖發送與收到的媒體位元組；連線不重播舊訊息、不收 `read`；所有機器人合計 `api.sendsPerMinute`（≤120/分鐘）加每連線 `limits.sendsPerSecond`；同時最多 4 個連線；重新產生／撤銷 Token 立即中斷所有機器人連線。Token 的產生與撤銷只接受一般 `/ws` 連線（實務上只有取得瀏覽器 cookie 的本機 CLI 會送；網頁不提供此 UI），機器人連線無此權限。
12. 聊天室一次性管理員權杖（2026-10 小語裁示）：每個聊天室各自以 32-byte 安全亂數建立 `chatadm_` 權杖，只存記憶體並綁定目前登入帳號。網頁可經聊天室標頭「搜尋」旁的「管理員權杖」取得，明文只回要求的分頁。權杖資訊**必須經 `/api/ws` 主動告知連入的外掛**：連線、登入完成、頻道清單更新與每次成功兌換後，推送 `api.chats` 內已知聊天室的 `chat:admin-token { chatId, token, createdAt }`（無 `requestId`），外掛也可主動 `chat:admin-token:get`；不得推送清單外聊天室。不得入日誌、落盤或存入瀏覽器儲存。只有 API 可兌換；取得與兌換共用每連線每秒 10 次。兌換須驗證格式並以 `timingSafeEqual` 比對，比對後同步產生不同的新權杖並替換，再回不含新權杖的成功影格，確保並行只有一個成功；網頁只收不含祕密的失效通知。登出、換帳號、關閉服務與聊天室移除須撤銷（外掛收 `chat:admin-token:changed` 或非 `ready` 的 `auth:state`）。兌換只證明權杖被消耗，由機器人自行授權，不得變更 LINE 管理員或授予 API／mention 權限；因 API 可讀明文，不能當作 WEB 操作或 LINE 管理員身分證明。
13. 踢出成員（2026-10 小語裁示：社群與一般群組，網頁與 `/api/ws` 皆可）：`chat:membership:get { requestId, chatId }` 回本帳號在群組／社群的身分 `chat:membership { requestId, chatId, memberId, role? }`（群組：自己的 mid、無 `role`；社群：`getSquareChat.squareChatMember` 的成員 ID 與 `getSquareMember` 的 `admin`／`coAdmin`，一般成員省略；私聊／多人聊天室回 `MEMBERSHIP_UNSUPPORTED`，失敗回 `MEMBERSHIP_FAILED`），與歷史共用每連線每秒 10 次。`chat:member:remove { requestId, chatId, memberId, block? }`：群組只接受 `u` 開頭 mid、經 `deleteOtherFromChat`，`block` 回 `MEMBER_REMOVE_UNSUPPORTED`；社群只接受 `p` 開頭成員 ID、經 `updateSquareMember` 屬性 5 設 `KICK_OUT`（踢出）或 `BANNED`（踢出並封鎖），adapter 須先以 `getSquareMember` 確認對象的 `squareMid` 等於該聊天室所屬社群，否則不送出；永遠不接受本帳號自己；伺服器不自行判斷權限（LINE 為準），LINE 拒絕回 `MEMBER_REMOVE_FAILED`，成功回 `chat:member:removed { requestId, chatId, memberId, block }`，與 `message:send` 共用每連線每秒 5 次；機器人限 `api.chats`。網頁只在群組（任何成員）或自己是管理員／共同管理員的社群，於別人的訊息右鍵選單顯示「踢出」／「踢出並封鎖」，操作前必須確認。成功只記 `成員已移除：chat=… member=… block=…`。`BANNED` 對應「踢出並封鎖」尚未以真實帳號確認，不得宣稱已驗證。

記事本排查日誌（小語要求）：可能是記事本的即時訊息記 `LINE 記事本通知：…`（`contentType`、`serviceType`、`locKey`、`postEndUrl`、metadata 欄位名稱、摘要長度、是否辨識），hub 記略過原因、推送長度與 `NOTE_FETCH_FAILED` 原因（只限本服務代碼加 LINE 狀態碼與 80 字內 JSON 引號訊息，其他錯誤只記類別名稱）；未處理的 LINE operation 與社群事件只記類型，不記參數。記事本內文與摘要文字一律不入日誌。

社群加入大頭照：`profileImageObsHash` 為空不代表沒有照片（小語上傳頭像實測）。`chat:member-joined.member.pictureUrl` 有有效 hash 時沿用 hash 網址，否則以通過 `SQUARE_MEMBER_MID` 驗證的 ID 組成固定 `https://obs.line-scdn.net/r/g2/member/<memberId>` 路徑；已實際讀取回報成員的圖片。`pictureId` 可缺省，外掛應使用 `pictureUrl`；不為加入通知額外呼叫 `getSquareMember`，移除先前補查與臨時照片診斷。一般訊息的成員資料查詢不變。

社群記事本（小語實測）：社群張貼記事本不會產生聊天訊息，LINE 只在全帳號社群推播送 `NOTIFIED_UPDATE_SQUARE_NOTE_STATUS`（社群 ID、篇數、最新建立時間，沒有貼文 ID）。adapter 只在最新建立時間晚於登入或上次處理時間、且 `api.chats` 內有屬於該社群的聊天室（`getSquareChat` 查一次後記住）時，以 `base.timeline.listPost` 讀列表找新貼文（每次最多 5 篇、每篇只報一次、每社群同時一個檢查），再以 `getPost` 取全文，經 `onNotePosted` 由 hub 對該社群在 `api.chats` 內的每個聊天室推 `chat:note-posted`（沒有 `messageId`；列表讀不到時送不含 `postId` 的 `NOTE_FETCH_FAILED`）。刪除不推送，不得依篇數猜測內容。

內部日誌也不得包含憑證、token、QR URL、PIN 或 key material；不得直接 dump 套件錯誤物件、session 或登入 payload。圖片／貼圖／影片／語音位元組一律走 HTTP，WS 不傳位元組；收到的檔案只以 `file-<id>` 附件下載（`Content-Disposition: attachment`、`application/octet-stream`，不嗅探、不內嵌），規則同收到的媒體。訊息不落盤；每頻道最多 500 則，同 messageId 去重，編輯覆寫快取。LINE listen 失效採退避重啟；QR 失敗不自動循環，須由使用者動作重新產生。

版本更新（`src/update/`、`scripts/update.mjs`）：只通知、不自動下載或執行；檢查器僅匿名 GET 本專案 Release、只採 `X.Y.Z` tag、連結限本專案 `/releases/`、不轉送 Release 內文、不跟隨重新導向，失敗只記 `UPDATE_CHECK_FAILED`。不得新增網頁／WS 觸發更新的入口。`npm run update` 只 fast-forward 至 tag，工作樹不乾淨即中止。完整安全政策與回報流程見 [SECURITY.md](SECURITY.md)（英文）；變動其中任一硬規則須同步更新該檔。

其他 adapter 注意事項：OpenChat 歷史無「最新 N 則」查詢，只能由最舊事件向前走完再於記憶體分頁（快取 10 分鐘，期間以即時訊息與自己送出的訊息補上；LINE 監聽出錯即整個捨棄）；talk 歷史游標為 `deliveredTime:messageId` 且上界含端點，需多取一則並剔除錨點；非好友的群組成員名稱與大頭照以 `getContactsV2`／`getSquareMember` 補查（限時、限量、失敗退避），社群管理員角色同樣來自 `getSquareMember`；他人已讀位置來自 `getMessageReadRange` 與 `NOTIFIED_READ_MESSAGE`。**回報自己的已讀**（`sendChatChecked`／OpenChat `markAsRead`）會改變真實帳號狀態（對方看到「已讀」），因此只在小語要求下啟用：由網頁在聊天開啟且頁面可見時送 `chat:read`，伺服器只接受已顯示過的訊息、每個位置只送一次，並可用 `chat.sendReadReceipts: false` 關閉；驗證時不得對真實聯絡人的聊天室測試。已擁有貼圖包來自商店服務 `getOwnedProductSummaries`（linejs 3.4.2 未接線，經 `base.request.request` 呼叫 `/TSHOP4`），貼圖 id 與標題來自公開 CDN 的 `productInfo.meta`，失敗時退回 LINE 回傳的 id 區間。即時事件依聊天室各自排序處理：一個聊天室的成員查詢變慢不會拖住其他聊天室；好友資料以每批 100 人、最多 3 批同時查詢。

E2EE 文字發送：linejs 3.4.2 被要求 E2EE 時的自動重試只把 `text` 加密，`MENTION` 等 metadata 只留在明文。`decryptE2EEMessage` 會把解密內容的其他欄位併回 metadata，由此推斷 LINE App 從加密內容讀取標記（尚未以真實帳號實測）。因此 adapter 以 `e2ee: false` 先送明文，被拒才自行用 `encryptE2EEMessage(to, { ...metadata, text })` 加密後送出（明文 metadata 照舊保留）；不得改回交給 linejs 重試。

E2EE 群組金鑰（issue #2）：linejs 3.5.0 在 LINE 回 `NOT_FOUND`（成員變動後新世代尚未發到本裝置）時，會以 `tryRegisterE2EEGroupKey` 自行註冊群組金鑰，連解密路徑也會觸發；這可能與官方 App 建立的世代並存，使該群之後全面無法解密。adapter 於 `activate` 將其改為一律失敗（傳送失敗、訊息顯示佔位），不得恢復自行註冊。linejs 即時事件在解密失敗時會靜默丟棄訊息，adapter 包裝 `decryptE2EEMessage`，失敗時回傳原密文並標記為無法解密，讓即時訊息同樣 fail-closed 顯示佔位。

LINE operation 與連線注意事項：linejs 未記載多數 operation 的參數排列，`SEND_CHAT_CHECKED`（手機已讀）只取 `param1` 且須為伺服器已知聊天室；群組／個人資料／聊天室成員變動不解析參數，只觸發節流的頻道清單重新整理（3 秒合併、最多每 30 秒一次），不得改成依參數猜測內容。頻道清單的最後一則訊息（`Channel.lastMessage`）是預覽，不登記媒體來源，不能藉此下載。WS 心跳：伺服器以協定層 Ping 每 30 秒檢查、兩輪無回應即關閉；網頁 `ping` 需 10 秒內收到 `pong`，回到前景立即探測。斷線記錄（網頁主控台、服務日誌 `WS_CLOSED`）只可含時間、close code、截短的 reason 與前後景狀態，不得含標頭、cookie 或 Token。

PWA 注意事項：`web/public/sw.js` 只可快取公開靜態檔（`/`、`/assets/*`、`/icons/*`、manifest、favicon）；`/media/*`、`/ws` 與非 GET 請求絕不經手，避免私人內容在登出後殘留於 Cache Storage。新增靜態副檔名須同步 `src/http/server.ts` 的 mime 表。未讀數以 LINE 的 `unreadCount` 為準（talk `getMessageBoxes`、社群 `getSquareChatStatus`，盡力而為），連線時的訊息快照（`messages` 影格）不計未讀。

## 文件維護

README 描述目前可執行的指令與驗證限制；未實作的契約須明示狀態。README 以三種語言維護：`README.md`（繁體中文，正本）、`README.en.md`（English）、`README.ja.md`（日本語），三份章節結構與內容必須同步，修改其中一份須同步其餘兩份，且頂端的語言切換連結要保留。CLAUDE 僅引用本檔，不複製規範。PLAN 保留企劃全文，裁示變更需同步更新，不把假設寫成實測結果。
