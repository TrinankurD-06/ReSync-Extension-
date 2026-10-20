# claude.ai page fixtures

One HTML file per page type that has a message box (composer). `test/composerPages.test.js` loads each one and
checks that ReSync finds the composer, inserts text into it, and that the editor registers it.

| File | URL | Notes |
| --- | --- | --- |
| `project-home.html` | `/project/<id>` | "How can I help you today?" composer card, Instructions / Memory / Context panels (with editors of their own), chat list |
| `new-chat.html` | `/new` | composer under a greeting, no thread |
| `chat.html` | `/chat/<id>` | existing chat outside a project |
| `project-chat.html` | `/chat/<id>` | existing chat inside a project (project link in the header) |

The element ReSync must pick carries `data-expect="composer"`.

**Status: reconstructed, not captured.** These files were written by hand (2026-10-21) from the page layout
described in the bug report and the selectors ReSync already relied on; nobody could sign in to claude.ai from
the build machine. Replace them with real captures as soon as possible:

1. On claude.ai, open the page type and click into the message box.
2. Paste `scripts/capture-claude-page.js` into the DevTools console. It downloads `<page>.html` with all text
   redacted and the focused editor marked `data-expect="composer"`.
3. Save it over the matching file here and run `npx vitest run test/composerPages.test.js --maxWorkers=1`.

When claude.ai changes its layout, recapture the pages: the failing test names the page type, and the selector
lists to fix are `COMPOSER_BY_PAGE` in `src/lib/selectors.js` (or use Settings > Advanced: selector overrides
in the extension without a release).
