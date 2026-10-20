// The Chat Health Meter's small badge on the claude.ai page (bottom left, out of the way of the composer).
// Green is just a dot; amber and red say so; red (unless snoozed for this chat) also suggests a handoff, which runs
// from the ReSync panel. Never touches the chat itself.
import { HEALTH_TOOLTIP } from '../lib/chatHealth.js';

export const BADGE_ID = 'resync-health-badge';
const COLOUR = { green: '#16a34a', amber: '#d97706', red: '#dc2626' };

/**
 * @param {import('../lib/chatHealth.js').ChatHealth | null} health null removes the badge
 * @param {{ nudge?: boolean, onClick?: () => void, doc?: Document }} [o]
 */
export function renderBadge(health, o = {}) {
  const doc = o.doc ?? document;
  let el = doc.getElementById(BADGE_ID);
  if (!health) {
    el?.remove();
    return null;
  }
  if (!el) {
    el = doc.createElement('button');
    el.id = BADGE_ID;
    el.type = 'button';
    el.style.cssText = 'position:fixed;z-index:2147483646;left:12px;bottom:12px;display:flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.92);color:#333;font:11px/1.4 system-ui,sans-serif;cursor:pointer;opacity:.85;box-shadow:0 1px 4px rgba(0,0,0,.12)';
    el.addEventListener('click', () => o.onClick?.());
    doc.body.appendChild(el);
  }
  el.dataset.level = health.level;
  const why = health.reasons.length ? `\n${health.reasons.join('\n')}` : '';
  el.title = `ReSync chat health: ${health.level}. ${HEALTH_TOOLTIP}${why}${o.nudge ? '\nClick to open ReSync and hand off to a fresh chat.' : ''}`;
  el.setAttribute('aria-label', `ReSync chat health: ${health.level}. ${HEALTH_TOOLTIP}`);
  el.textContent = '';
  const dot = doc.createElement('span');
  dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${COLOUR[health.level]}`;
  el.appendChild(dot);
  if (health.level !== 'green') el.append(o.nudge ? 'Long chat: hand off?' : health.level === 'red' ? 'Long chat' : 'Getting long');
  return el;
}
