# Setting up ReSync (for teammates)

This guide gets one teammate fully set up: the Claude Code plugin, the `resync` CLI and work queue, the Chrome extension, and (if your team runs one) the team server. It takes about 10 minutes. **No API keys are needed.**

## 0. Before you start

- **Node.js 20 or newer** (`node -v`) and **git**.
- **Claude Code**, if you want the plugin and the work queue (`claude --version`).
- **Google Chrome**, version 116 or newer, for the extension.
- From your team: the **ReSync repository URL**, and (if you have one) the **team server URL** plus an **invite link**.

## 1. Get ReSync and the `resync` command

```sh
git clone <your team's ReSync repo> resync
cd resync
npm install
npm link -w @resync/cli        # makes `resync` available everywhere
resync --help
```
Windows: run these in PowerShell or Git Bash. If `resync` isn't found afterwards, open a new terminal.

## 2. Claude Code plugin

**Option A (recommended): your synced team prompts as commands.**
```sh
resync plugin install
```
This builds a local copy of the plugin in `~/.resync/claude-plugin` and registers it with Claude Code as `resync@resync-local`. Start a new Claude Code session, then try:

- `/resync:prompts`: lists the saved prompts
- `/resync:dev-code-review`: runs a saved prompt (arguments fill its `{{variables}}`)
- `/resync:passport`: writes a handoff brief to `.resync/passports/`
- `/resync:resume`: in a fresh session, continues from the newest passport
- `/resync:tree` and `/resync:summary`

**Option B: just the repo's seed prompts.** Inside Claude Code:
```
/plugin marketplace add <path or GitHub URL of the ReSync repo>
/plugin install resync@resync-team
```

**Statusline (optional):**
```sh
resync statusline install       # model, context used, session cost, today's total (estimates)
```
This edits `~/.claude/settings.json` (a backup is kept). Undo it with `resync statusline uninstall`.

**After compaction:** when Claude Code compacts a long conversation, ReSync asks Claude to remind you to run `/resync:passport`, so nothing important gets lost.

## 3. The Limit-Aware Work Queue

```sh
cd path/to/your/repo
resync queue add "Add input validation to the signup form" --prompt dev-code-review
resync queue list
resync queue run --at 02:00     # waits until 2am, then runs every task
```
- Each task runs `claude -p` inside its own git worktree on a new `resync/<task-id>` branch. ReSync never touches `main`, never merges and never pushes. Review the work with `git log resync/<task-id>`.
- **Tools:** by default a task can read, edit and run tests (`Bash(npm test *)` and similar). Change that with `--tools "Read,Edit,Bash(pnpm test *)"`. The `--skip-permissions` flag lets a task use any tool. It is a per-task opt-in and prints a warning.
- **Usage limits:** if a task hits one, it waits (`waiting-for-reset`) and retries after the reset time. With no reset time it backs off: 15 min, then 30, up to 2 h. Use `resync queue watch` to keep going all night.
- **Reports:** each task leaves a report in `<repo>/.resync/queue-reports/<task-id>.md` and a log in `~/.resync/logs/`.
- **Usage tables:** `resync usage` (all figures are estimates).

## 4. Chrome extension

```sh
npm run build -w @resync/extension
```
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose `packages/extension/dist`.
4. Open claude.ai and click the **ReSync** toolbar icon: the side panel opens.

Try:

- **Prompts:** search, then **Insert** (fills `{{variables}}`). Or type `;;` in the claude.ai message box.
- **Chain:** run a multi-step prompt. Each step waits for Claude's reply to finish. You can pause, skip or cancel.
- **Passport & more:** passport, topic tree and summary (**Play aloud**).
- **Colours:** colour-code projects and chats in the sidebar.
- **Usage:** your 7-day estimate chart.

If you see a banner saying ReSync "can't find" something, claude.ai has changed. Tell whoever maintains ReSync; selectors can also be adjusted under Settings > Advanced.

## 5. Optional: API mode (your own model and key)

ReSync works without keys. To use your own provider for passports, trees and summaries (no messages are added to your chat, but the conversation text is sent to that provider):

- **CLI:** `resync keys set anthropic` (or `openai`, `gemini`, `openrouter`), then e.g. `resync feature passport --mode api --provider anthropic`. Check it with `resync keys test`. For a free local model, run `resync provider add local --type openai-compatible --base-url http://localhost:11434/v1 --model qwen2.5-coder:7b`.
- **Extension:** Settings > API keys (choose a passphrase), then Settings > Providers > Add, then Feature to model.

Details: [PROVIDERS.md](PROVIDERS.md).

## 6. Join your team server (if your team has one)

1. Open the **invite link** your team owner sent, sign in, and click **Join**.
2. Connect the CLI:
   ```sh
   resync config set serverUrl https://resync.yourteam.example
   resync login           # open the link it prints and approve the code
   resync sync            # pulls team prompts (regenerates /resync: commands) and uploads usage numbers
   ```
   Then run `/reload-plugins` in Claude Code to see newly synced team prompts.
3. Connect the extension: Settings > Team server > enter the URL > **Save** (allow access), then **Sign in to the team server** and approve the code in the tab that opens. It syncs every 30 minutes, or press **Sync now**.
4. To share overnight queue reports with the team: `resync config set queue.uploadReports true`.

What syncs: prompt libraries, project colours, settings, and usage **numbers**. Conversations never sync. A passport or summary is shared only when you click **Share**. API keys never leave your device.

## Troubleshooting

| Problem | Fix |
|---|---|
| `/resync:...` commands don't appear | Start a new Claude Code session or run `/reload-plugins`; check `claude plugin list`. |
| Queue says Claude Code not found | Make sure `claude --version` works in the same terminal, or set `resync config set queue.claudeCommand "C:/path/to/claude.exe"`. |
| `resync login` says local-only | Set the server first: `resync config set serverUrl <url>`. |
| Extension API mode can't reach Ollama | Start Ollama with `OLLAMA_ORIGINS=chrome-extension://*` so it accepts the extension's requests. |
| Statusline shows nothing | Run `resync statusline install` again, then send a message in Claude Code (the line refreshes on new messages). |
