# Optional daily-summary companion

LINE.js does not schedule summaries or configure Notion or n8n. On Windows, it can show controls for a separately installed local companion. The button is hidden unless all three companion scripts exist. The default companion directory is `../LINE-daily-summary` relative to the LINE.js working directory; set `LINE_DIGEST_DIR` to an absolute directory to use another location.

The companion must provide these scripts:

| Script | Invocation | Contract |
| --- | --- | --- |
| `picker-data.mjs` | `node picker-data.mjs <output-json-file>` | Write `{ "profileId": string, "profileName": string, "selectedIds": string[], "chats": [{ "id": string, "kind": string, "name": string }] }`. The current LINE account must match the saved selection. |
| `picker-save.mjs` | `node picker-save.mjs <input-json-file>` | Read `{ "profileId": string, "selectedIds": string[] }`; verify the account and chat IDs, then persist the selection. |
| `scheduled-run.ps1` | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scheduled-run.ps1 -Mode now` | Produce today's summary. Exit 0 on success; send a human-readable success line to stdout. Write failures to the companion's private log and exit nonzero. |

The companion can manage its own recurring schedule independently. LINE.js never passes a webhook URL, token, or arbitrary command from the browser to these scripts. The new `/summary/*` routes require the browser cookie; mutations additionally require same-origin requests. The run is asynchronous and its status is kept in memory until the LINE.js service restarts. A manual run may transmit selected chat content to the companion's configured service, so the browser only starts it after the user presses 「立即摘要今天」.

The scripts, selection state, webhook configuration, and scheduled task are **not part of this repository**. Keep private configuration outside Git. A compatible companion should itself enforce chat selection, account binding, and output limits before publishing data.
