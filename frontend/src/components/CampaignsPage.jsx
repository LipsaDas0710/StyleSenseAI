import { useState } from 'react';
import { api } from '../api.js';
import { formatDate, fullName } from '../format.js';
import { useAction, useApi } from '../hooks.js';
import { Empty, ErrorBox, Loading, Notice, StatusBadge } from './ui.jsx';

const SUBJECTS = [
  '{{company_name}}’s {{observed_signal_short}} - quick question',
  'Cutting {{pain_point_category}} at {{company_name}}',
  '{{first_name}}, saw {{observed_signal_short}}',
];

export default function CampaignsPage({ version, onChanged, onSelectLead }) {
  const campaigns = useApi(() => api.listCampaigns(), [version]);
  const [selected, setSelected] = useState(null);
  const rows = campaigns.data?.data ?? [];

  return (
    <section>
      <div className="section-head">
        <h1>Campaigns</h1>
      </div>
      <NewCampaignForm
        onCreated={(c) => {
          setSelected(c.id);
          onChanged();
        }}
      />
      <ErrorBox error={campaigns.error} onRetry={campaigns.reload} />
      {campaigns.loading && !campaigns.data && <Loading />}
      {campaigns.data && rows.length === 0 && <Empty>No campaigns yet - create one above.</Empty>}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Leads</th>
                <th>Sent</th>
                <th>Opened</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className={c.id === selected ? 'selected' : undefined} onClick={() => setSelected(c.id)}>
                  <td className="strong">{c.name}</td>
                  <td>{c.status}</td>
                  <td>{c.lead_count}</td>
                  <td>{c.sent_count}</td>
                  <td>{c.opened_count}</td>
                  <td className="muted small">{formatDate(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && <CampaignDetail key={selected} id={selected} version={version} onChanged={onChanged} onSelectLead={onSelectLead} />}
    </section>
  );
}

function NewCampaignForm({ onCreated }) {
  const [form, setForm] = useState({ name: '', sender_name: '', subject_variant: 1, proposed_time_window: '' });
  const create = useAction(async () => {
    const c = await api.createCampaign({ ...form, subject_variant: Number(form.subject_variant) });
    setForm({ name: '', sender_name: '', subject_variant: 1, proposed_time_window: '' });
    onCreated(c);
  });
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  return (
    <form
      className="card form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        create.run();
      }}
    >
      <h3>New campaign</h3>
      <label>
        Name
        <input required value={form.name} onChange={set('name')} placeholder="US DTC planners - Q4" />
      </label>
      <label>
        Sender name
        <input required value={form.sender_name} onChange={set('sender_name')} placeholder="Your name" />
      </label>
      <label>
        Subject line
        <select value={form.subject_variant} onChange={set('subject_variant')}>
          {SUBJECTS.map((s, i) => (
            <option key={s} value={i + 1}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label>
        Proposed time window <span className="muted">(optional)</span>
        <input value={form.proposed_time_window} onChange={set('proposed_time_window')} placeholder="next Tuesday or Wednesday" />
      </label>
      <div>
        <button type="submit" className="primary" disabled={create.pending}>
          {create.pending ? 'Creating…' : 'Create campaign'}
        </button>
      </div>
      <ErrorBox error={create.error} />
    </form>
  );
}

function CampaignDetail({ id, version, onChanged, onSelectLead }) {
  const campaign = useApi(() => api.getCampaign(id), [id, version]);
  const [result, setResult] = useState(null);
  const sendAll = useAction(async () => {
    setResult(await api.sendCampaign(id));
    onChanged();
  });
  const toggle = useAction(async (status) => {
    await api.updateCampaign(id, { status });
    onChanged();
  });

  if (campaign.loading && !campaign.data) return <Loading />;
  if (campaign.error) return <ErrorBox error={campaign.error} onRetry={campaign.reload} />;
  const c = campaign.data;
  const unsent = c.leads.filter((l) => !l.message_id).length;

  return (
    <div className="card">
      <div className="section-head">
        <h3>{c.name}</h3>
        <span className="muted small">
          sender {c.sender_name} · subject variant {c.subject_variant} · {c.status}
        </span>
      </div>
      <div className="row">
        <button type="button" className="primary" disabled={c.status !== 'active' || unsent === 0 || sendAll.pending} onClick={() => sendAll.run()}>
          {sendAll.pending ? 'Sending…' : `Send to ${unsent} unsent lead${unsent === 1 ? '' : 's'}`}
        </button>
        <button type="button" disabled={toggle.pending} onClick={() => toggle.run(c.status === 'active' ? 'paused' : 'active')}>
          {c.status === 'active' ? 'Pause' : 'Activate'}
        </button>
      </div>
      <ErrorBox error={sendAll.error ?? toggle.error} />
      {result && (
        <Notice tone={result.summary.failed ? 'error' : 'info'}>
          Sent {result.summary.sent}, skipped {result.summary.skipped}, failed {result.summary.failed} (provider: {result.provider})
          <ul className="small">
            {result.results
              .filter((r) => r.status !== 'sent')
              .map((r) => (
                <li key={r.leadId}>
                  Lead {r.leadId}: {r.code} - {r.reason}
                </li>
              ))}
          </ul>
        </Notice>
      )}
      {c.leads.length === 0 ? (
        <Empty>No leads in this campaign. Open a lead and use “Add to campaign”.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Lead</th>
              <th>Company</th>
              <th>Status</th>
              <th>Email</th>
            </tr>
          </thead>
          <tbody>
            {c.leads.map((l) => (
              <tr key={l.id} onClick={() => onSelectLead(l.id)}>
                <td>
                  <div className="strong">{fullName(l)}</div>
                  <div className="muted small">{l.title}</div>
                </td>
                <td>{l.company_name}</td>
                <td>
                  <StatusBadge status={l.status} />
                </td>
                <td className="small">{l.sent_at ? `sent ${formatDate(l.sent_at)}` : l.email ? 'not sent' : <span className="muted">no email</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
