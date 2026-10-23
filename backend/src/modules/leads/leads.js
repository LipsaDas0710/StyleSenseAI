import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool.js';
import { AppError, notFound } from '../../http/errors.js';
import {
  emailSchema,
  httpUrl,
  idParams,
  offsetOf,
  optionalText,
  paginationSchema,
  toPage,
} from '../../http/validate.js';
import { companyInput, getCompany, upsertCompany } from '../companies/companies.js';
import { recomputeLeadScore } from '../scoring/scoring.service.js';

export const LEAD_STATUSES = ['new', 'sent', 'opened', 'replied', 'suppressed'];

const leadFields = {
  first_name: z.string().trim().min(1).max(100),
  last_name: optionalText(100),
  title: z.string().trim().min(1).max(200),
  email: z.preprocess((v) => (v === '' ? undefined : v), emailSchema.optional()),
  linkedin_url: z.preprocess((v) => (v === '' ? undefined : v), httpUrl.optional()),
  source_url: httpUrl,
  source_excerpt: optionalText(2000),
};

export const leadInput = z
  .object({
    ...leadFields,
    company_id: z.number().int().positive().optional(),
    company: companyInput.optional(),
  })
  .refine((v) => (v.company_id === undefined) !== (v.company === undefined), {
    message: 'Provide exactly one of company_id or company',
    path: ['company_id'],
  });

// Status and scores are derived from events, so they are deliberately not patchable.
const leadPatch = z
  .object({
    first_name: leadFields.first_name,
    last_name: z.string().trim().max(100).nullable(),
    title: leadFields.title,
    email: z.preprocess((v) => (v === '' ? null : v), emailSchema.nullable()),
    linkedin_url: z.preprocess((v) => (v === '' ? null : v), httpUrl.nullable()),
    source_url: leadFields.source_url,
    source_excerpt: z.string().trim().max(2000).nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const listQuery = paginationSchema.extend({
  status: z.enum(LEAD_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  campaignId: z.coerce.number().int().positive().optional(),
});

const LEAD_SELECT = `
  SELECT l.id, l.company_id, l.first_name, l.last_name, l.title, l.email, l.linkedin_url, l.source_url,
         l.source_excerpt, l.status, l.created_at, l.updated_at,
         c.name AS company_name, c.domain AS company_domain, c.industry, c.region, c.size_band, c.segment,
         COALESCE(s.fit, 0) AS fit_score, COALESCE(s.engagement, 0) AS engagement_score, COALESCE(s.total, 0) AS score,
         (SELECT max(e.occurred_at) FROM email_events e WHERE e.lead_id = l.id) AS last_activity_at
    FROM leads l
    JOIN companies c ON c.id = l.company_id
    LEFT JOIN lead_scores s ON s.lead_id = l.id`;

export async function getLead(db, id) {
  const lead = (await db.query(`${LEAD_SELECT} WHERE l.id = $1`, [id])).rows[0];
  if (!lead) throw notFound('Lead', id);
  return lead;
}

export async function createLead(db, input, reason) {
  const { rows } = await db.query(
    `INSERT INTO leads (company_id, first_name, last_name, title, email, linkedin_url, source_url, source_excerpt, discovery_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      input.company_id,
      input.first_name,
      input.last_name ?? null,
      input.title,
      input.email ?? null,
      input.linkedin_url ?? null,
      input.source_url,
      input.source_excerpt ?? null,
      input.discovery_run_id ?? null,
    ],
  );
  const id = rows[0].id;
  await recomputeLeadScore(db, id, { reason });
  return id;
}

export const leadsRouter = Router();

leadsRouter.get('/', async (req, res) => {
  const query = listQuery.parse(req.query);
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (query.status) add('l.status = ?', query.status);
  if (query.minScore !== undefined) add('COALESCE(s.total, 0) >= ?', query.minScore);
  if (query.q) {
    add(
      `(l.first_name || ' ' || COALESCE(l.last_name, '') || ' ' || l.title || ' ' || c.name) ILIKE ?`,
      `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`,
    );
  }
  if (query.campaignId)
    add('EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.lead_id = l.id AND cl.campaign_id = ?)', query.campaignId);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, count] = await Promise.all([
    pool.query(
      `${LEAD_SELECT} ${whereSql} ORDER BY score DESC, l.id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.limit, offsetOf(query)],
    ),
    pool.query(
      `SELECT count(*) AS n FROM leads l JOIN companies c ON c.id = l.company_id
         LEFT JOIN lead_scores s ON s.lead_id = l.id ${whereSql}`,
      params,
    ),
  ]);
  res.json(toPage(rows.rows, count.rows[0].n, query));
});

leadsRouter.get('/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const lead = await getLead(pool, id);
  const [company, breakdown, drafts, campaigns, messages] = await Promise.all([
    getCompany(pool, lead.company_id),
    pool.query('SELECT breakdown, computed_at FROM lead_scores WHERE lead_id = $1', [id]),
    pool.query('SELECT * FROM reply_drafts WHERE lead_id = $1 ORDER BY id DESC', [id]),
    pool.query(
      `SELECT c.id, c.name, cl.added_at,
              (SELECT m.sent_at FROM email_messages m WHERE m.campaign_id = c.id AND m.lead_id = $1 AND m.kind = 'outreach') AS sent_at
         FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.lead_id = $1 ORDER BY cl.added_at`,
      [id],
    ),
    // The tracking token is included so the single-user console can simulate an open in the demo.
    pool.query(
      `SELECT id, campaign_id, kind, subject, body_text, delivered_to, provider, tracking_token, sent_at
         FROM email_messages WHERE lead_id = $1 ORDER BY sent_at DESC`,
      [id],
    ),
  ]);
  res.json({
    ...lead,
    company,
    score_breakdown: breakdown.rows[0]?.breakdown ?? [],
    reply_drafts: drafts.rows,
    campaigns: campaigns.rows,
    messages: messages.rows,
  });
});

leadsRouter.post('/', async (req, res) => {
  const input = leadInput.parse(req.body);
  const id = await withTransaction(async (db) => {
    const companyId = input.company ? await upsertCompany(db, input.company) : input.company_id;
    if (!input.company) await getCompany(db, companyId);
    return createLead(db, { ...input, company_id: companyId }, 'lead created');
  });
  res.status(201).json(await getLead(pool, id));
});

leadsRouter.patch('/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const patch = leadPatch.parse(req.body);
  await withTransaction(async (db) => {
    const columns = Object.keys(patch);
    const { rowCount } = await db.query(
      `UPDATE leads SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [id, ...columns.map((c) => patch[c])],
    );
    if (!rowCount) throw notFound('Lead', id);
    await recomputeLeadScore(db, id, { reason: 'lead details updated' });
  });
  res.json(await getLead(pool, id));
});

leadsRouter.delete('/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { rowCount } = await pool.query('DELETE FROM leads WHERE id = $1', [id]);
  if (!rowCount) throw notFound('Lead', id);
  res.status(204).end();
});

leadsRouter.get('/:id/events', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const page = paginationSchema.parse(req.query);
  await getLead(pool, id);
  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT id, lead_id, message_id, type, occurred_at, payload FROM email_events
        WHERE lead_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [id, page.limit, offsetOf(page)],
    ),
    pool.query('SELECT count(*) AS n FROM email_events WHERE lead_id = $1', [id]),
  ]);
  res.json(toPage(rows.rows, count.rows[0].n, page));
});

leadsRouter.get('/:id/score-history', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const page = paginationSchema.parse(req.query);
  await getLead(pool, id);
  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT h.*, e.type AS event_type FROM score_history h LEFT JOIN email_events e ON e.id = h.event_id
        WHERE h.lead_id = $1 ORDER BY h.created_at DESC, h.id DESC LIMIT $2 OFFSET $3`,
      [id, page.limit, offsetOf(page)],
    ),
    pool.query('SELECT count(*) AS n FROM score_history WHERE lead_id = $1', [id]),
  ]);
  res.json(toPage(rows.rows, count.rows[0].n, page));
});

leadsRouter.post('/:id/recalculate-score', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const score = await withTransaction(async (db) => {
    const locked = await db.query('SELECT 1 FROM leads WHERE id = $1 FOR UPDATE', [id]);
    if (!locked.rowCount) throw notFound('Lead', id);
    return recomputeLeadScore(db, id, { reason: 'manual recompute from event history' });
  });
  res.json(score);
});

export function assertHasEmail(lead) {
  if (!lead.email) {
    throw new AppError(
      422,
      'LEAD_HAS_NO_EMAIL',
      `Lead ${lead.id} has no verified email address; add one before sending`,
    );
  }
}
