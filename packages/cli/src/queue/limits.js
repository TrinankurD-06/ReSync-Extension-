// Usage-limit detection for queued runs. Patterns come from ~/.resync/config.json (queue.limitPatterns).

/**
 * Compile config patterns (regex sources) case-insensitively. Invalid patterns are skipped and reported.
 * @param {string[]} sources
 */
export function compilePatterns(sources) {
  const patterns = [];
  const invalid = [];
  for (const s of sources ?? []) {
    try {
      patterns.push(new RegExp(s, 'i'));
    } catch {
      invalid.push(s);
    }
  }
  return { patterns, invalid };
}

/**
 * Look for a usage-limit message in a failed run's output.
 * @param {string} output combined stdout/stderr/result text
 * @param {RegExp[]} patterns
 * @returns {{ limited: false } | { limited: true, match: string, line: string }}
 */
export function detectLimit(output, patterns) {
  const text = String(output ?? '');
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const start = text.lastIndexOf('\n', m.index) + 1;
      const end = text.indexOf('\n', m.index);
      return { limited: true, match: m[0], line: text.slice(start, end === -1 ? undefined : end).trim().slice(0, 300) };
    }
  }
  return { limited: false };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Parse a reset time from a limit message. Handles the documented forms and common variants:
 *   "resets 3:45pm", "resets Mon 12:00am", "resets at 3pm", "reset at 15:30", "resets in 2 hours",
 *   "try again in 45 minutes", "resets Oct 18, 9am", ISO timestamps, unix epoch seconds.
 * Times are local. A time already past today means tomorrow (or next week for a weekday).
 * @param {string} text
 * @param {Date} [now]
 * @returns {Date | null}
 */
export function parseResetTime(text, now = new Date()) {
  const s = String(text ?? '');

  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)\b/.exec(s);
  if (iso) {
    const d = new Date(iso[1]);
    if (!Number.isNaN(d.getTime()) && d > now) return d;
  }

  const epoch = /\bresets?(?:_at)?["']?\s*[:=]?\s*(\d{10})\b/i.exec(s);
  if (epoch) {
    const d = new Date(Number(epoch[1]) * 1000);
    if (d > now) return d;
  }

  const rel = /\b(?:resets?|try again|retry)\s+(?:in|after)\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:and\s+)?(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(s);
  if (rel && (rel[1] || rel[2])) {
    const ms = (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000;
    if (ms > 0) return new Date(now.getTime() + ms);
  }

  // "resets [at] [Mon|Oct 18,] 3:45pm" / "15:30"
  const abs = /\bresets?\s+(?:at\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s+|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(s);
  if (abs) {
    const [, day, mon, dom, hh, mm, ampm] = abs;
    let h = Number(hh);
    const min = Number(mm ?? 0);
    if (!ampm && mm === undefined) return null; // a bare number is too ambiguous
    if (h > 23 || min > 59) return null;
    if (ampm) {
      if (h > 12 || h === 0) return null;
      h = (h % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
    }
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setHours(h, min);
    if (mon) {
      d.setMonth(MONTHS.indexOf(mon.toLowerCase()), Number(dom));
      if (d <= now) d.setFullYear(d.getFullYear() + 1);
    } else if (day) {
      const target = DAYS.indexOf(day.toLowerCase());
      let add = (target - now.getDay() + 7) % 7;
      d.setDate(now.getDate() + add);
      if (d <= now) d.setDate(d.getDate() + 7);
    } else if (d <= now) {
      d.setDate(d.getDate() + 1);
    }
    return d;
  }
  return null;
}

/**
 * Backoff when no reset time is known: 15 min, doubling, capped at 2 h (all configurable).
 * @param {number | undefined} previousMinutes
 * @param {{ initialMinutes: number, maxMinutes: number }} cfg
 */
export function nextBackoffMinutes(previousMinutes, cfg) {
  if (!previousMinutes) return cfg.initialMinutes;
  return Math.min(previousMinutes * 2, cfg.maxMinutes);
}

/**
 * Decide when a limited task may retry.
 * @param {string} output
 * @param {{ backoffMinutes?: number }} task
 * @param {{ initialMinutes: number, maxMinutes: number }} backoff
 * @param {Date} [now]
 * @returns {{ notBefore: Date, backoffMinutes?: number, reason: string }}
 */
export function scheduleRetry(output, task, backoff, now = new Date()) {
  const reset = parseResetTime(output, now);
  if (reset) {
    // Small margin so we don't start the second the window flips.
    return { notBefore: new Date(reset.getTime() + 60_000), backoffMinutes: undefined, reason: `limit resets at ${reset.toLocaleString()}` };
  }
  const minutes = nextBackoffMinutes(task.backoffMinutes, backoff);
  return { notBefore: new Date(now.getTime() + minutes * 60_000), backoffMinutes: minutes, reason: `no reset time found; backing off ${minutes} min` };
}
