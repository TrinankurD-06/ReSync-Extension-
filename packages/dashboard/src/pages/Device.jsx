import { useState } from 'react';
import { post } from '../api.js';

/** Approve a login code shown by the resync CLI or the extension. */
export default function Device() {
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get('code') ?? '');
  const [result, setResult] = useState(/** @type {any} */ (null));
  const send = async (approve) => {
    try {
      const r = await post('/auth/device/approve', { userCode: code.trim(), approve });
      setResult({ ok: true, text: approve ? `Approved "${r.label}". You can go back to it now.` : 'Denied. Nothing was signed in.' });
    } catch (e) {
      setResult({ ok: false, text: e.message });
    }
  };
  return (
    <>
      <h1>Connect a device</h1>
      <p className="muted">The resync CLI or the ReSync extension shows a code like <code>ABCD-EFGH</code>. Enter it to give that device a personal token. You can revoke it later on the Team page.</p>
      <label htmlFor="code">Code</label>
      <div className="row">
        <input id="code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" style={{ letterSpacing: 2, fontFamily: 'monospace' }} />
        <button className="primary" onClick={() => send(true)} disabled={!code.trim()}>Approve</button>
        <button className="danger" onClick={() => send(false)} disabled={!code.trim()}>Deny</button>
      </div>
      {result && <p className={result.ok ? 'ok' : 'banner'}>{result.text}</p>}
    </>
  );
}
