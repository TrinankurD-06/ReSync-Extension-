import { useEffect, useState } from 'react';
import { renderVariables } from '@resync/shared/prompts';
import { VariablesForm } from './PromptsTab.jsx';
import { toPage } from './bridge.js';

const STATUS_TEXT = {
  idle: 'Ready',
  sending: 'Sending...',
  'waiting-reply': 'Waiting for the reply to finish',
  countdown: 'Waiting before the next step',
  paused: 'Paused',
  done: 'Finished',
  stopped: 'Stopped',
  cancelled: 'Cancelled',
};

/** @param {{ prompt: import('@resync/shared/prompts').Prompt | null }} props */
export default function ChainTab({ prompt }) {
  const [state, setState] = useState(/** @type {any} */ (null));
  const [error, setError] = useState('');

  useEffect(() => {
    toPage({ type: 'resync:chainState' }).then((r) => r?.ok && r.state && setState(r.state));
    const onMsg = (msg) => {
      if (msg?.type === 'resync:chainUpdate') setState(msg.state);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  const running = state && !['done', 'stopped', 'cancelled'].includes(state.status);

  const start = async (values) => {
    setError('');
    const steps = prompt.steps.map((s) => ({ ...s, text: renderVariables(s.text, values, { defaults: prompt.variables }) }));
    const r = await toPage({ type: 'resync:chainStart', title: prompt.title, steps });
    if (!r?.ok) setError(r?.error ?? 'Could not start the chain.');
  };
  const control = async (action) => {
    const r = await toPage({ type: 'resync:chainControl', action });
    if (!r?.ok) setError(r?.error ?? 'Could not reach the page.');
  };

  return (
    <>
      <h2>Multi-step chain</h2>
      <p className="small muted">Each step is sent only after Claude's reply to the previous one has finished, then any extra wait is applied. The chain stops by itself on an error, a usage-limit message, or if the message box disappears.</p>
      {error && <p className="banner">{error}</p>}
      {state && (
        <div className="card" aria-live="polite">
          <strong>{state.title}</strong>
          <div>
            {STATUS_TEXT[state.status] ?? state.status}
            {state.status === 'countdown' && <> : <strong>{state.countdown}s</strong></>}
            {state.paused && state.status !== 'paused' && running && <> (will pause before the next step)</>}
          </div>
          <div className="small">Step {Math.min(state.step + 1, state.total)} of {state.total} · sent {state.sent.length}{state.skipped.length ? ` · skipped ${state.skipped.length}` : ''}</div>
          <progress max={state.total} value={state.sent.length + state.skipped.length} style={{ width: '100%' }} />
          {state.reason && <div className="error small">{state.reason}</div>}
          {running && (
            <div className="row" style={{ marginTop: 6 }}>
              {state.paused ? <button className="primary" onClick={() => control('resume')}>Resume</button> : <button className="secondary" onClick={() => control('pause')}>Pause</button>}
              <button className="secondary" onClick={() => control('skip')}>Skip next</button>
              <button className="secondary" onClick={() => control('cancel')}>Cancel</button>
            </div>
          )}
        </div>
      )}
      {!prompt && !state && <p className="muted">Pick a chain in the Prompts tab ("Run chain").</p>}
      {prompt && !running && (
        <div className="card">
          <strong>{prompt.title}</strong>
          <ol className="small">
            {prompt.steps.map((s, i) => (
              <li key={i}>{s.text}{i > 0 && s.waitFor === 'timer' && s.delaySeconds ? <span className="muted"> (then wait {s.delaySeconds}s)</span> : null}</li>
            ))}
          </ol>
          {prompt.variables.length
            ? <VariablesForm prompt={prompt} submitLabel="Start chain" onSubmit={start} onCancel={() => setError('')} />
            : <button className="primary" onClick={() => start({})}>Start chain</button>}
        </div>
      )}
    </>
  );
}
