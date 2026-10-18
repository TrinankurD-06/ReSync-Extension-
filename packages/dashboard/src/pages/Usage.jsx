import { useState } from 'react';
import { useApi } from '../useApi.js';

const fmt = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const money = (n) => (n ? `$${n.toFixed(2)}` : '-');
/** Browser-extension range of tokens claude.ai processed (estimate); '-' when there is none. */
const range = (r) => (r?.high ? (fmt(r.low) === fmt(r.high) ? fmt(r.low) : `${fmt(r.low)} to ${fmt(r.high)}`) : '-');
const SOURCE = { plugin: 'Claude Code', queue: 'Work queue', cli: 'CLI', extension: 'Browser extension' };

/** Local calendar date n days ago (usage records use local dates, not UTC). */
function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** @param {{ me: any }} props */
export default function Usage({ me }) {
  const [days, setDays] = useState(14);
  const from = isoDaysAgo(days - 1);
  const byUser = useApi(`/usage?groupBy=user&from=${from}`);
  const byProject = useApi(`/usage?groupBy=project&from=${from}`);
  const byDay = useApi(`/usage?groupBy=day&from=${from}`);
  const max = Math.max(1, ...(byDay.data?.rows ?? []).map((r) => r.tokens));

  return (
    <>
      <h1>Usage <span className="estimate">estimate</span></h1>
      <p className="muted">
        Tokens and cost recorded by Claude Code sessions, queued tasks and the browser extension{me.team ? ` across ${me.team.name}` : ''}.
        These are estimates of what was used, not a view of plan limits. Only numbers are stored, never content.
      </p>
      <p className="muted small">For the browser extension, "Tokens" counts what people typed. "Processed (range)" estimates what claude.ai actually read each turn (the whole chat again, replies, files, images, hidden instructions): claude.ai doesn't show real token counts, so these are approximations.</p>
      <div className="row">
        <label htmlFor="days" style={{ margin: 0 }}>Period</label>
        <select id="days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      {byUser.error && <p className="banner">{byUser.error.message}</p>}

      <h2>Per user <span className="estimate">estimate</span></h2>
      <table aria-label="Usage per user">
        <thead><tr><th>User</th><th>Sources</th><th className="num">Tokens (est.)</th><th className="num">Processed (range)</th><th className="num">Messages</th><th className="num">Cost (est.)</th></tr></thead>
        <tbody>
          {(byUser.data?.rows ?? []).map((r) => (
            <tr key={r.userId}><td>{r.userName}</td><td>{r.sources.map((s) => <span className="tag" key={s}>{SOURCE[s] ?? s}</span>)}</td><td className="num">{fmt(r.tokens)}</td><td className="num">{range(r.processedTokens)}</td><td className="num">{r.messages || '-'}</td><td className="num">{money(r.costUsd)}</td></tr>
          ))}
          {byUser.data?.rows.length === 0 && <tr><td colSpan={6} className="muted">No usage yet. Run <code>resync sync</code> or sign in from the extension to upload numbers.</td></tr>}
        </tbody>
      </table>

      <h2>Per project <span className="estimate">estimate</span></h2>
      <table aria-label="Usage per project">
        <thead><tr><th>Project</th><th className="num">Tokens (est.)</th><th className="num">Processed (range)</th><th className="num">Messages</th><th className="num">Cost (est.)</th></tr></thead>
        <tbody>
          {(byProject.data?.rows ?? []).map((r) => <tr key={r.project}><td>{r.project}</td><td className="num">{fmt(r.tokens)}</td><td className="num">{range(r.processedTokens)}</td><td className="num">{r.messages || '-'}</td><td className="num">{money(r.costUsd)}</td></tr>)}
        </tbody>
      </table>

      <h2>Per day <span className="estimate">estimate</span></h2>
      <table aria-label="Usage per day">
        <thead><tr><th>Date</th><th style={{ width: '50%' }}></th><th className="num">Tokens (est.)</th><th className="num">Cost (est.)</th></tr></thead>
        <tbody>
          {[...(byDay.data?.rows ?? [])].sort((a, b) => (a.date < b.date ? 1 : -1)).map((r) => (
            <tr key={r.date}><td>{r.date}</td><td><div className="bar" style={{ width: `${(r.tokens / max) * 100}%` }} title={`${fmt(r.tokens)} tokens (estimate)`} /></td><td className="num">{fmt(r.tokens)}</td><td className="num">{money(r.costUsd)}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
