// Project colour-coding for the claude.ai sidebar. Colours sync to the team server (numbers/labels only).
import { queryAll } from './selectors.js';

/** @typedef {{ id: string, label: string, colour: string }} ColourChoice */

/** @type {Record<string, { label: string, colours: ColourChoice[] }>} */
export const PRESETS = {
  startup: {
    label: 'Startup',
    colours: [
      { id: 'product', label: 'Product', colour: '#4f46e5' },
      { id: 'engineering', label: 'Engineering', colour: '#0891b2' },
      { id: 'growth', label: 'Growth', colour: '#16a34a' },
      { id: 'fundraising', label: 'Fundraising', colour: '#d97706' },
      { id: 'ops', label: 'Ops & admin', colour: '#64748b' },
    ],
  },
  personal: {
    label: 'Personal',
    colours: [
      { id: 'learning', label: 'Learning', colour: '#2563eb' },
      { id: 'health', label: 'Health', colour: '#059669' },
      { id: 'money', label: 'Money', colour: '#ca8a04' },
      { id: 'ideas', label: 'Ideas', colour: '#db2777' },
      { id: 'home', label: 'Home', colour: '#7c3aed' },
    ],
  },
};

/** All colour choices across presets, by id. */
export function colourById(id) {
  for (const p of Object.values(PRESETS)) {
    const c = p.colours.find((x) => x.id === id);
    if (c) return c;
  }
  return null;
}

/**
 * Sidebar item key from a link: "project:<id>" or "chat:<id>".
 * @param {string} href
 */
export function itemKey(href) {
  const m = /\/(project|chat)\/([A-Za-z0-9-]+)/.exec(href ?? '');
  return m ? `${m[1]}:${m[2]}` : null;
}

/**
 * List sidebar projects and chats (for the side panel's colour picker).
 * @param {{ root?: ParentNode, overrides?: Record<string, string[]> }} [o]
 */
export function listSidebarItems(o = {}) {
  const seen = new Set();
  const items = [];
  for (const name of ['sidebarProjectLink', 'sidebarChatLink']) {
    for (const a of queryAll(name, o)) {
      const key = itemKey(a.getAttribute('href'));
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push({ key, kind: key.split(':')[0], title: (a.textContent ?? '').trim().slice(0, 80) || key });
    }
  }
  return items;
}

const ATTR = 'data-resync-colour';

/**
 * Paint assigned colours on sidebar links; clear stale ones. Returns how many links were coloured.
 * @param {Record<string, string>} assignments item key -> colour id
 * @param {{ root?: ParentNode, overrides?: Record<string, string[]> }} [o]
 */
export function applyColours(assignments, o = {}) {
  let painted = 0;
  for (const name of ['sidebarProjectLink', 'sidebarChatLink']) {
    for (const a of queryAll(name, o)) {
      const el = /** @type {HTMLElement} */ (a);
      const key = itemKey(el.getAttribute('href'));
      const choice = key ? colourById(assignments[key]) : null;
      if (choice) {
        if (el.getAttribute(ATTR) !== choice.id) {
          el.setAttribute(ATTR, choice.id);
          el.style.boxShadow = `inset 3px 0 0 ${choice.colour}`;
          el.title = `${choice.label} (ReSync)`;
        }
        painted++;
      } else if (el.hasAttribute(ATTR)) {
        el.removeAttribute(ATTR);
        el.style.boxShadow = '';
        el.removeAttribute('title');
      }
    }
  }
  return painted;
}
