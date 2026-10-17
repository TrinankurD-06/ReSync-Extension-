import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { useSettings } from './useSettings.js';
import SettingsTab from './SettingsTab.jsx';
import ColoursTab from './ColoursTab.jsx';
import PromptsTab from './PromptsTab.jsx';
import ChainTab from './ChainTab.jsx';
import AiTab from './AiTab.jsx';
import UsageTab from './UsageTab.jsx';

const TABS = [
  ['prompts', 'Prompts'],
  ['chain', 'Chain'],
  ['ai', 'Passport & more'],
  ['usage', 'Usage'],
  ['colours', 'Colours'],
  ['settings', 'Settings'],
];

function App() {
  const { settings, update } = useSettings();
  const [tab, setTab] = useState('prompts');
  const [chainPrompt, setChainPrompt] = useState(null);
  if (!settings) return <main className="muted">Loading...</main>;
  return (
    <>
      <nav className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      <main>
        {tab === 'prompts' && <PromptsTab onRunChain={(p) => { setChainPrompt(p); setTab('chain'); }} />}
        {tab === 'chain' && <ChainTab prompt={chainPrompt} />}
        {tab === 'ai' && <AiTab settings={settings} update={update} />}
        {tab === 'usage' && <UsageTab />}
        {tab === 'colours' && <ColoursTab settings={settings} update={update} />}
        {tab === 'settings' && <SettingsTab settings={settings} update={update} />}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
