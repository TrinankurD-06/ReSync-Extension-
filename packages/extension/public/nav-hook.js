// Runs in the PAGE's JavaScript world ("world": "MAIN" in the manifest), before claude.ai's own scripts.
// claude.ai is a single-page app that changes the URL with history.pushState/replaceState, which an isolated
// content script cannot see (it has its own `history`). This wraps both and fires a plain DOM event on document,
// which the content script listens for (see watchUrl in src/lib/selectors.js). It sends no data, only "the URL
// changed"; the content script reads location itself. Keep this file tiny and dependency-free.
(() => {
  if (window.__resyncNavHook) return;
  window.__resyncNavHook = true;
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name];
    history[name] = function (...args) {
      const result = original.apply(this, args);
      try {
        document.dispatchEvent(new Event('resync:navigate'));
      } catch {
        /* never break the page */
      }
      return result;
    };
  }
})();
