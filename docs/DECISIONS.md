# Decisions

Choices made while building ReSync, newest first. Each records what was decided and why. Facts behind them are in `docs/VERIFIED.md`.

## 2026-10-23: Renamed from Relay to ReSync
- **Requested by the project owner**. Everything was renamed, code included: the `resync` CLI, `/resync:*` plugin commands, `@resync/*` packages, `~/.resync` and `.resync/` folders, `RESYNC_*` env vars, `resync/<task-id>` and queue branches.
- The extension moves data saved under the old `relay.*` storage keys to `resync.*` on install or update (`src/lib/migrate.js`), so a loaded extension keeps its settings, prompts, colours, vault and ledger. The CLI does not migrate automatically: `~/.relay` is referenced by an installed statusline, so moving it is left to the user (see PROGRESS).
- Entries below this one were written before the rename and now use the new names.

## 2026-10-17: Spec change: ReSync works with no API keys
- **Change (requested by the project owner):** spec section 1 gained principle 6: "ReSync must work fully with no API keys. In-chat mode is the default for every AI feature; API mode is optional and off until the user adds a provider."
- **Change:** in section 8 (definition of done), the item "`resync keys test` passes for Anthropic and for an OpenAI-compatible local model, and `resync passport --api` works" was replaced. The new item: the Anthropic, OpenAI, Gemini and OpenRouter adapters pass mocked-HTTP tests, and a real end-to-end test passes with a local model through the OpenAI-compatible adapter (Ollama). If Ollama isn't installed, that one check is marked "needs Ollama" and the build continues.
- **Kept separately:** "`resync passport --api` works" was part of the replaced item. It is kept as its own DoD line, because API mode is still a spec feature (sections 4.2 and 4.3). It is satisfied with the local Ollama model, so no paid key is needed.
- **Effect on the design:**
  - The feature to model map defaults to in-chat mode for every feature, with no provider.
  - Every API-mode entry point (CLI `--api`, extension API mode) returns a clear "API mode is off; add a provider with ..." message instead of failing.
  - Nothing at install, startup or test time requires a key.
  - Real-network tests run only against local Ollama, and are skipped (not failed) when it is unreachable, e.g. in CI.
- **Code impact:** no code assumed an Anthropic key at the time of the change (only the prompt format existed). The plan item that said "Anthropic needs a key" was removed.

## 2026-10-17: Hosting (free tier, Rs 0) and self-hosting
- **Database: MongoDB Atlas M0 (free).** It gives 0.5 GB, 500 connections and 100 ops/s, which is far more than a small team's prompts and usage numbers need. One catch: it auto-pauses after 30 days with no connections.
- **Server and dashboard: one Render free web service.** The Express server also serves the built dashboard, so there is one origin, no CORS needed for the dashboard, and one free service. Render spins down after 15 minutes idle (about 1 minute cold start) and gives 750 hours a month, enough for one always-available service. A cold start is fine here because the CLI and extension work offline and only sync.
- **Ruled out:**
  - Fly.io: no free tier for new organisations.
  - Railway: trial credit only.
  - Vercel Hobby and GitHub Pages: both forbid commercial use, and a startup's internal tool is borderline.
  - Koyeb: a viable fallback (1 free instance, sleeps after 1 h) and documented as an alternative.
- **Self-host:** `docker-compose.yml` runs `mongo` + `resync-server` (which serves the dashboard). Nothing is tied to a hosted URL: every URL comes from env (`.env.example`).

## 2026-10-17: Findings from the live plugin check
- On Windows, Claude Code can run shell commands through its PowerShell tool. A command's `allowed-tools: Bash(node *)` alone did not pre-approve `/resync:tree`'s validator, so it now lists `Bash(node *) PowerShell(node *)`.
- Usage cost per session comes from the statusline snapshot (the SessionEnd input has no cost field, verified). The statusline runs only in interactive sessions, so headless `claude -p` sessions record tokens (from the transcript) but no cost. Queued tasks are unaffected: they record cost from `claude -p --output-format json` (`total_cost_usd`).

## 2026-10-17: Topic tree "Mermaid view" shows Mermaid code, not a rendered diagram
- The side panel shows the tree as a collapsible tree (the visual view) and offers a Mermaid view with the mindmap code plus a Copy button. The CLI and plugin also save it as `.mmd`.
- The `mermaid` library (v12) is several MB and would make every extension build and side panel load much heavier. This build machine is RAM-constrained, and the spec's requirement (a Mermaid view) is met by the code view.
- Rendering in-panel can be added later by lazy-loading mermaid in the Mermaid view only.

## 2026-10-17: Extension in-chat mode reads rendered replies back as Markdown
claude.ai shows replies as HTML, so `src/content/conversation.js#markdownOf` converts headings, lists and code blocks back to Markdown before the shared parsers (passport sections, tree JSON) read them.

## 2026-10-17: Extension build: plain Vite 8, two builds
- `@crxjs/vite-plugin` 3.0.0 (released 2026-09-24) is maintained, but it is a brand-new major whose API I did not verify. Plain Vite is simple, checked locally, and has nothing extra to break.
- Build 1 (`vite.config.js`) produces the side panel page plus the background service worker as an ES module (`"type": "module"` in the manifest). The worker gets the fixed name `background.js`.
- Build 2 (`vite.content.config.js`) produces the content script as a single IIFE file, because content scripts cannot import chunks.
- Vite 8 uses Rolldown. The option is `build.rolldownOptions`; `rollupOptions` is a deprecated alias (checked in Vite's type definitions).
- The extension is named "ReSync" (not "ReSync for Claude"), and its description says it is not affiliated with Anthropic.
- Icons are generated by a dependency-free script (`packages/extension/scripts/make-icons.mjs`).

## 2026-10-17: How synced team prompts reach Claude Code
- Plugin command files are **generated** from the shared templates and the prompt library, so the in-chat text matches the CLI and the extension. The repo's `packages/plugin/commands/` holds the seed prompts and is checked by a test.
- An installed plugin lives in a Claude Code-managed folder that changes on every update (verified), so `resync sync` cannot write there. Instead, `resync plugin build` / `resync sync` maintain a local copy at `~/.resync/claude-plugin` (a local-path marketplace named `resync-local`). `resync plugin install` registers it once. After that, synced prompts show up at the next session or on `/reload-plugins` (verified behaviour for local-path marketplaces).
- Teammates who just want the seed commands can install `resync@resync-team` straight from the repo's marketplace.
- Plugin scripts are dependency-free Node (no `node_modules` in an installed plugin). `scripts/tree.mjs` duplicates the small tree validator, and a test keeps it identical in behaviour to `@resync/shared`.

## 2026-10-17: Plugin hooks: how the passport reminder reaches the user
Verified: Claude Code discards a PreCompact hook's `systemMessage`, so the reminder cannot be shown at compaction time. Instead:
1. The PreCompact hook writes a marker (session id, transcript path, time, trigger) to `~/.resync/compact-markers/`.
2. A SessionStart hook with matcher `compact` (it fires right after compaction) reads the marker and returns `additionalContext` telling Claude to remind the user to run `/resync:passport`.

Neither hook calls an AI. The SessionEnd hook stays under its verified 1.5 s budget by doing one synchronous file append.

## 2026-10-17: Repository root
The spec's `resync/` repo root is this project folder (`Extension/`). The layout under it follows spec section 2 exactly.

## 2026-10-17: Prompt format details
- Frontmatter is parsed with `yaml` (maintained). `gray-matter` was not chosen because it has had no release since 2023.
- Validation uses `zod` 4, which runs in Node and the browser, so the CLI, extension and server share one schema.
- `variables` accepts plain names (`- repo`) or objects (`{ name, description, default }`) and is normalised to objects. A `{{variable}}` used in the body or steps but not declared is a validation error.
- Chain steps: `waitFor: response` sends after the previous reply finishes. `waitFor: timer` also waits `delaySeconds` after the reply finishes. A step is never sent before the previous reply completes (spec section 5.3).

## 2026-10-17: OS keychain library
`@napi-rs/keyring` (actively maintained, Windows/macOS/Linux prebuilds). `keytar` is archived (Dec 2022). Environment variables (`RESYNC_<PROVIDER>_API_KEY`) are the fallback when no keychain is available.

## 2026-10-17: Line endings
`.gitattributes` forces LF. The hook and statusline scripts run under Git Bash on Windows, and CRLF breaks shebang scripts.

## 2026-10-21: Composer detection per page type
The old single list picked the first match anywhere. Now the page type (from the URL) selects an ordered list, and among the first selector's matches ReSync takes the visible one in `main`, never inside navigation, dialogs, or a project page's Instructions / Memory / Context panels (judged by the panel's heading or aria-label). User overrides of `composer` still go first. The health check waits for the composer (up to 8 s, and again if the one it found was the previous page's) before reporting it missing. Fixtures are reconstructed (nobody could sign in from the build machine); a capture script is provided to replace them.

## 2026-10-21: "Sent" means the editor took it
After inserting, ReSync requires the text to be present and the Send button (when there is one) to be enabled within about a second. A disabled Send button means only the DOM changed, which claude.ai would ignore, so ReSync shows the Retry banner and copies the text instead of claiming success.

## 2026-10-21: Decision Ledger choices
- The model is used only when "Decision Ledger checks" is routed to a provider in Feature to model (API mode, with a one-time consent). "In-chat" makes no sense here (ReSync must never post in the chat), so that option is labelled "Local matching only".
- The two ledger prompts (conflict check, same-decision check) do **not** append the shared rules: they are JSON classifiers over decision text, and rules like "mark anything inferred as (assumed)" would corrupt the JSON. Recorded as an intentional exception to spec 3.4.
- Thresholds: merge at Jaccard >= 0.6 over key terms; 0.35 to 0.6 is borderline (model-confirmed only with a provider). Prefilter candidates share two key terms, or one distinctive term (5+ characters) that is a tag of a short decision.
- Only conflicts are shown when the model is used; "related" results are dropped, to keep banners rare. Without a model, at most two candidates show as "Related team decision".
- Rate limit: one model check per chat per 20 s, 12 per hour (local checks are free and unlimited). Dismissals: hidden in that chat; muted everywhere after dismissals in 3 different chats.
- Author: Settings > Decision Ledger name, else the team-server name from the last sync, else "You".
- Sync merge: last write wins by `updatedAt`; local changes not yet pushed always win. Deleting a decision is local only (not propagated to the team server yet).
- Team switch lives on the Team document (`ledgerSync`), so one owner decision covers everyone; each user still has their own switch.

## 2026-10-21: Chat health measures
The meter reads the chat's re-read context (high end of the estimate), turns and attachments, and uses the worst of the three. Defaults (60k / 120k tokens, 40 / 80 turns, 8 / 15 attachments) are rules of thumb that don't depend on a model's window; all six are settings. The first message of a chat started on a project home or new-chat page now continues the same running estimate (it used to be reset when the URL changed to `/chat/<id>`, which also hid it from the ledger check).
