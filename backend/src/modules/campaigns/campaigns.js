import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool.js';
import { AppError, notFound } from '../../http/errors.js';
import { idSchema, offsetOf, optionalText, paginationSchema, toPage } from '../../http/validate.js';
import { previewOutreach, sendCampaign } from '../email/email.service.js';

const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'completed'];

const icpSchema = z.object({
  industry: optionalText(100),
  region: optionalText(100),
  company_size: optionalText(50),
  titles: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
});

const campaignInput = z.object({
  name: z.string().trim().min(1).max(200),
  icp: icpSchema.default({ titles: [] }),
  subject_variant: z.number().int().min(1).max(3).default(1),
  sender_name: z.string().trim().min(1).max(100),
  proposed_time_window: optionalText(80),
  status: z.enum(CAMPAIGN_STATUSES).default('active'),
});

const campaignPatch = campaignInput
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const campaignParams = z.object({ id: idSchema });
const campaignLeadParams = z.object({ id: idSchema, leadId: idSchema });
const leadIdsBody = z.object({ leadIds: z.array(idSchema).min(1).max(200) });
const sendBody = z.object({ leadIds: z.array(idSchema).min(1).max(200).optional() }).default({});

const CAMPAIGN_SELECT = `
  SELECT c.*,
         (SELECT count(*) FROM campaign_leads cl WHERE cl.campaign_id = c.id) AS lead_count,
         (SELECT count(*) FROM email_messages m WHERE m.campaign_id = c.id AND m.kind = 'outreach') AS sent_count,
         (SELECT count(DISTINCT e.message_id) FROM email_events e JOIN email_messages m ON m.id = e.message_id
           WHERE m.campaign_id = c.id AND e.type = 'opened') AS opened_count
    FROM campaigns c`;

async function getCampaign(id) {
  const campaign = (await pool.query(`${CAMPAIGN_SELECT} WHERE c.id = $1`, [id])).rows[0];
  if (!campaign) throw notFound('Campaign', id);
  return campaign;
}

export const campaignsRouter = Router();

campaignsRouter.get('/', async (req, res) => {
  const page = paginationSchema.parse(req.query);
  const [rows, count] = await Promise.all([
    pool.query(`${CAMPAIGN_SELECT} ORDER BY c.created_at DESC LIMIT $1 OFFSET $2`, [page.limit, offsetOf(page)]),
    pool.query('SELECT count(*) AS n FROM campaigns'),
  ]);
  res.json(toPage(rows.rows, count.rows[0].n, page));
});

campaignsRouter.get('/:id', async (req, res) => {
  const { id } = campaignParams.parse(req.params);
  const campaign = await getCampaign(id);
  const leads = await pool.query(
    `SELECT l.id, l.first_name, l.last_name, l.title, l.email, l.status, co.name AS company_name,
            m.id AS message_id, m.subject, m.sent_at, m.delivered_to
       FROM campaign_leads cl
       JOIN leads l ON l.id = cl.lead_id
       JOIN companies co ON co.id = l.company_id
       LEFT JOIN email_messages m ON m.campaign_id = cl.campaign_id AND m.lead_id = l.id AND m.kind = 'outreach'
      WHERE cl.campaign_id = $1 ORDER BY cl.added_at`,
    [id],
  );
  res.json({ ...campaign, leads: leads.rows });
});

campaignsRouter.post('/', async (req, res) => {
  const input = campaignInput.parse(req.body);
  const { rows } = await pool.query(
    `INSERT INTO campaigns (name, icp, subject_variant, sender_name, proposed_time_window, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      input.name,
      JSON.stringify(input.icp),
      input.subject_variant,
      input.sender_name,
      input.proposed_time_window ?? null,
      input.status,
    ],
  );
  res.status(201).json(await getCampaign(rows[0].id));
});

campaignsRouter.patch('/:id', async (req, res) => {
  const { id } = campaignParams.parse(req.params);
  const patch = campaignPatch.parse(req.body);
  const columns = Object.keys(patch);
  const values = columns.map((c) => (c === 'icp' ? JSON.stringify(patch.icp) : (patch[c] ?? null)));
  const { rowCount } = await pool.query(
    `UPDATE campaigns SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [id, ...values],
  );
  if (!rowCount) throw notFound('Campaign', id);
  res.json(await getCampaign(id));
});

campaignsRouter.post('/:id/leads', async (req, res) => {
  const { id } = campaignParams.parse(req.params);
  const { leadIds } = leadIdsBody.parse(req.body);
  await getCampaign(id);
  const added = await withTransaction(async (db) => {
    const found = await db.query('SELECT id FROM leads WHERE id = ANY($1::bigint[])', [leadIds]);
    const missing = leadIds.filter((l) => !found.rows.some((r) => r.id === l));
    if (missing.length) throw new AppError(404, 'NOT_FOUND', `Leads not found: ${missing.join(', ')}`);
    const result = await db.query(
      `INSERT INTO campaign_leads (campaign_id, lead_id) SELECT $1, unnest($2::bigint[])
       ON CONFLICT DO NOTHING`,
      [id, leadIds],
    );
    return result.rowCount ?? 0;
  });
  res.status(201).json({ added, alreadyEnrolled: leadIds.length - added });
});

campaignsRouter.get('/:id/leads/:leadId/preview', async (req, res) => {
  const { id, leadId } = campaignLeadParams.parse(req.params);
  res.json(await previewOutreach(id, leadId));
});

campaignsRouter.post('/:id/send', async (req, res) => {
  const { id } = campaignParams.parse(req.params);
  const { leadIds } = sendBody.parse(req.body ?? {});
  res.json(await sendCampaign(id, leadIds));
});
