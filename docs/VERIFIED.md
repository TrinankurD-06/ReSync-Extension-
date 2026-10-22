# Verified external interfaces

Everything ReSync relies on from outside this repo was checked against current official documentation on **2026-10-17** (spec section 0).
Each fact below carries its source URL. Items marked [PROBE] were observed with a live request (an invalid key or a CORS preflight). Items marked UNVERIFIED / NOT verified were not confirmed, and the code treats them defensively.
Local tool versions at verification time: Claude Code 2.1.301, Node 24.10.0, npm 11.6.1, git 2.51, Docker 29.8, Ollama (models qwen2.5-coder:7b, llama2).

## Consequences for the build (summary)

**Claude Code**
- The plugin lives at `packages/plugin` with `.claude-plugin/plugin.json` (`name: "resync"`, so commands are `/resync:<name>`). The root `.claude-plugin/marketplace.json` points at it with a relative `./packages/plugin` source.
- Commands use `commands/*.md`, which is still supported, flat, and what the spec asks for. Arguments are 0-based (`$0`), and `$ARGUMENTS` holds them all.
- PreCompact cannot show a message to the user (its `systemMessage` is discarded). So the hook writes a marker file, and a `SessionStart` hook with matcher `compact` injects the "run /resync:passport" reminder via `additionalContext`. No AI call happens in any hook.
- The SessionEnd budget is 1.5 s, and plugin hook timeouts don't raise it. The hook appends one usage line synchronously, which is fast, and does nothing else.
- A plugin cannot set the main `statusLine`. `resync statusline install` writes the user's `~/.claude/settings.json` entry, with a backup.
- Statusline fields used: `model.display_name`, `context_window.used_percentage`, `context_window.context_window_size`, `context_window.total_input_tokens`, `context_window.total_output_tokens`, `cost.total_cost_usd`, `session_id`, `workspace.project_dir`, `cwd`. Fields can be absent or null, so the script handles that.
- Headless: `claude -p --output-format json --allowedTools "<rules>"`, spawned with `cwd` set to the worktree (there is no `--cwd` flag). The result fields are `result`, `is_error`, `subtype`, `total_cost_usd`, `usage`, `session_id`. Error subtypes have no `result`.
- Limit strings (e.g. "You've hit your session limit · resets 3:45pm") become the default detection patterns in `~/.resync/config.json`.
- The transcript JSONL format is internal and changes between versions. `resync passport --api` reads it defensively (text content of user and assistant entries only) and supports `--from-file`.

**Providers**
- Anthropic: `x-api-key` + `anthropic-version: 2023-06-01`, top-level `system`, `max_tokens` required, no temperature. Read only text blocks and skip thinking. The stream ends at `message_stop`. The extension also sends `anthropic-dangerous-direct-browser-access: true`.
- OpenAI: system prompt as `role: "developer"`, `max_completion_tokens`, `stream_options.include_usage`. Billing errors come back as 429 with codes like `credit_balance_exhausted` / `insufficient_quota`.
- Gemini: `x-goog-api-key` header, roles `user`/`model`, `systemInstruction`, `generationConfig.maxOutputTokens`. Skip `thought` parts. An invalid key returns 400 `API_KEY_INVALID`, which maps to `auth`.
- OpenRouter: OpenAI shape. Skip `:` comment lines. Errors can arrive inside a 200 stream. Context overflow shows as `error.metadata.error_type`. 402 means credits are used up.
- OpenAI-compatible (Ollama `http://localhost:11434/v1`, LM Studio `http://localhost:1234/v1`): the key is optional. For browser use, Ollama needs `OLLAMA_ORIGINS=chrome-extension://*`.
- TTS: OpenAI `/v1/audio/speech` (`gpt-4o-mini-tts`, voice `marin`, input max 4096 chars).

**Chrome / platform**
- The side panel needs Chrome 114+. Keys are vaulted with PBKDF2-SHA256 at 600,000 iterations (OWASP) and AES-GCM-256 with a fresh 12-byte IV. The unlocked key lives in `storage.session`, which is cleared on browser restart and on extension update or reload.
- Provider origins go in `optional_host_permissions`, requested on a user gesture when a provider is added. All provider fetches happen in the service worker.
- Keychain: `@napi-rs/keyring` 2.1.1. Hosting: MongoDB Atlas M0 + Render free (see DECISIONS.md). OAuth: GitHub + Google endpoints as recorded below.

**claude.ai page structure: NOT verified.** claude.ai needs a signed-in browser, and its markup is undocumented and changes without notice. The selectors in `packages/extension/src/lib/selectors.js` are best-effort fallback lists. Users can override them in Settings, and a health-check banner appears when a required element is missing. They must be checked by hand in a signed-in Chrome during the final extension check before release.

---

## Part: Verified Claude Code facts (fetched 2026-10-17, local CLI 2.1.301)

Every fact below was read from an official page fetched today (code.claude.com/docs). Short URL forms used:
- [MANIFEST] https://code.claude.com/docs/en/plugins-reference (serves "Plugin manifest reference"; canonical /docs/en/plugins/manifest-reference)
- [MKT-CREATE] https://code.claude.com/docs/en/plugin-marketplaces (serves "Create a marketplace")
- [MKT-REF] https://code.claude.com/docs/en/plugins/marketplace-reference
- [SKILLS] https://code.claude.com/docs/en/slash-commands and https://code.claude.com/docs/en/skills (the slash-commands URL now serves the Skills page)
- [HOOKS] https://code.claude.com/docs/en/hooks
- [STATUS] https://code.claude.com/docs/en/statusline
- [HEADLESS] https://code.claude.com/docs/en/headless
- [CLI] https://code.claude.com/docs/en/cli-reference
- [SDK-TS] https://code.claude.com/docs/en/agent-sdk/typescript
- [COST] https://code.claude.com/docs/en/agent-sdk/cost-tracking
- [SESSIONS] https://code.claude.com/docs/en/sessions
- [WORKFLOWS] https://code.claude.com/docs/en/common-workflows
- [ERRORS] https://code.claude.com/docs/en/errors
- [HELP] = local `claude --help` / `claude plugin --help` output (v2.1.301)

---

### 1. Plugins

### Layout and manifest
- The manifest goes in `.claude-plugin/plugin.json` and is **optional**. Without it, components load from the standard layout, and the name comes from the marketplace entry or the directory name. [MANIFEST]
- "Put every other plugin file at the plugin root, not inside `.claude-plugin/`. That includes `skills/`, `commands/`, and `hooks/`." [MANIFEST]
- `name` is the only required field. It must be kebab-case, with no spaces, `@`, `:` or path separators. "Every component is namespaced under it." [MANIFEST]
- Reserved plugin names: a name that starts with `claude-`, `anthropic-`, `anthropics-` or `cc-plugin-` is an **error**. So are the exact names `claude`, `anthropic`, `claude-code` and `claude-mods`, and any name that puts `official` beside claude or anthropic. A name with `claude` as a whole word anywhere else (e.g. `mcp-for-claude`) is a **warning**. [MANIFEST]
- Other fields: `$schema`, `displayName`, `version` (pins users until you change it), `description`, `author{name(required),email,url}`, `homepage` (the plugin fails to load if this isn't a valid URL), `repository`, `license`, `keywords`, `metadata`, `defaultEnabled` (default true), `dependencies`, `settings`, `userConfig`, `channels`, `skills`, `commands`, `agents`, `hooks`, `mcpServers`, `lspServers`, `outputStyles`, `workflows`, `experimental{themes,monitors,evals}`. Unknown top-level keys are stripped and reported as a validate warning. [MANIFEST]
- Component paths must start with `./`, must stay inside the plugin root (no `..`) and must exist. [MANIFEST]
- How each manifest key combines with its default folder: `commands`, `agents`, `outputStyles` and `workflows` **replace** the default folder scan. `skills` **adds** to `skills/`. `hooks`, `mcpServers` and `lspServers` **merge** with the default file. [MANIFEST]
- Standard layout (verbatim tree, trimmed): [MANIFEST]
```text
deploy-tools/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   └── deploy/
│       └── SKILL.md
├── commands/
│   └── status.md
├── agents/
│   └── reviewer.md
├── hooks/
│   └── hooks.json
├── bin/
│   └── deploy-tool
├── scripts/
│   └── format.sh
├── settings.json
├── .mcp.json
└── .lsp.json
```
- Standard-layout table row for commands: "`commands/` | Flat Markdown command files. **Prefer `skills/` for new plugins**". `bin/` files are on the Bash tool's PATH while the plugin is enabled, but claude.ai and Cowork won't install a plugin that has `bin/`. [MANIFEST]
- `scripts/` has no special meaning. It is just a folder that hooks call through `${CLAUDE_PLUGIN_ROOT}`. [MANIFEST]
- A `CLAUDE.md` at the plugin root is NOT loaded. Validate warns about it. [MANIFEST]
- Validate a plugin with `claude plugin validate ./my-plugin` (`--strict` turns warnings into failures). [MANIFEST]
- The `commands` key can also be an object map, `{ "about": { "content": "...", "description": "..." } }` or `{ "status": { "source": "./commands/status.md", "argumentHint": "[env]" } }`. Map entries take the fields source|content, description, argumentHint, model and allowedTools. [MANIFEST]

### Variables
- `${CLAUDE_PLUGIN_ROOT}` is the absolute path of the installed plugin version. It **changes on update**, so don't write state there. [MANIFEST]
- `${CLAUDE_PLUGIN_DATA}` is `~/.claude/plugins/data/<id>/`. It persists across updates and is deleted on the last uninstall unless you pass `--keep-data`. [MANIFEST]
- `${CLAUDE_PROJECT_DIR}` is the project root. [MANIFEST]
- Hook commands: `${...}` resolves anywhere in `command`/`args`. The hook process also receives `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR` and `CLAUDE_PLUGIN_OPTION_<KEY>` as env vars. In skill, command and agent Markdown, `${...}` is substituted inline. [MANIFEST]
- The variables are NOT in the environment of the Bash tool's commands. [MANIFEST]
- In shell-form hooks, quote the variable: `"\"${CLAUDE_PLUGIN_ROOT}\"/scripts/format.sh"`. On Windows the substituted paths use forward slashes. [MANIFEST]

### Namespacing
- Plugin skills and commands run as `/plugin-name:skill-name`, e.g. `my-plugin/skills/review/SKILL.md` becomes `/my-plugin:review`. Agents are namespaced the same way: `deploy-tools:reviewer`. [SKILLS][MANIFEST]
- An object-map command key `"about"` in plugin `deploy-tools` runs as `/deploy-tools:about`. [MANIFEST]

### commands/ vs skills/
- "Custom commands have been merged into skills." A command file at `.claude/commands/deploy.md` and a skill at `.claude/skills/deploy/SKILL.md` both create `/deploy`. "Your existing `.claude/commands/` files keep working." [SKILLS]
- "a Markdown file in `.claude/commands/` is the older format and still works... Prefer a skill for new work, since skills also support supporting files." [SKILLS]
- **Verdict:** `commands/` is still supported. `skills/<name>/SKILL.md` is preferred.

### Plugin settings / statusline
- A plugin's `settings.json` at its root (or the `settings` key) applies **only `agent` and `subagentStatusLine`**. Other keys are dropped. [MANIFEST]
- "Plugins can ship a default `subagentStatusLine` in their settings.json" [STATUS]
- **Conclusion:** a plugin CANNOT ship the main `statusLine`. The user must set `statusLine` in their own settings.json (or run `/statusline`). A plugin can only ship the script, and a skill or command could instruct the user (or Claude) to edit settings.

### Marketplace
- File: `.claude-plugin/marketplace.json` at the marketplace root. **Required: `name`, `owner` (`name` required; `email` and `url` optional), `plugins`.** Optional: `$schema`, `description`, `version`, `metadata.description`, `metadata.version`, `metadata.pluginRoot` (v2.1.239+), `forceRemoveDeletedPlugins`, `allowCrossMarketplaceDependenciesOn`, `renames`. [MKT-REF]
- Marketplace name rules: letters, digits, `.`, `_` and `-`, starting with a letter or digit, and no `..`. Reserved names include `claude-plugins-official`, `claude-code-marketplace`, `anthropic-plugins`, `agent-skills` and others, plus anything that impersonates them or starts with `claudeai-`. `npm`, `github`, `gh`, `inline`, `builtin`, `skills-dir` and `synced` are also reserved. [MKT-REF]
- Plugin entry fields: `name` and `source` are required. Optional: `description`, `version`, `category`, `tags`, `strict` (default true), `dependencies`, `defaultEnabled`, `displayName`, `metadata`, plus any plugin.json field. [MKT-REF]
- **Keep the entry `name` equal to the plugin.json `name`.** The entry name is the install id. The manifest name is the skill prefix. [MKT-CREATE]
- Verbatim example: [MKT-CREATE]
```json
{
  "name": "my-marketplace",
  "description": "Plugins for my team",
  "owner": {
    "name": "Your Name"
  },
  "plugins": [
    {
      "name": "my-first-plugin",
      "source": "./plugins/my-first-plugin",
      "description": "A greeting plugin to learn the basics"
    }
  ]
}
```
- Source forms: [MKT-REF]
  - Relative path `"./plugins/x"` (must start `./`, resolved from the marketplace root, i.e. the directory containing `.claude-plugin/`). `"."` means the root itself, so the plugin can be the repository itself. Relative paths do NOT work when the marketplace was added by a direct `url` to marketplace.json.
  - `{ "source": "github", "repo": "owner/repo", "ref": "v2.0.0", "sha": "<40 hex>" }`
  - `{ "source": "url", "url": "https://.../x.git", "ref": "main" }`
  - `{ "source": "git-subdir", "url": "owner/repo or git URL", "path": "tools/x" }`
  - `{ "source": "npm", "package": "@org/x", "version": "^2.0.0", "registry": "https://..." }`
  - `{ "source": "archive", "url": "https://...zip", "sha256": "..." }` (v2.1.224+)
  - `{ "source": "command", "command": "...", "timeout": 120 }` (v2.1.229+)
- Add a marketplace and install. Shell: `claude plugin marketplace add ./my-marketplace` (or `owner/repo`, `owner/repo@ref`, a git URL, or a URL to marketplace.json), then `claude plugin install my-first-plugin@my-marketplace`. In-session: `/plugin marketplace add ./my-marketplace`. `/plugin install name@mkt` opens the details panel, where you install. Also `/reload-plugins`, `claude plugin list`, `claude plugin details <name>`, `claude plugin marketplace remove <name>`. [MKT-CREATE][MKT-REF]
- For a local-path marketplace with relative sources, edits take effect at the next session start or `/reload-plugins` without a version bump. [MKT-CREATE]
- Dev loop without a marketplace: `claude --plugin-dir ./my-plugin` (repeatable, also accepts a .zip). [CLI][HELP]
- `claude plugin init <name>` scaffolds into `~/.claude/skills/<name>/`, loaded as `<name>@skills-dir`. [HELP]

### 2. Slash command / skill files

Frontmatter fields (all optional; `description` recommended): [SKILLS]
- `name`, `description`, `when_to_use`, `argument-hint` (e.g. `[issue-number]`), `arguments` (named positional args, used as `$name`)
- `disable-model-invocation` (true means only the user can invoke; default false)
- `user-invocable` (false hides the skill from the / menu; default true)
- `allowed-tools` (e.g. `allowed-tools: Bash(git add *) Bash(git commit *) Bash(git status *)`)
- `model`, `effort` (low|medium|high|xhigh|max), `context: fork`, `agent`
- also `hooks`, `paths`, `shell`, `metadata`, `license`, `compatibility`, `disallowed-tools`, `background`

Arguments: [SKILLS]
- `$ARGUMENTS` holds all args. If no placeholder appears in the file, Claude Code appends `ARGUMENTS: <value>`.
- `$ARGUMENTS[N]` is **0-based**, and `$N` is shorthand: `$0` is the first arg and `$1` is the second. Quoting groups words: `/my-skill "hello world" second` gives `$0`=`hello world` and `$1`=`second`. Escape `\$1.00`.
- Other substitutions: `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, and in plugin skills only `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}`.

Bash injection: [SKILLS]
- `` !`command` `` runs before the content reaches Claude, and its output replaces the placeholder. Example: `` - PR diff: !`gh pr diff` ``. Multi-line form: a fenced block opened with ` ```! `.
- The `!` must start a line or follow whitespace. A failed command aborts the invocation. Commands are checked against permission rules and **don't prompt**, so a command that isn't allowed aborts unless `allowed-tools` pre-approves it. Deny rules still win. The `disableSkillShellExecution: true` setting disables injection.
- This means a command CAN inject file contents via `` !`cat path` `` when `allowed-tools: Bash(cat *)` is set.

@file: [WORKFLOWS][SKILLS]
- In prompts, `@src/utils/auth.js` includes the file content when it fits the Read tool limit (25,000 tokens by default). Text files over 256KB aren't included. Directory references show listings. @ references also add the CLAUDE.md files of that directory and its parents.
- For skills, the Skills page says only that synced claude.ai skills on other machines "don't attach the files that `@` references name **the way it does for a local skill**". This implies local skill and command bodies attach `@path` references. The exact semantics inside SKILL.md are not separately documented.

### 3. Hooks

- **Event list (33)**: SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult, SessionEnd. [HOOKS]
- Matchers: [HOOKS]
  - PreCompact and PostCompact: `manual` (`/compact`) or `auto` (auto-compact window and idle compaction).
  - SessionStart: `startup`, `resume` (`--resume`/`--continue`/`/resume`), `clear`, `compact`, `fork`.
  - SessionEnd: `clear`, `resume`, `logout`, `prompt_input_exit`, `other` (`bypass_permissions_disabled` was removed in v2.1.234).
- Common input fields: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `effort`, `hook_event_name` (plus `agent_id` and `agent_type` in subagents). [HOOKS]

PreCompact input (verbatim). For manual compaction, `custom_instructions` is whatever the user passed to `/compact`, or null. For auto it is always null. [HOOKS]
```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "PreCompact",
  "trigger": "manual",
  "custom_instructions": null
}
```
- PreCompact: exit 2, or JSON `"decision": "block"`, **blocks compaction**. For a manual compaction, stderr is shown to the user. **"Claude Code discards a PreCompact hook's `systemMessage` and `continue` fields."** [HOOKS]

PostCompact input (verbatim). PostCompact has no decision control, and its systemMessage and continue are discarded. [HOOKS]
```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "PostCompact",
  "trigger": "manual",
  "compact_summary": "Summary of the compacted conversation..."
}
```

SessionEnd input (verbatim): [HOOKS]
```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "SessionEnd",
  "reason": "other"
}
```
- SessionEnd has no decision control, and Claude Code discards its JSON output, systemMessage included. Exit 2 shows stderr to the user only. [HOOKS]
- **The default SessionEnd timeout is 1.5 seconds** (on exit, `/clear` and interactive `/resume`). A per-hook `timeout` raises the overall budget up to 60s, **but "Timeouts set on plugin-provided hooks don't raise the budget."** `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` overrides the budget. A plugin should therefore do fast work in SessionEnd, e.g. spawn a detached process. [HOOKS]
- SIGTERM on `claude -p` still runs SessionEnd hooks. [HEADLESS]

SessionStart input example (resume case, verbatim). `source` is one of startup|resume|clear|compact|fork. Optional fields: `model`, `agent_type`, `session_title`. [HOOKS]
```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "SessionStart",
  "source": "resume",
  "model": "claude-opus-5",
  "seconds_since_last_response": 5400,
  "context_tokens": 182340,
  "prompt_cache_likely_expired": true,
  "estimated_cache_write_usd": 1.1396
}
```
SessionStart output (verbatim). Plain-text stdout from a SessionStart hook is also added to Claude's context. [HOOKS]
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Current branch: feat/auth-refactor\nUncommitted changes: src/auth.ts, src/login.tsx\nActive issue: #4211 Migrate to OAuth2",
    "sessionTitle": "auth-refactor"
  }
}
```
- `CLAUDE_ENV_FILE` is available in SessionStart, Setup, CwdChanged and FileChanged hooks. Append `export` lines to it. It is not available to PowerShell hooks. [HOOKS]

Output semantics: [HOOKS]
- Exit 0: stdout is parsed as JSON if it is a single JSON object, otherwise it is treated as plain text. Plain stdout goes only to the debug log, **except** for UserPromptSubmit, UserPromptExpansion, SessionStart and PostModelSwitch, where it is added as context Claude sees.
- Exit 2: a blocking error on events that can block, with stderr as the reason. Per event: PreCompact blocks compaction. SessionEnd and SessionStart show stderr to the user only.
- Other exit codes: a non-blocking error. The transcript shows a `<hook name> hook error` notice with the first line of stderr.
- JSON fields:
  - `continue` (false stops Claude) and `stopReason` (shown to the user)
  - `suppressOutput` (accepted but has no effect)
  - `systemMessage` ("warning shown to the user", but discarded for PreCompact, PostCompact, SessionEnd, Setup, Notification and others)
  - `hookSpecificOutput{hookEventName, additionalContext}`
- additionalContext is supported for SessionStart, SubagentStart, UserPromptSubmit, UserPromptExpansion, PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Stop, SubagentStop and PostModelSwitch.
- **Implication:** neither PreCompact nor SessionEnd can display a message to the user on success. Use a side effect (file write), or surface the result at the next SessionStart through additionalContext.

Config format. Default command-hook timeout is 600 s. Plugin `hooks/hooks.json` wraps the events in a top-level `"hooks"` key and may add a `"description"`. A file without the wrapper fails to load. [HOOKS][MANIFEST]
```json
{
  "description": "Automatic code formatting",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/format.sh",
            "args": [],
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### 4. Statusline

- The config goes in user `~/.claude/settings.json` or project settings. `padding` defaults to 0. Optional `refreshInterval` re-runs the command every N seconds (minimum 1). [STATUS]
```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh",
    "padding": 2
  }
}
```
- When it runs: at session start or resume, on each new assistant message, when `/compact` finishes, on permission-mode change, on vim toggle, on a command change, on the refreshInterval timer, and when a rate-limit `resets_at` or cache `expires_at` passes. Updates are debounced at 300ms, and an in-flight run is cancelled by a newer one. Multi-line output and ANSI colors are OK. The script must read `COLUMNS` and `LINES` from env because `tput` can't see the terminal. It uses no API tokens. [STATUS]
- **Windows:** the command runs through Git Bash if it is installed, otherwise PowerShell. Use forward slashes in paths, e.g. `"command": "powershell -NoProfile -File C:/Users/username/.claude/statusline.ps1"`. [STATUS]
- Full stdin JSON (verbatim from the docs "Full JSON schema"): [STATUS]
```json
{
  "cwd": "/current/working/directory",
  "session_id": "abc123...",
  "session_name": "my-session",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/path/to/transcript.jsonl",
  "model": { "id": "claude-opus-5-5", "display_name": "Opus" },
  "workspace": {
    "current_dir": "/current/working/directory",
    "project_dir": "/original/project/directory",
    "added_dirs": [],
    "git_worktree": "feature-xyz",
    "repo": { "host": "github.com", "owner": "anthropics", "name": "claude-code" }
  },
  "version": "2.1.90",
  "output_style": { "name": "default" },
  "cost": {
    "total_cost_usd": 0.01234,
    "total_duration_ms": 45000,
    "total_api_duration_ms": 2300,
    "total_lines_added": 156,
    "total_lines_removed": 23
  },
  "context_window": {
    "total_input_tokens": 15500,
    "total_output_tokens": 1200,
    "context_window_size": 200000,
    "used_percentage": 8,
    "remaining_percentage": 92,
    "current_usage": {
      "input_tokens": 8500,
      "output_tokens": 1200,
      "cache_creation_input_tokens": 5000,
      "cache_read_input_tokens": 2000
    }
  },
  "exceeds_200k_tokens": false,
  "prompt_cache": {
    "warm": true, "caching_observed": true, "ttl": "1h", "expires_at": 1738429200,
    "requests": 14, "misses": 2, "expected_rebuilds": 1, "hit_ratio": 0.91,
    "cache_write_tokens": 352000, "miss_recache_tokens": 310200, "last_miss_at": 1738425230,
    "last_miss_cause": { "causes": ["tools_changed"], "tools_added": 2, "tools_removed": 0 },
    "miss_causes": { "tools_changed": 2 },
    "recache_tokens_if_cold": 45000
  },
  "fast_mode": false,
  "effort": { "level": "high" },
  "thinking": { "enabled": true },
  "rate_limits": {
    "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
    "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 },
    "spend_limit": { "used_percentage": 62.8, "resets_at": 1740787200, "used_usd": 314.12, "limit_usd": 500, "period": "monthly" }
  },
  "vim": { "mode": "NORMAL" },
  "agent": { "name": "security-reviewer" },
  "pr": { "number": 1234, "url": "https://github.com/anthropics/claude-code/pull/1234", "review_state": "pending" },
  "worktree": {
    "name": "my-feature", "path": "/path/to/.claude/worktrees/my-feature",
    "branch": "worktree-my-feature", "original_cwd": "/path/to/project", "original_branch": "main"
  }
}
```
(Nesting is identical to the docs. Short objects were collapsed onto single lines for length; the keys and values are unchanged.)
- Field notes: [STATUS]
  - `used_percentage` is input-only: input + cache_creation + cache_read.
  - `context_window_size` is 200000 by default, or 1000000 for extended-context models.
  - `exceeds_200k_tokens` is a fixed 200k threshold on the last response's total tokens.
  - `cost.total_cost_usd` is a client-side estimate and resets on `/clear`.
  - `total_duration_ms` is wall-clock time and accumulates across resumes.
  - `total_input_tokens` and `total_output_tokens` are **current context**, from the most recent response, not session-cumulative. Both are 0 before the first response.
- May be absent: `session_name`, `prompt_id`, `workspace.git_worktree`, `workspace.repo`, `effort`, `vim`, `agent`, `pr`, `worktree`, `rate_limits` (Pro and Max only, after the first response, and each window independently), `prompt_cache`. [STATUS]
- May be null: `context_window.current_usage` (before the first call and right after `/compact`), and `used_percentage`/`remaining_percentage` early in a session. [STATUS]
- **A plugin can't set the main statusLine.** See section 1. [MANIFEST][STATUS]

### 5. Headless (`claude -p`)

- `--output-format text|json|stream-json` works only with -p. stream-json needs `--verbose`. `--include-partial-messages` streams tokens. The last stream line is a `result` message. [HEADLESS][CLI]
- JSON result fields: `jq -r '.result'` gives the text, `.session_id` the session, and `.structured_output` the output when `--json-schema` is used. The payload includes `total_cost_usd` and a per-model breakdown. With `--continue`/`--resume`, the cost is the whole conversation's total. [HEADLESS]
- Result type (SDKResultMessage, verbatim key list; `--output-format json` returns this object): [SDK-TS]
  - success arm: `type:"result"`, `subtype:"success"`, `uuid`, `session_id`, `duration_ms`, `duration_api_ms`, `is_error`, `api_error_status?`, `num_turns`, `result`, `stop_reason`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, `structured_output?`, `terminal_reason?`, and more optional timing fields.
  - error arm: `subtype` is one of `"error_max_turns" | "error_during_execution" | "error_max_budget_usd" | "error_max_structured_output_retries"`, with the same cost and usage fields plus `errors: string[]` and `startup_failure_reason?`. **The error arm has no `result` field.**
- `usage` excludes subagents. `total_cost_usd` and `modelUsage` include them. All are estimates. [COST]
- Exit code: 0 on success, non-zero on failure. A failure inside the run, such as missing auth, is printed as the result on stdout. Invalid flags go to stderr. SIGTERM exits 143. [HEADLESS]
- `--allowedTools` / `--allowed-tools` use permission rule syntax, comma- or space-separated: `"Bash,Read,Edit"`, `"Bash(git diff *),Bash(git log *),Bash(git commit *)"`. "The trailing ` *` enables prefix matching... The space before `*` is important." [HEADLESS][CLI][HELP]
- **Unverified for 2.1.301:** the older `Bash(npm test:*)` colon form. It is not shown on any page fetched; current docs use `Bash(npm test *)`.
- `--disallowedTools`: a bare name removes the tool. A scoped rule like `Bash(rm *)` denies only matching calls. [CLI]
- `--permission-mode` takes `default` (alias `manual`), `acceptEdits`, `plan`, `auto`, `dontAsk` or `bypassPermissions`. `--dangerously-skip-permissions` is the same as `--permission-mode bypassPermissions`. `--permission-prompts none` (v2.1.259+) auto-denies anything that would prompt. [CLI][HELP]
- `--max-turns N`: print mode only, errors out when the limit is reached, and has no limit by default. [CLI] The flag is NOT listed in local `claude --help`, but the CLI ref says "`claude --help` does not list every flag".
- `--max-budget-usd`: print mode only. [CLI]
- `--append-system-prompt "..."` and `--append-system-prompt-file path` append to the default prompt. `--system-prompt` and `--system-prompt-file` replace it. All work in interactive and -p modes. [CLI]
- Caveat: the system prompt is recorded on the first request and reused on `--resume`/`--continue` until compaction. `--system-prompt-snapshot off` disables that. [CLI]
- `--model sonnet|opus|haiku|fable|<full id>`. [CLI]
- `-c/--continue` resumes the most recent conversation in the current directory. Interactive `--continue` skips -p and SDK sessions, but `claude -p --continue` includes them. [CLI]
- `-r/--resume <id|name|abs path to .jsonl>`. `--fork-session` gives the resumed session a new ID. `--session-id <uuid>` sets an ID. `-n/--name`. [CLI][SESSIONS]
- **There is no `--cwd` flag for `claude`.** The working directory is the process cwd, so set it by spawning in that directory. `--add-dir` grants additional dirs. `--cwd` exists only on `claude agents` as a filter. [CLI][HELP]
- Also available: `--bare` (skips hooks, plugins, CLAUDE.md, MCP; requires ANTHROPIC_API_KEY or apiKeyHelper, not OAuth), `--no-session-persistence`, `--json-schema`, `--settings`, `--plugin-dir`, `--tools`. [HEADLESS][CLI]
- Usage-limit messages. Documented interactive strings, verbatim: [ERRORS]
  - `You've hit your session limit · resets 3:45pm`
  - `You've hit your weekly limit · resets Mon 12:00am`
  - `You've hit your Opus limit · resets 3:45pm`
  - `You've hit your Sonnet limit · resets 3:45pm`
  - Others: `Server is temporarily limiting requests`, `Request rejected (429)`, `Credit balance is too low`, `You've hit your monthly spend limit`.
  - The stream-json `system/api_retry` event's `error` field takes values like `rate_limit`, `overloaded`, `billing_error`, etc. [HEADLESS]
  - The exact -p/JSON shape of a usage-limit failure was NOT found. Presumably it is a result with `is_error:true` and the message in `result`, but this is unverified.

### 6. Starting a primed session (/resume-style feature)

- `claude "query"` starts an interactive session with an initial prompt. `claude -r "<session>" "query"` resumes and sends a prompt. [CLI]
- `claude --append-system-prompt-file ./ctx.md` (interactive or -p) injects content into the system prompt. Beware the snapshot-on-resume rule. [CLI]
- A SessionStart hook can inject `additionalContext`, or plain stdout, at startup, resume, clear or compact. SessionStart hookSpecificOutput can also "supply the first user message", but the field name was not captured. [HOOKS]
- A slash command or skill can inject file contents via `` !`cat file` `` (needs `allowed-tools: Bash(cat *)`), via `@path` references (implied for local skills), or by telling Claude to Read the path. `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_SESSION_ID}` are substituted inline. [SKILLS][WORKFLOWS]
- In -p mode, "User-invoked skills and custom commands work. Include `/skill-name` in the prompt string." [HEADLESS]

### 7. Transcript JSONL

- Path: `~/.claude/projects/<project>/<session-id>.jsonl`. `<project>` is the cwd path with non-alphanumeric characters replaced by `-`, truncated to 200 characters plus a hash if longer. `CLAUDE_CONFIG_DIR` moves it. Default retention is 30 days (`cleanupPeriodDays`). [SESSIONS]
- "Each line is a JSON object for a message, tool use, or metadata entry. **The entry format is internal to Claude Code and changes between versions**, so scripts that parse these files directly can break on any release. To build on session data, use `/export` or the script interfaces instead." [SESSIONS]
- Recommended alternatives: `claude -p --resume <id> --output-format json "summarize..." | jq -r .result`, the `transcript_path` field from hooks or statusline, a SessionEnd hook that archives the transcript, or the Agent SDK. [SESSIONS]
- Session totals are saved to the transcript on normal exit and restored on resume (v2.1.277+). [COST]

### NOT verified / gaps
- The per-line JSONL schema (type, uuid, parentUuid, message, etc.). The docs deliberately leave it undocumented and say it may change.
- The `Bash(cmd:*)` colon syntax is still accepted in 2.1.301 (only the space-star form is documented now).
- The exact JSON emitted by `claude -p --output-format json` on a usage-limit or rate-limit failure. No verbatim example was found.
- A verbatim full example of the `--output-format json` stdout object. Only the TS type and prose were found; `modelUsage`/`usage` inner field names beyond inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens and costUSD were not captured.
- The name of the SessionStart output field that "supplies the first user message", and how `@path` behaves inside SKILL.md bodies (only implied).
- `--max-turns` is documented in the CLI reference but absent from local `--help`. Not tested at runtime.


---

## Part: Verified provider facts (fetched 2026-10-17 from official docs)

Legend: [DOC] = quoted or paraphrased from the official page at the URL. [PROBE] = observed by a live HTTP request I made today with an invalid key or an OPTIONS preflight (real server behavior, not documentation). [UNVERIFIED] = not confirmed.

---
### 1. Anthropic (Claude API)

**Base and endpoint** [DOC] https://platform.claude.com/docs/en/api/overview
- Base URL: `https://api.anthropic.com`. Chat: `POST /v1/messages`. Models: `GET /v1/models`. Token count: `POST /v1/messages/count_tokens`.
- Headers: `x-api-key: <key>` (the docs call this the "legacy fallback, still supported"); `Authorization: Bearer <key>` is now listed as the primary option. Also `anthropic-version: 2023-06-01` (required) and `content-type: application/json` (required).
- Request size limit for Messages: 32 MB. Over the limit returns 413 `request_too_large`.

**Request** [DOC] https://platform.claude.com/docs/en/build-with-claude/working-with-messages
```json
{"model":"claude-opus-5-5","max_tokens":1024,"system":"You are ...",
 "messages":[{"role":"user","content":"Hello, Claude"}]}
```
- `max_tokens` is required. `system` is a top-level string or an array of text blocks; there is no system role at the start of `messages` (https://platform.claude.com/docs/en/api/messages). Roles are `user` and `assistant`.
- GOTCHA [DOC]: `temperature`, `top_p` and `top_k` are **not supported on Claude 4.7+**. A non-default value returns 400. Prefilling the assistant turn is not supported on 4.6+ and returns 400 (same page and https://platform.claude.com/docs/en/api/errors).
- GOTCHA [DOC]: on Opus 5.5 and Fable 5.1 thinking is always on, so `content` can include `thinking` blocks before the `text` block. Filter for `block.type === "text"` (TS SDK example: https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript).

**Response** [DOC] (working-with-messages page)
```json
{"id":"msg_01XF...","type":"message","role":"assistant",
 "content":[{"type":"text","text":"Hello!"}],"model":"claude-opus-5-5",
 "stop_reason":"end_turn","stop_sequence":null,
 "usage":{"input_tokens":12,"output_tokens":6}}
```
- Text is in `content[i].text` where `type == "text"`. Usage is in `usage.input_tokens` and `usage.output_tokens`, plus `cache_read_input_tokens` and `cache_creation_input_tokens` when caching is used.
- `stop_reason` values: `end_turn`, `stop_sequence`, `max_tokens`, `refusal`, `model_context_window_exceeded`.

**Streaming** [DOC] https://platform.claude.com/docs/en/build-with-claude/streaming
- Enable with `"stream": true`. Responses are named SSE events (`event: <type>` plus `data: {...}`).
- Event flow: `message_start` → for each block (`content_block_start`, one or more `content_block_delta`, `content_block_stop`) → one or more `message_delta` → `message_stop`. `ping` events can appear anywhere. New event types may be added, so ignore unknown ones.
```
event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}
event: message_delta
data: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence":null}, "usage": {"output_tokens": 15}}
event: message_stop
data: {"type": "message_stop"}
```
- Text is at `delta.text` when `delta.type == "text_delta"`. Thinking arrives as `delta.type == "thinking_delta"` (field `thinking`); skip it. Input usage is in `message_start.message.usage`. `message_delta.usage` counts are **cumulative**. The stream ends at `message_stop`; there is no `[DONE]`.
- Mid-stream errors arrive after HTTP 200: `event: error` / `data: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}`.

**Errors** [DOC] https://platform.claude.com/docs/en/api/errors
```json
{"type":"error","error":{"type":"not_found_error","message":"The requested resource could not be found."},"request_id":"req_011CSHoEeqs5C35K2UUqR7Fy"}
```
- 400 `invalid_request_error` (also returned when an org or workspace **spend limit you set** is reached)
- 401 `authentication_error`
- **402 `billing_error`**
- 403 `permission_error`
- 404 `not_found_error`
- 409 `conflict_error`
- 413 `request_too_large`
- **429 `rate_limit_error`**. This also covers a tier monthly spend cap; a spend-cap 429 has **no `retry-after`** header and keeps failing.
- 500 `api_error`
- 504 `timeout_error`
- **529 `overloaded_error`**
- The `request-id` response header carries the request ID.
- Context too long [DOC] https://platform.claude.com/docs/en/build-with-claude/context-windows: "If the input alone already exceeds the model's context window, the API returns a 400 `invalid_request_error` ("prompt is too long")". On 4.5+ models, input + max_tokens > window is accepted and stops with `stop_reason: "model_context_window_exceeded"`.
- [PROBE] An invalid key returns 401 `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_..."}`.

**List models** [DOC] https://platform.claude.com/docs/en/api/models/list
- `GET /v1/models?limit=20&after_id=...`. The default limit is 20 and the maximum is 1000. Results list the newest models first.
- Response: `{"data":[{"type":"model","id":"claude-opus-5-5","display_name":"Claude Opus 5.5","created_at":"...","lifecycle":"active","line":"opus","max_input_tokens":...,"max_tokens":...,"capabilities":{...}}],"has_more":true,"first_id":"...","last_id":"..."}`

**Models** [DOC] https://platform.claude.com/docs/en/about-claude/models/overview (redirects to /docs/en/models/overview)

| Model | API id | Price $/MTok (in/out) | Context window | Max output |
|---|---|---|---|---|
| Claude Fable 5.1 | `claude-fable-5-1` | 10/50 | 1M | 128K |
| Claude Opus 5.5 ("start here for most workloads") | `claude-opus-5-5` | 4/20 | 1M | 128K |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 2/10 | 1M | 128K |
| Claude Haiku 5.5 (fastest) | `claude-haiku-5-5` | from 0.10/0.50 | 1M | 128K |

- Suggested defaults: **cheap = `claude-haiku-5-5`**, **strong = `claude-opus-5-5`** (Sonnet 5.5 is the balanced middle). All ids are dateless pinned snapshots.

**Browser / CORS**
- [DOC] The TS SDK disables browsers by default. The opt-in is `dangerouslyAllowBrowser: true` (https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript).
- [Official SDK source] With that option the SDK sends `anthropic-dangerous-direct-browser-access: true` (https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts, ~line 1922). It also always sends `anthropic-version: 2023-06-01`.
- [PROBE] An OPTIONS preflight with `Origin: chrome-extension://...` returned `access-control-allow-origin: *` and allowed headers including `anthropic-dangerous-direct-browser-access`.
- Recommendation: send the header from the extension. Chrome attaches an Origin header to extension service-worker fetches (see section 7).

**TTS**: none in the Claude API (no speech endpoint is listed on the API overview).

---
### 2. OpenAI

Note: platform.openai.com/docs returns 403 to fetchers. The official docs now live at developers.openai.com and each page has a `.md` twin.

**Chat Completions** [DOC] https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- `POST https://api.openai.com/v1/chat/completions`. Headers: `Authorization: Bearer $OPENAI_API_KEY`, `Content-Type: application/json`.
- The system prompt goes in `messages` with `role: "developer"`; the docs say "With o1 models and newer, developer messages replace the previous system messages". The `system` role is still accepted.
- **`max_completion_tokens`** is "an upper bound ... including visible output tokens and reasoning tokens". `max_tokens` is "**Deprecated** ... not compatible with o-series models".
```json
{"model":"gpt-6-astra","messages":[{"role":"developer","content":"You are a helpful assistant."},{"role":"user","content":"Hello!"}]}
```
Response [DOC]:
```json
{"id":"chatcmpl-B9M...","object":"chat.completion","created":1741569952,"model":"gpt-6-astra",
 "choices":[{"index":0,"message":{"role":"assistant","content":"Hello! How can I assist you today?","refusal":null,"annotations":[]},"logprobs":null,"finish_reason":"stop"}],
 "usage":{"prompt_tokens":19,"completion_tokens":10,"total_tokens":29,
  "prompt_tokens_details":{"cached_tokens":0,"audio_tokens":0},
  "completion_tokens_details":{"reasoning_tokens":0,"audio_tokens":0,"accepted_prediction_tokens":0,"rejected_prediction_tokens":0}},
 "service_tier":"default"}
```
- Text is at `choices[0].message.content`. Usage fields: `usage.prompt_tokens`, `completion_tokens`, `total_tokens`.
- The docs steer new work to the Responses API (`POST /v1/responses`), but Chat Completions is listed as "Supported" on the GPT-6 model pages.

**Streaming** [DOC] (same page)
- Enable with `"stream": true`. Lines are unnamed SSE `data:` lines. Text is at `choices[0].delta.content`. The end marker is the literal `data: [DONE]`.
```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{"content":"Hello"},"logprobs":null,"finish_reason":null}]}
data: {"id":"chatcmpl-123",...,"choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}]}
data: [DONE]
```
- Usage in a stream needs `"stream_options":{"include_usage":true}`. Then "an additional chunk will be streamed before the data: [DONE] message" carrying `usage`, with an empty `choices`.

**List models** [DOC] https://developers.openai.com/api/reference/resources/models/methods/list.md
- `GET https://api.openai.com/v1/models` → `{"object":"list","data":[{"id":"...","object":"model","created":1686935002,"owned_by":"openai","shutdown_date":null}]}`
- The list includes non-chat models (tts, embeddings, image models), so filter client-side.

**Errors** [DOC] https://developers.openai.com/api/docs/guides/error-codes.md
- 401: "Invalid Authentication", "Incorrect API key provided", "IP not authorized".
- 403: "Country, region, or territory not supported".
- 429 has several causes:
  - rate limit: follow `Retry-After`
  - `rate_limit_error` / `slow_down`
  - **`credit_balance_exhausted`**
  - `organization_spend_limit_exceeded`
  - `project_spend_limit_exceeded`
  - `organization_usage_limit_exceeded`
- The page says: "For billing-related errors, inspect `error.code` ... The broader `error.type` can still be `insufficient_quota`." It also says retrying billing or quota errors won't help.
- 500: server error. 503 `service_unavailable_error` / `server_is_overloaded`.
- [PROBE] Error body shape for an invalid key (HTTP 401):
```json
{"error":{"message":"Incorrect API key provided: sk-invalid. ...","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}
```
- Context too long: `context_length_exceeded` ("Input exceeds the model's context window") is documented only in the **Agents API** error table (https://developers.openai.com/api/llms-full.txt, "Errors and recovery"). For Chat Completions, assume HTTP 400 with `error.code == "context_length_exceeded"` [UNVERIFIED for chat]. Also match on message text.

**TTS** [DOC] https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create.md and https://developers.openai.com/api/docs/guides/text-to-speech.md
- `POST https://api.openai.com/v1/audio/speech` with body `{"model":"gpt-4o-mini-tts","input":"...","voice":"marin"}`. `input` is at most **4096 chars**.
- Models: `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`, `gpt-4o-mini-tts-2025-12-15`. `gpt-4o-mini-tts` is "our newest and most reliable".
- Voices: alloy, ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer, verse, marin, cedar. The guide recommends `marin` or `cedar` "for best quality". tts-1 and tts-1-hd support only alloy, ash, coral, echo, fable, onyx, nova, sage, shimmer.
- `response_format`: mp3 (default), opus, aac, flac, wav, pcm. `speed` ranges 0.25 to 4.0. `instructions` does not work with tts-1 or tts-1-hd.
- `stream_format`: `sse` or `audio`; `sse` is not available for tts-1 or tts-1-hd. The response body is raw audio bytes, so use `res.blob()` or `arrayBuffer()`.

**Models** [DOC] https://developers.openai.com/api/docs/models.md and the per-model pages

| Model | id | Price $/MTok (in/out) | Context window | Max output |
|---|---|---|---|---|
| GPT-6 Astra (flagship) | `gpt-6-astra` | 10/50 | 1.05M | 128K |
| GPT-6.1 Sol (balance) | `gpt-6.1-sol` | 2/10 | 1.05M | 128K |
| GPT-6 Luna (cost-sensitive) | `gpt-6-luna` | 0.10/0.50 | 1.05M | 128K |

- All three list Chat Completions as "Supported".
- Suggested defaults: **cheap = `gpt-6-luna`**, **strong = `gpt-6-astra`**, mid = `gpt-6.1-sol`.

**Browser / CORS**
- [DOC] The docs say never to expose keys in client-side code (https://developers.openai.com/api/llms-full.txt, quickstart text).
- [PROBE] A preflight from `chrome-extension://...` returned `Access-Control-Allow-Origin: <echoed origin>` and allowed `authorization,content-type`. No special header is needed.

---
### 3. Google Gemini API

**Endpoints** [DOC] https://ai.google.dev/api/generate-content (markdown at `...generate-content.md.txt`)
- `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- Streaming: `POST .../v1beta/models/{model}:streamGenerateContent?alt=sse`
- Auth: header **`x-goog-api-key: $GEMINI_API_KEY`**, used in the current docs (https://ai.google.dev/gemini-api/docs/api-key). The reference curl examples still use the `?key=$GEMINI_API_KEY` query parameter, and both appear in official docs. Prefer the header so the key stays out of URLs.
- NOTE [DOC]: the current guides lead with a new **Interactions API** (`POST /v1beta/interactions`, body `{"model":"gemini-3.8-flash","input":"..."}`) (https://ai.google.dev/gemini-api/docs/text-generation). generateContent is still fully documented in the API reference.

**Request (generateContent)** [DOC]
```json
{"system_instruction":{"parts":{"text":"You are a cat. Your name is Neko."}},
 "contents":[{"role":"user","parts":[{"text":"Hello there"}]}],
 "generationConfig":{"maxOutputTokens":800}}
```
- `role` must be `user` or `model` (not `assistant`). The system prompt goes in the top-level `systemInstruction` (`system_instruction` is accepted too). The max-tokens field is `generationConfig.maxOutputTokens`.
- Thinking is controlled with `generationConfig.thinkingConfig.thinkingLevel` or `thinkingBudget`.

**Response** [DOC] (GenerateContentResponse)
- `{"candidates":[{"content":{"role":"model","parts":[{"text":"..."}]},"finishReason":"STOP",...}],"promptFeedback":{...},"usageMetadata":{...}}`
- Text: join `candidates[0].content.parts[].text`, **skipping parts with `"thought": true`** ("Indicates if the part is thought from the model").
- Usage: `usageMetadata.promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `totalTokenCount`, `cachedContentTokenCount`.
- A blocked prompt has `promptFeedback.blockReason` set and no candidates.

**Streaming** [DOC]
- With `?alt=sse`, each `data:` line is a complete GenerateContentResponse chunk. Text deltas are at `candidates[0].content.parts[].text`, and the last chunk carries `finishReason` and `usageMetadata`.
- The end marker is that the stream simply closes. [UNVERIFIED: no `[DONE]` sentinel is documented; none was observed in the docs.]

**List models** [DOC] https://ai.google.dev/api/models
- `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=50&pageToken=...` → `{"models":[{"name":"models/...","baseModelId":"...","version":"...","displayName":"...","description":"...","inputTokenLimit":N,"outputTokenLimit":N,"supportedGenerationMethods":["generateContent",...]}],"nextPageToken":"..."}`
- Strip the `models/` prefix from `name`. Filter on `supportedGenerationMethods` containing `generateContent`.

**Errors**
- [DOC] Interactions API error codes (https://ai.google.dev/gemini-api/docs/api-errors):

| HTTP status | Code |
|---|---|
| 400 | `invalid_request`, `failed_precondition` (e.g. disabled billing) |
| 401 | `authentication` |
| **402** | **`payment_required`** ("Prepay credit balance is depleted. Don't retry") |
| 403 | `permission_denied` |
| 404 | `model_not_found` |
| 429 | `rate_limit_exceeded`, **`quota_exceeded`** (daily quota), `too_many_requests` |
| 500 | `api_error` |
| 503 | `service_unavailable` |
| 504 | `deadline_exceeded` |

  The shape is `{"error":{"code":"invalid_request","message":"..."}}`.
- [DOC] The troubleshooting page (https://ai.google.dev/gemini-api/docs/troubleshooting) says to retry `429 RESOURCE_EXHAUSTED` and `503 UNAVAILABLE` and to not retry 400, 402 or 403.
- [PROBE] generateContent and models use the **Google RPC style**, and an **invalid API key returns HTTP 400 (not 401)**:
```json
{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT",
 "details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID","domain":"googleapis.com",...}]}}
```
  Map `details[].reason == "API_KEY_INVALID"` to an auth error.
- Context too long: [UNVERIFIED] there is no documented code. Expect 400 `INVALID_ARGUMENT` with a token-count message.

**OpenAI-compatible endpoint** [DOC] https://ai.google.dev/gemini-api/docs/openai
- Base URL `https://generativelanguage.googleapis.com/v1beta/openai/`. It provides `POST .../chat/completions` and `GET .../models`, with auth `Authorization: Bearer $GEMINI_API_KEY`. The docs say "Reasoning cannot be turned off for Gemini 2.5 Pro or 3 models". This endpoint is a usable fallback, and the generic adapter could cover Gemini through it.

**Models** [DOC] https://ai.google.dev/gemini-api/docs/models
- Stable: `gemini-3.8-flash` ("Our most intelligent Flash model"), `gemini-3.6-flash` (previous generation), `gemini-3.5-flash-lite` ("fastest, most cost-effective 3.5 model"), `gemini-3.1-flash-lite`.
- Preview: `gemini-3.1-pro-preview`, `gemini-3-flash-preview`.
- The page says 2.5 models are "limit[ed] ... to users who have actively used them in the past".
- Suggested defaults: **cheap = `gemini-3.5-flash-lite`**, **strong = `gemini-3.8-flash`**. The only Pro model is a preview (`gemini-3.1-pro-preview`).

**TTS** [DOC] https://ai.google.dev/gemini-api/docs/speech-generation
- Models: `gemini-3.8-flash-tts` and `gemini-3.8-flash-lite-tts`. Example voice: `Kore`.
- It works through the Interactions API with `"response_format":{"type":"audio"}` and `"generation_config":{"speech_config":[{"voice":"Kore"}]}`. The audio is base64 in `steps[].content[].data`; the default is WAV, and streaming sends 16-bit little-endian PCM at 24 kHz mono.

**Browser / CORS**
- [DOC] "Never expose keys client-side in production" (api-key page).
- [PROBE] The preflight from `chrome-extension://...` echoed the origin and allowed `x-goog-api-key,content-type`.

---
### 4. OpenRouter

**Base / auth** [DOC] https://openrouter.ai/docs/api_reference/authentication.md
- Base URL `https://openrouter.ai/api/v1`. Chat: `POST /chat/completions`, OpenAI-compatible. Auth: `Authorization: Bearer <OPENROUTER_API_KEY>`.
- Optional attribution headers [DOC] https://openrouter.ai/docs/app-attribution.md:
  - `HTTP-Referer: <app URL>` is "required for app attribution" but not for the API itself.
  - `X-OpenRouter-Title: <name>`. The old **`X-Title` "is still supported for backwards compatibility"**.
  - `X-OpenRouter-Categories`.
  - "Apps using `localhost` URLs must also include `X-OpenRouter-Title` to be tracked."

**Request / response** [DOC] https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion.md
- Same shape as OpenAI: `messages` with a `system` role, model ids like `openai/gpt-5.2`, and `choices[0].message.content`.
- `max_completion_tokens` is preferred. `max_tokens` is "deprecated, use max_completion_tokens. Note: some providers enforce a minimum of 16".

**Streaming** [DOC] https://openrouter.ai/docs/api_reference/streaming.md
- Enable with `"stream": true`. Uses OpenAI-style `data:` chunks with text at `choices[0].delta.content`, and ends with `data: [DONE]`.
- **SSE comment keep-alives like `: OPENROUTER PROCESSING`** must be skipped; lines starting with `:` are not JSON.
- Every Chat Completions stream ends with an extra usage chunk just before `[DONE]`. `stream_options.include_usage` is "Deprecated: This field has no effect. Full usage details are always included". `finish_reason` appears twice.
- Mid-stream error chunk (HTTP stays 200): `data: {"id":"gen-abc123","object":"chat.completion.chunk",...,"error":{"code":429,"message":"Rate limit exceeded","metadata":{"error_type":"rate_limit_exceeded"}},"choices":[...]}`

**Errors** [DOC] https://openrouter.ai/docs/api_reference/errors-and-debugging.md
- Shape: `{"error":{"code":<number>,"message":"...","metadata":{...}}}`. The HTTP status equals `error.code` for invalid requests or out-of-credits; otherwise the status is 200 and the error is in the body or stream.
- Status codes:
  - 400: bad request, including CORS problems
  - 401: invalid credentials
  - **402: insufficient credits**
  - 403: moderation, guardrail, or **key/workspace budget spent** (the message ends with "$X of $Y used; resets ...")
  - 408: timeout
  - 429: rate limited (`Retry-After` is sent on 429, 503 and some 402s)
  - 502: model down
  - 503: no provider meets the routing requirements
- Typed `error_type` codes include **`context_length_exceeded` → 400** ("combined input and output tokens exceed the model's context window") and `payment_required` → 402. For Chat Completions they are at `error.metadata.error_type`.
- [PROBE] An invalid key returned 401 `{"error":{"message":"Missing Authentication header","code":401}}`. The message is misleading, so rely on the status code.

**List models** [DOC] https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md
- `GET https://openrouter.ai/api/v1/models`. Query parameters include `offset`, `limit` (500), `q`, `sort`, `context`, `max_price`, `output_modalities`, and more. The OpenAPI spec lists a bearer key under security.
- Response: `{"data":[{"id":"openai/gpt-4","canonical_slug":"openai/gpt-4","name":"GPT-4","context_length":8192,"pricing":{"prompt":"0.00003","completion":"0.00006","request":"0","image":"0"},"architecture":{"input_modalities":["text"],"output_modalities":["text"],...},"top_provider":{"context_length":8192,"max_completion_tokens":4096,"is_moderated":true},"supported_parameters":["temperature","top_p","max_tokens"],...}]}`. Pricing values are strings in USD per token.

**Defaults** [DOC]
- Routers: `openrouter/auto` ("Automatically select the best model") and `openrouter/free` ("Free Models Router") (https://openrouter.ai/docs/guides/routing/routers/auto-router.md, .../free-router.md). The `:free` variant suffix also exists.
- Suggested: **cheap = `openrouter/free`** (rate-limited free models) or a provider-prefixed cheap id (e.g. `google/...flash-lite`); **strong = `openrouter/auto`** or `anthropic/claude-opus-5-5`. [UNVERIFIED: the exact provider-prefixed slugs for Claude, GPT-6 and Gemini 3.8 were not checked against /models.]

**TTS** [DOC] https://openrouter.ai/docs/api/api-reference/tts/create-speech.md
- `POST /api/v1/audio/speech`, example `{"model":"mistralai/voxtral-mini-tts-2603","voice":"en_paul_neutral","response_format":"pcm","input":"..."}`.

**Browser / CORS**
- [PROBE] The preflight returns `Access-Control-Allow-Origin: *` and allows `Authorization`, `HTTP-Referer`, `X-Title`, `X-OpenRouter-Title`, and more.
- The docs recommend a credit limit on every key and say to keep unlimited keys out of client-side code.

---
### 5. Ollama (OpenAI-compatible) [DOC] https://docs.ollama.com/api/openai-compatibility.md
- Base URL **`http://localhost:11434/v1/`**. Endpoints: `POST /v1/chat/completions`, `POST /v1/completions`, `POST /v1/responses`, `GET /v1/models`, `GET /v1/models/{model}`, `POST /v1/embeddings`.
- **API key: "required but ignored"** (examples use `api_key='ollama'`), so any Bearer value or none works locally.
- Ollama cloud uses `https://ollama.com/v1` with a real `OLLAMA_API_KEY`.
- Supported chat fields include `model`, `messages` (text, base64 images; **image URLs are not supported**), `stream`, `stream_options.include_usage`, `max_tokens`, `temperature`, `top_p`, `stop`, `seed`, `response_format`, `tools`, and `reasoning_effort`. `tool_choice`, `logit_bias`, `n` and logprobs are not supported.
- `/v1/models`: `created` is the last-modified time and `owned_by` is the username, defaulting to `"library"`.
- Context [DOC] https://docs.ollama.com/faq.md: the **default context window is 4096 tokens**. Override it with `OLLAMA_CONTEXT_LENGTH`, or `num_ctx` (the native API or a Modelfile; the OpenAI API cannot set it). [UNVERIFIED] Ollama truncates prompts rather than returning a context error.
- **CORS** [DOC] (FAQ): "Ollama allows cross-origin requests from `127.0.0.1` and `0.0.0.0` by default." "For browser extensions, you'll need to explicitly allow the extension's origin pattern":
  `OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*,safari-web-extension://* ollama serve`
  Without this, requests from the extension are rejected. [UNVERIFIED exact status; commonly 403.]

### 6. LM Studio (OpenAI-compatible) [DOC] https://lmstudio.ai/docs/developer/openai-compat.md
- Default port **1234**, base URL `http://localhost:1234/v1`. Endpoints: `GET /v1/models` ("Lists the currently **loaded** models" per the llms.txt docs), `POST /v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/responses`.
- Auth [DOC] https://lmstudio.ai/docs/developer/core/authentication.md: "By default, LM Studio does not require authentication". The optional "Require Authentication" switch (LM Studio 0.4.0+) makes requests send `Authorization: Bearer $LM_API_TOKEN`.
- **CORS** [DOC] https://lmstudio.ai/docs/developer/core/server/settings.md: "Enable CORS" is a switch in Server Settings (CLI: `lms server start --cors`, which "When not set, CORS is disabled", per https://lmstudio.ai/llms.txt). The user must enable it for extension calls if Chrome's Origin triggers a check. [UNVERIFIED: whether LM Studio rejects or only omits ACAO headers; with host_permissions Chrome bypasses CORS, so omission alone should be fine.]

### 7. Chrome MV3 extension and CORS [DOC] https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- Extension origins (service worker, extension pages) "can talk to remote servers outside of its origin, as long as the extension requests host permissions". In that case the browser's CORS check is not enforced.
- Content scripts are always subject to the same-origin policy. Do fetches from the service worker.
- HTTP and HTTPS must be declared separately in `host_permissions`. Local servers need entries like `http://localhost:11434/*`, `http://127.0.0.1:11434/*` and `http://localhost:1234/*`.
- Caveat: Chrome still sends `Origin: chrome-extension://<id>`. **Servers can reject based on Origin**. This matters for Ollama (needs OLLAMA_ORIGINS, per the FAQ above) and may be why Anthropic expects `anthropic-dangerous-direct-browser-access: true`. [UNVERIFIED: my probe with an invalid key got 401 auth errors both with and without that header, so I could not confirm Anthropic's CORS gate.]

---
### Could NOT verify
1. OpenAI Chat Completions context-overflow error code/message. `context_length_exceeded` is only documented for the Agents API.
2. The Gemini generateContent error JSON schema and the context-too-long error. The RPC shape is from a live probe only; the docs page covers the Interactions API.
3. The Gemini SSE end-of-stream behavior. No `[DONE]` is documented; assume the stream closes.
4. Whether Anthropic rejects Origin-bearing requests that lack `anthropic-dangerous-direct-browser-access` (the probe was inconclusive). The header is confirmed only in the official SDK source, not in the prose docs.
5. The exact HTTP status Ollama returns for a disallowed Origin, and whether Ollama silently truncates over-context prompts.
6. LM Studio's behavior with CORS disabled for extension origins, and whether `/v1/models` lists only loaded models or also downloaded ones under JIT loading (the current page doesn't say; the older llms.txt says "loaded").
7. OpenRouter provider-prefixed slugs for the newest Claude, GPT and Gemini models (not checked against the live /models list).
8. OpenAI `/v1/chat/completions` response fields `refusal` and `annotations` for GPT-6 reasoning output (`reasoning_content` etc.) were not explored.


---

## Part: Verified platform facts (checked 2026-10-17)

Sources are official docs, fetched live. npm data comes from `npm view` run on 2026-10-17.

### A. Chrome MV3

### chrome.sidePanel — https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- Requires Chrome 114+ and MV3. Add `"permissions": ["sidePanel"]`.
- Manifest: `"side_panel": { "default_path": "sidepanel.html" }`. The path is relative to the extension root and sets the same panel for every site.
- `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`: the default is `false`. When true, clicking the toolbar icon toggles the panel. The doc's example also declares `"action"` in the manifest.
- `chrome.sidePanel.setOptions({ tabId?, path?, enabled? })`:
  - With `tabId`, the options apply only to that tab. Without it, they become the default for tabs that have no specific settings.
  - `enabled` defaults to true.
- `chrome.sidePanel.open({ windowId | tabId })`: Chrome 116+. It works only in response to a user action (action click, shortcut, context menu, or a user gesture on an extension page or content script).

### chrome.storage — https://developer.chrome.com/docs/extensions/reference/api/storage
- **local**: QUOTA_BYTES = 10,485,760 (10 MB). It was 5 MB in Chrome 113 and earlier. The limit is ignored when the extension has the `unlimitedStorage` permission. Exposed to content scripts by default.
- **session**: Chrome 102+, MV3. QUOTA_BYTES = 10,485,760 (10 MB), measured as estimated in-memory usage. It was 1 MB in Chrome 111 and earlier.
  - The doc says it holds data "in memory while an extension is loaded".
  - CLEARED: "The storage is cleared if the extension is disabled, reloaded, updated, and when the browser restarts." This fits a "locked until unlocked once per browser session" model. Note that an extension update also wipes it, so it re-locks.
  - "By default, it's not exposed to content scripts, but this behavior can be changed by calling `storage.session.setAccessLevel()`".
  - The AccessLevel enum (Chrome 102+) has two values: `TRUSTED_CONTEXTS` (contexts from the extension itself) and `TRUSTED_AND_UNTRUSTED_CONTEXTS`. The page does not literally say "the default is TRUSTED_CONTEXTS". That default follows from the text but is not stated in so many words.
- **sync**: QUOTA_BYTES = 102,400. QUOTA_BYTES_PER_ITEM = 8,192. MAX_ITEMS = 512. MAX_WRITE_OPERATIONS_PER_MINUTE = 120. MAX_WRITE_OPERATIONS_PER_HOUR = 1,800.
- Any write that exceeds a quota fails immediately: the Promise rejects, or `runtime.lastError` is set.

### Permissions — https://developer.chrome.com/docs/extensions/reference/api/permissions
- Manifest: `"optional_host_permissions": ["https://*/*"]`. With that entry you can request any origin at runtime through `permissions.request({ origins: ["https://api.example.com/*"] })`.
- `request()` must be called inside a user gesture ("like a button's click handler"). It resolves to a boolean.
  - A prompt appears only when the request produces new warnings.
  - Paths in origin patterns are ignored.
- `contains()` resolves to `Promise<boolean>`. `remove()` resolves to `Promise<boolean>`; required permissions cannot be removed. Events: `onAdded` and `onRemoved`.
- Cannot be optional: debugger, declarativeNetRequest, devtools, geolocation, mdns, proxy, tts, ttsEngine, wallpaper.
- `permissions.addHostAccessRequest()` is available from Chrome 133+.

### Network and CORS — https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- Service worker and extension pages: a script "can talk to remote servers outside of its origin, as long as the extension requests host permissions". In effect this bypasses CORS for granted hosts.
- Content scripts do not get this: "Cross-origin requests are always treated as such in content scripts, even if the extension has host permissions." They are subject to the page origin's same-origin policy.
  - Pattern: the content script sends a message, and the service worker or extension page does the fetch.
  - The doc warns against message handlers that fetch arbitrary URLs.

### Service worker lifetime — https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- The worker stops after 30 s idle. Receiving an event or calling an extension API resets the timer (Chrome 110+).
- Chrome terminates the worker if a single event or API call runs more than 5 min, or if a `fetch()` response takes more than 30 s to arrive.
- Things that keep the worker alive, by version:
  - Chrome 114+: long-lived `runtime.connect` ports keep it alive while messages flow. Opening a port alone does not reset the timers.
  - Chrome 116+: active WebSockets extend lifetime. `permissions.request` and `identity.launchWebAuthFlow` may exceed the 5-min limit.
  - Chrome 105: `connectNative`. Chrome 109: offscreen document messages. Chrome 120: alarms can use a 30 s minimum period.
- Do not rely on globals. Persist state in chrome.storage or IndexedDB. Web Storage (localStorage) is not available in the service worker.

### Messaging — https://developer.chrome.com/docs/extensions/develop/concepts/messaging
- `runtime.sendMessage` is a one-shot call that returns a Promise of the response. To answer asynchronously, the listener returns literal `true` and calls `sendResponse` later. Returning a Promise from the listener is rolling out gradually from Chrome 148.
- `runtime.connect()` and `tabs.connect()` give `Port` objects with `postMessage`, `onMessage` and `onDisconnect`. `onDisconnect` may fire more than once.
  - Use ports for streaming chunks, for example LLM tokens, from the service worker to the side panel.
- Chrome serializes messages as JSON, not structured clone. `undefined` becomes `null`. Maximum message size is 64 MiB.

### Content scripts — https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts
- Keys:
  - `matches` (required), `exclude_matches`, `js`, `css`.
  - `run_at`: `document_start`, `document_end`, or `document_idle` (default).
  - `all_frames` (default false), `match_about_blank`.
  - `world`: `ISOLATED` (default) or `MAIN`. MAIN shares the page's JS environment and carries risk.
- The page did not state a minimum Chrome version for `world`.

### identity.launchWebAuthFlow — https://developer.chrome.com/docs/extensions/reference/api/identity
- Needs the `"identity"` permission. `launchWebAuthFlow({ url, interactive })` resolves to the final redirect URL string (Promise form in Chrome 106+). It works with non-Google identity providers.
- `chrome.identity.getRedirectURL(path?)` returns `https://<app-id>.chromiumapp.org/<path>`. Register this URL as the OAuth callback.
- Non-interactive tuning (Chrome 113+): `abortOnLoadForNonInteractive` and `timeoutMsForNonInteractive`.
- `getAuthToken` uses the manifest's `oauth2` section and is aimed at Google accounts.

### speechSynthesis (MDN) — https://developer.mozilla.org/en-US/docs/Web/API/Window/speechSynthesis
- Baseline "Widely available" since September 2018.
- `getVoices()` can return an empty list at first. Repopulate the list on `voiceschanged`, as MDN's example does.
- NOT VERIFIED: no official doc explicitly confirms `speechSynthesis` in a Chrome side panel page. Side panel pages are regular extension pages with a `window`, so it is expected to work. Test it in the build.
- Alternative with official docs: `chrome.tts` (permission `tts`).

### WebCrypto PBKDF2 to AES-GCM (MDN) — https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey
- Import the password: `importKey("raw", utf8(password), "PBKDF2", false, ["deriveKey"])`.
- Derive the key: `deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])`.
  - MDN's example uses `extractable: true`. Use `false` unless you need to export the key.
- IV: `crypto.getRandomValues(new Uint8Array(12))`. MDN: the IV "must be regenerated for every message" and need not be secret, so store it next to the ciphertext.
- MDN's example uses 100,000 iterations. That is below the OWASP figure.
- OWASP Password Storage Cheat Sheet (https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html):
  - PBKDF2-HMAC-SHA256: **600,000** iterations.
  - PBKDF2-HMAC-SHA512: 220,000.
  - PBKDF2-HMAC-SHA1: 1,400,000 (legacy only).
  - Argon2id: m=19 MiB, t=2, p=1.

### Vite + MV3 build
- `@crxjs/vite-plugin`:
  - Latest 3.0.0, published 2026-09-24.
  - Earlier releases: 2.0.0 (2025-06-10), then 2.1–2.7 through 2026-07-01.
  - Peer range: `vite ^3 || ^4 || ^5 || ^6 || ^7 || ^8`, so it covers vite 8.3.4.
  - Repo https://github.com/crxjs/chrome-extension-tools is not archived and is active. It targets MV3.
- Alternative: a plain Vite multi-entry build.
  - Use `build.rollupOptions.input` with sidepanel.html, options.html, and the background/content entries as separate inputs.
  - Use fixed `entryFileNames` (no hash) for the background and content scripts.
  - Copy `manifest.json` from `public/`.
  - The content script must be a single classic bundle or IIFE, because content scripts can't be ES modules unless loaded through dynamic import. The background can use `"type": "module"`.
  - This alternative was not checked against a doc page. It is general Vite and Rollup knowledge.

### B. OS keychain for Node (npm view, 2026-10-17)

| Package | Latest | Last modified | Status | Windows |
|---|---|---|---|---|
| @napi-rs/keyring | 2.1.1 | 2026-10-10 | Active, repo github.com/Brooooooklyn/keyring-node not archived | Yes: prebuilt win32-x64/ia32/arm64-msvc optional deps |
| keytar | 7.9.0 | 2025-07-30 (registry metadata; 7.9.0 itself is old) | **ARCHIVED** Dec 15, 2022 (github.com/atom/node-keytar banner) | Yes, but unmaintained. Avoid. |
| cross-keychain | 1.1.0 | 2025-10-07 | Repo github.com/magarcia/cross-keychain not archived, small (15 commits) | Credential Manager via native; PowerShell DPAPI fallback |

- **@napi-rs/keyring** is a napi-rs binding of keyring-rs. Its API, from the npm README:
  ```js
  import { Entry } from '@napi-rs/keyring'
  const e = new Entry('service', 'account')
  e.setPassword('x')
  e.getPassword()
  e.deletePassword()
  ```
  - There is also an `AsyncEntry` and `Entry.withTarget(target, service, name, opts)`.
  - Linux options: `{ linux: { store: 'secret-service' | 'keyutils' } }`.
- **cross-keychain** API: `setPassword(service, account, pw)`, `getPassword(service, account)` (returns null if missing), `deletePassword(service, account)`, and `getCredential`.
  - It uses @napi-rs/keyring when available and falls back to CLI tools or an AES-GCM encrypted file.
  - Its npm deps include `@inquirer/prompts` and `meow`, because it ships a CLI.
- Recommendation from these facts: use `@napi-rs/keyring`.

### C. Free tiers

- **MongoDB Atlas Free (M0)** — https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/
  - Capacity: 0.5 GB storage (data plus indexes), 500 connections max, 100 ops/sec.
  - Transfer: 10 GB in plus 10 GB out per rolling 7 days.
  - Size limits: 100 databases and 500 collections. One free cluster per project.
  - Version: MongoDB 8.0, with no manual upgrade.
  - Operation limits:
    - Aggregation is capped at 50 stages, and `allowDiskUse` is ignored.
    - In-memory sort is capped at 32 MB.
    - No server-side JS (`$where`).
  - Auto-pauses after 30 days with zero connections.
  - Exceeding limits causes throttling plus a 1 s per-connection cooldown.
- **Render free web service** — https://render.com/docs/free
  - Spins down after 15 min with no inbound HTTP or WebSocket traffic. Spin-up takes about 1 min.
  - 750 instance-hours per workspace per month. Services are suspended when the hours run out.
  - The filesystem is ephemeral, and Render may restart the service at any time.
  - Outbound SMTP ports 25, 465 and 587 are blocked.
  - Free Postgres expires after 30 days, plus a 14-day grace period.
- **Koyeb** — https://www.koyeb.com/docs/reference/instances
  - One Free Instance per organization: 512 MB RAM, 0.1 vCPU, 2 GB SSD.
  - Scales to zero after 1 h without traffic.
  - Runs only in Frankfurt or Washington DC. No volumes.
  - The pricing page (https://www.koyeb.com/pricing) did not clearly list it. The docs page is the source here.
- **Fly.io** — https://docs.fly.io/about/pricing
  - "New organizations don't have a free tier or a monthly free usage allowance."
  - The trial is 2 h of machine runtime or 7 days, whichever comes first.
- **Railway** — https://docs.railway.com/reference/pricing/free-trial
  - Trial: a one-time $5 credit, valid 30 days, with 1 GB RAM.
  - After the trial, the Free plan gives $1 of credit per month, which does not roll over.
- **GitHub Actions** — https://docs.github.com/en/billing/concepts/product-billing/github-actions
  - "free ... for public repositories that use standard GitHub-hosted runners".
  - Private repos on the Free plan get 2,000 min per month.
- **Static dashboard hosts**
  - GitHub Pages — https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
    - 1 GB published site, soft limit of 100 GB/month bandwidth.
    - Soft limit of 10 builds/hour. This does not apply to custom Actions workflows.
    - Not allowed for running an online business or commercial SaaS.
  - Cloudflare Pages — https://developers.cloudflare.com/pages/platform/limits/
    - Free plan: 500 builds per month and 1 concurrent build.
    - 20,000 files, 25 MiB per file, 100 custom domains per project.
    - The limits page does not state bandwidth.
  - Vercel Hobby — https://vercel.com/docs/plans/hobby
    - Free, but non-commercial personal use only.
    - 100 GB Fast Data Transfer and 1M CDN requests.
    - 100 deployments per day.
  - Netlify — https://www.netlify.com/pricing/
    - The Free plan has a "300 credit limit".
    - Bandwidth costs 20 credits/GB and each production deploy costs 15 credits.
    - The reset period and overage behavior were not shown on the page.

### D. OAuth

### GitHub OAuth App — https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- Authorize: `GET https://github.com/login/oauth/authorize`.
  - Parameters: `client_id`, `redirect_uri`, `scope` (space-delimited), `state`, `code_challenge` plus `code_challenge_method=S256`.
  - PKCE with S256 is supported and strongly recommended. `plain` is not supported. The implicit grant is not supported.
- Token: `POST https://github.com/login/oauth/access_token`.
  - Parameters: `client_id`, `client_secret`, `code` (expires after 10 min), `redirect_uri`, `code_verifier`.
  - Send `Accept: application/json` to get JSON. The default response is form-encoded.
- API calls use the header `Authorization: Bearer <token>`.
- Scopes — https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
  - `read:user`: read profile data.
  - `user:email`: read email addresses.
  - No scope: public information only.
- `GET https://api.github.com/user` — https://docs.github.com/en/rest/users/users
  - Returns `id` (durable numeric ID, use it as the key), `login`, `name`, `avatar_url`.
  - `email` is the public profile email and may be null.
- `GET https://api.github.com/user/emails` — https://docs.github.com/en/rest/users/emails
  - Needs `user:email`. Returns `[{ email, primary, verified, visibility }]`.
- Device flow, same doc:
  - It must be enabled in the app settings.
  - `POST https://github.com/login/device/code` with `client_id` and `scope` returns `device_code`, `user_code`, `verification_uri` (https://github.com/login/device), `expires_in` (900) and `interval` (5).
  - Poll `POST https://github.com/login/oauth/access_token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`. No `client_secret` is needed.
  - Errors: `authorization_pending`, `slow_down` (adds 5 s to the interval), `expired_token`, `access_denied`, `device_flow_disabled`.

### Google OAuth 2.0 / OIDC
- Web server flow — https://developers.google.com/identity/protocols/oauth2/web-server
  - Authorize: `https://accounts.google.com/o/oauth2/v2/auth`, with `client_id`, `redirect_uri` (exact match), `response_type=code`, `scope`, `state`, and optionally `access_type=offline`.
  - Token: `POST https://oauth2.googleapis.com/token` with `grant_type=authorization_code`.
  - Revoke: `https://oauth2.googleapis.com/revoke`.
- OIDC — https://developers.google.com/identity/openid-connect/openid-connect
  - Discovery document: `https://accounts.google.com/.well-known/openid-configuration`.
  - Scopes: `openid email profile`. The scope string must begin with `openid`.
  - The token endpoint returns an `id_token` (JWT) with claims `sub`, `email`, `email_verified`, `name`, `picture`, `aud`, `iss`, `exp`.
    - **Use `sub` as the user ID, not email.**
  - Validate the id_token:
    - Check the signature against the JWKS at `https://www.googleapis.com/oauth2/v3/certs`.
    - `iss` must be `https://accounts.google.com` or `accounts.google.com`.
    - `aud` must equal your client_id, and `exp` must be in the future.
  - Userinfo: `GET https://openidconnect.googleapis.com/v1/userinfo` with a Bearer token.
  - PKCE: the discovery document lists `code_challenge_methods_supported` S256 and plain.
  - The `tokeninfo` endpoint is for debugging only.

### npm latest versions (npm view, 2026-10-17)
| pkg | version | pkg | version |
|---|---|---|---|
| express | 5.3.0 | vite | 8.3.4 |
| mongoose | 9.11.2 | react / react-dom | 19.3.1 |
| helmet | 8.3.0 | @vitejs/plugin-react | 6.1.2 |
| express-rate-limit | 8.7.1 | mermaid | 12.2.0 |
| zod | 4.6.7 | gray-matter | 4.0.3 (last modified 2023-07-12: stale) |
| mongodb-memory-server | 11.3.0 | yaml | 2.9.1 |
| vitest | 5.0.5 | commander | 15.0.0 |
| @playwright/test | 1.64.1 | pino | 10.4.0 |
| cors | 2.8.6 | supertest | 7.3.1 |
| @crxjs/vite-plugin | 3.0.0 | @napi-rs/keyring | 2.1.1 |

- gray-matter has not been updated since 2023. Prefer `yaml` (active) with a small frontmatter split.

### NOT verified or caveats
- A literal doc statement that the storage.session default access level is `TRUSTED_CONTEXTS`. The doc only says "not exposed to content scripts by default".
- speechSynthesis inside a Chrome side panel specifically. No official doc covers it; test it.
- Content-script `world` minimum Chrome version.
- Whether an open messaging port alone keeps the service worker alive. The lifecycle doc says ports keep it alive from Chrome 114 but that opening a port alone does not reset the timers, so messages must flow.
- Google web-server doc PKCE usage details. The page was truncated; S256 support is confirmed only through the discovery document listing.
- Netlify free credit reset period and overage behavior, and Cloudflare Pages bandwidth.
- The GitHub API was not queried directly (`gh` is not installed). Archive status was checked through the GitHub web pages.
- The Vite multi-entry alternative is not doc-verified.

## Feature refinements (2026-10-19)

- **Image tokens** (https://platform.claude.com/docs/en/build-with-claude/vision, checked 2026-10-19): an image costs `ceil(width/28) x ceil(height/28)` visual tokens; Claude 4.7 and later downscale to a 2576 px long edge / 4784 tokens max (1000x1000 = 1296, 1920x1080 = 2691); older models cap at 1568. claude.ai allows 20 images per message. ReSync's default per-image estimate is therefore 1,000 to 4,800 tokens (editable in Settings).
- **Mermaid** (npm registry, checked 2026-10-19): latest is 12.2.0 (2026-10-13, under two weeks old), so ReSync pins **12.1.0** (2026-10-02). The package ships a prebuilt browser bundle `dist/mermaid.min.js` (5.5 MB, sets `window.mermaid`); the build copies it to `vendor/mermaid.min.js` because MV3 extension pages only run packaged scripts (no remote code). **Confirmed working under the extension CSP** in the Playwright run: the mindmap renders as an SVG in the side panel with `securityLevel: 'strict'`, and the node groups have class `mindmap-node`.
- **Click-to-scroll**: `scrollIntoView` on the Nth turn element, counted with the same function that produces "The conversation has N turns". Confirmed against the mock page in Playwright (tree view and mindmap).
- **NOT verified against live claude.ai** (needs a signed-in browser; same status as the other selectors): the turn wrapper `[data-test-render-count]`, the attachment chips `[data-testid="file-thumbnail"]`, the project page's "N% of project capacity used" text, and the project title `main h1`. All are overridable in Settings > Advanced: selector overrides. If they are missing, attachments count as 0 and project files fall back to Settings, then the default.
- **Virtualised chats**: claude.ai keeps only part of a long chat in the page (found 2026-10-17). Turn counts and scroll targets use what is rendered, so in a very long chat the count can be low and early turns unreachable. The usage tracker keeps each chat's running context as a number, so a reload doesn't reset it.

## Composer fix, Decision Ledger, Chat Health Meter (2026-10-21)

- **Main-world content scripts** (https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts and https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts, checked 2026-10-21): `"world"` is an optional static content-script key; `"ISOLATED"` (the default) is "the execution environment unique to the content script"; `"MAIN"` "will share the execution environment with the host page's JavaScript". Content-script variables are not visible to the page, so a content script's own `history.pushState` wrapper would not see the page's calls; the two worlds communicate "through the shared DOM". ReSync therefore ships `nav-hook.js` with `"world": "MAIN", "run_at": "document_start"`, which only dispatches a DOM event (`resync:navigate`) on `document`. "When a content script is injected into the main world, the CSP of the page applies" (the hook uses no eval or network). Still **not stated** on either page: the Chrome version that added `world` (ReSync's minimum is 116); the isolated script also listens for `popstate` and compares the URL on DOM changes, so navigation is still seen if the hook does not run.
- **`Element.checkVisibility()`** is used to pick the visible composer (Chrome 105+); it is also implemented by happy-dom, so the unit tests exercise the same path. A computed-style walk is the fallback.
- **NOT verified against live claude.ai**: the composer structure on each page type. The fixtures in `packages/extension/test/fixtures/claude-pages/` are reconstructed from the bug report's description of the project home page and the selectors ReSync already used; replace them with real captures (`packages/extension/scripts/capture-claude-page.js`, which redacts text) when someone can sign in. Also unverified: whether claude.ai's Send button really stays disabled until the editor has text (ReSync treats "button present but disabled after insert" as "the editor did not take it" and falls back to the clipboard), and the exact URL claude.ai moves to after the first message on a project home page (ReSync assumes `/chat/<id>`, like `/new`).
