import { useEffect, useState } from 'react';
import { get, post, serverUrl } from '../api.js';

/** @param {{ next: string }} props */
export default function SignIn({ next }) {
  const [providers, setProviders] = useState(/** @type {any} */ (null));
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    get('/auth/providers').then(setProviders, (e) => setError(e.message));
  }, []);
  const back = encodeURIComponent(next && next !== '/' ? next + window.location.search : '/usage');

  const devLogin = async (e) => {
    e.preventDefault();
    try {
      await post('/auth/dev-login', { email });
      window.location.reload();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="center">
      <h1><img src="/icon.svg" alt="" width="24" height="24" style={{ verticalAlign: 'middle' }} /> ReSync</h1>
      <p className="muted">Sign in to see your team's prompts, usage and handoffs.</p>
      {error && <p className="banner">{error}</p>}
      {providers && (
        <>
          {providers.github && <p><a href={serverUrl(`/auth/github/start?next=${back}`)}><button className="primary" style={{ width: '100%' }}>Sign in with GitHub</button></a></p>}
          {providers.google && <p><a href={serverUrl(`/auth/google/start?next=${back}`)}><button className="primary" style={{ width: '100%' }}>Sign in with Google</button></a></p>}
          {providers.dev && (
            <form onSubmit={devLogin} className="card">
              <div className="small muted">Development sign-in (ALLOW_DEV_LOGIN is on: never use in production)</div>
              <label htmlFor="dev-email">Email</label>
              <div className="row">
                <input id="dev-email" type="email" required className="grow" value={email} onChange={(e) => setEmail(e.target.value)} />
                <button className="primary" type="submit">Continue</button>
              </div>
            </form>
          )}
          {!providers.github && !providers.google && !providers.dev && (
            <p className="banner">No sign-in method is configured on this server. Set GITHUB_CLIENT_ID/SECRET or GOOGLE_CLIENT_ID/SECRET (see docs/SELF_HOSTING.md).</p>
          )}
        </>
      )}
    </div>
  );
}
