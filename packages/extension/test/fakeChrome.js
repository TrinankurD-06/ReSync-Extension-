// Minimal in-memory stand-ins for chrome.storage areas used in tests.

/** @returns {{ get(k: string | string[] | null): Promise<Record<string, any>>, set(o: Record<string, any>): Promise<void>, remove(k: string | string[]): Promise<void>, dump(): Record<string, any> }} */
export function memoryArea() {
  const m = new Map();
  return {
    async get(k) {
      if (k == null) return Object.fromEntries(m);
      const keys = Array.isArray(k) ? k : [k];
      return Object.fromEntries(keys.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))]));
    },
    async set(o) {
      for (const [k, v] of Object.entries(o)) m.set(k, structuredClone(v));
    },
    async remove(k) {
      for (const x of Array.isArray(k) ? k : [k]) m.delete(x);
    },
    dump: () => Object.fromEntries(m),
  };
}
