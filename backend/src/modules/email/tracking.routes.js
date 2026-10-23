import { Router } from 'express';
import { trackOpen, unsubscribe } from './email.service.js';

// Public, unauthenticated endpoints hit from inside recipients' mail clients.
export const trackingRouter = Router();

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

trackingRouter.get('/t/o/:file', async (req, res) => {
  const token = req.params.file.replace(/\.gif$/, '');
  try {
    await trackOpen(token, req.get('user-agent'));
  } catch (error) {
    // A tracking failure must never break the email's rendering.
    console.error('[tracking] failed to record open', error);
  }
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private' });
  res.send(PIXEL);
});

const page = (res, status, title, message) =>
  res.status(status).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,sans-serif;max-width:480px;margin:64px auto;padding:0 16px">
<h1 style="font-size:20px">${title}</h1><p>${message}</p></body></html>`);

async function handleUnsubscribe(token, res) {
  const result = await unsubscribe(token);
  if (!result) return page(res, 404, 'Link not recognised', 'This unsubscribe link is invalid or has expired.');
  return page(res, 200, 'You are unsubscribed', 'You will not receive any further emails from StyleSense AI.');
}

// GET for the link in the email body; POST for RFC 8058 one-click (List-Unsubscribe-Post).
trackingRouter.get('/u/:token', (req, res) => handleUnsubscribe(req.params.token, res));
trackingRouter.post('/u/:token', (req, res) => handleUnsubscribe(req.params.token, res));
