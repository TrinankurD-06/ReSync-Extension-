import { useEffect, useState } from 'react';
import { get, post } from '../api.js';
import { navigate } from '../router.jsx';

/** @param {{ token: string, me: any, onJoined: () => void }} props */
export default function Invite({ token, me, onJoined }) {
  const [team, setTeam] = useState(/** @type {any} */ (null));
  const [error, setError] = useState('');
  useEffect(() => {
    get(`/invites/${encodeURIComponent(token)}`).then((r) => setTeam(r.team), (e) => setError(e.message));
  }, [token]);
  const accept = async () => {
    try {
      await post(`/invites/${encodeURIComponent(token)}/accept`);
      onJoined();
      navigate('/team');
    } catch (e) {
      setError(e.message);
    }
  };
  return (
    <>
      <h1>Team invite</h1>
      {error && <p className="banner">{error}</p>}
      {team && !me.team && (
        <div className="card">
          <p>You have been invited to join <strong>{team.name}</strong>.</p>
          <p className="small muted">Your teammates will see your usage numbers (estimates, no content), team prompts, queue report summaries and anything you choose to share.</p>
          <button className="primary" onClick={accept}>Join {team.name}</button>
        </div>
      )}
      {team && me.team && <p className="banner">You are already in the team "{me.team.name}". Leave it on the Team page first.</p>}
    </>
  );
}
