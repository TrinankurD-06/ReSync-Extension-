import { useEffect, useRef, useState } from 'react';
import { resolveFeature } from '@resync/shared/models';
import { providerSpeak } from './bridge.js';

/** Voices from speechSynthesis; the list can arrive late, so listen for voiceschanged (MDN). */
function useVoices() {
  const [voices, setVoices] = useState(() => (typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : []));
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return undefined;
    const load = () => setVoices(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', load);
    load();
    return () => speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);
  return voices;
}

/**
 * Read text aloud. Default: the browser's free speechSynthesis (voice picker, speed, play/pause).
 * Optional: provider TTS (BYO key) when the "Voice" feature is routed to a provider in Settings.
 * @param {{ text: string, settings: import('../lib/settings.js').Settings, update?: (fn: (s: any) => void) => Promise<void> }} props
 */
export default function Voice({ text, settings, update }) {
  const voices = useVoices();
  const [state, setState] = useState(/** @type {'idle' | 'playing' | 'paused' | 'loading'} */ ('idle'));
  const [voiceURI, setVoiceURI] = useState(settings.voice.voiceURI);
  const [rate, setRate] = useState(settings.voice.rate);
  const [error, setError] = useState('');
  const audio = useRef(/** @type {HTMLAudioElement | null} */ (null));
  // Where the browser voice has got to (character index), so a speed change can carry on from there.
  const providerRate = useRef(1);
  const spoken = useRef({ base: 0, at: 0, rateChanged: false });

  let providerMode = false;
  try {
    providerMode = resolveFeature(settings.ai, 'tts').mode === 'api';
  } catch {
    providerMode = false;
  }

  useEffect(() => () => {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    audio.current?.pause();
  }, []);

  const remember = (patch) => update?.((s) => {
    Object.assign(s.voice, patch);
  });

  const play = async () => {
    setError('');
    if (state === 'paused') {
      if (audio.current) audio.current.play();
      else if (spoken.current.rateChanged) return speakBrowser(spoken.current.at);
      else speechSynthesis.resume();
      setState('playing');
      return;
    }
    if (providerMode) {
      setState('loading');
      const r = await providerSpeak({ text, speed: rate });
      if (!r?.ok) {
        setState('idle');
        setError(`${r?.error?.message ?? 'Provider voice failed'}. Using the browser voice instead.`);
        return speakBrowser();
      }
      const bytes = Uint8Array.from(atob(r.audioBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: r.mimeType }));
      audio.current = new Audio(url);
      providerRate.current = rate; // the provider already spoke at this speed
      audio.current.onended = () => setState('idle');
      await audio.current.play();
      setState('playing');
      return;
    }
    speakBrowser();
  };

  /** Speak with the browser voice from character `from` (a speed change restarts from where it got to). */
  const speakBrowser = (from = 0, r = rate) => {
    if (typeof speechSynthesis === 'undefined') return setError('Speech is not available in this browser.');
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.slice(from));
    spoken.current = { base: from, at: from, rateChanged: false };
    const current = () => spoken.current.base === from; // ignore events from an utterance we replaced
    const v = voices.find((x) => x.voiceURI === voiceURI);
    if (v) u.voice = v;
    u.rate = r;
    u.onboundary = (e) => {
      if (current()) spoken.current.at = from + e.charIndex;
    };
    u.onend = () => {
      if (current()) setState('idle');
    };
    u.onerror = (e) => {
      if (!current()) return;
      if (e.error !== 'interrupted' && e.error !== 'canceled') setError(`Speech error: ${e.error}`);
      setState('idle');
    };
    speechSynthesis.speak(u);
    setState('playing');
  };

  // The browser voice reads the speed only when speech starts: restart from the current word at the new speed.
  const changeRate = (r) => {
    setRate(r);
    remember({ rate: r });
    if (audio.current) audio.current.playbackRate = r / providerRate.current;
    else if (state === 'playing') speakBrowser(spoken.current.at, r);
    else if (state === 'paused') spoken.current.rateChanged = true;
  };

  const pause = () => {
    if (audio.current) audio.current.pause();
    else speechSynthesis.pause();
    setState('paused');
  };
  const stop = () => {
    audio.current?.pause();
    audio.current = null;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    setState('idle');
  };

  return (
    <div className="card" aria-label="Read aloud">
      <div className="row">
        {state === 'playing' ? <button className="primary" onClick={pause}>Pause</button> : <button className="primary" onClick={play} disabled={state === 'loading'}>{state === 'paused' ? 'Resume' : state === 'loading' ? 'Loading...' : 'Play aloud'}</button>}
        <button className="secondary" onClick={stop} disabled={state === 'idle'}>Stop</button>
      </div>
      {!providerMode && (
        <>
          <label htmlFor="voice">Voice</label>
          <select id="voice" value={voiceURI} onChange={(e) => { setVoiceURI(e.target.value); remember({ voiceURI: e.target.value }); }}>
            <option value="">Default voice</option>
            {voices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}
          </select>
        </>
      )}
      <label htmlFor="rate">Speed: {rate.toFixed(1)}x</label>
      <input id="rate" type="range" min="0.5" max="2" step="0.1" value={rate} onChange={(e) => changeRate(Number(e.target.value))} />
      <div className="small muted">{providerMode ? 'Using your provider voice (API mode, the summary text is sent to the provider).' : 'Using the free browser voice.'}</div>
      {error && <div className="small error">{error}</div>}
    </div>
  );
}
