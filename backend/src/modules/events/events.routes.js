import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool.js';
import { emailSchema, idSchema, offsetOf, paginationSchema, toPage } from '../../http/validate.js';
import { recomputeLeadScore } from '../scoring/scoring.service.js';
import { recordEvent } from './events.service.js';

// Replies go through /api/leads/:id/replies so they are always classified; everything else can be posted raw
// (e.g. from a provider webhook or for manual corrections).
const eventInput = z.object({
  leadId: idSchema,
  type: z.enum(['delivered', 'opened', 'unsubscribed']),
  messageId: idSchema.optional(),
  occurredAt: z.coerce.date().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  dedupeKey: z.string().trim().min(1).max(200).optional(),
});

export const eventsRouter = Router();

eventsRouter.post('/events', async (req, res) => {
  const input = eventInput.parse(req.body);
  const result = await recordEvent(input);
  res.status(result.duplicate ? 200 : 201).json(result);
});

eventsRouter.get('/suppressions', async (req, res) => {
  const page = paginationSchema.parse(req.query);
  const [rows, count] = await Promise.all([
    pool.query('SELECT * FROM suppression_list ORDER BY created_at DESC LIMIT $1 OFFSET $2', [
      page.limit,
      offsetOf(page),
    ]),
    pool.query('SELECT count(*) AS n FROM suppression_list'),
  ]);
  res.json(toPage(rows.rows, count.rows[0].n, page));
});

eventsRouter.post('/suppressions', async (req, res) => {
  const { email } = z.object({ email: emailSchema }).parse(req.body);
  await pool.query(
    `INSERT INTO suppression_list (email, reason) VALUES ($1, 'manual') ON CONFLICT (email) DO NOTHING`,
    [email],
  );
  // Leads using this address become suppressed immediately.
  const leads = await pool.query('SELECT id FROM leads WHERE email = $1', [email]);
  for (const lead of leads.rows) {
    await withTransaction((db) => recomputeLeadScore(db, lead.id, { reason: 'address manually suppressed' }));
  }
  res.status(201).json({ email, leadsAffected: leads.rowCount });
});
