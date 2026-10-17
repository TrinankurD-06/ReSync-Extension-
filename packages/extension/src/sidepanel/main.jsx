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
import { Icon } from './Icon.jsx';

// [id, accessible name, short visible label, icon, one-line description shown in the header]
const TABS = [
  ['prompts', 'Prompts', 'Prompts', 'prompts', 'Your saved prompts, one click away'],
  ['chain', 'Chain', 'Chain', 'chain', 'Send a series of prompts, one reply at a time'],
  ['ai', 'Passport & more', 'Passport', 'passport', 'Hand off, map and summarise this chat'],
  ['usage', 'Usage', 'Usage', 'usage', 'How much you have been chatting'],
  ['colours', 'Colours', 'Colours', 'colours', 'Colour-code your projects and chats'],
  ['settings', 'Settings', 'Settings', 'settings', 'Account, providers and privacy'],
];

function App() {
  const { settings, update } = useSettings();
  const [tab, setTab] = useState('prompts');
  const [chainPrompt, setChainPrompt] = useState(null);
  const current = TABS.find((t) => t[0] === tab);
  if (!settings) return <main className="loading"><span className="spinner" aria-hidden="true" /> Loading ReSync...</main>;
  return (
    <>
      <header className="app-header">
        <div className="brand">
          <span className="logo" aria-hidden="true">R</span>
          <div>
            <div className="brand-name">ReSync</div>
            <div className="brand-sub">{current[4]}</div>
          </div>
        </div>
        <nav className="tabs" role="tablist">
          {TABS.map(([id, name, label, icon]) => (
            <button key={id} role="tab" aria-label={name} aria-selected={tab === id} onClick={() => setTab(id)}>
              <Icon name={icon} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </header>
      <main key={tab} className="view">
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
