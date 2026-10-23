import { useState } from 'react';
import { api } from '../api.js';
import { formatDate } from '../format.js';
import { useAction, useApi } from '../hooks.js';
import { ErrorBox, Notice } from './ui.jsx';

const SIZE_BANDS = ['1-50', '51-200', '201-1000', '1001-5000', '5000+'];
const SIGNAL_KINDS = ['launch', 'expansion', 'hiring', 'markdowns', 'stockouts', 'returns', 'funding', 'leadership', 'sustainability', 'other'];
const PAIN_POINTS = [
  ['overstock', 'Overstock / markdowns → demand forecasting'],
  ['returns', 'Returns / sizing → size & fit prediction'],
  ['slow_trends', 'Slow trend reaction → trend intelligence'],
  ['stockouts', 'Stockouts → inventory allocation'],
];

export default function DiscoverPage({ onChanged, onSelectLead }) {
  return (
    <section>
      <div className="section-head">
        <h1>Find leads</h1>
      </div>
      <DiscoveryForm onChanged={onChanged} onSelectLead={onSelectLead} />
      <ManualLeadForm onChanged={onChanged} onSelectLead={onSelectLead} />
    </section>
  );
}

function DiscoveryForm({ onChanged, onSelectLead }) {
  const [icp, setIcp] = useState({
    industry: 'Fashion and apparel',
    region: 'United States',
    company_size: '51-1000 employees',
    titles: 'Head of Merchandising, Director of Demand Planning, VP Supply Chain, Head of Inventory',
    max_leads: 6,
  });
  const [result, setResult] = useState(null);
  const runs = useApi(() => api.listDiscoveryRuns(), [result]);
  const run = useAction(async () => {
    setResult(null);
    const res = await api.runDiscovery({
      ...icp,
      max_leads: Number(icp.max_leads),
      titles: icp.titles.split(',').map((t) => t.trim()).filter(Boolean),
    });
    setResult(res);
    onChanged();
  });
  const set = (key) => (e) => setIcp({ ...icp, [key]: e.target.value });

  return (
    <form
      className="card form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        run.run();
      }}
    >
      <h3>AI lead discovery</h3>
      <p className="muted small span-2">
        The agent searches the web, fetches pages, and extracts people + company signals. Every lead must appear verbatim on a
        page it fetched, or it is rejected. Takes up to a minute.
      </p>
      <label>
        Industry
        <input required value={icp.industry} onChange={set('industry')} />
      </label>
      <label>
        Region
        <input required value={icp.region} onChange={set('region')} />
      </label>
      <label>
        Company size
        <input value={icp.company_size} onChange={set('company_size')} />
      </label>
      <label>
        Max leads
        <input type="number" min={1} max={10} value={icp.max_leads} onChange={set('max_leads')} />
      </label>
      <label className="span-2">
        Target titles (comma separated)
        <input required value={icp.titles} onChange={set('titles')} />
      </label>
      <div>
        <button type="submit" className="primary" disabled={run.pending}>
          {run.pending ? 'Researching… (this can take a minute)' : 'Find leads'}
        </button>
      </div>
      <div className="span-2">
        <ErrorBox error={run.error} />
        {run.error?.code === 'AI_NOT_CONFIGURED' && (
          <Notice tone="warn">Add LLM_API_KEY and SEARCH_API_KEY to backend/.env and restart the backend, or add a lead manually below.</Notice>
        )}
        {result && (
          <Notice>
            Saved {result.leadIds.length} lead(s).{' '}
            {result.leadIds.map((id) => (
              <button key={id} type="button" className="link" onClick={() => onSelectLead(id)}>
                open #{id}
              </button>
            ))}
            <details>
              <summary className="small">Agent log ({result.log.length} steps)</summary>
              <pre className="log">{result.log.map((l) => JSON.stringify(l)).join('\n')}</pre>
            </details>
          </Notice>
        )}
        {runs.data?.data.length > 0 && (
          <details>
            <summary className="small">Previous runs</summary>
            <ul className="small">
              {runs.data.data.map((r) => (
                <li key={r.id}>
                  #{r.id} {formatDate(r.started_at)} - {r.status}, {r.leads_found} leads {r.error && <span className="muted">({r.error})</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </form>
  );
}

const EMPTY_MANUAL = {
  first_name: '', last_name: '', title: '', email: '', source_url: '',
  company_name: '', domain: '', industry: 'Apparel & Fashion', region: '', size_band: '', segment: '',
  signal_kind: 'expansion', pain_point: '', summary_short: '', sentence: '', signal_url: '', excerpt: '',
};

/** For leads researched by hand: same validation and grounding rules as discovered ones. */
function ManualLeadForm({ onChanged, onSelectLead }) {
  const [f, setF] = useState(EMPTY_MANUAL);
  const set = (key) => (e) => setF({ ...f, [key]: e.target.value });
  const hasSignal = f.summary_short || f.sentence || f.signal_url || f.excerpt;
  const save = useAction(async () => {
    const lead = await api.createLead({
      first_name: f.first_name, last_name: f.last_name, title: f.title, email: f.email, source_url: f.source_url,
      company: {
        name: f.company_name,
        domain: f.domain || undefined,
        industry: f.industry,
        region: f.region,
        size_band: f.size_band || undefined,
        segment: f.segment,
        signals: hasSignal
          ? [{ kind: f.signal_kind, pain_point: f.pain_point || null, summary_short: f.summary_short, sentence: f.sentence,
              source_url: f.signal_url, source_excerpt: f.excerpt }]
          : [],
      },
    });
    setF(EMPTY_MANUAL);
    onChanged();
    onSelectLead(lead.id);
  });

  return (
    <details className="card">
      <summary>
        <strong>Add a researched lead manually</strong>
      </summary>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          save.run();
        }}
      >
        <h4 className="span-2">Person</h4>
        <label>First name<input required value={f.first_name} onChange={set('first_name')} /></label>
        <label>Last name<input value={f.last_name} onChange={set('last_name')} /></label>
        <label>Title<input required value={f.title} onChange={set('title')} placeholder="Head of Merchandising" /></label>
        <label>Email <span className="muted">(only if verified, or a test address)</span><input type="email" value={f.email} onChange={set('email')} /></label>
        <label className="span-2">Source URL naming this person<input required type="url" value={f.source_url} onChange={set('source_url')} /></label>

        <h4 className="span-2">Company</h4>
        <label>Name<input required value={f.company_name} onChange={set('company_name')} /></label>
        <label>Domain<input value={f.domain} onChange={set('domain')} placeholder="brand.com" /></label>
        <label>Industry<input value={f.industry} onChange={set('industry')} /></label>
        <label>Region<input value={f.region} onChange={set('region')} placeholder="United States" /></label>
        <label>
          Size
          <select value={f.size_band} onChange={set('size_band')}>
            <option value="">Unknown</option>
            {SIZE_BANDS.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label>Segment<input value={f.segment} onChange={set('segment')} placeholder="DTC brand" /></label>

        <h4 className="span-2">Research signal <span className="muted small">(needed to send outreach)</span></h4>
        <label>
          Kind
          <select value={f.signal_kind} onChange={set('signal_kind')}>
            {SIGNAL_KINDS.map((k) => <option key={k}>{k}</option>)}
          </select>
        </label>
        <label>
          Pain point
          <select value={f.pain_point} onChange={set('pain_point')}>
            <option value="">None</option>
            {PAIN_POINTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label>Short summary (2-6 words)<input value={f.summary_short} onChange={set('summary_short')} placeholder="first London store" /></label>
        <label>Signal source URL<input type="url" value={f.signal_url} onChange={set('signal_url')} /></label>
        <label className="span-2">
          Sentence (reads after “I noticed …”)
          <input value={f.sentence} onChange={set('sentence')} placeholder="that Brand opened its first London store in May" />
        </label>
        <label className="span-2">
          Verbatim excerpt from the source
          <textarea rows={3} value={f.excerpt} onChange={set('excerpt')} />
        </label>
        <div>
          <button type="submit" className="primary" disabled={save.pending}>
            {save.pending ? 'Saving…' : 'Save lead'}
          </button>
        </div>
        <div className="span-2">
          <ErrorBox error={save.error} />
        </div>
      </form>
    </details>
  );
}
