import { useEffect, useMemo, useState } from 'react';
import { formatTokenEstimate, formatTokenRange } from '@resync/shared/tokens';
import { createUsageStore, summarise, USAGE_KEY } from '../lib/usageEstimates.js';

/** 7-day bar chart: each bar runs from the low to the high estimate of tokens processed (plain SVG, labelled). */
function Chart({ days }) {
  const max = Math.max(1, ...days.map((d) => d.processed.high));
  const W = 300;
  const H = 120;
  const bw = W / days.length;
  return (
    <svg viewBox={`0 0 ${W} ${H + 30}`} width="100%" role="img" aria-label="Estimated tokens processed per day, last 7 days (low to high)">
      {days.map((d, i) => {
        const lo = Math.round((d.processed.low / max) * H);
        const hi = Math.round((d.processed.high / max) * H);
        const label = new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
        return (
          <g key={d.date}>
            <title>{`${d.date}: processed ${formatTokenRange(d.processed)}; you typed ${formatTokenEstimate(d.typed)}; ${d.messages} message(s)`}</title>
            <rect x={i * bw + 6} y={H - hi} width={bw - 12} height={Math.max(hi, d.processed.high ? 2 : 0)} rx="3" fill="var(--accent)" opacity="0.35" />
            <rect x={i * bw + 6} y={H - lo} width={bw - 12} height={Math.max(lo, d.processed.low ? 2 : 0)} rx="3" fill="var(--accent)" />
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

  return (
    <>
      <h2>Usage <span className="estimate">estimate</span></h2>
      <p className="small muted">claude.ai doesn't show real token counts, so these are approximations. Only these numbers sync to your team server, never message text.</p>
      <div className="card">
        <div className="row"><strong>Last 7 days</strong><span className="small">{s.week.messages} messages</span></div>
        <div className="usage-figures">
          <div>
            <div className="small muted">Tokens you typed <span className="estimate">estimate</span></div>
            <strong data-testid="usage-typed">{formatTokenEstimate(s.week.typed)}</strong>
          </div>
          <div>
            <div className="small muted">Estimated tokens processed <span className="estimate">estimate</span></div>
            <strong data-testid="usage-processed">{formatTokenRange(s.week.processed)}</strong>
          </div>
        </div>
        <Chart days={s.days} />
        <p className="small muted">Bars show tokens processed: solid to the low estimate, light to the high one.</p>
      </div>
      <details className="card">
        <summary>How "processed" is estimated</summary>
        <p className="small">Every message you send makes Claude re-read the whole chat so far, plus project files, attachments and hidden instructions, then write a reply. So per message ReSync adds: all earlier turns in that chat + your message + images and files (a fixed estimate each) + the project's files + an allowance for hidden instructions; and each reply once. Text counts about 4 characters per token for English prose, 3 for code and JSON, 2 for non-Latin scripts. The range comes from what the page can't show: hidden instructions, file sizes, project files. Adjust the assumptions in Settings &gt; Usage estimates.</p>
      </details>
      <h2>By project <span className="estimate">estimate</span></h2>
      {s.projects.length === 0 && <p className="muted small">No usage recorded yet. ReSync counts new messages from now on.</p>}
      {s.projects.map((p) => (
        <div className="row card" key={p.project}>
          <span>{p.project}</span>
          <span className="small">{p.messages} msg · typed {formatTokenEstimate(p.typed)} · processed {formatTokenRange(p.processed)}</span>
        </div>
      ))}
    </>
  );
}
