// Capture a claude.ai page as a test fixture (test/fixtures/claude-pages/). Run it in the browser, not in Node:
//   1. Open the page type on claude.ai (project home, new chat, a chat in a project, a chat outside one).
//   2. CLICK INTO THE MESSAGE BOX (the script marks the focused editor as the expected composer).
//   3. Open DevTools > Console, paste this whole file, press Enter. A file named claude-<page>.html downloads.
//   4. Save it over the matching fixture and run: npx vitest run test/composerPages.test.js --maxWorkers=1
// Privacy: every text node is replaced with x's (same length, spaces kept), and scripts, styles' URLs, images,
// SVG paths, hrefs' query strings and input values are dropped. Only the page's STRUCTURE and attributes such as
// role, aria-label, placeholder and data-testid are kept. Check the file before committing it anyway.
(() => {
  const focused = document.activeElement;
  const marked = focused && (focused.isContentEditable || focused.tagName === 'TEXTAREA') ? focused : null;
  if (marked) marked.setAttribute('data-expect', 'composer');
  const clone = document.documentElement.cloneNode(true);
  marked?.removeAttribute('data-expect');
  clone.querySelectorAll('script, noscript, iframe, link[rel="preload"], link[rel="modulepreload"], img, video, canvas').forEach((n) => n.remove());
  clone.querySelectorAll('path').forEach((p) => p.removeAttribute('d'));
  clone.querySelectorAll('input, textarea').forEach((i) => i.removeAttribute('value'));
  clone.querySelectorAll('a[href]').forEach((a) => a.setAttribute('href', a.getAttribute('href').split(/[?#]/)[0]));
  const KEEP = new Set(['role', 'aria-label', 'aria-hidden', 'aria-multiline', 'placeholder', 'data-placeholder', 'data-testid', 'data-expect', 'contenteditable', 'hidden', 'inert', 'disabled', 'type', 'href', 'class', 'style', 'data-is-streaming', 'data-test-render-count', 'data-turn-key']);
  clone.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) if (!KEEP.has(a.name)) el.removeAttribute(a.name);
    if (el.hasAttribute('aria-label') && !/prompt|message|send|stop|files|instructions|memory|project|chat/i.test(el.getAttribute('aria-label'))) el.setAttribute('aria-label', 'x');
  });
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const keepText = /^(Instructions|Memory|Context|Project knowledge|Chats|How can I help you today\?|\d+% of project capacity used)$/;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.tagName === 'STYLE') continue;
    if (!keepText.test(n.textContent.trim())) n.textContent = n.textContent.replace(/[^\s]/g, 'x');
  }
  const p = location.pathname;
  const page = /^\/project\/[^/]+\/?$/.test(p) ? 'project-home' : /^\/new\/?$/.test(p) ? 'new-chat' : /^\/chat\//.test(p) ? (document.querySelector('header a[href^="/project/"], main a[href^="/project/"]') ? 'project-chat' : 'chat') : 'other';
  const html = `<!doctype html>\n<!-- claude.ai ${page} page, captured ${new Date().toISOString().slice(0, 10)} with scripts/capture-claude-page.js (text redacted). ${marked ? 'Expected composer marked data-expect="composer".' : 'WARNING: no editor was focused; add data-expect="composer" to the message box by hand.'} -->\n${clone.outerHTML}`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  a.download = `${page}.html`;
  a.click();
  console.log(`ReSync: saved ${page}.html (${Math.round(html.length / 1024)} KB).`);
})();
