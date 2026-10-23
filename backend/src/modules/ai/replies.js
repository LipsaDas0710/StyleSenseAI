import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool.js';
import { AppError, notFound } from '../../http/errors.js';
import { idParams } from '../../http/validate.js';
import { newTrackingToken, unsubscribeUrl } from '../email/email.service.js';
import { PAIN_POINT_MAP, painPointFor } from '../email/painPoints.js';
import { getEmailProvider, resolveRecipient } from '../email/providers.js';
import { renderHtml, renderText } from '../email/template.js';
import { isSuppressed, recordEvent } from '../events/events.service.js';
import { classifyReply, draftReply } from './classifier.js';

const replyBody = z.object({ text: z.string().trim().min(2).max(5000) });
const approveBody = z.object({ body: z.string().trim().min(10).max(5000).optional() }).default({});

async function loadReplyContext(leadId) {
  const lead = (
    await pool.query(
      `SELECT l.first_name, l.email, l.company_id, c.name AS company_name,
              (SELECT row_to_json(m) FROM (SELECT m.id, m.subject, ca.sender_name FROM email_messages m
                 LEFT JOIN campaigns ca ON ca.id = m.campaign_id
                WHERE m.lead_id = l.id AND m.kind = 'outreach' ORDER BY m.sent_at DESC LIMIT 1) m) AS last_outreach
         FROM leads l JOIN companies c ON c.id = l.company_id WHERE l.id = $1`,
      [leadId],
    )
  ).rows[0];
  if (!lead) throw notFound('Lead', leadId);
  const signals = (
    await pool.query(
      'SELECT kind, pain_point, sentence FROM company_signals WHERE company_id = $1 ORDER BY pain_point NULLS LAST, id',
      [lead.company_id],
    )
  ).rows;
  const pain = signals.map(painPointFor).find((p) => p.key)?.key;
  return {
    firstName: lead.first_name,
    companyName: lead.company_name,
    senderName: lead.last_outreach?.sender_name ?? 'The StyleSense AI team',
    capability: pain ? PAIN_POINT_MAP[pain].capability : null,
    facts: signals.map((s) => s.sentence.replace(/^\s*i noticed\s+/i, '')),
    email: lead.email,
    lastSubject: lead.last_outreach?.subject ?? null,
    lastMessageId: lead.last_outreach?.id ?? null,
  };
}

export const repliesRouter = Router();

/** Simulated inbound reply: store raw event, classify, draft a response for human approval. Nothing is sent. */
repliesRouter.post('/leads/:id/replies', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { text } = replyBody.parse(req.body);
  const ctx = await loadReplyContext(id);

  // LLM calls happen before the transaction so no DB locks are held while waiting on the network.
  const classification = await classifyReply(text);
  const draft = await draftReply(classification.intent, text, ctx);

  const result = await withTransaction(async (db) => {
    const recorded = await recordEvent(
      {
        leadId: id,
        type: 'replied',
        messageId: ctx.lastMessageId,
        payload: {
          text,
          intent: classification.intent,
          classifier: classification.classifier,
          rationale: classification.rationale,
        },
      },
      db,
    );
    const row = (
      await db.query(
        `INSERT INTO reply_drafts (event_id, lead_id, intent, classifier, rationale, draft_body, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          recorded.event.id,
          id,
          classification.intent,
          classification.classifier,
          classification.rationale,
          draft.draft,
          draft.draft ? 'pending' : 'not_applicable',
        ],
      )
    ).rows[0];
    return { recorded, row };
  });

  res.status(201).json({
    classification,
    draft: result.row,
    draft_source: draft.source,
    grounding_issues: draft.groundingIssues,
    score: result.recorded.score,
    requires_human_approval: draft.draft !== null,
    sent: false,
  });
});

async function pendingDraft(id) {
  const draft = (await pool.query('SELECT * FROM reply_drafts WHERE id = $1', [id])).rows[0];
  if (!draft) throw notFound('Reply draft', id);
  if (draft.status !== 'pending') throw new AppError(409, 'DRAFT_NOT_PENDING', `Draft is already ${draft.status}`);
  return draft;
}

/** Human-approved send of a drafted reply (optionally edited). */
repliesRouter.post('/reply-drafts/:id/approve', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { body } = approveBody.parse(req.body ?? {});
  const draft = await pendingDraft(id);
  const ctx = await loadReplyContext(draft.lead_id);
  if (!ctx.email) throw new AppError(422, 'LEAD_HAS_NO_EMAIL', 'Lead has no email address to reply to');
  if (await isSuppressed(pool, ctx.email))
    throw new AppError(409, 'SUPPRESSED', `${ctx.email} is on the suppression list`);

  const provider = getEmailProvider();
  const text = body ?? draft.draft_body;
  const token = newTrackingToken();
  const parts = { paragraphs: text.split(/\n{2,}/), signOff: [] };
  const subject = ctx.lastSubject ? `Re: ${ctx.lastSubject}` : 'Re: StyleSense AI';
  const deliveredTo = resolveRecipient(provider, ctx.email);
  const rendered = {
    text: renderText(parts, unsubscribeUrl(token)),
    html: renderHtml(parts, { unsubscribeUrl: unsubscribeUrl(token) }),
  };

  const { providerMessageId } = await provider.send({ to: deliveredTo, subject, ...rendered });
  const updated = await withTransaction(async (db) => {
    const message = (
      await db.query(
        `INSERT INTO email_messages (lead_id, kind, to_email, delivered_to, subject, body_text, body_html, tracking_token,
                                     provider, provider_message_id)
         VALUES ($1, 'reply', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          draft.lead_id,
          ctx.email,
          deliveredTo,
          subject,
          rendered.text,
          rendered.html,
          token,
          provider.name,
          providerMessageId,
        ],
      )
    ).rows[0];
    return (
      await db.query(
        `UPDATE reply_drafts SET status = 'approved', decided_at = now(), sent_message_id = $2, draft_body = $3
          WHERE id = $1 RETURNING *`,
        [id, message.id, text],
      )
    ).rows[0];
  });
  res.json({ draft: updated, sent: true, provider: provider.name, delivered_to: deliveredTo });
});

repliesRouter.post('/reply-drafts/:id/discard', async (req, res) => {
  const { id } = idParams.parse(req.params);
  await pendingDraft(id);
  const { rows } = await pool.query(
    `UPDATE reply_drafts SET status = 'discarded', decided_at = now() WHERE id = $1 RETURNING *`,
    [id],
  );
  res.json({ draft: rows[0], sent: false });
});
