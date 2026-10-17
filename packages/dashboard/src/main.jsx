import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { get, post, ApiError } from './api.js';
import { usePath, Link, navigate } from './router.jsx';
import SignIn from './pages/SignIn.jsx';
import Prompts from './pages/Prompts.jsx';
import Usage from './pages/Usage.jsx';
import Reports from './pages/Reports.jsx';
import Shared from './pages/Shared.jsx';
import Team from './pages/Team.jsx';
import Data from './pages/Data.jsx';
import Device from './pages/Device.jsx';
import Invite from './pages/Invite.jsx';

const NAV = [
  ['/usage', 'Usage'],
  ['/prompts', 'Prompts'],
  ['/reports', 'Queue reports'],
  ['/shared', 'Shared passports'],
  ['/team', 'Team'],
  ['/data', 'Your data'],
];

function App() {
  const path = usePath();
  const [me, setMe] = useState(/** @type {any} */ (undefined));
  const reload = () => get('/me').then(setMe, (e) => (e instanceof ApiError && e.status === 401 ? setMe(null) : setMe({ error: e.message })));
  useEffect(() => {
    reload();
  }, []);

  if (me === undefined) return <div className="center muted">Loading...</div>;
  if (me?.error) return <div className="center"><p className="banner">Could not reach the ReSync server: {me.error}</p></div>;
  if (!me) return <SignIn next={path} />;

  let page;
  if (path.startsWith('/invite/')) page = <Invite token={path.slice('/invite/'.length)} me={me} onJoined={reload} />;
  else if (path === '/device') page = <Device />;
  else if (path === '/prompts') page = <Prompts me={me} />;
  else if (path === '/reports') page = <Reports />;
  else if (path === '/shared') page = <Shared me={me} />;
  else if (path === '/team') page = <Team me={me} onChange={reload} />;
  else if (path === '/data') page = <Data me={me} />;
  else page = <Usage me={me} />;

  return (
    <div className="shell">
      <nav className="side" aria-label="Main">
        <div className="brand"><img src="/icon.svg" alt="" width="22" height="22" /> ReSync</div>
        {NAV.map(([to, label]) => <Link key={to} to={to}>{label}</Link>)}
        <div className="small muted" style={{ padding: '16px 10px 0' }}>
          Signed in as <strong>{me.name}</strong>
          {me.team ? <><br />Team: {me.team.name} ({me.role})</> : <><br />No team yet</>}
          <br />
          <button style={{ marginTop: 8 }} onClick={async () => { await post('/auth/logout'); navigate('/'); setMe(null); }}>Sign out</button>
        </div>
      </nav>
      <main>{page}</main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
