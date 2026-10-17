import { useEffect, useMemo, useState } from 'react';
import { formatTokenEstimate } from '@resync/shared/tokens';
import { createUsageStore, summarise, USAGE_KEY } from '../lib/usageEstimates.js';

/** 7-day bar chart of estimated tokens (plain SVG, labelled as an estimate). */
function Chart({ days }) {
  const max = Math.max(1, ...days.map((d) => d.tokens));
  const W = 300;
  const H = 120;
  const bw = W / days.length;
  return (
    <svg viewBox={`0 0 ${W} ${H + 30}`} width="100%" role="img" aria-label="Estimated tokens per day, last 7 days">
      {days.map((d, i) => {
        const h = Math.round((d.tokens / max) * H);
        const label = new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
        return (
          <g key={d.date}>
            <title>{`${d.date}: ${formatTokenEstimate(d.tokens)}, ${d.messages} message(s)`}</title>
            <rect x={i * bw + 6} y={H - h} width={bw - 12} height={Math.max(h, d.tokens ? 2 : 0)} rx="3" fill="var(--accent)" />
            <text x={i * bw + bw / 2} y={H + 14} textAnchor="middle" fontSize="10" fill="var(--muted)">{label}</text>
            {d.messages > 0 && <text x={i * bw + bw / 2} y={H + 26} textAnchor="middle" fontSize="9" fill="var(--muted)">{d.messages} msg</text>}
          </g>
        );
      })}
      <line x1="0" x2={W} y1={H} y2={H} stroke="var(--border)" />
    </svg>
  );
}

export default function UsageTab() {
  const store = useMemo(() => createUsageStore(), []);
  const [rows, setRows] = useState([]);
  useEffect(() => {
    const load = () => store.all().then(setRows);
    load();
    const onChange = (c, area) => area === 'local' && c[USAGE_KEY] && load();
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [store]);
  const s = summarise(rows);
  const week = s.days.reduce((a, d) => ({ tokens: a.tokens + d.tokens, messages: a.messages + d.messages }), { tokens: 0, messages: 0 });

  return (
    <>
      <h2>Usage <span className="estimate">estimate</span></h2>
      <p className="small muted">Messages you sent on claude.ai and an estimate of tokens (about 4 characters per token). This is an estimate of what was used, not your plan limits. Only these numbers sync to your team server.</p>
      <div className="card">
        <div className="row"><strong>Last 7 days</strong><span className="small">{week.messages} messages · {formatTokenEstimate(week.tokens)}</span></div>
        <Chart days={s.days} />
      </div>
      <h2>By project <span className="estimate">estimate</span></h2>
      {s.projects.length === 0 && <p className="muted small">No usage recorded yet. ReSync counts new messages from now on.</p>}
      {s.projects.map((p) => (
        <div className="row card" key={p.project}>
          <span>{p.project}</span>
          <span className="small">{p.messages} msg · {formatTokenEstimate(p.tokens)}</span>
        </div>
      ))}
    </>
  );
}
