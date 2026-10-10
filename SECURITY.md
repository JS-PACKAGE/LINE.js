# Security Policy

LINE.js is a **local-only** web client for LINE, built on the unofficial `@evex/linejs` library. It
handles account credentials, end-to-end-encryption key material and private messages, so the bar for
security reports and for security-relevant changes is deliberately strict.

This document states what is protected, how the protections are enforced, what is explicitly **not**
protected, and how to report a problem. Where a protection is enforced in code, the file is named so
the claim can be checked.

## 1. Supported versions

| Version | Supported |
|---|---|
| Latest published release (`vX.Y.Z` tag on GitHub) | Yes |
| `main` | Best effort; may contain unreleased work |
| Anything older than the latest release | **No.** Update with `npm run update` |

Fixes are released as a new patch (or minor) version only. Backports to older versions are not made.

## 2. Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a suspected vulnerability.**

Use GitHub private vulnerability reporting for this repository:
**Security tab → "Report a vulnerability"** (<https://github.com/JS-PACKAGE/LINE.js/security/advisories/new>).

> **Status (2026-10-08, verified):** private vulnerability reporting is currently **disabled** on
> <https://github.com/JS-PACKAGE/LINE.js>, so the button above is not available yet. It is enabled by
> the repository owner under
> *Settings → Code security and analysis → Private vulnerability reporting*. Until then, open a public
> issue that says only "security report, no details" and asks the owner for a private contact channel —
> an owner reply gives you a channel, and the discussion then continues privately. Do not paste
> vulnerability details in a public issue.

A useful report contains:

- The affected version (`package.json` version or release tag) and Node.js version.
- The impact in one or two sentences, and which rule in section 4 it breaks, if any.
- Minimal reproduction steps or a proof of concept.
- Whether the issue needs a local process, a malicious web page, a malicious LINE message/sender, or a
  network position.

**Never include real credentials.** Do not attach `session.json`, `config.yaml`, auth tokens, QR URLs,
PIN codes, E2EE keys, or real message contents. Redact them. If a reproduction needs account state,
describe it instead of sending it.

### Response targets

These are targets, not guarantees; this is a volunteer-maintained project.

| Stage | Target |
|---|---|
| Acknowledge receipt (once the report has actually reached the maintainers) | 3 days |
| Initial assessment (accepted / declined, severity) | 7 days |
| Fix or mitigation for Critical / High | 14 days |
| Fix or mitigation for Medium / Low | 60 days |
| Public disclosure | After a fix is released, or at most 90 days after the report, whichever comes first |

Severity follows CVSS v3.1 base scoring, adjusted for the local-only deployment model. Reporters are
credited in the advisory unless they ask not to be.

### Good-faith research

Research that follows these rules will not be pursued by the maintainers:

- Test **only against your own LINE secondary account** and your own machine. Never against other
  people's accounts, chats or contacts.
- Do not send messages, read receipts or friend/group actions to real contacts while testing. Reporting
  your own read position changes state visible to the other party.
- Do not attempt to attack LINE's servers or infrastructure. LINE.js is a client; server-side issues
  belong to LINE Corporation.
- Do not exfiltrate, retain or disclose data you encounter; stop and report as soon as impact is shown.

## 3. Scope

### In scope

- Anything that lets a party other than the user read or send LINE data, or obtain `session.json`
  contents, QR URLs, PINs or tokens, through LINE.js code.
- Bypasses of the Host/Origin/cookie checks, the bot API's token and scope checks, CSP, rate limits,
  size limits or input validation described in section 4.
- A malicious LINE message, sticker, avatar or media object that causes code execution, script
  injection, out-of-bounds file access, memory exhaustion, or a crash of the local process.
- Credential or key material appearing in logs, error messages, WebSocket frames, or shared state.
- The update mechanism (section 5) running, downloading or trusting anything it should not.
- Dependency vulnerabilities with a high or critical advisory that are reachable in this project.

### Out of scope

- Vulnerabilities in `@evex/linejs`, LINE's servers or apps. Report those upstream. (A LINE.js-side
  mitigation of an upstream bug is welcome as a report only if LINE.js's own behavior is wrong.)
- Account restriction or ban risk from using an unofficial client. This is a known, documented risk
  (section 6); use a secondary account.
- An attacker who already runs arbitrary code as the same OS user, has root, or has physical access
  (see section 6).
- Deliberately editing the code or `config.yaml` to weaken a control. In particular, `server.host` is
  whatever `config.yaml` says (see section 4): choosing a non-loopback address, or listing chats in
  `api.chats`, is the user's decision and is not a vulnerability by itself. Modifying the program to
  remove a check is not a vulnerability either.
- Missing hardening headers or best-practice findings without a demonstrated exploit path.
- Denial of service that requires the already-trusted local browser tab.
- Findings from automated scanners without a working proof of concept.

## 4. Security architecture and where it is enforced

These are hard rules for the project. A change that weakens any of them needs explicit maintainer
approval, and a regression against any of them is treated as a vulnerability.

### Network exposure

| Rule | Enforcement |
|---|---|
| The listen address is whatever `server.host` in `config.yaml` says (hostname, IPv4 or IPv6; malformed values fail startup with `CONFIG_INVALID`). The shipped default and template are `127.0.0.1` and must never be `0.0.0.0`. Starting on any non-loopback address prints a warning, because the page has no password: whoever can reach the address can operate the signed-in account. | `src/config.ts`, `src/main.ts` |
| Every HTTP request is rejected when `Sec-Fetch-Site: cross-site`. The `Host` header is **not** pinned, on any bind (owner's decision, so the service works behind a reverse proxy, LAN name or tunnel); the cost is that DNS rebinding is not defended, since a page on an attacker domain resolving to the listen address is same-origin with itself. Keep the service on `127.0.0.1` unless the network is trusted. | `src/http/server.ts` |
| A WebSocket upgrade must pass **all** of: path `/ws`, an `http`/`https` `Origin` whose host equals the `Host` header (the scheme is not pinned so a TLS-terminating reverse proxy or custom domain works), and the per-process browser cookie. | `src/http/server.ts` (`authorizeUpgrade`), `src/ws/hub.ts` |
| The browser cookie is a 256-bit random per-process token, `HttpOnly; SameSite=Strict`, compared in constant time. It is issued only with the page. | `src/http/server.ts` |
| `POST /media/upload` additionally requires same-origin `Origin` and the cookie, so another website cannot queue media for sending. | `src/http/server.ts` |
| A strict CSP (`default-src 'none'`, `script-src 'self'`, `frame-ancestors 'none'`, no inline script) and `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` are sent on every response. The one exception is the public build output under `/assets/` (content-hashed file names, no account data), which is `public, max-age=31536000, immutable`. | `src/http/server.ts` |
| There is no HTTP login endpoint. Login runs only over the WebSocket. The CLI (`npm run cli`) is a client of that same WebSocket; it never reads or writes `session.json` itself. | `src/ws/hub.ts`, `src/cli.ts` |

### Bot API (`/api/ws`, off by default)

| Rule | Enforcement |
|---|---|
| The endpoint exists only when `api.enabled` is `true`, and `api.chats` must then list at least one valid chat id (an empty list is a startup error, never "everything"). | `src/config.ts` |
| An upgrade needs **no `Origin` header** (every browser WebSocket sends one, so no web page can use this endpoint even if the token leaks into it) and `Authorization: Bearer <token>`; the `Host` header is not checked. Failures all look the same (403); more than 4 concurrent bots get 429. | `src/http/server.ts` (`authorizeApiUpgrade`), `src/ws/hub.ts` |
| The token is 256 bits of randomness with a `linejs_` prefix. Only its SHA-256 is stored (`api-token.json`, mode `0600`, git-ignored, written via temporary file and rename); it is compared in constant time and shown **once**, only to the connection that asked for it. It is never logged or broadcast. | `src/http/apiToken.ts`, `src/ws/hub.ts`, `src/cli.ts` |
| Regenerating or revoking the token closes every bot connection immediately. Only ordinary `/ws` connections (the web page, or the local CLI, which obtains the page cookie the same way) can create or revoke it; a bot cannot. | `src/ws/hub.ts` |
| A bot may send only `message:send` (text only), `history:fetch` and `ping`; everything else, including login, logout, read receipts, stickers and media, is `UNKNOWN_TYPE`. It can reach only the chats in `api.chats` (anything else is `UNKNOWN_CHAT`), receives only live messages (no replay, no read positions) and never receives media bytes. | `src/ws/hub.ts`, `src/ws/requests.ts` |
| Sending is limited per connection (`limits.sendsPerSecond`, at most 5/s) and across all bots (`api.sendsPerMinute`, at most 120/min). | `src/ws/hub.ts`, `src/limit.ts` |

### Secrets and credentials

| Rule | Enforcement |
|---|---|
| The QR URL and PIN are sent **only** to the connection that sent `auth:start`, once. They are never broadcast, replayed on reconnect, logged, or written to disk. `auth:state` carries no secret. | `src/ws/hub.ts`, `src/line/login.ts` |
| `session.json` is created with mode `0600` using `O_EXCL \| O_NOFOLLOW`, re-tightened to `0600` if it exists, must be a regular file owned by the current user, and is rejected if it is a symlink or corrupt (it is never overwritten in that case). | `src/line/session.ts` |
| Session writes are serialized and atomic (temporary file `0600`, fsync, rename). A write failure is surfaced and is not silently swallowed. | `src/line/session.ts` |
| `session.json` and `config.yaml` are git-ignored. The process runs with `umask 077`. | `.gitignore`, `src/main.ts` |
| Logs never contain credentials, tokens, QR URLs, PINs, key material, or package error objects. Internal errors are logged as short codes locally; clients only ever receive a generic message. | `src/ws/hub.ts`, project rule |
| On logout or auth failure, the message cache, media cache and read state are cleared from memory. | `src/ws/hub.ts` |
| Decrypt or parse failures **fail closed**: a placeholder is shown; content is never guessed. | project rule |

### Input, limits and abuse resistance

| Rule | Enforcement |
|---|---|
| WebSocket frames are capped (`maxPayload`, at most 256 KiB). Every socket has an `error` handler, so an oversized frame cannot crash the process. | `src/ws/hub.ts`, `src/config.ts` |
| Per connection: `message:send` is limited (at most 5 per second); history and sticker requests are limited; uploads are limited per minute and by size. | `src/ws/hub.ts`, `src/http/server.ts`, `src/limit.ts` |
| Inputs are validated: `chatId` format, text length (at most 8000), history `limit` (at most 100), positive-integer sticker ids, reply and mention targets that this server has already shown. | `src/ws/requests.ts`, `src/ws/hub.ts` |
| Taking a message back (`message:unsend`) is page-only and shares the send rate limit. The server sends it to LINE only for a message it has shown that this account sent (its own mid, or in OpenChat the member id its own sends came back with); bots cannot. | `src/ws/hub.ts`, `src/ws/requests.ts` |
| Uploaded media types are decided from the bytes, never from the client-supplied type or file name. | `src/media/service.ts` |
| Binary data never travels over the WebSocket; it is served over HTTP. | design rule |

### Media and content

| Rule | Enforcement |
|---|---|
| Received media can only be requested for message ids this server has itself seen (`msg-<id>`), so the browser cannot use the logged-in session to probe arbitrary LINE objects. The chat list's last-message previews do not count as seen: they never make media fetchable. | `src/line/provider.ts`, `src/media/service.ts` |
| Media types are determined from content bytes; SVG and HTML are never served as received media. | `src/media/service.ts` |
| Received files (`file-<id>`, same seen-message rule and size limit) are never sniffed or shown inline: always `application/octet-stream` with `Content-Disposition: attachment`, `no-store`, and no longer served once taken back. | `src/line/provider.ts`, `src/http/server.ts` |
| Download size is capped (`limits.downloadMaxBytes`, default 50 MiB, at most 100 MiB) and the media cache is a bounded LRU. | `src/line/provider.ts`, `src/media/service.ts` |
| Message media is served `private, no-store`; it must not linger in the browser cache. | `src/http/server.ts` |
| A message its sender took back keeps only sender and time in the cache (history pages and list previews included); its media is dropped from the media cache, a download already in progress is handed only to requests already waiting and never cached, and it is no longer fetched from LINE. | `src/model/store.ts`, `src/ws/hub.ts`, `src/line/provider.ts`, `src/media/service.ts` |
| Avatar and sticker fetches use fixed LINE CDN origins with a timeout and `redirect: "error"`. | `src/line/provider.ts` |
| Messages are never written to disk. At most 500 are kept per channel in memory, de-duplicated by message id. | `src/model/store.ts` |

### PWA

The service worker caches only public static files (`/`, `/assets/*`, `/icons/*`, manifest, favicon).
`/media/*`, `/ws` and every non-GET request never pass through it, so private content cannot remain in
Cache Storage after logout (`web/public/sw.js`).

### Supply chain

- `@evex/linejs` and `@evex/linejs-types` are pinned to **3.4.2** and are not upgraded without explicit
  maintainer approval. All direct dependencies are pinned to exact versions, and `package-lock.json` is
  committed.
- `thrift` is forced to a patched version through `overrides` (see [CVE-2026-41636](https://github.com/advisories/GHSA-r67j-r569-jrwp)).
  The override must not be removed while the upstream dependency is affected.
- `npm audit` must report no high or critical advisories before a release.
- New dependencies require justification; trivial functionality is written locally.

## 5. Update mechanism

The update mechanism is designed so that **LINE.js never downloads or executes new code on its own**.

- **Notification only.** On start and every 24 hours, the service makes one anonymous `GET` to the
  GitHub Releases API for this repository. No credentials, cookies, LINE data, or identifiers are sent
  beyond what any HTTPS request discloses (your IP address and a fixed `User-Agent`).
- **Strictly parsed.** Only `X.Y.Z` / `vX.Y.Z` tags count; pre-releases and drafts are ignored. The
  release URL is shown only if it points to this repository's `/releases/`. Release notes are untrusted
  and are never forwarded. Redirects are refused and the response size is capped.
- **Opt-out.** Set `update.check: false` in `config.yaml` to disable all outbound update checks.
- **Updating is a deliberate local command.** `npm run update` fast-forwards to the newest release tag
  only: it aborts if tracked files are modified or local commits exist that the tag does not contain. It
  then runs `npm ci` and `npm run build`. `--check` changes nothing; `--verify` additionally requires
  `git verify-tag` to pass. There is no web-triggered update, because that would turn any bug in the web
  layer into remote code execution.
- **Limit of the trust model.** The update trusts the `origin` git remote and GitHub's TLS. Tags are
  only cryptographically verified when `--verify` is used and the maintainers have signed the tag. Anyone
  who needs stronger assurance should review the diff between tags before updating.

## 6. Known limitations and accepted risks

Be aware of these. They are not bugs, and reports that only restate them will be closed.

1. **Unofficial API.** LINE.js uses a reverse-engineered client library. LINE may restrict or ban an
   account that uses it. Use a **secondary account** (LINE.js defaults to the `ANDROIDSECONDARY` device
   type).
2. **Local processes are not isolated from each other.** The browser cookie and Origin checks stop
   *other websites*. They cannot stop another process running as the same OS user, which can read
   `session.json` directly or fetch `/` to obtain the cookie (the bundled CLI does exactly that, by
   design). Treat the machine's user account as the trust boundary. The same applies to the bot API
   token: anyone who holds it can send messages as the account in the listed chats.
3. **Secrets at rest.** `session.json` holds credentials and E2EE key material in plaintext, protected
   only by file permissions (`0600`). Full-disk encryption and a locked screen are the user's
   responsibility.
4. **Read receipts change real account state.** When enabled (`chat.sendReadReceipts`, default `true`),
   opening a chat marks it read for the other party. Set it to `false` to stay unseen.
5. **Memory.** Cached messages and media live in process memory, are not zeroed on exit, and could
   appear in core dumps or swap.
6. **No transport encryption and no page password.** The page and WebSocket use plain `http://` and
   `ws://`, and the page has no login of its own. This is acceptable only on the loopback interface
   (the default). If you set `server.host` to another address, or put the service behind a reverse
   proxy, port forward, tunnel or container port mapping, anyone who can reach it can read your
   messages and operate the account, and traffic is readable on the network. That is your decision and
   your responsibility; the service only prints a warning.
7. **Bot automation.** A bot speaks as your real account. LINE may treat frequent or machine-like
   sending as abuse and restrict the account. Keep `api.sendsPerMinute` low and use a secondary
   account.
8. **Browser-side state.** The web page keeps the conversation in the page's memory; a browser
   extension or a compromised browser profile can read it. Desktop notifications are off by default;
   when turned on, sender names and message previews appear in the operating system's notification
   center, outside the page.

## 7. Hardening checklist for users

- Keep `server.host` at `127.0.0.1` unless you fully control the network; never expose the port to the
  internet.
- Leave `api.enabled` off unless you run a bot. If you do, list only the chats it needs in
  `api.chats`, keep the token out of git and shell history, regenerate it if it may have leaked
  (`npm run cli -- token`; `npm run cli -- token --revoke` revokes it without issuing a new one), and keep `api.sendsPerMinute` low.
- Use a secondary LINE account and review LINE's "logged-in devices" list periodically; remove the
  device if you stop using LINE.js.
- Keep `session.json` out of backups you do not control, and out of git. If it may have leaked, log out
  from the web page and remove the device from your phone's LINE settings.
- Run `npm run update -- --check` regularly (or leave `update.check` on) and stay on the latest release.
- Run `npm audit` after installing.
- Do not run untrusted browser extensions in the profile you use for LINE.js.

## 8. Coordinated disclosure

Please give the maintainers a reasonable chance to fix an issue before publishing details. After a fix
is released, the advisory will describe the affected versions, the impact, the fixed version, and any
workaround. If you believe a report is not being handled within the targets in section 2, you may
disclose after 90 days from your report.
