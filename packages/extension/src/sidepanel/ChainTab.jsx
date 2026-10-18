import { useEffect, useState } from 'react';
import { renderVariables } from '@resync/shared/prompts';
import {
  CHAIN_FACTS, planIntake, applyIntakeAnswers, mergeChainContext, chainSteps, successCriteriaDefault, parseTeamMembers, MAX_INTAKE_QUESTIONS,
} from '@resync/shared/chains';
import { VariablesForm } from './PromptsTab.jsx';
import { toPage } from './bridge.js';
import { Icon } from './Icon.jsx';

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

/** Facts that are worth keeping between chains (the team rarely changes; product facts are per product). */
const SAVED_FACTS = /** @type {const} */ (['teamMembers', 'teamSize', 'budget', 'deadline', 'successMetric', 'coreFeature', 'targetUser', 'differentiator']);

/** The reusable part of a context (no per-run inputs or assumptions). @param {import('@resync/shared/chains').ChainContext} c */
const reusable = (c) => ({ ...mergeChainContext(c), inputs: {}, assumptions: [] });

/**
 * @param {{
 *   prompt: import('@resync/shared/prompts').Prompt | null,
 *   settings: import('../lib/settings.js').Settings,
 *   update: (fn: (s: any) => void) => Promise<void>,
 * }} props
 */
export default function ChainTab({ prompt, settings, update }) {
  const [state, setState] = useState(/** @type {any} */ (null));
  const [error, setError] = useState('');
  /** Intake in progress: the context so far, the steps (variables filled) and the questions to ask. */
  const [intake, setIntake] = useState(/** @type {any} */ (null));

  useEffect(() => {
    toPage({ type: 'resync:chainState' }).then((r) => r?.ok && r.state && setState(r.state));
    const onMsg = (msg) => {
      if (msg?.type === 'resync:chainUpdate') setState(msg.state);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);
  useEffect(() => setIntake(null), [prompt]);

  const running = state && !['done', 'stopped', 'cancelled'].includes(state.status);
  const success = prompt ? (settings.chains.successCriteria[prompt.slug] ?? successCriteriaDefault(prompt)) : false;

  /** Variables filled: build the context, then ask the intake questions (if any) before starting. */
  const prepare = (values) => {
    setError('');
    const steps = prompt.steps.map((s) => ({ ...s, text: renderVariables(s.text, values, { defaults: prompt.variables }) }));
    const inputs = Object.fromEntries(prompt.variables.map((v) => [v.description || v.name, values[v.name] || v.default || '']).filter(([, x]) => x));
    const context = mergeChainContext(settings.chains.context, { inputs });
    const plan = planIntake(prompt, context, { successCriteria: success });
    if (!plan.questions.length) return start({ steps, context });
    setIntake({ steps, context, questions: plan.questions, notAsked: plan.missing.slice(plan.questions.length) });
  };

  /** @param {{ steps: any[], context: import('@resync/shared/chains').ChainContext }} run */
  const start = async (run) => {
    const all = chainSteps({ steps: run.steps }, { context: run.context, successCriteria: success });
    const r = await toPage({ type: 'resync:chainStart', title: prompt.title, steps: all, context: run.context });
    if (!r?.ok) setError(r?.error ?? 'Could not start the chain.');
    else setIntake(null);
  };

  const finishIntake = async (answers, remember) => {
    const context = applyIntakeAnswers(intake.context, intake.questions, answers);
    if (remember && Object.values(answers).some((a) => String(a ?? '').trim())) {
      await update((s) => {
        s.chains.context = reusable(context);
      });
    }
    await start({ steps: intake.steps, context });
  };

  const control = async (action) => {
    const r = await toPage({ type: 'resync:chainControl', action });
    if (!r?.ok) setError(r?.error ?? 'Could not reach the page.');
  };

  return (
    <>
      <h2>Multi-step chain</h2>
      <p className="small muted">Each step is sent only after Claude's reply to the previous one has finished, then any extra wait is applied. Every step carries the chain context and the previous step's output. The chain stops by itself on an error, a usage-limit message, or if the message box disappears.</p>
      {error && <p className="banner">{error}</p>}
      {state && (
        <div className="card" aria-live="polite">
          <strong>{state.title}</strong>
          <div>
            {STATUS_TEXT[state.status] ?? state.status}
            {state.status === 'countdown' && <> : <strong>{state.countdown}s</strong></>}
            {state.status === 'paused' && <>: step {Math.min(state.step + 1, state.total)} will not be sent until you press Resume{state.pausedFrom === 'countdown' && state.countdown ? ` (${state.countdown}s left on the timer)` : ''}</>}
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
      {!prompt && !state && <div className="empty"><Icon name="chain" size={26} /><div>No chain picked yet.</div><div className="small">In the Prompts tab, press <strong>Run chain</strong> on a multi-step prompt.</div></div>}
      {prompt && !running && !intake && (
        <div className="card">
          <strong>{prompt.title}</strong>
          <ol className="small">
            {prompt.steps.map((s, i) => (
              <li key={i}>{s.text}{i > 0 && s.waitFor === 'timer' && s.delaySeconds ? <span className="muted"> (then wait {s.delaySeconds}s)</span> : null}</li>
            ))}
            {success && <li className="muted">Success criteria: a measurable target for each item, tied to your primary success metric.</li>}
          </ol>
          <label className="row">
            <input type="checkbox" checked={success} onChange={() => update((s) => { s.chains.successCriteria[prompt.slug] = !success; })} /> Add a success-criteria step at the end
          </label>
          {prompt.variables.length
            ? <VariablesForm prompt={prompt} submitLabel="Next" onSubmit={prepare} onCancel={() => setError('')} />
            : <button className="primary" onClick={() => prepare({})}>Next</button>}
        </div>
      )}
      {prompt && intake && <IntakeForm intake={intake} onDone={finishIntake} onCancel={() => setIntake(null)} />}
      {prompt && !running && <ContextEditor settings={settings} update={update} />}
    </>
  );
}

/** At most 3 short questions before the first step. Skipping records the gaps as assumptions. */
function IntakeForm({ intake, onDone, onCancel }) {
  const [answers, setAnswers] = useState(/** @type {Record<string, string>} */ ({}));
  const [remember, setRemember] = useState(true);
  return (
    <form className="card intake" data-testid="chain-intake" onSubmit={(e) => { e.preventDefault(); onDone(answers, remember); }}>
      <strong>Before step 1: {intake.questions.length} quick question{intake.questions.length > 1 ? 's' : ''}</strong>
      <p className="small muted">ReSync asks at most {MAX_INTAKE_QUESTIONS} so the steps don't have to guess. Leave any blank (or skip) and Claude will mark its guesses (assumed).</p>
      {intake.questions.map((q, i) => (
        <div key={q.key}>
          <label htmlFor={`intake-${q.key}`}>{q.question}</label>
          <input id={`intake-${q.key}`} autoFocus={i === 0} value={answers[q.key] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })} />
        </div>
      ))}
      {intake.notAsked.length > 0 && <p className="small muted">Not asked (marked unknown in the context): {intake.notAsked.map((k) => CHAIN_FACTS[k].label).join(', ')}. You can fill these in under Chain context.</p>}
      <label className="row"><input type="checkbox" checked={remember} onChange={() => setRemember(!remember)} /> Remember my answers for the next chain (this browser only)</label>
      <div className="row" style={{ marginTop: 6 }}>
        <button type="submit" className="primary">Start chain</button>
        <button type="button" className="secondary" onClick={() => onDone({}, false)}>Skip questions</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** The saved chain context: facts reused by every chain (kept in this browser only, never synced). */
function ContextEditor({ settings, update }) {
  const c = settings.chains.context;
  const set = (key, value) => update((s) => {
    const next = { ...s.chains.context };
    if (key === 'teamMembers') next.teamMembers = parseTeamMembers(value);
    else next[key] = value;
    s.chains.context = reusable(next);
  });
  const team = c.teamMembers.map((m) => (m.role ? `${m.name}: ${m.role}` : m.name)).join(', ');
  return (
    <details className="card">
      <summary>Chain context ({SAVED_FACTS.filter((k) => (k === 'teamMembers' ? c.teamMembers.length : c[k])).length} of {SAVED_FACTS.length} known)</summary>
      <p className="small muted">Facts every chain gets, so it never has to ask. Saved in this browser only, never synced.</p>
      {SAVED_FACTS.map((k) => (
        <div key={k}>
          <label htmlFor={`ctx-${k}`}>{CHAIN_FACTS[k].label}</label>
          <input id={`ctx-${k}`} placeholder={k === 'teamMembers' ? 'Asha: founder, Ravi: design' : ''} defaultValue={k === 'teamMembers' ? team : (c[k] ?? '')} onBlur={(e) => set(k, e.target.value)} />
        </div>
      ))}
    </details>
  );
}
