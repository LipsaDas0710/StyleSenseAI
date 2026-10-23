import { withTransaction } from '../../db/pool.js';
import { notFound } from '../../http/errors.js';

import { recomputeLeadScore } from '../scoring/scoring.service.js';

export async function addToSuppressionList(db, email, reason, sourceEventId) {
  await db.query(
    `INSERT INTO suppression_list (email, reason, source_event_id) VALUES (lower($1), $2, $3)
     ON CONFLICT (email) DO NOTHING`,
    [email, reason, sourceEventId],
  );
}

export async function isSuppressed(db, email) {
  const { rows } = await db.query('SELECT 1 FROM suppression_list WHERE email = lower($1)', [email]);
  return rows.length > 0;
}

/**
 * The single write path for engagement: persist the raw event, apply suppression if it is an
 * opt-out, then recompute derived score/status - all in one transaction.
 */
/**
 * @param input  { leadId, type, messageId?, occurredAt?, payload?, dedupeKey? } - the same dedupeKey twice is
 *               the same real-world event (pixel reload, webhook retry) and the second is ignored.
 * @param client optional transaction client; a new transaction is opened when omitted.
 * @returns { event | null, duplicate, score }
 */
export async function recordEvent(input, client) {
  const run = async (db) => {
    // Row lock serialises concurrent events for the same lead so recomputes don't interleave.
    const lead = (await db.query('SELECT email FROM leads WHERE id = $1 FOR UPDATE', [input.leadId])).rows[0];
    if (!lead) throw notFound('Lead', input.leadId);

    const inserted =
      (
        await db.query(
          `INSERT INTO email_events (lead_id, message_id, type, occurred_at, payload, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id, lead_id, message_id, type, occurred_at, payload`,
          [
            input.leadId,
            input.messageId ?? null,
            input.type,
            input.occurredAt ?? new Date(),
            JSON.stringify(input.payload ?? {}),
            input.dedupeKey ?? null,
          ],
        )
      ).rows[0] ?? null;

    if (!inserted) {
      const score = await recomputeLeadScore(db, input.leadId, { reason: `duplicate ${input.type} ignored` });
      return { event: null, duplicate: true, score };
    }

    const optOut =
      input.type === 'unsubscribed' || (input.type === 'replied' && input.payload?.intent === 'unsubscribe');
    if (optOut && lead.email) {
      await addToSuppressionList(
        db,
        lead.email,
        input.type === 'unsubscribed' ? 'unsubscribe_link' : 'reply_unsubscribe',
        inserted.id,
      );
    }

    const reason =
      input.type === 'replied' && input.payload?.intent
        ? `replied (${String(input.payload.intent)})`
        : `${input.type} event`;
    const score = await recomputeLeadScore(db, input.leadId, { reason, eventId: inserted.id });
    return { event: inserted, duplicate: false, score };
  };
  return client ? run(client) : withTransaction(run);
}
