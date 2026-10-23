import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool.js';
import { notFound } from '../../http/errors.js';
import { httpUrl, idParams, offsetOf, optionalText, paginationSchema, toPage } from '../../http/validate.js';

export const SIZE_BANDS = ['1-50', '51-200', '201-1000', '1001-5000', '5000+'];
export const SIGNAL_KINDS = [
  'launch',
  'expansion',
  'hiring',
  'markdowns',
  'stockouts',
  'returns',
  'funding',
  'leadership',
  'sustainability',
  'other',
];
export const PAIN_POINTS = ['overstock', 'returns', 'slow_trends', 'stockouts'];

export const signalInput = z.object({
  kind: z.enum(SIGNAL_KINDS),
  pain_point: z.enum(PAIN_POINTS).nullish(),
  summary_short: z.string().trim().min(3).max(60),
  sentence: z.string().trim().min(10).max(300),
  source_url: httpUrl,
  source_excerpt: z.string().trim().min(1).max(2000),
  observed_at: z.iso.date().nullish(),
});

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((d) =>
    d
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, ''),
  )
  .pipe(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Must be a domain like example.com'));

export const companyInput = z.object({
  name: z.string().trim().min(1).max(200),
  domain: domainSchema.optional(),
  website: httpUrl.optional(),
  industry: optionalText(100),
  region: optionalText(100),
  size_band: z.enum(SIZE_BANDS).optional(),
  segment: optionalText(100),
  raw: z.record(z.string(), z.unknown()).optional(),
  signals: z.array(signalInput).max(20).default([]),
});

export async function insertSignals(db, companyId, signals) {
  for (const s of signals) {
    await db.query(
      `INSERT INTO company_signals (company_id, kind, pain_point, summary_short, sentence, source_url, source_excerpt, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (company_id, source_url, lower(summary_short)) DO NOTHING`,
      [
        companyId,
        s.kind,
        s.pain_point ?? null,
        s.summary_short,
        s.sentence,
        s.source_url,
        s.source_excerpt,
        s.observed_at ?? null,
      ],
    );
  }
}

/** Creates a company, or returns the existing one with the same domain (signals are appended). */
export async function upsertCompany(db, input) {
  const { rows } = await db.query(
    `INSERT INTO companies (name, domain, website, industry, region, size_band, segment, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (domain) DO UPDATE SET
       industry = COALESCE(companies.industry, EXCLUDED.industry),
       region = COALESCE(companies.region, EXCLUDED.region),
       size_band = COALESCE(companies.size_band, EXCLUDED.size_band),
       segment = COALESCE(companies.segment, EXCLUDED.segment)
     RETURNING id`,
    [
      input.name,
      input.domain ?? null,
      input.website ?? null,
      input.industry ?? null,
      input.region ?? null,
      input.size_band ?? null,
      input.segment ?? null,
      JSON.stringify(input.raw ?? {}),
    ],
  );
  const id = rows[0].id;
  await insertSignals(db, id, input.signals);
  return id;
}

export async function getCompany(db, id) {
  const company = (await db.query('SELECT * FROM companies WHERE id = $1', [id])).rows[0];
  if (!company) throw notFound('Company', id);
  const signals = (await db.query('SELECT * FROM company_signals WHERE company_id = $1 ORDER BY id', [id])).rows;
  return { ...company, signals };
}

export const companiesRouter = Router();

companiesRouter.get('/', async (req, res) => {
  const page = paginationSchema.parse(req.query);
  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT c.*, (SELECT count(*) FROM leads l WHERE l.company_id = c.id) AS lead_count,
              (SELECT count(*) FROM company_signals s WHERE s.company_id = c.id) AS signal_count
         FROM companies c ORDER BY c.name LIMIT $1 OFFSET $2`,
      [page.limit, offsetOf(page)],
    ),
    pool.query('SELECT count(*) AS n FROM companies'),
  ]);
  res.json(toPage(rows.rows, count.rows[0].n, page));
});

companiesRouter.get('/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await getCompany(pool, id));
});

companiesRouter.post('/', async (req, res) => {
  const input = companyInput.parse(req.body);
  const id = await withTransaction((db) => upsertCompany(db, input));
  res.status(201).json(await getCompany(pool, id));
});

companiesRouter.post('/:id/signals', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const signal = signalInput.parse(req.body);
  await getCompany(pool, id);
  await insertSignals(pool, id, [signal]);
  res.status(201).json(await getCompany(pool, id));
});
