import { useState } from 'react';
import { api } from '../api.js';
import { formatDate, fullName, STATUSES } from '../format.js';
import { useApi, useDebounced } from '../hooks.js';
import { Empty, ErrorBox, Loading, ScoreBar, StatusBadge } from './ui.jsx';

const PAGE_SIZE = 20;

export default function LeadsPage({ version, selectedId, onSelect }) {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [minScore, setMinScore] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(search);

  const leads = useApi(
    () => api.listLeads({ page, limit: PAGE_SIZE, status, q, minScore }),
    [page, status, q, minScore, version],
    { pollMs: 5000 }, // opens and replies arrive from outside the console
  );

  const resetPage = (setter) => (e) => {
    setter(e.target.value);
    setPage(1);
  };
  const filtered = status || q || minScore;
  const rows = leads.data?.data ?? [];
  const pagination = leads.data?.pagination;

  return (
    <section>
      <div className="section-head">
        <h1>Leads</h1>
        <span className="muted">Ranked by score (fit 60% + engagement 40%)</span>
      </div>

      <div className="filters">
        <input type="search" placeholder="Search name, title or company" value={search} onChange={resetPage(setSearch)} />
        <select value={status} onChange={resetPage(setStatus)} aria-label="Status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={minScore} onChange={resetPage(setMinScore)} aria-label="Minimum score">
          <option value="">Any score</option>
          {[20, 40, 60, 80].map((n) => (
            <option key={n} value={n}>
              Score ≥ {n}
            </option>
          ))}
        </select>
        {filtered && (
          <button
            type="button"
            className="link"
            onClick={() => {
              setStatus('');
              setSearch('');
              setMinScore('');
              setPage(1);
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <ErrorBox error={leads.error} onRetry={leads.reload} />
      {leads.loading && !leads.data && <Loading label="Loading leads…" />}

      {leads.data && rows.length === 0 && (
        <Empty>
          {filtered ? 'No leads match these filters.' : 'No leads yet. Use “Find leads” to discover or add some.'}
        </Empty>
      )}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="leads">
            <thead>
              <tr>
                <th>#</th>
                <th>Score</th>
                <th>Lead</th>
                <th>Company</th>
                <th>Status</th>
                <th title="Fit / engagement">Fit · Eng</th>
                <th>Last activity</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((lead, i) => (
                <tr
                  key={lead.id}
                  className={lead.id === selectedId ? 'selected' : undefined}
                  onClick={() => onSelect(lead.id)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && onSelect(lead.id)}
                >
                  <td className="muted">{(page - 1) * PAGE_SIZE + i + 1}</td>
                  <td>
                    <ScoreBar value={lead.score} />
                  </td>
                  <td>
                    <div className="strong">{fullName(lead)}</div>
                    <div className="muted small">{lead.title}</div>
                  </td>
                  <td>
                    {lead.company_name}
                    <div className="muted small">{[lead.region, lead.size_band].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td>
                    <StatusBadge status={lead.status} />
                  </td>
                  <td className="muted">
                    {lead.fit_score} · {lead.engagement_score}
                  </td>
                  <td className="muted small">{formatDate(lead.last_activity_at)}</td>
                  <td>
                    <a href={lead.source_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                      source
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="pager">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="muted">
            Page {pagination.page} of {pagination.totalPages} · {pagination.total} leads
          </span>
          <button type="button" disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}
    </section>
  );
}
