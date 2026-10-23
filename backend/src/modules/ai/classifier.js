import { z } from 'zod';
import { findUnverifiableClaims } from '../email/grounding.js';
import { REPLY_INTENTS } from '../scoring/scoring.js';
import { getLlm, parseJsonObject } from './llm.js';

// Ordered: the first matching rule wins, so opt-outs and misroutes beat generic positive words.
const RULES = [
  {
    intent: 'unsubscribe',
    patterns: [
      /unsubscribe/,
      /remove me/,
      /stop (emailing|contacting|sending)/,
      /opt(ed)? out/,
      /take me off/,
      /do not (contact|email)/,
      /don'?t (contact|email) me/,
      /no more emails/,
    ],
  },
  {
    intent: 'wrong_person',
    patterns: [
      /wrong person/,
      /not the (right )?(person|contact)/,
      /no longer (work|with|at)/,
      /(left|leaving) the company/,
      /not my (area|department|remit)/,
      /(you should|better to|please) (contact|reach out to|speak (to|with))/,
      /(handles|owns|is responsible for) (this|that|merchandising|planning)/,
      /i'?m not (involved|responsible)/,
    ],
  },
  {
    intent: 'not_now',
    patterns: [
      /not (right )?now/,
      /not a (priority|good time)/,
      /(next|following) (quarter|year|month)/,
      /later (this|in the) year/,
      /circle back/,
      /(reach|check) (back )?(out )?in (a few|\d+|six|three)/,
      /no budget/,
      /(too )?busy/,
      /timing (isn'?t|is not)/,
      /maybe later/,
      /already (have|use|working with)/,
    ],
  },
  {
    intent: 'needs_info',
    patterns: [
      /more (info|information|details)/,
      /(send|share) (me |over |us )?(some |a |the |more )?(info|information|details|deck|overview|case stud|pricing|one-pager)/,
      /how (does|do|would|much)/,
      /what (does|do|is|are) (it|you|the)/,
      /pricing/,
      /\bcost\b/,
      /integrat/,
      /case stud/,
      /can you explain/,
    ],
  },
  {
    intent: 'interested',
    patterns: [
      /interested/,
      /let'?s (talk|chat|connect|set up|book)/,
      /sounds (good|great|interesting)/,
      /happy to (chat|talk|connect|meet|take a call)/,
      /(book|schedule|set up) (a |some )?(call|time|meeting)/,
      /(works|work) for me/,
      /free (on|next)/,
      /send (me )?(a )?(calendar|invite)/,
      /\byes\b/,
    ],
  },
];

export function keywordClassify(text) {
  const t = text.toLowerCase().replace(/[’]/g, "'");
  for (const rule of RULES) {
    const hit = rule.patterns.find((p) => p.test(t));
    if (hit) return { intent: rule.intent, rationale: `Matched keyword rule ${hit.source}`, classifier: 'keyword' };
  }
  return t.includes('?')
    ? { intent: 'needs_info', rationale: 'No rule matched; the reply asks a question', classifier: 'keyword' }
    : { intent: 'not_now', rationale: 'No rule matched; treated as a non-committal reply', classifier: 'keyword' };
}

const CLASSIFY_PROMPT = `You classify replies to a B2B cold email from StyleSense AI (AI demand forecasting, size/fit prediction,
trend intelligence and inventory allocation for fashion brands).

Choose exactly one intent:
- interested: wants a call/meeting or clearly positive about talking.
- needs_info: asks questions or wants material (pricing, deck, how it works) before committing.
- not_now: declines for timing/budget/priority or already has a solution, without opting out.
- wrong_person: says they are not the right contact, have left, or redirects to someone else.
- unsubscribe: asks to stop emailing, be removed, or opts out in any wording. This overrides every other intent.

Respond with JSON only: {"intent": "<one of: interested, needs_info, not_now, wrong_person, unsubscribe>", "rationale": "<one short sentence>"}`;

const classificationSchema = z.object({ intent: z.enum(REPLY_INTENTS), rationale: z.string().min(1).max(500) });

export async function classifyReply(text, llm = getLlm()) {
  if (!llm) return keywordClassify(text);
  const message = await llm.chat({
    json: true,
    maxTokens: 200,
    messages: [
      { role: 'system', content: CLASSIFY_PROMPT },
      { role: 'user', content: `Reply:\n"""\n${text}\n"""` },
    ],
  });
  const parsed = classificationSchema.safeParse(parseJsonObject(message.content));
  if (!parsed.success) {
    console.warn('[classifier] LLM output failed validation; using keyword rules', parsed.error.issues);
    return { ...keywordClassify(text), rationale: 'LLM output invalid; fell back to keyword rules' };
  }
  return { ...parsed.data, classifier: 'llm' };
}

function templateDraft(intent, ctx) {
  const help = ctx.capability ? ` with ${ctx.capability}` : '';
  const sign = `\n\nBest,\n${ctx.senderName}\nStyleSense AI`;
  switch (intent) {
    case 'interested':
      return `Hi ${ctx.firstName},\n\nThanks for getting back to me - glad this is relevant. What day and time suits you for a 15-minute call? I'll keep it focused on how StyleSense AI could help ${ctx.companyName}${help}.${sign}`;
    case 'needs_info':
      return `Hi ${ctx.firstName},\n\nHappy to share more. In short, StyleSense AI helps apparel and fashion teams${help || ' with demand forecasting, size and fit prediction, trend intelligence and inventory allocation'}. Which questions matter most to your team at ${ctx.companyName}? I can send a short overview or walk you through it on a 15-minute call.${sign}`;
    case 'not_now':
      return `Hi ${ctx.firstName},\n\nUnderstood, thanks for letting me know. Would it be alright if I checked back in a few months?${sign}`;
    case 'wrong_person':
      return `Hi ${ctx.firstName},\n\nThanks for letting me know, and apologies for the misdirect. Could you point me to the person who looks after merchandising or demand planning at ${ctx.companyName}?${sign}`;
    case 'unsubscribe':
      return null; // We never reply to an opt-out; the address is suppressed instead.
  }
}

const DRAFT_PROMPT = `You draft a reply on behalf of a StyleSense AI salesperson to a prospect's email.
Rules:
- 40-90 words, plain text, warm and concise, end with "Best,\\n<sender name>\\nStyleSense AI".
- Use ONLY facts in CONTEXT. Do not invent numbers, results, customer names, prices, features or meeting times.
- If they ask something CONTEXT cannot answer, offer to follow up or cover it on a call.
Return JSON: {"draft": "<the email body>"}`;

/** Draft for human approval. LLM drafts must pass the same unverifiable-claim check as outreach. */
export async function draftReply(intent, replyText, ctx, llm = getLlm()) {
  const fallback = templateDraft(intent, ctx);
  if (!llm || intent === 'unsubscribe') return { draft: fallback, source: 'template', groundingIssues: [] };

  const context = [
    `Prospect first name: ${ctx.firstName}`,
    `Company: ${ctx.companyName}`,
    `Sender name: ${ctx.senderName}`,
    `Relevant capability: ${ctx.capability ?? 'demand forecasting, size and fit prediction, trend intelligence, inventory allocation'}`,
    ...ctx.facts.map((f) => `Fact: ${f}`),
  ].join('\n');
  try {
    const message = await llm.chat({
      json: true,
      temperature: 0.3,
      maxTokens: 400,
      messages: [
        { role: 'system', content: DRAFT_PROMPT },
        {
          role: 'user',
          content: `CONTEXT:\n${context}\n\nCLASSIFIED INTENT: ${intent}\n\nPROSPECT REPLY:\n"""\n${replyText}\n"""`,
        },
      ],
    });
    const draft = z.object({ draft: z.string().min(10).max(2000) }).parse(parseJsonObject(message.content)).draft;
    // The prospect's own words and our stored facts are the only allowed evidence.
    const issues = findUnverifiableClaims(draft, `${context}\n${replyText}`).map((i) => i.detail);
    if (issues.length) {
      console.warn('[grounding] LLM reply draft blocked:', issues);
      return { draft: fallback, source: 'template', groundingIssues: issues };
    }
    return { draft, source: 'llm', groundingIssues: [] };
  } catch (error) {
    console.warn('[classifier] LLM draft failed; using template', error.message);
    return { draft: fallback, source: 'template', groundingIssues: [] };
  }
}
