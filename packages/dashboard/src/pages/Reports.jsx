import { useApi } from '../useApi.js';

/** Queue report summaries uploaded by teammates (`resync config set queue.uploadReports true`). */
export default function Reports() {
  const { data, error } = useApi('/queue-reports');
  return (
    <>
      <h1>Queue reports</h1>
      <p className="muted">What the Limit-Aware Work Queue ran overnight. Each task ran on its own <code>resync/&lt;task-id&gt;</code> branch: nothing was merged or pushed. Summaries are uploaded only when a teammate turns on report upload.</p>
      {error && <p className="banner">{error.message}</p>}
      {data?.reports.length === 0 && <p className="muted">No reports yet. Turn on uploads with <code>resync config set queue.uploadReports true</code>.</p>}
      {data?.reports.map((r) => (
        <div className="card" key={r.id}>
          <div className="row">
            <strong className="grow">{r.title}</strong>
            <span className={r.status === 'done' ? 'ok' : r.status === 'failed' ? 'error' : 'muted'}>{r.status}</span>
          </div>
          <div className="small muted">{r.userName} · {r.finishedAt ? new Date(r.finishedAt).toLocaleString() : 'not finished'} · <code>{r.branch}</code></div>
          {r.summary && <pre className="small">{r.summary}</pre>}
          <div className="small">Files changed: {r.filesChanged.length ? r.filesChanged.map((f) => <code key={f} style={{ marginRight: 6 }}>{f}</code>) : 'none'}</div>
          <div className="small">Tests run: {r.testsRun ?? 'not reported'}</div>
        </div>
      ))}
    </>
  );
}
