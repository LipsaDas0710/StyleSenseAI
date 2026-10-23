import 'dotenv/config';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Deterministic, offline configuration for the API tests.
process.env.EMAIL_PROVIDER = 'log';
process.env.EMAIL_TEST_RECIPIENT = '';
process.env.LLM_API_KEY = '';

const hasDb = Boolean(process.env.TEST_DATABASE_URL);
if (!hasDb) console.warn('TEST_DATABASE_URL not set - skipping API tests');

let app;
let pool;

const company = {
  name: 'Northwind Apparel',
  domain: 'northwind-apparel.example',
  industry: 'Apparel & Fashion',
  region: 'United States',
  size_band: '201-1000',
  segment: 'DTC brand',
  signals: [
    {
      kind: 'expansion',
      pain_point: 'stockouts',
      summary_short: 'new Austin store',
      sentence: 'that Northwind Apparel opened a new store in Austin in March',
      source_url: 'https://news.example/northwind-austin',
      source_excerpt: 'Northwind Apparel opened a new store in Austin in March, its fourth in Texas.',
    },
  ],
};
const leadBody = {
  first_name: 'Dana',
  last_name: 'Reyes',
  title: 'Head of Merchandising',
  email: 'Dana.Reyes@Example.com',
  source_url: 'https://news.example/northwind-team',
  company,
};

describe.skipIf(!hasDb)('API', () => {
  beforeAll(async () => {
    ({ pool } = await import('../src/db/pool.js'));
    const { migrate } = await import('../src/db/migrate.js');
    await migrate(() => {});
    app = (await import('../src/app.js')).createApp();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE companies, leads, campaigns, campaign_leads, email_messages, email_events,
      lead_scores, score_history, suppression_list, grounding_logs, discovery_runs, reply_drafts, company_signals
      RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('POST /api/leads', () => {
    it('creates a lead with its company, normalises the email and computes an initial score', async () => {
      const res = await request(app).post('/api/leads').send(leadBody).expect(201);
      expect(res.body).toMatchObject({
        first_name: 'Dana',
        email: 'dana.reyes@example.com',
        status: 'new',
        company_name: 'Northwind Apparel',
        fit_score: 100,
        score: 60,
      });
      const history = await request(app).get(`/api/leads/${res.body.id}/score-history`).expect(200);
      expect(history.body.data[0].reason).toMatch(/^Initial score 60/);
    });

    it('returns 400 with field details for invalid input', async () => {
      const res = await request(app)
        .post('/api/leads')
        .send({ first_name: '', title: 'x', source_url: 'not-a-url', company_id: 1 })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      const paths = res.body.error.details.map((d) => d.path);
      expect(paths).toEqual(expect.arrayContaining(['first_name', 'source_url']));
    });

    it('returns 409 for a duplicate email and 400 for malformed JSON', async () => {
      await request(app).post('/api/leads').send(leadBody).expect(201);
      const dup = await request(app)
        .post('/api/leads')
        .send({ ...leadBody, first_name: 'Other', email: 'dana.reyes@example.com' })
        .expect(409);
      expect(dup.body.error.code).toBe('CONFLICT');
      const bad = await request(app)
        .post('/api/leads')
        .set('Content-Type', 'application/json')
        .send('{"oops"')
        .expect(400);
      expect(bad.body.error.code).toBe('INVALID_JSON');
    });
  });

  describe('GET /api/leads', () => {
    it('paginates, ranks by score and filters by status', async () => {
      await request(app).post('/api/leads').send(leadBody).expect(201);
      await request(app)
        .post('/api/leads')
        .send({ ...leadBody, first_name: 'Sam', email: 'sam@example.com', title: 'Office Manager' })
        .expect(201);
      const res = await request(app).get('/api/leads?limit=1').expect(200);
      expect(res.body.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
      expect(res.body.data[0].first_name).toBe('Dana');
      const filtered = await request(app).get('/api/leads?status=opened').expect(200);
      expect(filtered.body.data).toEqual([]);
      await request(app).get('/api/leads?limit=500').expect(400);
      await request(app).get('/api/leads/999').expect(404);
    });
  });

  it('runs the full lifecycle: send -> open -> reply -> unsubscribe -> suppressed', async () => {
    const lead = (await request(app).post('/api/leads').send(leadBody).expect(201)).body;
    const campaign = (
      await request(app).post('/api/campaigns').send({ name: 'Q3 outreach', sender_name: 'Priya' }).expect(201)
    ).body;
    await request(app)
      .post(`/api/campaigns/${campaign.id}/leads`)
      .send({ leadIds: [lead.id] })
      .expect(201);

    const preview = await request(app).get(`/api/campaigns/${campaign.id}/leads/${lead.id}/preview`).expect(200);
    expect(preview.body.blocked).toBe(false);
    expect(preview.body.subject).toBe('Northwind Apparel’s new Austin store - quick question');

    const send = await request(app).post(`/api/campaigns/${campaign.id}/send`).send({}).expect(200);
    expect(send.body.summary).toEqual({ sent: 1, skipped: 0, failed: 0 });
    const again = await request(app)
      .post(`/api/campaigns/${campaign.id}/send`)
      .send({ leadIds: [lead.id] })
      .expect(200);
    expect(again.body.results[0].code).toBe('ALREADY_SENT');

    const { tracking_token: token, body_html: html } = (
      await pool.query('SELECT tracking_token, body_html FROM email_messages WHERE lead_id = $1', [lead.id])
    ).rows[0];
    expect(html).toContain(`/t/o/${token}.gif`);
    expect(html).toContain(`/u/${token}`);

    const pixel = await request(app).get(`/t/o/${token}.gif`).expect(200);
    expect(pixel.headers['content-type']).toBe('image/gif');
    await request(app)
      .get(`/t/o/${'0'.repeat(48)}.gif`)
      .expect(200); // unknown token still returns the pixel
    const afterOpen = (await request(app).get(`/api/leads/${lead.id}`).expect(200)).body;
    expect(afterOpen.status).toBe('opened');
    expect(afterOpen.score).toBeGreaterThan(lead.score);

    const reply = await request(app)
      .post(`/api/leads/${lead.id}/replies`)
      .send({ text: "Sounds interesting - let's set up a call next week." })
      .expect(201);
    expect(reply.body.classification.intent).toBe('interested');
    expect(reply.body).toMatchObject({ requires_human_approval: true, sent: false });
    expect(reply.body.draft.status).toBe('pending');
    const afterReply = (await request(app).get(`/api/leads/${lead.id}`).expect(200)).body;
    expect(afterReply.status).toBe('replied');
    expect(afterReply.score).toBeGreaterThan(afterOpen.score);

    await request(app).post(`/api/reply-drafts/${reply.body.draft.id}/approve`).send({}).expect(200);
    await request(app).post(`/api/reply-drafts/${reply.body.draft.id}/approve`).send({}).expect(409);

    const unsub = await request(app).get(`/u/${token}`).expect(200);
    expect(unsub.text).toContain('You are unsubscribed');
    const afterUnsub = (await request(app).get(`/api/leads/${lead.id}`).expect(200)).body;
    expect(afterUnsub).toMatchObject({ status: 'suppressed', score: 0 });

    // Suppression is honoured on future sends, server side.
    const second = (
      await request(app).post('/api/campaigns').send({ name: 'Follow-up', sender_name: 'Priya' }).expect(201)
    ).body;
    await request(app)
      .post(`/api/campaigns/${second.id}/leads`)
      .send({ leadIds: [lead.id] })
      .expect(201);
    const blocked = await request(app).post(`/api/campaigns/${second.id}/send`).send({}).expect(200);
    expect(blocked.body.results[0]).toMatchObject({ status: 'skipped', code: 'SUPPRESSED' });

    const history = (await request(app).get(`/api/leads/${lead.id}/score-history`).expect(200)).body.data;
    expect(history.map((h) => h.event_type)).toEqual(['unsubscribed', 'replied', 'opened', 'delivered', null]);
  });

  it('recomputing from raw events reproduces the stored score', async () => {
    const lead = (await request(app).post('/api/leads').send(leadBody).expect(201)).body;
    await request(app).post('/api/events').send({ leadId: lead.id, type: 'opened' }).expect(201);
    const stored = (await request(app).get(`/api/leads/${lead.id}`)).body.score;
    await pool.query('DELETE FROM lead_scores WHERE lead_id = $1', [lead.id]);
    const recomputed = await request(app).post(`/api/leads/${lead.id}/recalculate-score`).expect(200);
    expect(recomputed.body.total).toBe(stored);
  });
});
