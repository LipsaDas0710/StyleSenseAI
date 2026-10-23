import cors from 'cors';
import express from 'express';
import { pool } from './db/pool.js';
import { errorHandler, routeNotFound } from './http/errors.js';
import { discoveryRouter } from './modules/ai/discovery.js';
import { repliesRouter } from './modules/ai/replies.js';
import { campaignsRouter } from './modules/campaigns/campaigns.js';
import { companiesRouter } from './modules/companies/companies.js';
import { trackingRouter } from './modules/email/tracking.routes.js';
import { eventsRouter } from './modules/events/events.routes.js';
import { leadsRouter } from './modules/leads/leads.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  // Public endpoints opened from recipients' inboxes.
  app.use(trackingRouter);

  const api = express.Router();
  api.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'up' });
  });
  api.use('/leads', leadsRouter);
  api.use('/companies', companiesRouter);
  api.use('/campaigns', campaignsRouter);
  api.use('/discovery/runs', discoveryRouter);
  api.use(eventsRouter);
  api.use(repliesRouter);
  app.use('/api', api);

  app.use(routeNotFound);
  app.use(errorHandler);
  return app;
}
