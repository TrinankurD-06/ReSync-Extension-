import { useState } from 'react';
import { useApi } from '../useApi.js';
import { post, patch, del } from '../api.js';

/** @param {{ me: any, onChange: () => void }} props */
export default function Team({ me, onChange }) {
  const team = useApi(me.team ? '/team' : null);
  const invites = useApi(me.role === 'owner' ? '/team/invites' : null);
  const tokens = useApi('/tokens');
  const [name, setName] = useState('');
  const [newInvite, setNewInvite] = useState('');
  const [msg, setMsg] = useState('');
  const isOwner = me.role === 'owner';

  const act = async (fn, ok) => {
    setMsg('');
    try {
      await fn();
      if (ok) setMsg(ok);
      team.reload();
      invites.reload();
      tokens.reload();
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <>
      <h1>Team</h1>
      {msg && <p className="banner">{msg}</p>}
      {!me.team && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Create a team</h2>
          <p className="small muted">Teams are invite-only. You become the owner and can invite teammates by link.</p>
          <div className="row">
            <input aria-label="Team name" placeholder="Team name" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="primary" disabled={!name.trim()} onClick={() => act(async () => { await post('/teams', { name }); onChange(); }, 'Team created.')}>Create team</button>
          </div>
          <p className="small muted">Got an invite link? Open it while signed in to join.</p>
        </section>
      )}

      {team.data && (
        <>
          <h2>{team.data.team.name}: members</h2>
          <table aria-label="Members">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th>{isOwner && <th></th>}</tr></thead>
            <tbody>
              {team.data.members.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}{m.id === me.id && <span className="small muted"> (you)</span>}</td>
                  <td>{m.email ?? '-'}</td>
                  <td>{m.role}</td>
                  {isOwner && (
                    <td>
                      {m.id !== me.id && (
                        <div className="row">
                          <button onClick={() => confirm(`Make ${m.name} the owner? You will become a member.`) && act(async () => { await patch(`/team/members/${m.id}`, { role: 'owner' }); onChange(); }, 'Ownership transferred.')}>Make owner</button>
                          <button className="danger" onClick={() => confirm(`Remove ${m.name} from the team?`) && act(() => del(`/team/members/${m.id}`), 'Member removed.')}>Remove</button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {isOwner && (
            <>
              <h2>Invites</h2>
              <button className="primary" onClick={() => act(async () => setNewInvite((await post('/team/invites')).url))}>Create invite link</button>
              {newInvite && (
                <div className="card">
                  <div className="small">Send this link to one teammate (single use, expires in 7 days). It is shown only once:</div>
                  <div className="row"><code className="grow" style={{ wordBreak: 'break-all' }} aria-label="Invite link">{newInvite}</code><button onClick={() => navigator.clipboard.writeText(newInvite)}>Copy</button></div>
                </div>
              )}
              {invites.data?.invites.map((i) => (
                <div className="row card" key={i.id}>
                  <span className="grow small">Invite created {new Date(i.createdAt).toLocaleString()}, expires {new Date(i.expiresAt).toLocaleDateString()}</span>
                  <button className="danger" onClick={() => act(() => del(`/team/invites/${i.id}`), 'Invite revoked.')}>Revoke</button>
                </div>
              ))}
            </>
          )}
          {!isOwner && <p><button className="danger" onClick={() => confirm('Leave the team?') && act(async () => { await post('/team/leave'); onChange(); }, 'You left the team.')}>Leave team</button></p>}
        </>
      )}

      <h2>Signed-in devices and tokens</h2>
      <p className="small muted">The resync CLI and the extension sign in with personal tokens (approve them on the <a href="/device">Connect a device</a> page). Revoke any you no longer use.</p>
      <table aria-label="Tokens">
        <thead><tr><th>Device</th><th>Kind</th><th>Created</th><th>Last used</th><th></th></tr></thead>
        <tbody>
          {tokens.data?.tokens.map((t) => (
            <tr key={t.id}>
              <td>{t.label || '(unnamed)'}{t.current && <span className="small muted"> (this browser)</span>}</td>
              <td>{t.kind}</td>
              <td>{new Date(t.createdAt).toLocaleDateString()}</td>
              <td>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : '-'}</td>
              <td>{!t.current && <button className="danger" onClick={() => act(() => del(`/tokens/${t.id}`), 'Token revoked.')}>Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
