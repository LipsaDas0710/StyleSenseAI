import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { pool, withTransaction } from '../../db/pool.js';
import { AppError, notFound } from '../../http/errors.js';
import { isSuppressed, recordEvent } from '../events/events.service.js';
import { getEmailProvider, resolveRecipient } from './providers.js';
import { buildOutreachEmail, renderHtml, renderText } from './template.js';

export const newTrackingToken = () => randomBytes(24).toString('hex');
export const pixelUrl = (token) => `${env.PUBLIC_BASE_URL}/t/o/${token}.gif`;
export const unsubscribeUrl = (token) => `${env.PUBLIC_BASE_URL}/u/${token}`;

async function loadContext(db, campaignId, leadId) {
  const campaign = (await db.query('SELECT * FROM campaigns WHERE id = $1', [campaignId])).rows[0];
  if (!campaign) throw notFound('Campaign', campaignId);
  const lead = (
    await db.query(
      `SELECT l.id, l.first_name, l.email, l.company_id, c.name AS company_name, c.segment
         FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id JOIN companies c ON c.id = l.company_id
        WHERE cl.campaign_id = $1 AND cl.lead_id = $2`,
      [campaignId, leadId],
    )
  ).rows[0];
  if (!lead) throw new AppError(404, 'NOT_IN_CAMPAIGN', `Lead ${leadId} is not part of campaign ${campaignId}`);
  const signals = (
    await db.query(
      `SELECT id, kind, pain_point, summary_short, sentence, source_url, source_excerpt
         FROM company_signals WHERE company_id = $1 ORDER BY observed_at DESC NULLS LAST, id`,
      [lead.company_id],
    )
  ).rows;
  return {
    campaign,
    lead: { id: lead.id, first_name: lead.first_name, email: lead.email, company_id: lead.company_id },
    company: { name: lead.company_name, segment: lead.segment },
    signals,
  };
}

function compose(ctx) {
  return buildOutreachEmail({ lead: ctx.lead, company: ctx.company, signals: ctx.signals, campaign: ctx.campaign });
}

async function writeGroundingLog(db, ctx, email) {
  for (const entry of email.log) {
    await db.query(
      `INSERT INTO grounding_logs (lead_id, campaign_id, token, attempted_value, rule, action) VALUES ($1, $2, $3, $4, $5, $6)`,
      [ctx.lead.id, ctx.campaign.id, entry.token, entry.value, `${entry.rule}: ${entry.detail}`, entry.action],
    );
    console.warn(
      `[grounding] lead=${ctx.lead.id} token=${entry.token} ${entry.rule} -> ${entry.action}: ${entry.detail}`,
    );
  }
}

export async function previewOutreach(campaignId, leadId) {
  const ctx = await loadContext(pool, campaignId, leadId);
  const email = compose(ctx);
  const sample = 'preview-token';
  return {
    ...email,
    text: renderText(email, unsubscribeUrl(sample)),
    suppressed: ctx.lead.email ? await isSuppressed(pool, ctx.lead.email) : false,
    has_email: ctx.lead.email !== null,
  };
}

async function sendOne(provider, campaignId, leadId) {
  const ctx = await loadContext(pool, campaignId, leadId);
  const skip = (code, reason) => ({ leadId, status: 'skipped', code, reason });

  if (!ctx.lead.email) return skip('LEAD_HAS_NO_EMAIL', 'lead has no verified email address');
  // Enforced here on the server, not just hidden in the UI.
  if (await isSuppressed(pool, ctx.lead.email))
    return skip('SUPPRESSED', `${ctx.lead.email} is on the suppression list`);

  const email = compose(ctx);
  await writeGroundingLog(pool, ctx, email);
  if (email.blocked) return skip('BLOCKED_BY_GROUNDING', email.blockReason);

  const token = newTrackingToken();
  const links = { unsubscribeUrl: unsubscribeUrl(token), pixelUrl: pixelUrl(token) };
  const text = renderText(email, links.unsubscribeUrl);
  const html = renderHtml(email, links);
  const deliveredTo = resolveRecipient(provider, ctx.lead.email);

  // Reserve the (campaign, lead) slot first: the partial unique index makes a concurrent double send impossible.
  const reserved = (
    await pool.query(
      `INSERT INTO email_messages (lead_id, campaign_id, kind, to_email, delivered_to, subject, body_text, body_html,
                                   tracking_token, provider, grounding)
       VALUES ($1, $2, 'outreach', $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (campaign_id, lead_id) WHERE kind = 'outreach' DO NOTHING
       RETURNING id`,
      [
        leadId,
        campaignId,
        ctx.lead.email,
        deliveredTo,
        email.subject,
        text,
        html,
        token,
        provider.name,
        JSON.stringify({ tokens: email.tokens, log: email.log }),
      ],
    )
  ).rows[0];
  if (!reserved) return skip('ALREADY_SENT', 'this lead already received this campaign');

  try {
    const { providerMessageId } = await provider.send({
      to: deliveredTo,
      subject: email.subject,
      text,
      html,
      headers: {
        'List-Unsubscribe': `<${links.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    await withTransaction(async (db) => {
      await db.query('UPDATE email_messages SET provider_message_id = $2 WHERE id = $1', [
        reserved.id,
        providerMessageId,
      ]);
      await recordEvent(
        {
          leadId,
          type: 'delivered',
          messageId: reserved.id,
          dedupeKey: `delivered:${reserved.id}`,
          payload: { provider: provider.name, provider_message_id: providerMessageId },
        },
        db,
      );
    });
    return { leadId, status: 'sent', messageId: reserved.id, deliveredTo };
  } catch (error) {
    // Nothing was accepted by the provider, so release the slot and allow a retry.
    await pool.query('DELETE FROM email_messages WHERE id = $1', [reserved.id]);
    const appError = error instanceof AppError ? error : new AppError(502, 'EMAIL_PROVIDER_ERROR', error.message);
    return { leadId, status: 'failed', code: appError.code, reason: appError.message };
  }
}

export async function sendCampaign(campaignId, leadIds) {
  const campaign = (await pool.query('SELECT id, status FROM campaigns WHERE id = $1', [campaignId])).rows[0];
  if (!campaign) throw notFound('Campaign', campaignId);
  if (campaign.status !== 'active') {
    throw new AppError(409, 'CAMPAIGN_NOT_ACTIVE', `Campaign is ${campaign.status}; set it to active to send`);
  }
  const provider = getEmailProvider();
  const targets =
    leadIds ??
    (
      await pool.query(
        `SELECT cl.lead_id FROM campaign_leads cl WHERE cl.campaign_id = $1 AND NOT EXISTS
         (SELECT 1 FROM email_messages m WHERE m.campaign_id = cl.campaign_id AND m.lead_id = cl.lead_id AND m.kind = 'outreach')`,
        [campaignId],
      )
    ).rows.map((r) => r.lead_id);

  const results = [];
  for (const leadId of targets) results.push(await sendOne(provider, campaignId, leadId)); // sequential: simple + rate-limit friendly
  return {
    provider: provider.name,
    summary: {
      sent: results.filter((r) => r.status === 'sent').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'failed').length,
    },
    results,
  };
}

async function messageByToken(token) {
  if (!/^[a-f0-9]{32,}$/.test(token)) return null;
  return (
    (await pool.query('SELECT id, lead_id, to_email FROM email_messages WHERE tracking_token = $1', [token])).rows[0] ??
    null
  );
}

/** Every pixel load is stored as a raw event; scoring decides how much repeat opens count. */
export async function trackOpen(token, userAgent) {
  const message = await messageByToken(token);
  if (!message) return false;
  await recordEvent({
    leadId: message.lead_id,
    type: 'opened',
    messageId: message.id,
    payload: { user_agent: userAgent?.slice(0, 300) ?? null },
  });
  return true;
}

export async function unsubscribe(token) {
  const message = await messageByToken(token);
  if (!message) return null;
  // One unsubscribe per lead: repeated clicks are idempotent.
  await recordEvent({
    leadId: message.lead_id,
    type: 'unsubscribed',
    messageId: message.id,
    dedupeKey: `unsubscribed:${message.lead_id}`,
    payload: { via: 'unsubscribe_link' },
  });
  // The lead's address may have changed since sending; suppress the address the email actually went to as well.
  await pool.query(
    `INSERT INTO suppression_list (email, reason) VALUES (lower($1), 'unsubscribe_link') ON CONFLICT (email) DO NOTHING`,
    [message.to_email],
  );
  return { email: message.to_email };
}
