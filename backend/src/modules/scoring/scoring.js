import defaultConfig from '../../config/scoring.json' with { type: 'json' };

export const scoringConfig = defaultConfig;

export const REPLY_INTENTS = ['interested', 'needs_info', 'not_now', 'wrong_person', 'unsubscribe'];

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const includesAny = (text, keywords) => keywords.some((k) => text.includes(k));

export function computeFit(input, config = scoringConfig) {
  const items = [];
  const f = config.fit;

  const industryText = `${input.industry ?? ''} ${input.segment ?? ''}`.toLowerCase();
  if (includesAny(industryText, f.industry.keywords)) {
    items.push({ component: 'fit', label: 'Apparel/fashion company', points: f.industry.points });
  }

  const region = (input.region ?? '').toLowerCase().trim();
  // Short codes ("us", "uk") must match exactly; longer names may appear inside "New York, United States".
  if (region && f.region.targets.some((t) => region === t || (t.length > 3 && region.includes(t)))) {
    items.push({ component: 'fit', label: `Target region (${input.region})`, points: f.region.points });
  }

  const sizePoints = input.sizeBand ? f.sizeBand[input.sizeBand] : undefined;
  if (sizePoints) {
    items.push({ component: 'fit', label: `Company size ${input.sizeBand}`, points: sizePoints });
  }

  const title = input.title.toLowerCase();
  const relevant = includesAny(title, f.title.functionKeywords);
  const senior = includesAny(title, f.title.seniorityKeywords);
  const titlePoints =
    relevant && senior
      ? f.title.seniorAndRelevant
      : relevant
        ? f.title.relevant
        : senior
          ? f.title.seniorOnly
          : f.title.other;
  if (titlePoints) {
    const label =
      relevant && senior ? 'Senior buyer title' : relevant ? 'Relevant function' : 'Senior, non-core function';
    items.push({ component: 'fit', label: `${label} (${input.title})`, points: titlePoints });
  }
  return items;
}

export function computeEngagement(events, config = scoringConfig) {
  const e = config.engagement;
  const items = [];
  const count = (type) => events.filter((ev) => ev.type === type).length;

  if (count('delivered') > 0) items.push({ component: 'engagement', label: 'Email delivered', points: e.delivered });

  // Opens are noisy (image proxies, repeated loads): first open counts fully, a few repeats a little, then nothing.
  const opens = count('opened');
  if (opens > 0) items.push({ component: 'engagement', label: 'Opened email', points: e.firstOpen });
  const repeats = Math.min(Math.max(opens - 1, 0), e.maxRepeatOpens);
  if (repeats > 0) {
    items.push({ component: 'engagement', label: `Re-opened ${repeats}x`, points: repeats * e.repeatOpen });
  }

  // Only the latest reply's intent counts: a prospect who said "not now" and later "let's talk" is interested.
  const replies = events.filter((ev) => ev.type === 'replied').sort((a, b) => +a.occurredAt - +b.occurredAt);
  const latest = replies.at(-1);
  if (latest) {
    items.push({ component: 'engagement', label: 'Replied', points: e.replied });
    const bonus = latest.intent ? e.replyIntent[latest.intent] : 0;
    if (bonus) items.push({ component: 'engagement', label: `Reply intent: ${latest.intent}`, points: bonus });
  }
  return items;
}

/**
 * Pure, deterministic score from stored facts + the full raw event history.
 * @param fitInput { title, industry, segment, region, sizeBand }
 * @param events   [{ type: 'delivered'|'opened'|'replied'|'unsubscribed', occurredAt: Date, intent? }]
 * @returns { fit, engagement, total (0-100), status, suppressed, breakdown: [{ component, label, points }] }
 */
export function computeScore(fitInput, events, options = {}, config = scoringConfig) {
  const fitItems = computeFit(fitInput, config);
  const engagementItems = computeEngagement(events, config);
  const fit = clamp(fitItems.reduce((s, i) => s + i.points, 0));
  const engagement = clamp(engagementItems.reduce((s, i) => s + i.points, 0));

  const suppressed =
    options.suppressed === true ||
    events.some((ev) => ev.type === 'unsubscribed' || (ev.type === 'replied' && ev.intent === 'unsubscribe'));

  const has = (type) => events.some((ev) => ev.type === type);
  const status = suppressed
    ? 'suppressed'
    : has('replied')
      ? 'replied'
      : has('opened')
        ? 'opened'
        : has('delivered')
          ? 'sent'
          : 'new';

  // A suppressed lead must never be worked again, so it drops to the bottom regardless of fit.
  const total = suppressed ? 0 : clamp(fit * config.weights.fit + engagement * config.weights.engagement);

  return { fit, engagement, total, status, suppressed, breakdown: [...fitItems, ...engagementItems] };
}

/** Human-readable explanation of a score change, stored in score_history.reason. */
export function describeChange(previous, next, trigger) {
  if (!previous) {
    return `Initial score ${next.total} (fit ${next.fit}, engagement ${next.engagement}) - ${trigger}`;
  }
  const delta = next.total - previous.total;
  const sign = delta >= 0 ? '+' : '';
  const parts = [`${trigger}: ${previous.total} -> ${next.total} (${sign}${delta})`];
  if (next.engagement !== previous.engagement) parts.push(`engagement ${previous.engagement} -> ${next.engagement}`);
  if (next.fit !== previous.fit) parts.push(`fit ${previous.fit} -> ${next.fit}`);
  if (next.suppressed) parts.push('lead suppressed (unsubscribed)');
  return parts.join('; ');
}
