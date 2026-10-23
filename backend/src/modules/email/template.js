import { checkToken } from './grounding.js';
import { PAIN_POINT_MAP, painPointFor } from './painPoints.js';

/** Appendix A. Locked copy lives here and only here; tokens are filled from stored data. */

const field = (kind, ref) => ({ kind, ref });
const signalProv = (s, column) => ({
  kind: 'signal',
  ref: `company_signals.${s.id}.${column}`,
  sourceUrl: s.source_url,
  evidence: s.source_excerpt,
});
const productCopy = (ref) => ({ kind: 'product_copy', ref });

const describe = (p) => (p.kind === 'signal' ? `signal (${p.ref})` : `${p.kind.replace('_', ' ')} ${p.ref}`);
const stripEnd = (s) => s.trim().replace(/[.!?]+$/, '');

/**
 * @param input { lead: { id, first_name }, company: { name, segment }, campaign: { subject_variant, sender_name,
 *   proposed_time_window }, signals: [{ id, pain_point, summary_short, sentence, source_url, source_excerpt }] }
 * @returns { subject, paragraphs, signOff, tokens: [{ token, value, source, sourceUrl? }], log, blocked, blockReason }
 */
export function buildOutreachEmail(input) {
  const { lead, company, signals, campaign } = input;
  const tokens = new Map();
  const log = [];

  /** Resolves a group of tokens that one sentence needs; all must pass, otherwise the sentence is dropped. */
  const resolve = (candidates, onFail) => {
    const issues = candidates.flatMap(checkToken);
    if (issues.length) {
      log.push(...issues.map((i) => ({ ...i, action: onFail })));
      return null;
    }
    const values = {};
    for (const c of candidates) {
      const value = stripEnd(c.value);
      values[c.token] = value;
      tokens.set(c.token, {
        token: c.token,
        value,
        source: describe(c.provenance),
        ...(c.provenance.kind === 'signal' ? { sourceUrl: c.provenance.sourceUrl } : {}),
      });
    }
    return values;
  };

  // Pick the first signal whose own text passes grounding; prefer researched pain points, then inferable ones.
  const rank = (s) => (s.pain_point ? 2 : painPointFor(s).key ? 1 : 0);
  const ordered = [...signals].sort((a, b) => rank(b) - rank(a));
  let signal = null;
  let noticed = null;
  for (const s of ordered) {
    noticed = resolve(
      [
        {
          token: 'observed_signal_sentence',
          // Stored sentences should follow "I noticed"; tolerate ones that repeat it.
          value: s.sentence.replace(/^\s*i noticed\s+/i, ''),
          provenance: signalProv(s, 'sentence'),
        },
        { token: 'observed_signal_short', value: s.summary_short, provenance: signalProv(s, 'summary_short') },
      ],
      'dropped_sentence',
    );
    if (noticed) {
      signal = s;
      break;
    }
  }
  if (!signals.length) {
    log.push({
      token: 'observed_signal_sentence',
      value: null,
      rule: 'missing_value',
      detail: 'company has no researched signals with a source URL',
      action: 'dropped_sentence',
    });
  }

  const painPoint = painPointFor(signal);
  const pain = painPoint.key ? PAIN_POINT_MAP[painPoint.key] : null;
  const painRef = painPoint.key ?? 'none';
  const painNote = painPoint.inferred ? ` (inferred from "${signal.kind}" signal)` : '';
  const base = resolve(
    [
      { token: 'first_name', value: lead.first_name, provenance: field('lead_field', 'leads.first_name') },
      { token: 'company_name', value: company.name, provenance: field('company_field', 'companies.name') },
      {
        token: 'sender_name',
        value: campaign.sender_name,
        provenance: field('campaign_field', 'campaigns.sender_name'),
      },
    ],
    'blocked_send',
  );

  const paragraphs = [];
  if (base) {
    paragraphs.push(`Hi ${base.first_name},`);
    if (noticed) paragraphs.push(`I noticed ${noticed.observed_signal_sentence}.`);

    // quantified_outcome_optional: we hold no sourced customer outcome figures, so it is always omitted.
    const valueProp = resolve(
      [
        { token: 'company_segment', value: company.segment, provenance: field('company_field', 'companies.segment') },
        {
          token: 'value_prop_for_pain_point',
          value: pain?.valueProp,
          provenance: productCopy(`pain_point_map.${painRef}.valueProp${painNote}`),
        },
      ],
      'dropped_sentence',
    );
    if (valueProp) {
      paragraphs.push(
        `At StyleSense AI, we help apparel and fashion ${valueProp.company_segment} teams ${valueProp.value_prop_for_pain_point}.`,
      );
    }

    const context = resolve(
      [
        {
          token: 'specific_context_detail',
          value: signal?.summary_short,
          provenance: signal ? signalProv(signal, 'summary_short') : field('company_field', 'company_signals'),
        },
        {
          token: 'one_line_relevance_hypothesis',
          value: pain?.hypothesis,
          provenance: productCopy(`pain_point_map.${painRef}.hypothesis${painNote}`),
        },
      ],
      'dropped_sentence',
    );
    if (context) {
      paragraphs.push(
        `Given ${base.company_name}’s ${context.specific_context_detail}, ${context.one_line_relevance_hypothesis}.`,
      );
    }

    const window = campaign.proposed_time_window
      ? resolve(
          [
            {
              token: 'proposed_time_window',
              value: campaign.proposed_time_window,
              provenance: field('campaign_field', 'campaigns.proposed_time_window'),
            },
          ],
          'omitted_optional',
        )
      : null;
    paragraphs.push(
      window
        ? `Would you be open to a 15-minute call ${window.proposed_time_window} to see if it’s a fit?`
        : 'Would you be open to a 15-minute call to see if it’s a fit?',
    );
    // optional_soft_proof_point: no sourced proof points are stored, so the P.S. line is omitted.
  }

  // Subject: the campaign's chosen variant, falling back to the next one whose tokens are grounded.
  const firstName = tokens.get('first_name')?.value;
  const companyName = tokens.get('company_name')?.value;
  const signalShort = noticed?.observed_signal_short;
  const subjects = [
    companyName && signalShort ? `${companyName}’s ${signalShort} - quick question` : null,
    companyName && pain ? `Cutting ${pain.category} at ${companyName}` : null,
    firstName && signalShort ? `${firstName}, saw ${signalShort}` : null,
  ];
  const start = campaign.subject_variant - 1;
  const subject = [...subjects.slice(start), ...subjects.slice(0, start)].find((s) => s) ?? null;
  if (subject && pain && subject.startsWith('Cutting')) {
    tokens.set('pain_point_category', {
      token: 'pain_point_category',
      value: pain.category,
      source: `product copy pain_point_map.${painRef}.category${painNote}`,
    });
  }

  const bodySentences = paragraphs.length - 2; // minus greeting and call-to-action
  const blockReason = !base
    ? 'required lead/company/sender fields are missing'
    : !subject
      ? 'no subject line can be filled from grounded data'
      : bodySentences < 2
        ? 'fewer than two grounded body sentences remain'
        : null;
  if (blockReason) {
    log.push({ token: 'email', value: null, rule: 'missing_value', detail: blockReason, action: 'blocked_send' });
  }

  return {
    subject,
    paragraphs,
    signOff: ['Best,', tokens.get('sender_name')?.value ?? '', 'StyleSense AI'],
    tokens: [...tokens.values()],
    log,
    blocked: blockReason !== null,
    blockReason,
  };
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function renderText(email, unsubscribeUrl) {
  return [
    ...email.paragraphs,
    email.signOff.join('\n'),
    `---\nStyleSense AI (fictional company, demo outreach).\nUnsubscribe: ${unsubscribeUrl}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function renderHtml(email, links) {
  const body = email.paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  const signOff = email.signOff.length ? `<p>${email.signOff.map(escapeHtml).join('<br>')}</p>` : '';
  const footer = `<p style="font-size:12px;color:#777">StyleSense AI (fictional company, demo outreach).
<a href="${escapeHtml(links.unsubscribeUrl)}">Unsubscribe</a> and you will not hear from us again.</p>`;
  const pixel = links.pixelUrl
    ? `<img src="${escapeHtml(links.pixelUrl)}" width="1" height="1" alt="" style="display:none">`
    : '';
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
${body}
${signOff}
${footer}
${pixel}
</body></html>`;
}
