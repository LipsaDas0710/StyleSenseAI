import { notFound } from '../../http/errors.js';
import { computeScore, describeChange } from './scoring.js';

/**
 * Rebuilds a lead's derived state (lead_scores + leads.status) from its raw events and writes a
 * score_history row whenever the score changed. Call inside the same transaction as the event insert.
 */
export async function recomputeLeadScore(db, leadId, trigger) {
  const lead = (
    await db.query(
      `SELECT l.title, c.industry, c.segment, c.region, c.size_band, l.status,
              EXISTS (SELECT 1 FROM suppression_list s WHERE s.email = l.email) AS suppressed
         FROM leads l JOIN companies c ON c.id = l.company_id
        WHERE l.id = $1`,
      [leadId],
    )
  ).rows[0];
  if (!lead) throw notFound('Lead', leadId);

  const events = (
    await db.query(`SELECT type, occurred_at, payload->>'intent' AS intent FROM email_events WHERE lead_id = $1`, [
      leadId,
    ])
  ).rows.map((r) => ({
    type: r.type,
    occurredAt: r.occurred_at,
    intent: r.intent ?? undefined,
  }));

  const result = computeScore(
    {
      title: lead.title,
      industry: lead.industry,
      segment: lead.segment,
      region: lead.region,
      sizeBand: lead.size_band,
    },
    events,
    { suppressed: lead.suppressed },
  );

  const previous =
    (await db.query('SELECT fit, engagement, total FROM lead_scores WHERE lead_id = $1', [leadId])).rows[0] ?? null;

  await db.query(
    `INSERT INTO lead_scores (lead_id, fit, engagement, total, breakdown, computed_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (lead_id) DO UPDATE
       SET fit = EXCLUDED.fit, engagement = EXCLUDED.engagement, total = EXCLUDED.total,
           breakdown = EXCLUDED.breakdown, computed_at = now()`,
    [leadId, result.fit, result.engagement, result.total, JSON.stringify(result.breakdown)],
  );

  if (lead.status !== result.status) {
    await db.query('UPDATE leads SET status = $2 WHERE id = $1', [leadId, result.status]);
  }

  const changed =
    !previous ||
    previous.total !== result.total ||
    previous.fit !== result.fit ||
    previous.engagement !== result.engagement;
  if (changed) {
    await db.query(
      `INSERT INTO score_history (lead_id, event_id, previous_total, new_total, fit, engagement, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        leadId,
        trigger.eventId ?? null,
        previous?.total ?? null,
        result.total,
        result.fit,
        result.engagement,
        describeChange(previous, result, trigger.reason),
      ],
    );
  }
  return result;
}
