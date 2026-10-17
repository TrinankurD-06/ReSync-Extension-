import { useState } from 'react';
import { del, serverUrl } from '../api.js';

/** Data controls: export everything, delete my data, delete the team. @param {{ me: any }} props */
export default function Data({ me }) {
  const [msg, setMsg] = useState('');
  const isOwner = me.role === 'owner';
  const danger = async (path, what) => {
    const typed = prompt(`This permanently deletes ${what}. Type DELETE to confirm.`);
    if (typed !== 'DELETE') return;
    try {
      await del(path, { confirm: 'DELETE' });
      window.location.assign('/');
    } catch (e) {
      setMsg(e.message);
    }
  };
  return (
    <>
      <h1>Your data</h1>
      <p className="muted">
        What this server stores about you: your profile, your prompts (personal, and team prompts you can see), usage numbers (never content), queue report summaries you uploaded, items you explicitly shared, and your sign-in tokens (hashed). It never stores API keys or conversations.
      </p>
      {msg && <p className="banner">{msg}</p>}
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Export</h2>
        <p className="small">Download everything as one JSON file.</p>
        <a href={serverUrl('/me/export')}><button className="primary">Export my data (JSON)</button></a>
      </section>
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Delete my data</h2>
        <p className="small">Deletes your account, personal prompts, usage, reports, shared items and tokens. Team prompts you wrote stay with the team.{isOwner ? ' As owner, transfer ownership first if others are in the team.' : ''}</p>
        <button className="danger" onClick={() => danger('/me', 'your account and data')}>Delete my account and data</button>
      </section>
      {isOwner && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Delete team</h2>
          <p className="small">Deletes {me.team.name}, its team prompts, shared items and invites. Members keep their accounts and personal data.</p>
          <button className="danger" onClick={() => danger('/team', `the team "${me.team.name}"`)}>Delete team</button>
        </section>
      )}
    </>
  );
}
