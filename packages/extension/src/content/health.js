// Selector health banner: when claude.ai changes and a selector breaks, say so clearly on the page.
import { healthCheck } from '../lib/selectors.js';

const BANNER_ID = 'resync-health-banner';

const FRIENDLY = {
  composer: 'the message box',
  sidebarChatLink: 'the chat list in the sidebar',
};

/**
 * Show or remove the banner for a health result.
 * @param {{ ok: boolean, missing: string[] }} result
 * @param {Document} [doc]
 */
export function renderBanner(result, doc = document) {
  const existing = doc.getElementById(BANNER_ID);
  if (result.ok) {
    existing?.remove();
    return null;
  }
  if (existing?.dataset.dismissed === 'true') return existing;
  const el = existing ?? doc.createElement('div');
  el.id = BANNER_ID;
  el.setAttribute('role', 'status');
  el.style.cssText = 'position:fixed;z-index:2147483647;bottom:12px;right:12px;max-width:360px;padding:10px 12px;border-radius:8px;background:#7c2d12;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)';
  const what = result.missing.map((m) => FRIENDLY[m] ?? m).join(', ');
  el.textContent = `ReSync can't find ${what} on this page. claude.ai may have changed; some ReSync features are paused. Update ReSync or adjust selectors in ReSync Settings.`;
  const close = doc.createElement('button');
  close.textContent = 'Dismiss';
  close.style.cssText = 'margin-left:8px;background:transparent;color:#fff;border:1px solid #fff;border-radius:4px;cursor:pointer;font:inherit';
  close.addEventListener('click', () => {
    el.dataset.dismissed = 'true';
    el.style.display = 'none';
  });
  el.appendChild(close);
  if (!existing) doc.body.appendChild(el);
  return el;
}

/**
 * Run the check now and report it to the extension (side panel shows it too).
 * @param {{ overrides?: Record<string, string[] | string>, send?: (msg: unknown) => void }} [o]
 */
export function runHealthCheck(o = {}) {
  const result = healthCheck({ overrides: o.overrides });
  renderBanner(result);
  try {
    (o.send ?? ((m) => chrome.runtime.sendMessage(m).catch(() => {})))({ type: 'resync:health', result, url: location.pathname });
  } catch {
    /* extension context gone (e.g. after an update) */
  }
  return result;
}
