# Contributing to ReSync

Thanks for helping. ReSync is plain JavaScript (ES modules) with JSDoc types, in an npm workspaces monorepo.

## Layout

```
packages/shared     prompt format, provider layer, token estimator, schemas, sync client (browser-safe)
packages/cli        `resync`: queue, usage, keys, login/sync, plugin generator
packages/plugin     Claude Code plugin: generated commands/, hooks/, dependency-free scripts/
packages/extension  Chrome MV3 extension (Vite + React)
packages/server     Express + MongoDB API
packages/dashboard  React dashboard
prompts/            seed prompt library (Markdown + YAML frontmatter)
```

## Getting started

```sh
npm install
npm test          # Vitest across all packages
npm run lint
```

- **Machines with little RAM:** run one file at a time, e.g. `npx vitest run packages/cli/test/queue.test.js --maxWorkers=1`.
- **End-to-end tests:** `npm run test:e2e -w @resync/extension` and `npm run test:e2e -w @resync/dashboard`. Run `npx playwright install chromium` once first.
- **The real local-model test** (`packages/cli/test/ollama.e2e.test.js`) runs only when Ollama is reachable on `localhost:11434`, and skips otherwise.

## Rules of the road

- **Verify before you code.** If you rely on an external interface (a Claude Code flag, a provider API field, a Chrome API), check the official docs and add what you checked, with the URL, to `docs/VERIFIED.md`.
- **ReSync must work with no API keys.** In-chat mode is the default for every AI feature. Never make a key a requirement.
- **Keys never leave the device** except to the provider they belong to. **No telemetry.** Usage records are numbers only, and the shared schema rejects anything else.
- **Plugin scripts stay dependency-free.** An installed plugin is copied without `node_modules`.
- **Never edit generated plugin commands by hand.** Change the template or prompt, then run `resync plugin generate`. A test checks they match.
- **Add tests** for logic, and use mocked `fetch` for providers (every adapter takes `opts.fetch`).
- **Record non-obvious choices** in `docs/DECISIONS.md`.

## Common contributions

- **A new AI provider:** one adapter file. See [docs/PROVIDERS.md](docs/PROVIDERS.md).
- **A new queue runner** (another coding CLI): implement the runner interface in `packages/cli/src/queue/runners/index.js` (`name`, `description`, `run(input)`, optional `check(config)`), call `registerRunner`, and add tests with a fake runner like `packages/cli/test/queue.test.js`.
- **claude.ai changed and a selector broke:** update `packages/extension/src/lib/selectors.js` and keep the old selector as a fallback.
- **Seed prompts:** add `prompts/<category>/<slug>.md`, run `resync plugin generate`, and run the tests.

## Pull requests

Keep them small and focused, with tests passing (`npm test`) and lint clean. Describe what you verified, and how.
