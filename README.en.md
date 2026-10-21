[繁體中文](README.md) ｜ **English** ｜ [日本語](README.ja.md)

# LINE.js

A local TypeScript LINE web client that connects to LINE using the pinned [@evex/linejs v3.5.0](https://jsr.io/@evex/linejs/3.5.0), synchronizes channels and messages over WebSocket, and serves the web interface over HTTP on the same port.

> Development status: QR login/logout, session reuse, channel lists (friends and chats tabs, profile pictures), live and historical messages, sending text/images/videos/stickers (including pasting images or videos and selecting stickers from owned packs), inline display of received images/GIFs/videos/voice messages, others' read receipts, sending read receipts and unread counts, OpenChat administrator badges, links in messages, system messages (such as 「XX 新增 OO 至群組」 (XX added OO to the group)), a full-screen disconnection overlay, a mobile hamburger menu, the bot API (`/api/ws`), the terminal interface (CLI), and version update notifications are available. Gate 1 acceptance using a secondary account to scan the QR code still awaits confirmation from 小語.

## Agreed purpose and scope

The complete goal includes QR login/logout, session reuse, lists of friends/groups/chat rooms/OpenChat, live messages and edit events, paginated history, sending text/images/stickers, and displaying images/GIFs/videos/voice messages/stickers, and downloading files; an optional scam-probability check of other people's text messages uses TypeSafe Jev. Public deployment, multiple accounts, calls, and package publishing are out of scope; features not yet delivered are subject to their Gate status.

This project uses unofficial LINE APIs and may cause account restrictions or bans. **Verify with a secondary account first**; do not test directly with your main account.

**Quick navigation**: [Installation and startup](#installation-and-startup)｜[Management scripts](#management-scripts)｜[Configuration](#configuration)｜[Bot API](#bot-apiapiws)｜[Terminal interface (CLI)](#terminal-interface-cli)｜[Version updates](#version-updates)｜[Security policy](SECURITY.md)

## Target system architecture (including later Gates)

```mermaid
flowchart LR
    LINE[LINE service] <--> Provider[LineProvider adapter\n@evex/linejs 3.5.0]
    Provider <--> Backend[Node TypeScript backend\nsession and in-memory cache]
    Backend <-->|WebSocket messages and channels| Browser[Vite / vanilla TypeScript web interface]
    Backend <-->|Same-port HTTP static pages and media| Browser
```

The backend binds only to `127.0.0.1` by default (configurable in `config.yaml`; see “Configuration”), on port `3789` by default. The backend builds with `tsc` into `dist/`; the frontend builds with Vite into `dist/web/`. Messages are stored only in memory (up to 500 per channel, deduplicated by id, with edits overwriting existing messages), without a database. Stickers, profile pictures, and received media are cached by the backend in an LRU cache (200MB by default) and served over HTTP on the same port.

The OpenChat adapter additionally keeps a 10-minute in-memory history cache, bounded to 5 chats with 5000 messages each. Concurrent queries for one chat share one history walk, pagination anchors use message time and id, and live messages, take-backs, and reactions are merged. An expired cache reloads reaction state; media downloads are authorized only after the message's page has been delivered. Logging out or changing accounts invalidates pending queries so old-account results cannot enter the next account.

## Requirements

- Node.js **≥ 22** and npm.
- Network access to JSR, npm, and LINE.
- A secondary LINE account that can scan a QR code and confirm a PIN.
- Both `@evex/linejs` and `@evex/linejs-types` are pinned to **3.5.0** (JSR; this upgrade was explicitly authorized by the user); all other direct dependencies must also have pinned versions.

Previously, upstream 3.4.2's Thrift dependency contained a high-severity vulnerability. This project pins the patched `thrift@0.23.0` through `overrides` and retains that override after upgrading to 3.5.0. Patch reference: [CVE-2026-41636](https://github.com/advisories/GHSA-r67j-r569-jrwp). Previous real-account verification of login reuse, channel lists, and live messages applied to 3.4.2, **not to a real LINE Gate for 3.5.0**; this upgrade has not been verified with a real LINE account.

## Installation and startup

```sh
git clone https://github.com/JS-PACKAGE/LINE.js.git
cd LINE.js
npm install
npm run build
npm start
```

You can also use the root-level [management scripts](#management-scripts) to handle everything: `./linejs.sh start` (Windows: `.\linejs.ps1 start`) automatically installs missing dependencies or builds missing output before starting.

Open `http://127.0.0.1:3789`. If `session.json` can be reused, you enter the chat interface directly; otherwise, click 「產生登入 QR code」 (Generate login QR code), scan with a secondary account, and confirm the displayed PIN. The QR URL and PIN are sent only once over WebSocket to the connection that clicked the button; they are not logged or written to files, and refreshing does not replay them. Failures do not trigger automatic retries; click the button again. The left side has 「聊天」 (Chats) and 「好友」 (Friends) tabs, including profile pictures and unread counts. The Chats tab is ordered by recent activity; each row shows the last message (prefixed with the sender's name in groups and OpenChat) and its time (the clock today, 「昨天」 (yesterday), otherwise the date), taken from LINE's chat summaries on load and then kept current by live messages, edits and take-backs. Messages appear on the right: consecutive messages from the same person share a profile picture and name (full names do not wrap; OpenChat administrators have a crown badge and co-administrators a shield badge), timestamps appear after messages in 24-hour format, with a date separator above each day's messages (今天/昨天 (today/yesterday) or the date, with the year when it differs), and scrolling upward loads older history. When you scroll away from the newest message, a 「↓ 最新訊息」 (↓ Latest) button appears at the bottom right (it becomes 「↓ N 則新訊息」 (↓ N new messages) when others' messages arrive meanwhile; click to return to the bottom). Your own messages display 「已讀」 (Seen) above the timestamp in 1:1 chats, or 「已讀 N」 (Seen by N) in groups and chat rooms; OpenChat has no read receipts. Opening a chat with unread messages shows an unread separator. You can send text (Enter to send, Shift+Enter for a new line), images (click 「媒體」 (Media) to pick several at once, or **paste/drag** multiple images/videos into the input field; they preview first and, on 送出 (Send), upload one at a time with a 「第 n/N 個」 (item n/N) and upload-percentage indicator, and any draft text is sent after the whole selection; PNG/JPEG/GIF images and MP4/MOV videos only), and stickers (the 「貼圖」 (Stickers) panel lists packs owned by this account; click a sticker to send it, or send manually by ID). Received images/GIFs display directly (click to enlarge), videos load only when you press play, and voice messages can be played directly, and message search (searches only loaded messages: type a keyword in 「搜尋」 (Search) in the header, or press Ctrl/⌘+K; matches are highlighted, and clicking a result jumps to that message and opens its chat). Locations, contacts, files and rich (flex) cards are shown as small cards with the text LINE attaches (place name, address and an 「在地圖上開啟」 (Open in map) link; contact name; file name, size and a 「下載」 (Download) link; the card's alternative text). Files are always served as attachments (`Content-Disposition: attachment`, `application/octet-stream`; the browser never opens or runs them in this page), only for file messages this service has received, never after a take-back, and E2EE OpenChat files cannot be downloaded. Calls and other types show type placeholders only. **Sending read receipts**: when the chat is open and the page is visible, the client reports to LINE that messages up to the latest one have been read (the other person sees 「已讀」 (Seen)); disable this with `chat.sendReadReceipts: false`. Clicking 「登出」 (Log out) at the top right opens a confirmation dialog; confirming revokes the LINE-side login and clears `session.json` and the cache.

**Other web behavior**:
- **Links**: `http://` and `https://` URLs in message text become clickable links that open in a new tab (with `rel="noopener noreferrer"`, so the destination cannot access this page and receives no Referer). Trailing punctuation and extra closing parentheses are excluded from URLs; other protocols (such as `ftp://`) are not linked. The server does not fetch any URLs, and there are no link preview cards (deliberately: CSP and CORS prevent browser-side access, while server-side fetching risks SSRF and IP disclosure).
- **LINE emoji**: LINE emoji in received messages are shown as small pictures inside the text; a message made of LINE emoji alone shows them large. The server fetches the pictures from LINE's public CDN (the browser never contacts LINE directly) and shows only the static image; when one cannot be fetched, the original stand-in text stays. The web page cannot send LINE emoji yet (regular emoji can be typed as usual).
- **Member counts**: groups, multi-person chats and OpenChats show their current number of members in the chat header (and in the chat list when there is no latest message), e.g. 「社群 · 345 人」 (OpenChat · 345 people). The count comes from what LINE returns when the chat list loads (for an OpenChat, that chat's member count; nothing is shown when it is unavailable); group membership changes trigger a list refresh that updates it, while OpenChat counts update the next time the chat list is refreshed.
- **System messages**: LINE membership events (`CHATEVENT`, currently supporting `C_MI`) display as small, centered gray pills, such as 「XX 新增 OO 至群組」 (XX added OO to the group). Other event types whose meanings have not been confirmed always display the placeholder 「［系統訊息］」 ([System message]); their content is not guessed.
- **Take-backs**: when someone (or you, on another device) takes a message back, it becomes 「XX 已收回訊息」 (XX took back a message; your own read 「你已收回訊息」), replies quoting it show 「［已收回的訊息］」 ([Message taken back]), and its picture/video/voice/file is no longer served. If the take-back notice arrives before the message itself, only the placeholder is shown. Only message ids this service has already received are affected; nothing is guessed from the notice. Your own messages can be taken back with 「收回」 (Take back) in the context menu (after a confirmation; LINE only allows this for a limited time after sending, and a refusal shows a generic error). In OpenChat, the service recognizes your member id there only after you have sent a message from this page.
- **Reactions**: below a message, counts of LINE's six predefined reactions (👍 Nice, ❤️ Love, 😆 Fun, 😲 Amazing, 😢 Sad, 😱 OMG) are shown, with yours highlighted; send one with 「回應…」 (React…) in the context menu or by clicking a chip, and click your own choice again to take it back (the other side sees it; shares the send rate limit). Talk-chat reactions arrive with messages and history; LINE's live reaction notice has an unverified layout, so new reactions from others appear after history is loaded again. OpenChat has a live status event (`NOTIFIED_UPDATE_MESSAGE_STATUS`) that updates them immediately. LINE's newer custom reactions are not shown.
- **@ mentions**: typing `@` in the message box of a group, room or OpenChat lists the people who have spoken in that chat (most recent first); keep typing to filter, ↑／↓ to choose, Enter or Tab to confirm, Esc to close (Enter that confirms an input-method candidate picks nothing). Clicking a sender's name or 「@ 提及」 (@ Mention) in the context menu also works. Only names added from the list or a name click, whose `@name` is still whole in the text, become real tags; an `@name` typed by hand is just text. In end-to-end encrypted chats the tag data also goes inside the encrypted payload, not only in plain metadata (how the LINE apps show it has not yet been confirmed with a real account). Names tagged in received messages are shown in the accent color; a tag of you, or @All, also gets a yellow background. Ranges come from LINE's mention data; anything that does not fit (beyond the text, overlapping) is not highlighted. In OpenChat your member id differs from your account, so tags of you there only get the ordinary accent color.
- **Scam probability check** (requires `jev.token`; see [Configuration](#configuration)): right-click (or long-press) a **text message from someone else** and choose 「詐騙機率分析」 (Scam probability check). A dialog shows the scam probability and a reading (> 80% very likely a scam, ≤ 20% unlikely, anything between is uncertain, check carefully). Above 20% it also lists the closest scam kind with its confidence (fake investment／stock-tip groups, impersonating an agency／bank／customer service, phishing links, online shopping／"cancel installments", impersonating friends or family to borrow money, romance, jobs／renting out accounts, prizes, loans, other). The option is not offered for your own messages, taken-back, undecryptable, system or non-text messages, and the menu item is absent when no key is set. Every check sends that one text to TypeSafe and is billed; the result is only a model estimate.
- **Desktop notifications**: clicking 「通知」 (Notifications) at the top right asks the browser for permission and turns them on (the button switches to the accent color; the choice is kept in the browser's localStorage; click again to turn off). Only new messages from others are notified, and only while the page is not in the foreground; each chat shows at most one notification, replaced by its newest message; clicking it returns to the page with that chat open, and it closes once the chat is read. The notification content (sender and message preview) appears in the operating system's notification center. A secure context is required (`127.0.0.1`/`localhost` or HTTPS); on other http addresses the button is hidden.
- **Drafts**: when you switch chats, unsent text (including @ mentions and the reply target) stays with its chat and comes back when you return. Drafts live only in page memory and are cleared by reloading or logging out. A staged picture or video is not kept.
- **Message search and retention**: searches currently retained messages, newest first. Counts and matches are complete, but only visible rows plus overscan have DOM. Arrow keys, Home/End and Enter/Space navigate results. The frontend retains at most 500 messages per chat and 10,000 overall, evicting least-recently-used non-current chats when needed; the UI shows limits, retained counts and evictions. A contiguous history window moves upward so older messages remain reachable. 「最新訊息」 (Latest), or leaving a historical window and reopening the chat, fetches the latest page. Reply jumps and mention candidates cover retained messages only. Search neither fetches history nor sends read receipts; ordinary chats acknowledge only while the page is visible, at the bottom of the latest window with the newest message visible.
- **History retry and reaction updates**: the first failed history load offers a retry button. Reaction updates replace only the reaction chips without recreating images, videos, or voice messages.
- **Logout cleanup**: clears search, chat contents, profile information, the image viewer, dialogs, and the account's desktop notifications, while preserving notification preferences.
- **Disconnection overlay and heartbeat**: if the WebSocket connection to the local service is interrupted, 「與伺服器斷線」 (Disconnected from the server) covers the entire screen. It disappears automatically on reconnection, and messages are resynchronized (the complete snapshot is sent in batches per chat and merged for rendering). The page sends a `ping` every 30 seconds and gives up on the connection (and reconnects) if no `pong` arrives within 10 seconds; when the page returns to the foreground it probes at once and skips any reconnect backoff (browsers throttle timers in background tabs). The server additionally checks with WebSocket protocol-level Pings every 30 seconds and closes connections that miss two rounds. Disconnects are recorded: the browser console prints `LINE.js 連線中斷` (time, close code/reason or 「no pong」, seconds connected, foreground/background, online state) and the service log prints `WS_CLOSED page|bot code=… after=…s` (`heartbeat-timeout` for heartbeat failures), without headers, cookies or Tokens.
- **Keyboard**: in the chat list, ↑/↓ move between rows, Home/End jump to the ends, and Enter or Space opens a chat; ↓ in the search box above the list moves into it, and ↑ on the first row returns to the search box. Ctrl/⌘+K opens message search (the browser's own Ctrl/⌘+F is untouched).
- **Mobile layout**: at window widths ≤ 720px, the chat and friends lists move into a left drawer, opened with the 「☰」 hamburger button at the top left of the conversation header (click the backdrop or press Esc to close; selecting a chat closes it automatically). The drawer opens by default if no chat is selected. The desktop layout is unchanged.

The app can be installed as a PWA (the browser's 「安裝」 (Install) action; favicon and manifest included). The service worker caches only public static files, never `/media/*` or `/ws`; pages always use a network-first strategy. The web interface disables the browser's native context menu except in input fields, replacing it with a message menu (you can take back your own messages there; touch long-press works too. Right-clicking a chat in the list shows and copies its channel ID, and right-clicking your own name at the top left shows and copies your own ID); this is a convenience, not a security mechanism. Unread counts in the chat list come from LINE and are cleared after opening a chat and sending a read receipt; reading a chat on another device such as your phone (LINE's `SEND_CHAT_CHECKED`) also clears it at once. When a group is renamed or changes its picture, members join or leave, or a friend changes name or profile picture, the service fetches the channel list from LINE again (once per burst of changes, and at most once every 30 seconds).

Right-click a chat message (long-press on touch screens) and choose 「顯示寄件者 ID」 to view and copy another person's ID. Bots read `message.senderId` in live `message`/`message:edit` frames, or `messages[].senderId` in `history`, still restricted to `api.chats`. OpenChat returns the OpenChat member ID, not the ordinary LINE account ID; this feature does not look up members who have not appeared in messages.

`session.json` contains credentials and E2EE key material. It must be saved with permissions `600` and must not be shared or committed. `config.yaml` contains personal configuration and is excluded from version control. `api-token.json` (the bot Token's SHA-256 and creation time, permissions `600`) and `linejs.pid` (the running service's PID, used by `stop`/`restart`) are also excluded from version control.

SessionStorage in `src/line/session.ts` follows the linejs FileStorage contract, but saves data through serialized writes, temporary files with permissions `600`, and atomic replacement to prevent concurrent writes from losing tokens/keys. Existing files have their permissions tightened. Corrupt JSON and symlinks are refused without overwriting the original data. A write failure causes subsequent `flush()` calls to fail rather than falsely claiming the session was saved.

### Gate 1 acceptance

1. Start the process, scan the QR code in the web interface with a **secondary LINE account**, and complete PIN confirmation. The web interface should enter the chat interface automatically.
2. Send a message from LINE on your phone. Within 60 seconds, the terminal should show `LINE 訊息收到：id=… type=… kind=…` (LINE message received: id=… type=… kind=…), and the chat should display the message and unread count in real time. Only identifiers are logged, not message contents.
3. Stop the service and run `npm start` again. Confirm that the session is reused directly without rescanning, and that `session.json` still has permissions `600`.

## Configuration

`config.example.yaml` includes item-by-item comments in Traditional Chinese. On first startup, if `config.yaml` is missing, it is created automatically without overwriting an existing file; personal configuration takes precedence when present. Fields are grouped into `server`, `line`, `history`, `cache`, `chat`, `update`, `api`, `jev`, and `limits` (the `chat`, `update`, `api`, and `jev` sections, plus `limits.downloadMaxBytes` and `limits.uploadVideoMaxBytes`, may be omitted; older configuration files still work; `api` and `jev` are disabled by default).

- Listening host: defaults to the recommended `127.0.0.1`. `config.yaml` is authoritative; other hostnames, IPv4, or IPv6 addresses are allowed, and the program no longer enforces loopback. The web interface has no username/password, so anyone who can reach that address can operate the logged-in LINE account. A warning is printed on startup for non-local addresses. **The `Host` header is not restricted**: regardless of the listening address, connections using any IP or domain name are accepted (for example, reverse proxies, LAN names, or tunnel services). `Origin`, cookie, and Token checks remain unchanged, and requests with `Sec-Fetch-Site: cross-site` are still rejected. The tradeoff is that DNS rebinding is no longer prevented (when an attacker's domain resolves to a local address, that page is same-origin with the service).
- port: defaults to `3789` and is configurable; host and port are read from `config.yaml` and must not be hardcoded.
- LINE device: defaults to `ANDROIDSECONDARY`.
- History page size: 50 by default, at most 100 per request.
- Per-channel message cache: up to 500 messages; media LRU cache: 200MB by default.
- Client-to-server WS frame: at most 256KB; text: at most 8000 characters.
- Sending: at most 5 sends per second per WS connection. Media uploads: at most 10MB per image (PNG/JPEG/GIF), at most 50MB per video (MP4/MOV; configurable with `limits.uploadVideoMaxBytes`, capped at 200MB; the entire video is temporarily held in memory), and at most 5 uploads per minute per connection.
- Received media and files: at most 50MB each (`limits.downloadMaxBytes`); larger items show only a type label (a file download fails).
- Media download scheduling: at most 4 actual upstream requests and 64 FIFO waiters globally; identical IDs share work. A full queue returns the existing HTTP 404 and can be retried later. Take-back/logout cancels waiters and rejects old results; started work retains its slot until the upstream settles, without pretending the download was aborted.
- Bot API: disabled by default; `api.enabled`, `api.chats` (required, at least one chat room id), and `api.sendsPerMinute` (20 by default, ≤120). See [Bot API](#bot-apiapiws) for details.
- Scam check (optional): put a [TypeSafe](https://console.typesafe.ai/keys) API key in `jev.token` and restart; right-clicking (long-pressing on touch screens) **a text message from someone else** in the web interface then offers 「詐騙機率分析」 (Scam probability check), which uses TypeSafe's Jev decision model to estimate the probability that it is a scam (> 80% likely, ≤ 20% unlikely, uncertain in between) and the kind of scam it most resembles. When a new analysis is needed, only that one message's text is sent to `api.typesafe.ai` (the server uses its own cached copy, never text supplied by the page; no sender or chat information). Actual upstream requests are billed by TypeSafe, and each web connection may run at most 10 checks per minute. Bots can also check messages in `api.chats` with `scam:check` on the [Bot API](#bot-apiapiws) (at most 10 per minute across all bots). The key stays on the server: it is never sent to the page or logged. `jev.model` defaults to the pinned `jev-1.13.0`. The result is a model estimate for reference only. Leave `token` empty or omit it to disable the feature.
- Faster analysis: within one signed-in session, concurrent web/API checks of **exactly identical text** share one upstream request. Successful results remain valid for 5 minutes from completion; repeat checks return directly without sending the text again. The memory-only LRU holds at most 256 entries, including pending requests, indexed by text hashes without an extra plaintext copy or disk persistence. Failures are not cached; logout/account changes clear it. Message eligibility, chat permissions and existing rate limits still apply to every check. If the text changes, is withdrawn or leaves the message cache while waiting, the request returns `INVALID_REQUEST`, not an outdated result. The model, questions and full text are unchanged; first-time analysis of new content still depends on Jev/network latency, with no real-upstream latency guarantee.

## Protocol

Same-port `ws://<host>:<port>/ws` (default `ws://127.0.0.1:3789/ws`; the web interface automatically uses `wss://` behind a TLS reverse proxy or with a custom domain), with JSON frames. The client-to-server frame limit is set by `limits.frameMaxBytes` (≤256KB). An upgrade requires all of the following: path `/ws`, the host in `Origin` (`http` or `https`) matching `Host`, and the HttpOnly/SameSite=Strict browser cookie issued by the homepage; otherwise it returns 403. Reverse proxies must forward WebSocket upgrade headers and preserve the original `Host` (nginx: `proxy_set_header Host $host;`, `proxy_set_header Upgrade $http_upgrade;`, `proxy_set_header Connection "upgrade";`). See [section 4 of PLAN.md](PLAN.md) for complete payloads (PLAN.md is in Chinese).

Available:

| Direction | type | Purpose |
|---|---|---|
| Server → Client | `hello` | Protocol version 2 and server version; on receipt, the frontend clears its local cache and waits for a full snapshot |
| Server → Client | `auth:state` | `restoring`／`idle`／`authenticating`／`ready`／`error` |
| Server → Client | `auth:qr` / `auth:pin` | One-time delivery, only to the connection that initiated `auth:start` |
| Server → Client | `auth:ready` | Login completion and account data; a snapshot (`channels`, plus `messages` frames batched per chat) is sent on connection |
| Server → Client | `channels` | Channel snapshot; resent when channels are added or refreshed. Channels carry `lastMessage` (the last message, used as the list preview) and `lastMessageAt` |
| Server → Client | `channel` | `{ channel }`: one channel changed (a new message, edit or take-back changed its preview, or a read cleared its unread count); pages only |
| Server → Client | `chat:checked` | `{ chatId }`: this account read the chat on another device (the phone); the page clears its unread count; pages only |
| Server → Client | `messages` | Connect-time snapshot: `{ chatId, messages }`; a chat may span multiple frames, merged by ID (old messages, never counted as unread) |
| Server → Client | `message` / `message:edit` | Live messages and overwrites of existing messages |
| Server → Client | `message:unsend` | `{ chatId, messageId }`: the message was taken back; show a placeholder (`Message.unsent: true`, no content) |
| Server → Client | `message:reactions` | `{ chatId, messageId, reactions? }`: the message's reactions changed (`{ counts, mine? }`; omitted means nobody reacts). Pages only |
| Server → Client | `status` / `error` | LINE listener status and generic errors |
| Server → Client | `history` / `sent` | One history page (including `cursor`)/send confirmation |
| Server → Client | `read` | Others' read positions (snapshot when opening a chat and live increments) |
| Client → Server | `auth:start` / `auth:logout` | Start QR login/log out |
| Client → Server | `history:fetch` / `message:send` | Load one history page/send text, images (first `POST /media/upload`), or stickers |
| Client → Server | `stickers:list` → `stickers` | Retrieve sticker packs owned by this account and sticker ids |
| Client → Server | `profile:get` → `profile` | `{ requestId }`: get your own `profile` (`userId`, `displayName`, `pictureId?`, the same as in `auth:ready`); reads only what the server got at sign-in, with no LINE request; returns `INVALID_REQUEST` when not signed in |
| Client → Server | `chat:admin-token:get` → `chat:admin-token` | `{ requestId, chatId }`: retrieve this chat's single-use administrator token; only the requester receives `{ requestId, chatId, token, createdAt }` |
| Server → Client | `chat:admin-token:changed` | `{ chatId }`: pages-only invalidation without plaintext; an open token dialog fetches the replacement |
| Client → Server | `message:unsend` | `{ requestId, chatId, messageId }`: take back one of your own messages (pages only; the server accepts only this account's messages and shares the `message:send` rate limit); success is broadcast as `message:unsend` |
| Client → Server | `message:react` | `{ requestId, chatId, messageId, reaction }`: `NICE`/`LOVE`/`FUN`/`AMAZING`/`SAD`/`OMG`, or `null` to take it back (pages only; only for messages the server has shown that were not taken back; shares the `message:send` rate limit); success is broadcast as `message:reactions` |
| Client → Server | `chat:read` | Report messages read through a specific message (no response; only messages already displayed by the server, once per position) |
| Client → Server | `message:send` (`mentions`／`replyTo`) | Text may include @ mentions and a reply target (message context menu: 「回覆」 (Reply), 「@ 提及」 (@ Mention), 「複製文字」 (Copy text); images also offer 「複製圖片」 (Copy image) and 「下載圖片」 (Download image), videos 「下載影片」 (Download video)) |
| Client → Server | `channels:refresh` / `ping` → `pong` | Reload channels/keep the connection alive (the server answers `pong`, which the page uses to tell the connection still works) |
| Server → Client | `api:state` / `api:token` | Bot API state (web interface only)/newly generated Token (sent only once to the requesting connection) |
| Client → Server | `api:token:create` / `api:token:revoke` | Generate or revoke a bot Token (web connections only, not bots) |
| Server → Client | `scam:state` / `scam:result` | Whether a Jev key is configured (pages only, sent on connection)/the result `{ requestId, chatId, messageId, analysis: { probability, tactic? } }` (only to the requesting connection) |
| Client → Server | `scam:check` | `{ requestId, chatId, messageId }`: check a text message from someone else that the server has shown and that was not taken back (10 per minute per web connection; for bots see [Bot API](#bot-apiapiws); without a key it returns `SCAM_CHECK_UNAVAILABLE`, failures return the generic `SCAM_CHECK_FAILED`) |

HTTP: both `GET /media/:mediaId` (stickers, sticker pack icons, profile pictures and originals, received images/videos/voice messages; supports Range) and `POST /media/upload` (image/video uploads) require a browser cookie and same-origin access. WS does not carry media bytes.

### Bot API（`/api/ws`）

Lets your own programs (bots) send and receive messages. **Disabled by default**; enabling it takes three steps:

1. Add the following to `config.yaml` and **restart the service** (see `config.example.yaml` for the template):
   ```yaml
   api:
     enabled: true
     chats:                      # Chat room ids accessible to bots, at least one; unlisted chats are treated as nonexistent for bots
       - c0123456789abcdef0123456789abcdef
     sendsPerMinute: 20          # Maximum total sends per minute across all bots (1～120, optional, default 20)
   ```
   If `enabled: true` has no valid `chats`, service startup fails outright (to avoid treating “an empty list” as “all chats”).
2. Generate the API **connection Bearer Token** with `npm run cli -- token` (see [CLI `token`](#token-regenerate-or-revoke-the-bot-api-token)). It is shown **once**; the server stores only its SHA-256 (`api-token.json`, permissions 600, excluded from version control). It cannot be viewed again; generate a new one if lost. Only the CLI manages this connection token; it is distinct from the per-chat administrator tokens below.
3. Connect your bot to `ws://<host>:<port>/api/ws` (default `ws://127.0.0.1:3789/api/ws`) with the header `Authorization: Bearer <Token>`.

**Connection rules**
- An upgrade requires all of the following: `api.enabled`, **no `Origin` header** (browser WebSockets always include it, so no web page can use this endpoint, even if a Token leaks to a page), and a valid Token (compared in constant time). Every failure returns 403 without revealing which check failed. At most 4 connections are allowed simultaneously; additional connections receive 429.
- Replacing or revoking the Token **immediately** disconnects all bots (close code 1008); the old Token is no longer valid.

**Allowed operations (frame allowlist)**

| Direction | type | Description |
|---|---|---|
| Bot → Service | `message:send` | `{ requestId, chatId, text, mentions?, replyTo? }`: **text only**; `mediaId`／`sticker` returns `INVALID_REQUEST`. Success returns `sent { requestId, messageId }` |
| Bot → Service | `history:fetch` | `{ requestId, chatId, limit?, before? }`: the same pagination as the web interface, without a read-receipt snapshot |
| Bot → Service | `scam:check` | `{ requestId, chatId, messageId }`: check with Jev a text message **from someone else** in `api.chats` that the service has shown (received live or returned by `history:fetch`); the server sends its own cached text. Requires `jev.token` (otherwise `SCAM_CHECK_UNAVAILABLE`); 10 per minute across all bots, including cache hits. Only actual upstream requests are billed by TypeSafe. Success returns `scam:result { requestId, chatId, messageId, analysis: { probability, tactic? } }` |
| Bot → Service | `profile:get` | `{ requestId }`: get your own ID and name at any time; returns `profile { requestId, profile: { userId, displayName, pictureId? } }` (the same as `auth:ready`; no LINE request; shares the 10-per-second-per-connection budget with `history:fetch`; returns `INVALID_REQUEST` when not signed in) |
| Bot → Service | `chat:admins:get` | `{ requestId, chatId }`: list all current administrators and co-administrators in the specified OpenChat room, including members who have not spoken. Restricted to `api.chats`; shares the 10-per-second-per-connection budget with `history:fetch`/`profile:get`. Only the requester receives `chat:admins { requestId, chatId, ownMemberId, admins: [{ userId, displayName, role, pictureId? }] }`; `role` is `admin`/`coAdmin`, `displayName` is a string, and both `ownMemberId` (your membership ID in that chat) and `userId` match `/^p[A-Za-z0-9]{10,64}$/`. Ordinary groups/private chats return `CHAT_ADMINS_UNSUPPORTED`; signed-out, unknown or unauthorized chats return `UNKNOWN_CHAT`. LINE lookup failures, invalid IDs or incomplete pagination return `CHAT_ADMINS_FAILED`, never a partial list. Not available on browser `/ws` |
| Bot → Service | `chat:admin-token:get` | `{ requestId, chatId }`: retrieve the plaintext token for a known chat in `api.chats`; returns `chat:admin-token { requestId, chatId, token, createdAt }` |
| Bot → Service | `chat:admin-token:consume` | `{ requestId, chatId, token }`: immediately invalidate and replace a successfully redeemed token; returns `chat:admin-token:consumed { requestId, chatId }` (without the next value); the replacement is then pushed to every connected plugin |
| Bot → Service | `ping` → `pong` | Keepalive; the service also checks with WebSocket protocol-level Pings every 30 seconds and disconnects after two missed rounds (ordinary WebSocket libraries answer automatically) |
| Service → Bot | `hello`, `auth:state`, `status` | Sent on connection; `hello` retains numeric `protocol: 2` and `serverVersion`, advertising extensions with `capabilities: ["chat:admins", "chat:admin-token"]`. Sending/receiving is unavailable until `auth:state` is `ready` (LINE is logged in) |
| Service → Bot | `auth:ready` | Includes your own `profile.userId` to skip your messages in ordinary chats; for OpenChat, use `ownMemberId` from the `chat:admins` response instead |
| Service → Bot | `channels` | Only chat rooms in `api.chats`; resent on changes |
| Service → Bot | `chat:admin-token` | **Pushed** (no `requestId`) `{ chatId, token, createdAt }`: on connection, after login, on chat-list refresh and after every successful redemption, connected plugins receive the current token of each known chat in `api.chats` |
| Service → Bot | `chat:admin-token:changed` | `{ chatId }`: an `api.chats` chat left the server's list and its token was invalidated; no plaintext. On logout, `auth:state` other than `ready` invalidates all tokens |
| Service → Bot | `message`, `message:edit`, `message:unsend` | Only **live** messages, edits and take-backs from chat rooms in `api.chats`, including your own |
| Service → Bot | `sent`, `history`, `scam:result`, `profile`, `chat:admins`, `error` | Responses to corresponding requests; errors contain only generic codes (`UNKNOWN_CHAT`, `INVALID_REQUEST`, `RATE_LIMITED`, `SEND_FAILED`, `SCAM_CHECK_FAILED`, `CHAT_ADMINS_UNSUPPORTED`, `CHAT_ADMINS_FAILED`…) |

Everything else returns `UNKNOWN_TYPE`: no login/logout, `chat:read` (sending read receipts), `message:unsend` (taking back), `message:react` (reactions), `channels:refresh`, sticker lists, or API connection Bearer Token management. **Old messages are not replayed** (bots start from “now” and do not respond to history again; use `history:fetch` for history). No `read`, `update:available`, `api:state`, or `scam:state` is provided. Image/video and other media bytes are also inaccessible (bots see only the message's `contentType`).

**Administrator mention permission**: after a successful lookup, the same connection may use `message:send.mentions` in the same chat to tag returned administrators who have not spoken. Entries remain `{ userId, start, end }` (UTF-16 string offsets covering text starting with `@`), at most 20 per message. This extra permission is not shared with other connections, chats or web pages. A new lookup immediately revokes the old permission (including rate-limited or subsequently failed requests); only the latest successful query grants a new list, and superseded concurrent queries return `CHAT_ADMINS_FAILED`. Disconnect, logout or account changes clear permission and invalidate pending results. Senders of displayed messages remain mentionable under the existing rules. The old `chat:admins` **request** is no longer accepted (`UNKNOWN_TYPE`); the name is retained only for responses.

Isolated LINE responses and real HTTP/WS Token authentication verified the handshake, complete pagination, own membership ID and mention permission/revocation. No live LINE account or running NekoGuard integration has been tested; this does not establish a Gate pass.

**Single-use per-chat administrator tokens**: open a chat and click 「管理員權杖」 next to 「搜尋」 (Search) in the header to view, copy, or fetch the current token again. Each chat is independent; the first query creates a token from 32 cryptographically random bytes (`chatadm_` prefix plus base64url). `createdAt` is Unix milliseconds. Reading/refreshing does not consume or rotate it. Tokens live only in memory, never logs or browser storage; logout, account changes, service restart, or removal from the server's chat list invalidates them.

- **Both WEB and authenticated API clients may retrieve plaintext** (owner decision). Plugins **receive pushes over `/api/ws` without asking** and may also query with `chat:admin-token:get`, both limited to `api.chats`. The page can access any known chat even with the bot API disabled; page plaintext goes only to the requesting tab, never in snapshots or page broadcasts.
- Only the API can redeem tokens. Reads/redemptions share the history/profile budget of 10 per second per connection. A correct token succeeds exactly once, even with concurrent requests, and is immediately replaced by a different token. Wrong-chat, incorrect or used tokens return `CHAT_ADMIN_TOKEN_INVALID`; malformed input returns `INVALID_REQUEST`, signed-out/unknown/unauthorized chats return `UNKNOWN_CHAT`, generation failure returns `CHAT_ADMIN_TOKEN_FAILED`, and rate limiting returns `RATE_LIMITED`.
- Success only means the token was consumed. **The bot decides who receives which permissions**; this does not change LINE administrators, grant API/mention privileges, or replace the connection Bearer Token. Since API clients can read plaintext themselves, redemption **does not prove WEB use or LINE administrator identity**.
- On the secret-free `chat:admin-token:changed` notification, the page clears the old value and refetches if its dialog is open. Closing the dialog, switching chats, disconnecting or signing out clears the displayed token; clipboard contents remain the user's responsibility.

**Rate limits and risks**
- Each connection is limited by `limits.sendsPerSecond` (≤5), and all bots together may not exceed `api.sendsPerMinute`; exceeding either returns `RATE_LIMITED`.
- `scam:check` has its own limit of 10 per minute across all bots (separate from the web pages' budget); exceeding it returns `RATE_LIMITED`.
- Bots speak through **your personal account**. Frequent or mechanical sending may trigger LINE's risk controls. Set conservative limits and use a secondary account first.

```js
import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:3789/api/ws", { headers: { Authorization: `Bearer ${process.env.LINEJS_TOKEN}` } });
let me;
ws.on("message", (data) => {
  const frame = JSON.parse(data);
  if (frame.type === "auth:ready") me = frame.profile.userId;
  if (frame.type === "message" && frame.message.senderId !== me && frame.message.text === "ping") {
    ws.send(JSON.stringify({ type: "message:send", requestId: "r1", chatId: frame.message.channelId, text: "pong" }));
  }
});
```

Checking a message from someone else (requires `jev.token`): `analysis.probability` is the scam probability from 0 to 1; `tactic` may be absent, and when present its `kind` is one of `investment`, `impersonation` (agency／bank／customer service), `phishing`, `shopping` (online shopping／"cancel installments"), `friend` (impersonating friends or family), `romance`, `job` (jobs／renting out accounts), `prize`, `loan`, `other`, with `confidence` from 0 to 1. Only actual upstream requests are billed by TypeSafe; all bot checks, including cache hits, still share a limit of 10 per minute, so pick the messages worth checking (the example below checks only messages with a link).

```js
ws.on("message", (data) => {
  const frame = JSON.parse(data);
  if (frame.type === "message" && frame.message.senderId !== me && /https?:\/\//.test(frame.message.text ?? "")) {
    ws.send(JSON.stringify({ type: "scam:check", requestId: frame.message.messageId, chatId: frame.message.channelId, messageId: frame.message.messageId }));
  }
  if (frame.type === "scam:result" && frame.analysis.probability > 0.8) {
    ws.send(JSON.stringify({ type: "message:send", requestId: `warn-${frame.messageId}`, chatId: frame.chatId, text: "⚠️ Suspected scam message", replyTo: frame.messageId }));
  }
});
```

## Terminal interface (CLI)

Log in, log out, and replace Tokens without opening the web interface. The CLI **does not directly access `session.json`**; it connects to the **running** service, first using `GET /` to obtain a browser cookie, then the same WebSocket (`/ws`) and workflow as the web interface. There is therefore only one set of security checks and state, and the web interface and CLI see the same login state. The service address comes from `server` in `config.yaml` (a `0.0.0.0` binding is accessed through loopback instead).

**Prerequisites**: run `npm start` first, and have already run `npm run build` (the CLI runs the built `dist/` output).

```sh
npm run cli -- login     # 登入
npm run cli -- logout    # 登出
npm run cli -- token     # 重新產生機器人 API Token（加 --revoke 則撤銷）  (regenerate the bot API Token; add --revoke to revoke it)
npm run cli              # 不帶指令：顯示用法
```

> Do not omit the `--` after `npm run cli`; otherwise npm consumes the following arguments.

**Options**: `--yes` (or `-y`) skips confirmation. Environments without a terminal (scripts, scheduled jobs) cannot prompt and **must** use `--yes`; otherwise execution is refused. `--revoke` is only valid with `token`; any other combination is a usage error (exit code 2).

### `login`: log in and display a QR code in the terminal

1. Connect to the service; if it is still restoring the session, wait for completion.
2. Already logged in → print 「已經登入。」 (Already logged in.) and 「已登入：<名稱>」 (Logged in: <name>), then exit without doing anything.
3. Otherwise, start QR login, wait for LINE to generate the QR code, and draw it with block characters in the terminal. Scan with **LINE on a secondary account**.
4. After scanning, the phone asks for a PIN, printed below the QR code.
5. After LINE confirms, print 「已登入：<名稱>」 (Logged in: <name>) and exit; an open web interface also enters the chat interface.

- The QR code and PIN **appear only in the terminal running the command**: they are not written to files, logged, or broadcast to the web interface or other connections (the original QR URL itself is not printed).
- Waits at most 3 minutes; run the command again after failure or timeout (no automatic retry loop).
- If the web interface or another terminal is already logging in, it reports 「目前無法開始登入：已有登入程序在進行」 (Cannot start login now: a login process is already in progress). Complete login there.

### `logout`: log out

1. Not logged in → print 「目前沒有登入的 LINE 帳號。」 (No LINE account is currently logged in.) and do nothing.
2. Logged in → ask for confirmation: 「登出會清除本機登入資料與快取，並登出此裝置；下次需要重新掃描 QR code。確定登出？(y/N)」 (Logging out clears local login data and cache and logs out this device; next time you must scan the QR code again. Log out? (y/N)).
3. After confirmation, revoke the LINE-side login, clear `session.json` and the in-memory cache, and print 「已登出。」 (Logged out.). If LINE-side logout cannot be confirmed, an additional reminder asks you to remove this device manually under 「登入中的裝置」 (Logged-in devices) in LINE on your phone.

### `token`: regenerate or revoke the bot API Token

- Enable `api` in `config.yaml` first (see [Bot API](#bot-apiapiws)); otherwise it returns 「機器人 API 未啟用」 (Bot API is not enabled).
- If a Token exists, first confirm: 「目前的 Token 會立即失效，使用它的機器人會被中斷連線。確定重新產生？」 (The current Token will immediately become invalid, and bots using it will be disconnected. Regenerate?).
- The new Token is **printed alone to standard output**; all other messages (instructions, warnings) go to standard error, so it can be assigned directly to a variable. The Token is shown only once:

  ```sh
  LINEJS_TOKEN=$(npm run -s cli -- token --yes)   # -s 讓 npm 不印自己的標頭，輸出才乾淨
  ```
- `token --revoke`: revokes the current Token without issuing a new one. It first confirms (「撤銷後機器人會被中斷連線，且在重新產生前無法再連線。確定撤銷？」: Revoking disconnects bots, and they cannot reconnect until a new Token is generated. Revoke?), then immediately disconnects all bots and deletes `api-token.json`. With no Token it prints 「目前沒有 Token，不需撤銷。」 (There is no Token; nothing to revoke.) and exits 0.
- Only ordinary `/ws` connections that hold the browser cookie (that is, the local CLI) can generate or revoke Tokens; bot connections cannot replace their own Token. The Token is sent only to the requesting connection.

### Exit codes and common messages

| Exit code | Meaning |
|---|---|
| 0 | Success; or confirmation canceled, not currently logged in (`logout`), already logged in (`login`); or usage displayed without a command |
| 1 | Failure: cannot connect to the service, rejected by the service, login failed/timed out, API disabled, service connection interrupted, etc. |
| 2 | Invalid command or option (usage included) |

| Message | Meaning, cause, and action |
|---|---|
| 連不上服務（http://…）。請先執行 npm start。 | Cannot connect to the service (http://…). Run npm start first. The service is not running, or `server.host`／`port` in `config.yaml` differs from the service's actual settings. |
| 服務拒絕了連線，請確認 config.yaml 的 server.host 與 server.port。 | The service rejected the connection; check server.host and server.port in config.yaml. The endpoint is not this service (for example, another program occupies the port), or the service rejected the request. |
| 服務與 CLI 的通訊協定版本不同… | The service and CLI have different protocol versions… The program was updated without rebuilding or restarting: run `npm run build` and restart the service. |
| 非互動環境無法確認；若確定要執行，請加上 --yes。 | Confirmation is unavailable in a non-interactive environment; add --yes if you intend to proceed. Confirmation is required but no terminal is available. |
| 機器人 API 未啟用… | Bot API is not enabled… Configure `api.enabled` and `api.chats` as above, restart, and retry. |
| 登入失敗，請重新執行 login。 | Login failed; run login again. The QR code expired, the PIN was incorrect, or LINE rejected login; rerun the command. |

## Management scripts

The root-level `linejs.sh` and `linejs.ps1` provide equivalent functionality, grouping common operations into the same commands: `linejs.sh` (macOS/Linux, POSIX `sh`) and `linejs.ps1` (Windows PowerShell 5.1/PowerShell 7). You can invoke them from any directory; they first switch to the project root.

```sh
./linejs.sh start            # 啟動服務（前景執行，Ctrl+C 停止）
./linejs.sh stop             # 停止正在執行的服務
./linejs.sh restart          # 停止後重新啟動（沒在執行時等同 start）
./linejs.sh update           # 更新到最新版（可加 --check、--verify）
./linejs.sh login            # 登入：在終端機顯示 QR code
./linejs.sh logout           # 登出並清除本機登入資料
./linejs.sh token            # 重設機器人 API Token（新 Token 只顯示一次）
./linejs.sh help             # 顯示用法
```

```powershell
.\linejs.ps1 start           # 其餘指令相同：stop／restart／update／login／logout／token／help
# 若系統禁止執行腳本：powershell -ExecutionPolicy Bypass -File .\linejs.ps1 start
```

| Command | Actual execution | Description |
|---|---|---|
| `start` | `node dist/main.js` | Accepts no arguments. If `node_modules` does not match `package-lock.json` (missing packages or wrong versions, e.g. after an interrupted install or a lockfile change), runs `npm ci --include=dev` and then `npm run build`; if build output (`dist/main.js`, `dist/web/index.html`) is missing, or the sources (`src/`, `web/`, `package.json`, `package-lock.json`, `tsconfig.json`) are newer than it (e.g. after a plain `git pull` of code changes), runs `npm run build`. When both are up to date, starts directly without either step. Runs in the foreground; Ctrl+C stops it. Refuses to start if the service is already running and suggests `restart`. |
| `stop` | `node scripts/service.mjs stop` | Accepts no arguments. Finds the service through `linejs.pid` and sends a termination signal (`SIGTERM`; the service closes its LINE connection and finishes writing `session.json` before exiting), waiting at most 20 seconds. Reports success even if it is not running. |
| `restart` | `stop` then `start` | Accepts no arguments. Stops the running service first (skips if not running), then starts in the foreground, taking over this terminal; the service in the original terminal exits. |
| `update` | `node scripts/update.mjs …` | Equivalent to `npm run update`, forwarding options unchanged: `--check` only checks, and `--verify` requires a tag signature. See [Version updates](#version-updates) for the workflow and abort conditions; run `start` again after updating. |
| `login`／`logout`／`token` | `node scripts/cli.mjs <指令> …` | Equivalent to `npm run cli -- <指令>` (<command>), forwarding options such as `--yes` unchanged. **The service must already be running** (run `start` in another terminal). See [Terminal interface (CLI)](#terminal-interface-cli) for details and exit codes. If dependencies or the build are out of date, it does not reinstall or rebuild underneath the running service; it asks you to `restart` first. |

- The scripts first check for Node.js ≥ 22 and npm, aborting with a clear message if requirements are not met; exit codes are passed through unchanged (unknown commands return 2).
- **How `stop`/`restart` find the service**: on startup, the service writes its PID to `linejs.pid` in the project root (permissions 600, excluded from version control), removing it on normal exit. The scripts terminate only a process “pointed to by `linejs.pid` **whose command line is actually this project's `dist/main.js`**.” If the PID file is stale (a crashed service left it behind, or another program reused the PID), only the file is cleared; that process is not touched.
- This mechanism applies from the version that introduced `linejs.pid`: after updating for the first time, stop the old service manually (Ctrl+C). Only services subsequently launched with `start` can be found by `stop`/`restart`. Windows has no signal mechanism, so `stop` terminates the process directly (`session.json` writes are atomic and never leave a partially written file).
- If `stop` cannot observe the service exiting within 20 seconds, it reports failure with the PID. Inspect it and terminate it manually; the script does not force-kill it.
- Like `npm run cli -- token`, `token` prints only the new Token to standard output, so you can capture it directly: `LINEJS_TOKEN=$(./linejs.sh token --yes)` (PowerShell: `$env:LINEJS_TOKEN = .\linejs.ps1 token --yes`). The scripts call `node` directly rather than through `npm run`, so npm headers do not contaminate the output.
- The scripts are only shortcuts for the commands above, with no additional privileges; handling of `session.json`, `config.yaml`, and `api-token.json` is unchanged.

## Build and verification

The following commands are available. `npm test` builds first, then uses an isolated fake provider to test configuration, sessions, login/logout, message caching, history and send validation/rate limits, media routes (including Range), read receipts, WS security, and (with a stubbed DOM/upload) the message send queue: multiple media sent one at a time with progress, and the draft text sent only after the whole selection:

```sh
npm run typecheck
npm run build
npm test
npm audit
```

The same checks run automatically in GitHub Actions (`.github/workflows/ci.yml`) on every push and pull request from a clean install (Node 22: `npm ci --include=dev`, typecheck, test, `npm audit --audit-level=high`).

Tests use `node --test` and a Mock Provider; mocks do not replace real LINE acceptance. Gate 1 requires scanning with a secondary account and receiving a real message within 60 seconds; Gates 2–4 additionally verify web synchronization, history, sending, and media. See [PLAN.md](PLAN.md) for all Gates and acceptance criteria.

Third performance-audit fixes (protocol remains 2):

- Administrator queries share only in-flight work for the same chat within one account session. Entries are removed on success or failure; completed role lists are not cached. Each connection still independently passes authorization, consumes its rate budget and receives its mention grant. A new query immediately revokes the previous grant, and old-account results cannot affect replacement queries.
- Talk summary pagination and OpenChat statuses run concurrently. Each refresh still runs at most 5 OpenChat status requests, filling free slots immediately rather than waiting for a whole batch. Partial failures remain best effort, and account changes stop scheduling old work.
- The web UI defers channel sorting until rendering; a batch of increments sorts once while data and unread updates still run per event. Direct rendering, tabs, reconnects and logout resets remain supported. Equal activity/name keys retain their order from before the batch.

Typecheck, build and all 305 tests passed. Single before/after measurements used the production adapter/HTTP/WS with isolated upstreams, and Chromium:

| Scenario | Before | After |
|---|---|---|
| Upstream calls for 4 bots querying the same 3-page OpenChat concurrently | 12 member + 4 own-membership calls | 3 member + 1 own-membership calls |
| Summaries with an 80ms talk request and 10 OpenChat statuses (first 180ms, others 10ms) | About 275ms | About 182ms, OpenChat concurrency still peaks at 5 |
| Browser sorting for 5,000 channels and 100 increments | 100 sorts, about 47.1ms total | 1 sort, about 0.7ms |

Real WS Token authentication additionally verified complete administrator lists and MENTION metadata, no inherited grant after reconnect, immediate revocation on refresh and latest-query-only grants. Browser checks covered order, previews, unread counts, filtering, tabs, direct interaction while rendering was deferred, reconnect and logout/login. No real LINE account or paid AI was used; these isolated observations do not establish real upstream latency, a performance guarantee or Gate acceptance.

Second performance-audit fixes (protocol remains 2):

- Browser snapshots target 256KiB batches, advancing only after each send completes; concurrent increments are queued in order after the snapshot. Queued increments and socket buffering share the 8MiB limit, and a send stalled for 30 seconds disconnects. A single message is not split: one larger than the target gets its own batch, still subject to the 8MiB protection. Bots still receive no replay. Logout/account changes/disconnection/shutdown invalidate replay work.
- Search uses a variable-height virtual list; frontend retention and media scheduling use the limits above, without disk persistence or weaker authorization/content checks.

Typecheck, build and all 298 tests passed. Production HTTP/WS with isolated upstreams and actual Chromium interactions produced:

| Scenario | Before | After |
|---|---|---|
| Replay: 20 chats × 500 messages × 2KB text | Close 1006, incomplete delivery | All 10,000 delivered, connection stays open, concurrent edits/take-backs correct |
| Initial result DOM for 5,000 search matches | 5,000 rows | 13 rows, complete count and head/middle/tail navigation |
| Upstream concurrency for 30 distinct media IDs | 30 | 4 |

Also verified: scrolling through all 2,500 history messages with at most 500 retained in the chat; live traffic while reading history sends no erroneous read receipt, and Latest returns to recent messages; 25 chats plus 700 new messages remain within 10,000 retained messages. Search edits/take-backs, mobile width, keyboard jumps and logout cleanup passed. A single search observation used about 9.08ms script and 3.05ms layout; this is not a multi-run performance guarantee. No real LINE account or paid AI was used, and this does not establish Gate acceptance.

Current performance-audit fixes:

- Member lookups share in-flight requests for the same source/ID and prefetch concurrently while preserving per-chat delivery order. At most 5 real requests run globally; timed-out requests retain their slots until they settle, and late or old-account results cannot populate profiles.
- The web UI batches rendering by animation frame without merging or dropping events. It retains message ID indexes, date/search-text caches and sorted read positions, and reuses search nodes. History prepends anchor by message ID even when new messages arrive concurrently or grouping replaces DOM nodes.
- OpenChat caches add an ID index and binary-search cursors/insertion points, preserving unsends, reactions, live-event precedence and existing bounds.
- API channel snapshots directly look up authorized IDs instead of scanning every chat, preserving stable timestamp/name ties.
- Single-chunk media uploads/downloads avoid an extra copy; multi-chunk paths use the already-counted length. E2EE, content detection, actual-byte limits and Range rules remain unchanged; downloads are not converted to streaming.

Local isolated measurements: member lookups use a fixed 80ms upstream delay. API preparation compares the previous full scan against indexed lookup for 5,000 chats/3 authorized IDs, using 200 operations per round and the median of 5 rounds after warmup. Chromium uses the production HTTP/WS server, injecting 100 messages after the initial 50 messages and history have settled; the Layout counts below are a single controlled observation:

| Measurement | Before | After |
|---|---:|---:|
| 3 distinct members in one chat: last delivery (ms) | 245.08 | 82.09 |
| Same member in 3 chats: upstream requests | 3 | 1 |
| API channel preparation, 200 operations (ms) | 22.48 | 0.12 |
| 100 messages: browser Layout count | 206 | 3 |

Typecheck, build and all 285 tests passed. Actual browser checks covered complete ordered delivery, image DOM preservation, concurrent edits/reactions, scroll anchoring with simultaneous history/live messages, search updates/node reuse, own-send bottom scrolling, read updates, chat switching and logout cleanup, plus the actual image-upload route. Main-world visibility simulation verified no read receipt while hidden and acknowledgement after returning; this does not verify every browser's background throttling. Upstreams were isolated; no real LINE account or paid AI API was used, and these results do not establish real-network latency or Gate acceptance.

API channel synchronization verified: API connections filter by `api.chats` before sorting. Bot-only services skip the full browser snapshot; mixed connections reuse the browser's sorted result. Ordering, fields, payload size and protocol remain unchanged, with no new potentially stale cache. Typecheck, build and all 279 tests passed, covering stable ties, empty scopes, live updates, unsends, clearing and API-only synchronization.

Local production HTTP/WS hub with Bearer Token authentication and an isolated provider, 5,000 chats with 3 allowed for the API: median of 30 connections after 5 warmups. Data preparation uses the median of 5 rounds of 200 operations, checking contents throughout:

| Measurement | Before (ms) | After (ms) |
|---|---:|---:|
| API connection start to receiving channels | 3.18 | 0.52 |
| Channel data preparation, 200 operations | 591.77 | 25.92 |

This improves channel synchronization processing latency, not bandwidth or every API request by the same ratio. No real LINE account was used; this does not establish Gate acceptance.

Packet-processing optimization verified: each broadcast is JSON/UTF-8 encoded once and shared by web and authorized API connections; channel-list broadcasts sort once before filtering API-visible chats. Text frames and protocol version 2 remain unchanged, with no event coalescing or dropping and no changes to validation, rate limits or slow-client backpressure protection. Typecheck, build and all 277 tests passed, including new burst coverage for web-only, API-only and mixed connections, Unicode, edit/unsend ordering, deduplication and chat isolation.

Actual local HTTP/WS cookie/Token-authenticated measurement: 1 web-protocol connection and 4 bots, 4,000 messages containing Chinese/emoji per round, waiting for each connection's pong every 40 messages; medians of 5 rounds after warmup. Backend processing is cumulative synchronous `handleMessage` time; completion includes receipt and parsing of messages and pongs by all connections (milliseconds):

| Text length (UTF-16) | Backend: before | Backend: after | Completion: before | Completion: after |
|---|---:|---:|---:|---:|
| 100 | 74.18 | 62.60 | 107.04 | 97.93 |
| 2000 | 195.54 | 111.70 | 298.03 | 212.87 |

Measurements use the production HTTP/WS hub and an isolated LINE provider, excluding LINE upstream latency, AI inference and browser rendering. Text frames, contents, ordering and counts were checked on every connection. No real LINE account was used; this does not establish Gate acceptance.

Scam-analysis acceleration verified: typecheck, build and all 273 tests passed, covering request coalescing, exact text matching, expiration, LRU eviction, failure retries, authorization, rate limits and logout/account isolation. An actual HTTP/WS cookie- and Token-authenticated smoke run used the production JevClient with an isolated upstream delayed by 200ms: concurrent web/API checks of identical text followed by a repeat check reduced upstream calls from 3 to 1 and repeat latency from about 203ms to 0.46ms. This is not actual TypeSafe latency; no paid API or real LINE account was used, and this does not establish Gate acceptance.

Verified for this change (scam check): typecheck, build, all 200 tests passing, and zero vulnerabilities from `npm audit --audit-level=high`. Headless Chromium with an isolated provider (and a fake analyzer) confirmed that 「詐騙機率分析」 appears in the context menu only for other people's text messages, the result dialog's content and single button, and that later confirmation dialogs still show their cancel button. Calling the real TypeSafe endpoint with an invalid key returned 401 (endpoint and authentication scheme are correct). **Not verified**: a real result with a valid key (none was available), and use on a real LINE account.

Verified for the previous change: typecheck, build, all 193 tests passing, and zero vulnerabilities from `npm audit --audit-level=high`. Headless Chromium with `--mute-audio` enforced verified search ordering and live updates, retry after an initial history failure, image DOM preservation during reaction updates, and logout cleanup using an isolated provider. The actual `dist/main.js` was also launched and its signed-out screen checked. No real LINE account was used; these results do not establish Gate acceptance. The following records are retained from previous versions:

Verified: typecheck, build, 172 tests, and no high-severity findings from `npm audit`. With a real LINE account: session reuse, channel lists, live messages from friends/groups/OpenChat, talk history pagination (deduplicated, ordered, and scrollable to the end), OpenChat history pagination, profile pictures and non-friend name lookup, OpenChat image download/display, owned sticker pack lists (7 packs, including Traditional Chinese names and icons), administrator/co-administrator role detection in OpenChat messages, and rescanning to log in through the web interface (the service log shows the QR login flow and a switch to another account). In the browser with a fake provider: upward pagination, input/sending workflow, pasted image preview and sending (including sending text afterward), rejection of pasted videos, the owned sticker panel (pagination and click-to-send), image uploads, profile pictures and fallback letters, read/unread indicators, read-receipt triggers, badges and full nicknames without wrapping, timestamps after messages and 24-hour format (00:05, not 24:05), image enlargement, video (Range) and voice playback, long-press message menus on touch, confirmation dialogs, scrolling to the bottom after sending (including OpenChat cases where the replier's id differs from your own) and staying at the bottom when receiving stickers, the new-version banner (dismissal remembered), the refresh prompt when service/page versions differ, automatic reload of old tabs after service restart, last-message previews and times in the chat list with live reordering, the 「↓ N 則新訊息」 button (count, and click to return to the bottom), phone reads (`chat:checked`) clearing both the page's own count and LINE's, keyboard operation (↑↓/Home/End/Enter, Ctrl/⌘+K), the heartbeat (after freezing the service process the page detects the disconnect and shows the overlay, then reconnects on resume; the foreground probe detects it even when the regular ping is delayed; disconnect records in the console and the service log), stray Promise rejections being logged without stopping the service, and a clean shutdown releasing `linejs.pid` on an uncaught exception. **Bot API, CLI, and other additions**: automated tests with a fake provider cover authentication (missing Token/incorrect Token/`Origin` present/incorrect `Host`), frame allowlisting, chat scope, no replay of old messages, global send limits, the maximum of 4 connections, immediate disconnection on Token replacement/revocation, hash-only Token storage and file permissions, and CLI `login` (QR and PIN only in the terminal)/`logout`/`token`/`token --revoke` (revocation, no-op when there is no Token, and `--revoke` with any other command treated as a usage error). Against the real service, the CLI was only exercised with side-effect-free `login` (reporting state when already logged in) and the `token` error when the API is disabled. Parsing and names for 「XX 新增 OO 至群組」 (XX added OO to the group) were verified using historical messages from a real account. **Not yet verified** (requires side effects on real contacts or corresponding real messages): actual LINE sending and live receiving through the bot API, CLI `logout` and the real QR scanning login flow, the live system-message event path (only history was verified), actual use with a non-local binding, real text/sticker/image sending, real read receipts (the effect of `sendChatChecked`/OpenChat `markAsRead` on LINE), server confirmation of LINE-side logout, receiving/decrypting E2EE images, 1:1 read-event field formats (known mismatched shapes are ignored), real GIF/video sources, backoff reconnection after listen interruptions, chat summaries on a real account (`lastMessages` from `getMessageBoxes` and OpenChat `getSquareChatStatus.lastMessage`; missing fields simply mean no preview), the actual fields of `SEND_CHAT_CHECKED` (only `param1` is used and it must be a known chat; anything else is ignored) and the refresh triggered by group/profile change events, and the actual cause of disconnects while idle in the background in Edge and other browsers (the new disconnect records can help pin it down), downloading real files (including E2EE file decryption), sending and taking back real reactions (`talk.react`/`cancelReaction`, OpenChat `reactToMessage` with `UNDO`), and the actual contents of OpenChat `NOTIFIED_UPDATE_MESSAGE_STATUS`. The full `npm run update` workflow was verified only with temporary git repositories and a fake `npm`, not against a real newer version (the repository's current latest Release is v0.9.0; update notification queries against the real GitHub Release API have been tested).

## Version updates

Versions follow `package.json` and semver, published as GitHub Releases/tags `vX.Y.Z` (pushing tags and publishing Releases require explicit maintainer authorization). Updating is deliberately split into **automatic notifications** and **manual updates**: **LINE.js never downloads or executes new code on its own**.

```mermaid
flowchart LR
    A["Service startup / every 24 hours"] -->|"Anonymous GET releases/latest"| G[GitHub]
    G -->|"A newer vX.Y.Z is available"| B["Bottom web banner: run npm run update"]
    B --> U["You run npm run update in the terminal"]
    U -->|"git fetch --tags，ff-only，npm ci，npm run build"| R["You restart the service"]
    R --> P["Open web pages reload automatically"]
```

### 1. Notifications (automatic, informational only)

- **Timing**: once at service startup, then every 24 hours.
- **Request**: anonymous `GET https://api.github.com/repos/JS-PACKAGE/LINE.js/releases/latest`. No credentials, cookies, LINE data, or identifying information is sent (except the IP inherently disclosed by HTTPS and the fixed `User-Agent: LINE.js-update-check`).
- **Strict parsing**: only `X.Y.Z`/`vX.Y.Z` are recognized; pre-releases and drafts are ignored. Release links are displayed only if they point to this project's `/releases/`. Release descriptions are untrusted and are not forwarded. Redirects are not followed, and response size is bounded. No Releases in the repository (404) means “no new version.”
- **Display**: a bottom banner says 「有新版本 vX.Y.Z 可用（目前 vA.B.C）。請在終端機執行 `npm run update`，完成後重新啟動服務。」 (New version vX.Y.Z is available (current: vA.B.C). Run `npm run update` in the terminal, then restart the service.), with a 「版本說明」 (Release notes) link. Click ✕ to dismiss; the browser remembers that version in `localStorage` and does not prompt again until a newer version appears.
- **Failures**: network or GitHub failures retry with backoff of 5, 10, 20 minutes… up to 24 hours, rather than repeatedly hammering the service.
- **Disable**: set `update.check: false` in `config.yaml` to make no external update queries.

### 2. Updating (initiated by you)

```sh
npm run update                  # 更新到最新版，並重新安裝依賴、建置
npm run update -- --check       # 只檢查有沒有新版，不改動任何東西
npm run update -- --verify      # 更新前額外要求最新 tag 通過 git verify-tag（需維護者簽署該 tag）
```

`npm run update` performs these steps in order, aborting with an explanation if any step fails:

1. Confirm that this is a git repository with an `origin` remote and a recognizable version in `package.json`.
2. Confirm that **tracked files have no uncommitted changes** (untracked `config.yaml`, `session.json`, and `api-token.json` are unaffected and never touched).
3. Run `git fetch --tags origin` and find the newest of all `vX.Y.Z` tags.
4. Exit if none is newer than the current version (「已是最新版」 (Already up to date)); `--check` stops here.
5. With `--verify`, `git verify-tag` must pass.
6. The current commit must be an ancestor of the tag before advancing by **fast-forward** (only `merge --ff-only`; on a detached HEAD, use `checkout --detach` to that tag instead). If local commits are absent from the tag, abort; merge/rebase yourself before updating. **Your content is not overwritten**.
7. Run `npm ci --include=dev` (install pinned dependencies from the lockfile; the build needs devDependencies, so they are installed even with `NODE_ENV=production`).
8. Run `npm run build`.
9. Show 「已更新到 vX.Y.Z，請重新啟動服務」 (Updated to vX.Y.Z; restart the service).

To restart, press Ctrl+C in the terminal running `npm start`, then run `npm start` again. `session.json` is reused; no rescan is needed. If step 7 or 8 fails, the code has already switched to the new version; the message includes rollback commands (`git checkout <舊提交>` (<old commit>), then `npm ci --include=dev && npm run build`).

- **No one-click web update**: deliberate, to prevent a web-layer vulnerability from escalating into remote code execution.
- **Trust model**: updates trust the `origin` remote and GitHub's TLS. Tags are cryptographically verified only with `--verify` and a maintainer-signed tag. If you require stronger assurance, inspect the diff between the two tags before updating.
- For older versions without this feature (before v0.9.0), run `git pull` manually once first.

### 3. Page synchronization (automatic)

- Open tabs reload automatically after service restart (only after the old cookie becomes invalid, three consecutive rejections occur, and the service is reachable; at most once every 30 seconds to avoid reload loops when the service is actually down).
- If page and service versions differ, the prompt says 「本機服務已更新到 vX（此頁為 vY），請重新整理」 (The local service has updated to vX (this page is vY); please refresh). Incompatible protocol versions cause an immediate reload.

### 4. Publishing a new version (maintainers)

1. Update `version` in `package.json` and commit (for example, `release: vX.Y.Z`).
2. Create tag `vX.Y.Z` (signing recommended) and push; create the corresponding GitHub Release (not a pre-release).
3. Users' services see the notification at the next check (within 24 hours, or on restart).

The push, tag, and Release operations above are external actions and require explicit maintainer authorization.

See [SECURITY.md](SECURITY.md) (in English) for the security policy and reporting instructions.

## Development rules and licensing

See [AGENTS.md](AGENTS.md) (in Chinese) for engineering and security rules, and [PLAN.md](PLAN.md) for the full agreed plan. Commit in feature-based batches, excluding personal configuration and credentials; do not rewrite the existing `LICENSE` or `.nojekyll`.

This work, **LINE.js**, is licensed under **Apache-2.0**, as specified by the root [LICENSE](LICENSE). The consumed packages **@evex/linejs** and **@evex/linejs-types** are licensed under **MIT**, independently of this work; see the [upstream license](https://github.com/evex-dev/linejs/blob/v3.5.0/LICENSE). This repository is for cloning only; no npm/JSR package is published.
