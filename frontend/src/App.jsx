import { useState } from 'react';
import { api } from './api.js';
import CampaignsPage from './components/CampaignsPage.jsx';
import DiscoverPage from './components/DiscoverPage.jsx';
import LeadDetail from './components/LeadDetail.jsx';
import LeadsPage from './components/LeadsPage.jsx';
import { useApi } from './hooks.js';

const TABS = [
  { id: 'leads', label: 'Leads' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'discover', label: 'Find leads' },
];

export default function App() {
  const [tab, setTab] = useState('leads');
  const [selectedLeadId, setSelectedLeadId] = useState(null);
  // Bumped whenever a child changes data, so every visible list refetches.
  const [version, setVersion] = useState(0);
  const changed = () => setVersion((v) => v + 1);
  const health = useApi(() => api.health(), [], { pollMs: 15000 });

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          StyleSense AI <span className="muted">Lead console</span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <span className={health.error ? 'health down' : 'health'} title={health.error?.message ?? 'API and database reachable'}>
          {health.error ? 'API offline' : health.loading && !health.data ? 'Connecting…' : 'API online'}
        </span>
      </header>

      <div className={selectedLeadId ? 'layout with-detail' : 'layout'}>
        <main>
          {tab === 'leads' && <LeadsPage version={version} selectedId={selectedLeadId} onSelect={setSelectedLeadId} />}
          {tab === 'campaigns' && <CampaignsPage version={version} onChanged={changed} onSelectLead={setSelectedLeadId} />}
          {tab === 'discover' && (
            <DiscoverPage
              onChanged={changed}
              onSelectLead={(id) => {
                setTab('leads');
                setSelectedLeadId(id);
              }}
            />
          )}
        </main>
        {selectedLeadId && (
          <LeadDetail
            key={selectedLeadId}
            leadId={selectedLeadId}
            version={version}
            onChanged={changed}
            onClose={() => setSelectedLeadId(null)}
          />
        )}
      </div>
    </div>
  );
}
