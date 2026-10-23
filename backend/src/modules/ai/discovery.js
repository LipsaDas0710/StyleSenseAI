import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { pool, withTransaction } from '../../db/pool.js';
import { AppError, notFound } from '../../http/errors.js';
import { idParams, offsetOf, optionalText, paginationSchema, toPage } from '../../http/validate.js';
import { PAIN_POINTS, SIGNAL_KINDS, SIZE_BANDS, upsertCompany } from '../companies/companies.js';
import { createLead } from '../leads/leads.js';
import { getLlm, parseJsonObject } from './llm.js';
import { fetchPage, relevantExcerpt, TOOL_DEFINITIONS, webSearch } from './tools.js';

export const icpSchema = z.object({
  industry: z.string().trim().min(2).max(100),
  region: z.string().trim().min(2).max(100),
  company_size: optionalText(50),
  titles: z.array(z.string().trim().min(2).max(100)).min(1).max(8),
  max_leads: z.number().int().min(1).max(10).default(8),
});

// Budgets keep a run inside free-tier limits (Groq: ~8k tokens/minute) and bound its duration.
const MAX_TOOL_ROUNDS = 10;
const MAX_SEARCHES = 5;
const MAX_FETCHES = 6;
const TOOL_EXCERPT_CHARS = 1500;
const EXTRACT_EXCERPT_CHARS = 3500;

const ROLE_KEYWORDS = ['merchandis', 'planning', 'planner', 'supply chain', 'inventory', 'allocation', 'buying',
  'chief', 'head of', 'director', 'vice president', 'vp', 'appoint', 'named', 'joins', 'hired'];
const SIGNAL_KEYWORDS = ['launch', 'open', 'store', 'expan', 'markdown', 'discount', 'stockout', 'out of stock',
  'return', 'funding', 'raise', 'collection', 'dtc', 'direct-to-consumer', 'wholesale', 'sustainab', 'overproduction'];

const signalSchema = z.object({
  company_name: z.string().trim().min(1).max(200),
  kind: z.enum(SIGNAL_KINDS).catch('other'),
  pain_point: z.enum(PAIN_POINTS).nullish().catch(null),
  summary_short: z.string().trim().min(3).max(60),
  sentence: z.string().trim().min(10).max(300),
  source_excerpt: z.string().trim().min(5).max(600),
});

// What the extraction step must return. Everything is re-verified against fetched pages afterwards.
const extractedLead = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().max(100).nullish(),
  title: z.string().trim().min(2).max(200),
  source_url: z.string().url(),
  source_excerpt: z.string().trim().min(5).max(600),
  linkedin_url: z.string().url().nullish(),
  company: z.object({
    name: z.string().trim().min(1).max(200),
    website: z.string().url().nullish().catch(null),
    industry: z.string().trim().max(100).nullish(),
    region: z.string().trim().max(100).nullish(),
    size_band: z.enum(SIZE_BANDS).nullish().catch(null),
    segment: z.string().trim().max(100).nullish(),
  }),
  signals: z.array(signalSchema.extend({ source_url: z.string().url() })).max(3).default([]),
});

const SEARCH_PROMPT = (icp) => `You are a B2B sales researcher for StyleSense AI, which sells demand forecasting,
size/fit prediction, trend intelligence and inventory allocation software to apparel and fashion brands and retailers.

Ideal customer profile:
- Industry: ${icp.industry}
- Region: ${icp.region}
- Company size: ${icp.company_size ?? 'any'}
- Target titles: ${icp.titles.join(', ')}

Goal: find up to ${icp.max_leads} REAL, currently-employed people at different companies matching this profile, plus one
recent public signal per company (collection/store launch, DTC or marketplace expansion, new region, hiring for planning or
merchandising, markdowns, stockouts, high returns, funding, new leadership, sustainability/overproduction initiative).

Method: use web_search to find candidate pages (press releases or trade press announcing appointments - Business of
Fashion, Retail Dive, Drapers, WWD, Modern Retail - and company leadership pages). Then call fetch_page on the most
promising pages - a person or signal that does not appear in a fetched page will be discarded. Never guess names or emails.
Each page you fetch should be about a DIFFERENT company; you may call several tools in one turn.
Budget: at most ${MAX_SEARCHES} searches and ${MAX_FETCHES} page fetches. Fetched pages are shown as relevant excerpts
only. When you have fetched enough pages, reply with the single word DONE.`;

const EXTRACT_PROMPT = `Extract sales leads and company signals from ONE web page excerpt. Use ONLY what the text states.
- people: individuals the text names with a current job title at an apparel/fashion company. Skip journalists and people
  who have left. source_excerpt must be copied verbatim from the text and contain the person's full name.
- signals: recent facts about a company (launch, expansion, hiring, markdowns, stockouts, returns, funding, leadership,
  sustainability). source_excerpt must be verbatim from the text. sentence must read naturally after "I noticed "
  (e.g. "that Acme opened its first London store in May"). summary_short is 2-6 words (e.g. "first London store").
- company.segment is a short noun like "DTC brand" or "department store". size_band is one of ${SIZE_BANDS.join(', ')}
  or null. pain_point is one of ${PAIN_POINTS.join(', ')} or null. kind is one of ${SIGNAL_KINDS.join(', ')}.
Respond with JSON only: {"people": [{"first_name", "last_name", "title", "source_excerpt", "linkedin_url",
"company": {"name", "website", "industry", "region", "size_band", "segment"}}],
"signals": [{"company_name", "kind", "pain_point", "summary_short", "sentence", "source_excerpt"}]}
Return empty arrays if the text names nobody relevant.`;

const norm = (s) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const domainOf = (url) => new URL(url).hostname.toLowerCase().replace(/^www\./, '');

/**
 * Step 1: tool-calling loop where the model searches and fetches pages. Full page text is kept here for
 * extraction and verification; the model only ever sees short excerpts, and older tool outputs are
 * compacted to one-line notes so each request stays small.
 */
async function searchPhase(llm, icp, log) {
  const pages = new Map();
  const keywords = [...new Set([...icp.titles.map((t) => t.toLowerCase()), ...ROLE_KEYWORDS])];
  // Companies we already have leads for are excluded so each run finds new ones.
  const known = (await pool.query('SELECT name, domain FROM companies ORDER BY id')).rows;
  const excludeDomains = new Set(known.map((c) => c.domain).filter(Boolean));
  const knownNote = known.length ? `\nAlready in our CRM - skip these companies: ${known.map((c) => c.name).join(', ')}.` : '';
  const messages = [
    { role: 'system', content: SEARCH_PROMPT(icp) + knownNote },
    { role: 'user', content: 'Start researching.' },
  ];
  const compactable = []; // [message, shortSummary] from earlier rounds
  let searches = 0;

  const runTool = async (call) => {
    const args = JSON.parse(call.function.arguments || '{}');
    if (call.function.name === 'web_search' && args.query) {
      if (++searches > MAX_SEARCHES) return { output: 'Search budget used up. Fetch pages or reply DONE.' };
      const results = await webSearch(args.query, { excludeDomains: [...excludeDomains] });
      log({ step: 'tool', tool: 'web_search', query: args.query, results: results.map((r) => r.url) });
      const lines = results.map((r) => `- ${r.title} | ${r.url}`);
      return {
        output: results.map((r, i) => `${lines[i]}\n  ${r.snippet}`).join('\n') || 'No results.',
        summary: `Results for "${args.query}":\n${lines.join('\n')}`,
      };
    }
    if (call.function.name === 'fetch_page' && args.url) {
      if (pages.size >= MAX_FETCHES) return { output: 'Fetch budget used up. Reply DONE.' };
      const text = await fetchPage(args.url);
      pages.set(args.url, text);
      excludeDomains.add(domainOf(args.url));
      log({ step: 'tool', tool: 'fetch_page', url: args.url, chars: text.length });
      return {
        output: relevantExcerpt(text, keywords, TOOL_EXCERPT_CHARS),
        summary: `Fetched ${args.url} (stored for extraction).`,
      };
    }
    return { output: `Unknown tool or missing arguments: ${call.function.name}` };
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const reply = await llm.chat({ messages, tools: TOOL_DEFINITIONS, maxTokens: 1000 });
    messages.push(reply);
    if (!reply.tool_calls?.length) {
      // Models tend to stop after the first good page; push for more companies while budget remains.
      if (pages.size < Math.min(MAX_FETCHES, 4) && round < MAX_TOOL_ROUNDS - 1) {
        log({ step: 'nudge', round, pagesFetched: pages.size });
        messages.push({
          role: 'user',
          content: `You have fetched only ${pages.size} page(s). Fetch pages about people at other companies ` +
            `(different from those already fetched) before replying DONE.`,
        });
        continue;
      }
      log({ step: 'search_done', round, message: reply.content?.slice(0, 200) ?? null });
      break;
    }
    for (const [message, summary] of compactable.splice(0)) message.content = summary;
    for (const call of reply.tool_calls) {
      let result;
      try {
        result = await runTool(call);
      } catch (error) {
        result = { output: `Error: ${error.message}` };
        log({ step: 'tool_error', tool: call.function.name, args: call.function.arguments, error: error.message });
      }
      const message = { role: 'tool', tool_call_id: call.id, content: result.output };
      messages.push(message);
      compactable.push([message, result.summary ?? result.output.slice(0, 200)]);
    }
  }
  return pages;
}

/** Step 2: structured extraction, one page at a time; signals are then attached to leads by company name. */
async function extractPhase(llm, pages, log) {
  const people = [];
  const signals = [];
  for (const [url, text] of pages) {
    const excerpt = relevantExcerpt(text, [...ROLE_KEYWORDS, ...SIGNAL_KEYWORDS], EXTRACT_EXCERPT_CHARS);
    try {
      const reply = await llm.chat({
        json: true,
        maxTokens: 1500,
        messages: [
          { role: 'system', content: EXTRACT_PROMPT },
          { role: 'user', content: `PAGE ${url}\n"""\n${excerpt}\n"""` },
        ],
      });
      const parsed = parseJsonObject(reply.content);
      const found = Array.isArray(parsed.people) ? parsed.people : [];
      people.push(...found.map((p) => ({ ...p, source_url: url })));
      for (const s of Array.isArray(parsed.signals) ? parsed.signals : []) {
        const ok = signalSchema.safeParse(s);
        if (ok.success) {
          const sentence = ok.data.sentence.replace(/^\s*i noticed\s+/i, '').replace(/[.!?]+$/, '');
          signals.push({ ...ok.data, sentence, source_url: url });
        }
      }
      log({ step: 'extracted', url, people: found.length, signals: parsed.signals?.length ?? 0 });
    } catch (error) {
      log({ step: 'extract_error', url, error: error.message });
    }
  }
  const sameCompany = (a, b) => norm(a).includes(norm(b)) || norm(b).includes(norm(a));
  return people.map((p) => ({
    ...p,
    signals: signals.filter((s) => p.company?.name && sameCompany(s.company_name, p.company.name)).slice(0, 3),
  }));
}

/** Programmatic verification: every lead and signal must be backed by text we actually fetched. */
export function verifyLead(lead, pages) {
  const problems = [];
  const page = pages.get(lead.source_url);
  const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ');
  if (!page) problems.push(`source_url ${lead.source_url} was never fetched`);
  else {
    if (!norm(page).includes(norm(fullName))) problems.push(`"${fullName}" does not appear on ${lead.source_url}`);
    if (!norm(page).includes(norm(lead.source_excerpt)))
      problems.push('lead source_excerpt is not verbatim from the page');
  }
  const signals = lead.signals.filter((s) => {
    const sp = pages.get(s.source_url);
    const ok = sp !== undefined && norm(sp).includes(norm(s.source_excerpt));
    if (!ok) problems.push(`signal "${s.summary_short}" dropped: excerpt not found on ${s.source_url}`);
    return ok;
  });
  const fatal = !page || problems.some((p) => !p.startsWith('signal'));
  return { lead: fatal ? null : { ...lead, signals }, problems };
}

export async function runDiscovery(icpInput) {
  const icp = icpSchema.parse(icpInput);
  const llm = getLlm();
  const missing = [!llm && 'LLM_API_KEY', !env.SEARCH_API_KEY && 'SEARCH_API_KEY'].filter(Boolean);
  if (!llm || missing.length) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', `Lead discovery needs ${missing.join(' and ')} in backend/.env`);
  }

  const runId = (await pool.query(`INSERT INTO discovery_runs (icp) VALUES ($1) RETURNING id`, [JSON.stringify(icp)]))
    .rows[0].id;
  const agentLog = [];
  const log = (e) => agentLog.push({ at: new Date().toISOString(), ...e });

  try {
    const pages = await searchPhase(llm, icp, log);
    if (!pages.size)
      throw new AppError(502, 'DISCOVERY_NO_PAGES', 'The agent did not fetch any pages; try a broader ICP');
    const raw = await extractPhase(llm, pages, log);
    log({ step: 'candidates', count: raw.length });

    const savedLeadIds = [];
    for (const candidate of raw.slice(0, icp.max_leads * 2)) {
      if (savedLeadIds.length >= icp.max_leads) break;
      const parsed = extractedLead.safeParse(candidate);
      if (!parsed.success) {
        log({
          step: 'rejected',
          reason: 'schema',
          issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
        });
        continue;
      }
      const { lead, problems } = verifyLead(parsed.data, pages);
      if (!lead) {
        log({ step: 'rejected', name: `${parsed.data.first_name} ${parsed.data.last_name ?? ''}`.trim(), problems });
        continue;
      }
      if (problems.length) log({ step: 'warning', name: lead.first_name, problems });
      try {
        const leadId = await withTransaction(async (db) => {
          const website = lead.company.website ?? null;
          const companyId = await upsertCompany(db, {
            name: lead.company.name,
            domain: website ? domainOf(website) : undefined,
            website: website ?? undefined,
            industry: lead.company.industry ?? undefined,
            region: lead.company.region ?? undefined,
            size_band: lead.company.size_band ?? undefined,
            segment: lead.company.segment ?? undefined,
            raw: { discovery_run_id: runId, extracted: candidate },
            signals: lead.signals.map((s) => ({ ...s, observed_at: null })),
          });
          return createLead(
            db,
            {
              company_id: companyId,
              discovery_run_id: runId,
              first_name: lead.first_name,
              last_name: lead.last_name ?? undefined,
              title: lead.title,
              source_url: lead.source_url,
              source_excerpt: lead.source_excerpt,
              linkedin_url: lead.linkedin_url ?? undefined,
            },
            'discovered by agent',
          );
        });
        savedLeadIds.push(leadId);
        log({
          step: 'saved',
          leadId,
          name: `${lead.first_name} ${lead.last_name ?? ''}`.trim(),
          company: lead.company.name,
        });
      } catch (error) {
        const code = error.code;
        log({ step: 'rejected', name: lead.first_name, reason: code === '23505' ? 'duplicate lead' : error.message });
      }
    }

    await pool.query(
      `UPDATE discovery_runs SET status = 'succeeded', agent_log = $2, leads_found = $3, finished_at = now() WHERE id = $1`,
      [runId, JSON.stringify(agentLog), savedLeadIds.length],
    );
    return { runId, leadIds: savedLeadIds, log: agentLog };
  } catch (error) {
    await pool.query(
      `UPDATE discovery_runs SET status = 'failed', agent_log = $2, error = $3, finished_at = now() WHERE id = $1`,
      [runId, JSON.stringify(agentLog), error.message],
    );
    throw error;
  }
}

export const discoveryRouter = Router();

discoveryRouter.post('/', async (req, res) => {
  res.status(201).json(await runDiscovery(req.body));
});

discoveryRouter.get('/', async (req, res) => {
  const page = paginationSchema.parse(req.query);
  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT id, icp, status, leads_found, error, started_at, finished_at FROM discovery_runs
        ORDER BY started_at DESC LIMIT $1 OFFSET $2`,
      [page.limit, offsetOf(page)],
    ),
    pool.query('SELECT count(*) AS n FROM discovery_runs'),
  ]);
  res.json(toPage(rows.rows, count.rows[0].n, page));
});

discoveryRouter.get('/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const run = (await pool.query('SELECT * FROM discovery_runs WHERE id = $1', [id])).rows[0];
  if (!run) throw notFound('Discovery run', id);
  res.json(run);
});
