import { useState } from 'react';
import { api } from '../api.js';
import { formatDate, fullName, INTENT_LABELS } from '../format.js';
import { useAction, useApi } from '../hooks.js';
import { Empty, ErrorBox, Loading, Notice, ScoreBar, StatusBadge } from './ui.jsx';

export default function LeadDetail({ leadId, version, onChanged, onClose }) {
  const lead = useApi(() => api.getLead(leadId), [leadId, version], { pollMs: 5000 });
  const history = useApi(() => api.scoreHistory(leadId), [leadId, version, lead.data?.score]);
  const events = useApi(() => api.leadEvents(leadId), [leadId, version, lead.data?.last_activity_at]);

  const refresh = () => {
    lead.reload(true);
    onChanged();
  };

  return (
    <aside className="detail" aria-label="Lead details">
      <button type="button" className="close" onClick={onClose} aria-label="Close details">
        ×
      </button>
      <ErrorBox error={lead.error} onRetry={lead.reload} />
      {lead.loading && !lead.data && <Loading />}
      {lead.data && (
        <>
          <LeadHeader lead={lead.data} onSaved={refresh} />
          <CampaignSection lead={lead.data} onChanged={refresh} />
          <MessagesSection lead={lead.data} onChanged={refresh} />
          <ReplySection lead={lead.data} onChanged={refresh} />

          <h3>Score</h3>
          <ul className="breakdown">
            {lead.data.score_breakdown.map((item) => (
              <li key={item.component + item.label}>
                <span className={item.points < 0 ? 'neg' : 'pos'}>
                  {item.points > 0 ? '+' : ''}
                  {item.points}
                </span>{' '}
                <span className="muted">{item.component}</span> {item.label}
              </li>
            ))}
          </ul>
          <h4>Why it changed</h4>
          <ErrorBox error={history.error} onRetry={history.reload} />
          {history.data?.data.length === 0 && <Empty>No score history.</Empty>}
          <ol className="timeline">
            {history.data?.data.map((h) => (
              <li key={h.id}>
                <span className="muted small">{formatDate(h.created_at)}</span>
                <div>{h.reason}</div>
              </li>
            ))}
          </ol>

          <h3>Raw events</h3>
          <ErrorBox error={events.error} onRetry={events.reload} />
          {events.data?.data.length === 0 && <Empty>No email events yet.</Empty>}
          <ol className="timeline">
            {events.data?.data.map((e) => (
              <li key={e.id}>
                <span className="muted small">{formatDate(e.occurred_at)}</span>{' '}
                <span className={`badge badge-${e.type}`}>{e.type}</span>
                {e.payload?.intent && <span className="muted"> ({INTENT_LABELS[e.payload.intent]})</span>}
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}

function LeadHeader({ lead, onSaved }) {
  const [email, setEmail] = useState(lead.email ?? '');
  const save = useAction(async () => {
    await api.updateLead(lead.id, { email: email.trim() || null });
    onSaved();
  });
  const dirty = (lead.email ?? '') !== email.trim();

  return (
    <div className="lead-head">
      <h2>{fullName(lead)}</h2>
      <div className="muted">
        {lead.title} · {lead.company.name}
      </div>
      <div className="row">
        <ScoreBar value={lead.score} />
        <StatusBadge status={lead.status} />
        <span className="muted small">
          fit {lead.fit_score} · engagement {lead.engagement_score}
        </span>
      </div>
      <dl className="facts">
        <dt>Company</dt>
        <dd>
          {[lead.company.segment, lead.company.industry, lead.company.region, lead.company.size_band]
            .filter(Boolean)
            .join(' · ') || '—'}
        </dd>
        <dt>Source</dt>
        <dd>
          <a href={lead.source_url} target="_blank" rel="noreferrer">
            {lead.source_url}
          </a>
          {lead.source_excerpt && <blockquote>{lead.source_excerpt}</blockquote>}
        </dd>
        <dt>Signals</dt>
        <dd>
          {lead.company.signals.length === 0 && <span className="muted">No researched signals - outreach will be blocked.</span>}
          {lead.company.signals.map((s) => (
            <div key={s.id} className="signal">
              <strong>{s.summary_short}</strong> <span className="muted small">({s.kind}{s.pain_point ? ` → ${s.pain_point}` : ''})</span>{' '}
              <a href={s.source_url} target="_blank" rel="noreferrer">
                source
              </a>
            </div>
          ))}
        </dd>
      </dl>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          save.run();
        }}
      >
        <label>
          Email{' '}
          <input type="email" value={email} placeholder="verified or test address" onChange={(e) => setEmail(e.target.value)} />
        </label>
        <button type="submit" disabled={!dirty || save.pending}>
          {save.pending ? 'Saving…' : 'Save'}
        </button>
      </form>
      <ErrorBox error={save.error} />
    </div>
  );
}

function CampaignSection({ lead, onChanged }) {
  const campaigns = useApi(() => api.listCampaigns(), []);
  const [choice, setChoice] = useState('');
  const [previewFor, setPreviewFor] = useState(null);
  const enrolled = new Set(lead.campaigns.map((c) => c.id));
  const available = (campaigns.data?.data ?? []).filter((c) => !enrolled.has(c.id));

  const add = useAction(async () => {
    await api.addLeadsToCampaign(Number(choice), [lead.id]);
    setChoice('');
    onChanged();
  });

  return (
    <>
      <h3>Outreach</h3>
      {lead.campaigns.length === 0 && <p className="muted">Not in any campaign yet.</p>}
      {lead.campaigns.map((c) => (
        <div key={c.id} className="campaign-row">
          <span>{c.name}</span>
          {c.sent_at ? (
            <span className="muted small">sent {formatDate(c.sent_at)}</span>
          ) : (
            <button type="button" onClick={() => setPreviewFor(previewFor === c.id ? null : c.id)}>
              {previewFor === c.id ? 'Hide email' : 'Preview & send'}
            </button>
          )}
          {previewFor === c.id && !c.sent_at && (
            <EmailPreview
              campaignId={c.id}
              leadId={lead.id}
              onSent={() => {
                setPreviewFor(null);
                onChanged();
              }}
            />
          )}
        </div>
      ))}
      <ErrorBox error={campaigns.error} onRetry={campaigns.reload} />
      {available.length > 0 && (
        <div className="inline-form">
          <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Campaign">
            <option value="">Add to campaign…</option>
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button type="button" disabled={!choice || add.pending} onClick={() => add.run()}>
            Add
          </button>
        </div>
      )}
      {campaigns.data && campaigns.data.data.length === 0 && (
        <p className="muted small">Create a campaign in the Campaigns tab first.</p>
      )}
      <ErrorBox error={add.error} />
    </>
  );
}

function EmailPreview({ campaignId, leadId, onSent }) {
  const preview = useApi(() => api.previewEmail(campaignId, leadId), [campaignId, leadId]);
  const [result, setResult] = useState(null);
  const send = useAction(async () => {
    const res = await api.sendCampaign(campaignId, [leadId]);
    const outcome = res.results[0];
    setResult(outcome);
    if (outcome?.status === 'sent') onSent();
  });

  if (preview.loading) return <Loading label="Rendering email…" />;
  if (preview.error) return <ErrorBox error={preview.error} onRetry={preview.reload} />;
  const p = preview.data;
  const cannotSend = p.blocked || p.suppressed || !p.has_email;

  return (
    <div className="email-preview">
      {p.blocked && <Notice tone="error">Blocked by grounding check: {p.blockReason}</Notice>}
      {p.suppressed && <Notice tone="error">This address is on the suppression list - sending is disabled.</Notice>}
      {!p.has_email && <Notice tone="warn">Add an email address above before sending.</Notice>}
      <div className="subject">
        <span className="muted">Subject:</span> {p.subject ?? '—'}
      </div>
      <pre className="email-body">{p.text}</pre>
      <details>
        <summary>Token sources ({p.tokens.length})</summary>
        <ul className="small">
          {p.tokens.map((t) => (
            <li key={t.token}>
              <code>{t.token}</code> = “{t.value}” <span className="muted">from {t.source}</span>
              {t.sourceUrl && (
                <>
                  {' '}
                  <a href={t.sourceUrl} target="_blank" rel="noreferrer">
                    cite
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      </details>
      {p.log.length > 0 && (
        <details open>
          <summary>Grounding check fired ({p.log.length})</summary>
          <ul className="small">
            {p.log.map((l, i) => (
              <li key={i}>
                <code>{l.token}</code> {l.rule}: {l.detail} → <strong>{l.action.replace('_', ' ')}</strong>
              </li>
            ))}
          </ul>
        </details>
      )}
      <button type="button" className="primary" disabled={cannotSend || send.pending} onClick={() => send.run()}>
        {send.pending ? 'Sending…' : 'Send email'}
      </button>
      <ErrorBox error={send.error} />
      {result && result.status !== 'sent' && (
        <Notice tone="error">
          {result.status}: {result.code} - {result.reason}
        </Notice>
      )}
    </div>
  );
}

function MessagesSection({ lead, onChanged }) {
  const [opened, setOpened] = useState(null);
  const simulateOpen = useAction(async (token) => {
    // Loads the same tracking pixel a mail client would.
    const res = await fetch(`/t/o/${token}.gif`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Pixel request failed (${res.status})`);
    setOpened(token);
    onChanged();
  });
  if (lead.messages.length === 0) return null;

  return (
    <>
      <h3>Emails sent</h3>
      {lead.messages.map((m) => (
        <details key={m.id} className="message">
          <summary>
            <span className={`badge badge-${m.kind === 'reply' ? 'replied' : 'sent'}`}>{m.kind}</span> {m.subject}{' '}
            <span className="muted small">
              {formatDate(m.sent_at)} via {m.provider} to {m.delivered_to}
            </span>
          </summary>
          <pre className="email-body">{m.body_text}</pre>
          {m.kind === 'outreach' && (
            <div className="row">
              <button type="button" onClick={() => simulateOpen.run(m.tracking_token)} disabled={simulateOpen.pending}>
                Simulate open (load pixel)
              </button>
              <a href={`/u/${m.tracking_token}`} target="_blank" rel="noreferrer">
                Unsubscribe link
              </a>
              {opened === m.tracking_token && <span className="muted small">open recorded</span>}
            </div>
          )}
        </details>
      ))}
      <ErrorBox error={simulateOpen.error} />
    </>
  );
}

function ReplySection({ lead, onChanged }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const classify = useAction(async () => {
    const res = await api.simulateReply(lead.id, text);
    setResult(res);
    setText('');
    onChanged();
  });
  const pending = lead.reply_drafts.filter((d) => d.status === 'pending');
  const decided = lead.reply_drafts.filter((d) => d.status !== 'pending');

  return (
    <>
      <h3>Simulate reply</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          classify.run();
        }}
      >
        <textarea
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste the prospect's reply here…"
          disabled={lead.status === 'suppressed'}
        />
        <button type="submit" className="primary" disabled={text.trim().length < 2 || classify.pending}>
          {classify.pending ? 'Classifying…' : 'Classify & draft response'}
        </button>
      </form>
      {lead.status === 'suppressed' && <p className="muted small">Lead is suppressed; replies are no longer drafted.</p>}
      <ErrorBox error={classify.error} />
      {result && (
        <Notice tone={result.classification.intent === 'unsubscribe' ? 'warn' : 'info'}>
          Intent: <strong>{INTENT_LABELS[result.classification.intent]}</strong>{' '}
          <span className="muted small">
            ({result.classification.classifier}: {result.classification.rationale})
          </span>
          {result.classification.intent === 'unsubscribe' && <div>Address added to the suppression list. No reply will be drafted.</div>}
          {result.grounding_issues.length > 0 && (
            <div className="small">LLM draft rejected by grounding check, template used instead: {result.grounding_issues.join('; ')}</div>
          )}
        </Notice>
      )}
      {pending.map((d) => (
        <DraftCard key={d.id} draft={d} onDone={onChanged} />
      ))}
      {decided.length > 0 && (
        <details>
          <summary className="small">Past replies ({decided.length})</summary>
          <ul className="small">
            {decided.map((d) => (
              <li key={d.id}>
                {INTENT_LABELS[d.intent]} - {d.status} {d.decided_at && formatDate(d.decided_at)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function DraftCard({ draft, onDone }) {
  const [body, setBody] = useState(draft.draft_body);
  const approve = useAction(async () => {
    await api.approveDraft(draft.id, body !== draft.draft_body ? body : undefined);
    onDone();
  });
  const discard = useAction(async () => {
    await api.discardDraft(draft.id);
    onDone();
  });

  return (
    <div className="draft">
      <div className="small">
        Draft for <strong>{INTENT_LABELS[draft.intent]}</strong> reply - needs your approval, nothing has been sent.
      </div>
      <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="row">
        <button type="button" className="primary" disabled={approve.pending || body.trim().length < 10} onClick={() => approve.run()}>
          {approve.pending ? 'Sending…' : 'Approve & send'}
        </button>
        <button type="button" disabled={discard.pending} onClick={() => discard.run()}>
          Discard
        </button>
      </div>
      <ErrorBox error={approve.error ?? discard.error} />
    </div>
  );
}
