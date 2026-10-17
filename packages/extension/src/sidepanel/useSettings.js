import { useEffect, useState, useCallback, useMemo } from 'react';
import { createSettingsStore, SETTINGS_KEY } from '../lib/settings.js';

/** Live settings for React components: reloads when storage changes anywhere in the extension. */
export function useSettings() {
  const store = useMemo(() => createSettingsStore(), []);
  const [settings, setSettings] = useState(/** @type {import('../lib/settings.js').Settings | null} */ (null));

  useEffect(() => {
    let alive = true;
    store.get().then((s) => alive && setSettings(s));
    const onChange = (changes, area) => {
      if (area === 'local' && changes[SETTINGS_KEY]) store.get().then((s) => alive && setSettings(s));
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, [store]);

  /** @param {(s: import('../lib/settings.js').Settings) => void} fn */
  const update = useCallback(async (fn) => setSettings(await store.update(fn)), [store]);
  return { settings, update };
}
