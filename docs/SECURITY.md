# Security and privacy

ReSync is designed so that **API keys never leave your device** (except to the provider they belong to), **conversations stay local by default**, and **there is no telemetry**.

## How API keys are stored

| Where | How |
|---|---|
| **CLI** (`resync keys set`) | In the operating system's keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service) via `@napi-rs/keyring`, under the service name `resync-cli`. Environment variables such as `RESYNC_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY` work as a fallback. `~/.resync/config.json` holds only provider *names* and settings, never key values; `resync config set` refuses keys. |
| **Extension** | In `chrome.storage.local`, encrypted with **AES-GCM-256**. The key is derived from your passphrase with **PBKDF2-HMAC-SHA256, 600,000 iterations** (OWASP's current recommendation), a random 16-byte salt, and a fresh 12-byte IV for every encryption. Keys are **locked** until you unlock them once per browser session. The unlocked AES key lives only in `chrome.storage.session`, which stays in memory, is hidden from content scripts, and is cleared when the browser restarts or the extension updates. Keys are never put in `chrome.storage.sync`. |
| **Team server** | Never. The server does not accept keys: settings and sync payloads that look like API keys are rejected on both client and server. |

If you forget the extension passphrase, Settings > Reset keys deletes the encrypted keys. There is no recovery by design.

## What leaves your device, and when

| Data | Leaves the device? |
|---|---|
| Your chats and Claude Code sessions | **No**, in in-chat mode (the default): ReSync sends prompts inside your own chat or session. |
| Conversation text in **API mode** | **Yes, to the provider you chose** (Anthropic, OpenAI, Google, OpenRouter, or your own server), and only when you run a feature in API mode. The CLI prints this on every run; the extension asks before the first send for each feature. |
| Prompt libraries, project colours, non-secret settings | Only to **your team server**, only when you are signed in, and each can be turned off in the extension (Settings > Privacy). |
| Usage | **Numbers only** (tokens, cost estimates, message counts, dates, project names) to your team server when signed in. The shared schema rejects any non-number field, on the client and on the server. |
| Passports, summaries, topic trees | Only when you click **Share** (extension) or run `resync share <file>`, one item at a time. |
| Decision Ledger (decision text and reasons, author, project name, source chat link, status, links between decisions) | **Off by default; this is the one place conversation-derived text syncs without a per-item click (changed 2026-10-21).** It goes to your team server only when **both** your team owner allows ledger sync (dashboard Team page) **and** you turn on "Sync decisions" (extension Settings > Decision Ledger). Before upload ReSync removes API keys, tokens, `password: ...`-style secrets, emails and phone numbers (`scrubSecrets`), and the server removes them again. Without a server, or with either switch off, the ledger stays in your browser. |
| New messages, for the Decision Ledger check | **No**, by default: they are matched against your decisions locally. Only if you set "Decision Ledger checks" to API mode (it asks once) are a message and the decisions it might conflict with sent to **your** provider, and only when the local match finds candidates (rate-limited per chat). |
| Queue report summaries | Only if you turn on `queue.uploadReports`. |
| Telemetry or analytics | **Never.** ReSync has none. The only requests it makes are to the providers you configure and to the team server you choose. |

## Team server protections

- **Sign-in:** GitHub or Google OAuth with `state` + PKCE (S256), or the device-code flow for the CLI and extension.
- **Tokens:** sessions and personal tokens are random 256-bit values stored as **SHA-256 hashes**. Each can be revoked from the dashboard (Team > Signed-in devices). Personal tokens expire after a year, sessions after 14 days.
- **Cookies:** `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Writes authenticated by cookie also require a custom header (`x-resync-csrf`), which blocks cross-site form posts.
- **Requests:** helmet security headers; CORS limited to the dashboard and configured extension origins; rate limits (600 per 15 min per IP, 60 per 15 min on sign-in); 1 MB body limit; input validation (zod) on every route.
- **Logs:** pino logs record method, path, status, timing and user id. They never contain request bodies, prompt text, cookies or tokens; sensitive keys are redacted as defence in depth.
- **Production safety:** the server refuses to start with a weak `SESSION_SECRET` or with the development login on.
- **Data controls:** users can export everything (JSON) and delete their account; owners can delete the team.

## Work queue safety

- Every queued task runs in its **own git worktree** on a **new `resync/<task-id>` branch**. ReSync never checks out, commits to, merges or pushes `main` or any other existing branch, and a guard refuses writes to non-`resync/` branches.
- Tasks get an explicit **tool allowlist** (default: read, edit, run tests). Anything else is denied automatically (`--permission-prompts none`).
- `--skip-permissions` is a **per-task opt-in** that prints a warning and is recorded in the task's report. It is never a default.
- ReSync never calls an AI from inside a Claude Code hook.

## The extension and claude.ai

- The content script only reads and fills the claude.ai page. It never makes provider calls; API mode runs in the background service worker.
- A second, tiny script (`nav-hook.js`) runs in the page's own JavaScript world so ReSync notices in-app navigation (`history.pushState` / `replaceState`). It only fires a `resync:navigate` event on the page; it reads nothing and sends nothing.
- ReSync never sends a message for you unless you ask: the handoff pastes the brief and waits for you to press Send (unless you turn on auto-send), and the ledger banner never writes into the chat on its own.
- Host permission for each AI provider is requested only when you add that provider (optional permissions), never up front.
- The extension is not affiliated with Anthropic, and claude.ai can change at any time. When an expected element is missing, ReSync shows a banner instead of acting blindly.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report privately to the maintainers of the repository you got ReSync from: use GitHub's "Report a vulnerability" (private security advisories) on that repository, or email the maintainer listed there. Include steps to reproduce, the affected component (plugin, CLI, extension, server, dashboard) and the version or commit. We aim to acknowledge reports within 7 days.
