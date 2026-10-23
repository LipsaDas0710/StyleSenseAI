# StyleSense AI — Lead Generation & Outreach Console

A small working platform for the (fictional) StyleSense AI sales team: an LLM agent finds real apparel/fashion
leads from public web pages, outreach is generated from the Appendix A template using only stored, source-cited
facts, opens and unsubscribes are tracked, simulated replies are classified and answered with a human-approved
draft, and every lead carries a 0–100 score that is recomputed from its raw event history.

| Layer | Choice |
|---|---|
| Frontend | React 19 + Vite, plain JavaScript and CSS (no UI framework) |
| Backend | Node.js 24 + Express 5, plain JavaScript (ES modules), Zod validation |
| Database | PostgreSQL (developed against Neon serverless Postgres 18) via `pg` |
| Email | Provider interface: `log` (development) and Resend (HTTP API) |
| LLM | Any OpenAI-compatible chat API; developed with Groq `openai/gpt-oss-120b` (free tier) |
| Search | Tavily search API (free tier) |
| Tests | Vitest + Supertest |

A single-language (JavaScript) backend keeps one toolchain, one validation library and one test runner across the
API, the scoring engine and the agent; nothing in scope needed Python.

---

## Running it (Windows / PowerShell)

Prerequisites: Node.js 22+ (developed on 24; JSON import attributes are used) and a PostgreSQL database — local, or a free hosted one such as
[Neon](https://neon.tech). The API tests need a **second, empty** database because they truncate tables.

```powershell
# 1. Backend
cd backend
npm install
Copy-Item .env.example .env      # then edit .env: DATABASE_URL, TEST_DATABASE_URL, optional API keys
npm run migrate                  # applies db/migrations/*.sql in order
npm run dev                      # API on http://localhost:5000

# 2. Frontend (second terminal)
cd frontend
npm install
npm run dev                      # console on http://localhost:5173 (proxies /api, /t, /u to :5000)
```

| Command (in `backend/`) | What it does |
|---|---|
| `npm test` | Scoring + grounding unit tests and API tests (API tests skip if `TEST_DATABASE_URL` is unset) |
| `npm run eval` | Reply-classification accuracy on the labelled set (LLM if `LLM_API_KEY` is set, else keyword rules) |
| `npm run eval -- keyword` | Same, forcing the keyword classifier |
| `npm run samples -- <campaignId>` | Regenerates `samples/generated-emails.md` from the real renderer |

### Environment variables (`backend/.env`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` / `TEST_DATABASE_URL` | App and test databases (hosted: append `?sslmode=verify-full`) |
| `PUBLIC_BASE_URL` | Base URL written into tracking-pixel and unsubscribe links |
| `EMAIL_PROVIDER` | `log` (prints the email, nothing leaves the machine) or `resend` |
| `EMAIL_TEST_RECIPIENT` | When set, **every** email is redirected here. Required for real providers, so no real prospect is ever emailed |
| `RESEND_API_KEY`, `EMAIL_FROM` | Resend credentials (sandbox sender `onboarding@resend.dev` only delivers to your own account address) |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_REASONING_EFFORT` | OpenAI-compatible LLM; blank key = AI features degrade (see below) |
| `SEARCH_API_KEY` | Tavily key for lead discovery |

Without an LLM/search key the app still runs end to end: discovery returns `503 AI_NOT_CONFIGURED` (it never
fabricates leads — add researched leads with the manual form instead), and reply classification falls back to a
clearly labelled keyword classifier.

---

## Demo lifecycle (what the recording shows)

1. **Find leads** tab → enter an ICP → the agent searches, fetches pages and saves verified leads with source URLs.
2. **Campaigns** tab → create a campaign (sender, subject variant, optional time window).
3. Click a lead → **Add to campaign** → **Preview & send** shows the filled template, where every token came from,
   and any grounding-check firings → **Send email**.
4. **Simulate open** loads the real tracking pixel (`/t/o/<token>.gif`) → status becomes *opened*, score rises, the
   reason appears under “Why it changed”, and the lead moves up the ranked list (the list polls every 5 s).
5. **Simulate reply** → intent + rationale + editable draft → **Approve & send** (nothing is sent without approval).
6. The **Unsubscribe link** suppresses the address; the lead drops to score 0 and any later send is refused server-side.

---

## Architecture

```
frontend (React)  ──/api──▶  Express app ──▶ modules/<area>  ──▶ PostgreSQL
                                 │              leads, companies, campaigns, events,
mail client ──/t/o, /u──────────▶│              scoring, email (template, grounding,
                                 │              providers, tracking), ai (llm, tools,
                                 │              discovery, classifier, replies)
                                 └─▶ Groq (LLM) · Tavily (search) · Resend (email)
```

`backend/src/modules/*` each own their routes and SQL; cross-cutting pieces live in `src/http` (error model,
validation, pagination), `src/db` (pool, transactions, migration runner) and `src/config` (env, scoring weights).

### Data model

Raw facts and derived state are kept apart: **`email_events` is append-only** and `lead_scores` / `leads.status`
can always be rebuilt from it (`POST /api/leads/:id/recalculate-score`, covered by a test).

| Table | Role | Key constraints |
|---|---|---|
| `companies` | Target organisations | `domain` unique & lower-case; `size_band` enum |
| `company_signals` | Researched, **source-cited** facts — the only material outreach may quote | `source_url` and verbatim `source_excerpt` required; unique per (company, source, summary) |
| `leads` | People | FK → companies (cascade); `source_url` required; email unique & normalised, nullable (never guessed); one person per company (case-insensitive); `status` enum, derived |
| `campaigns` | Outreach configuration | unique name; `subject_variant` 1–3; status enum |
| `campaign_leads` | Enrolment (M:N) | composite PK |
| `email_messages` | Every email actually sent | composite FK → `campaign_leads`; unique tracking token; **at most one outreach per lead per campaign** (partial unique index, also prevents concurrent double sends) |
| `email_events` | Raw delivered / opened / replied / unsubscribed events | type enum; JSONB payload; `dedupe_key` unique for idempotency |
| `lead_scores` | Current derived score | 1:1 with leads; 0–100 checks |
| `score_history` | Every score change with a human-readable reason | FK → triggering event (nullable for initial/manual) |
| `suppression_list` | Opted-out addresses | lower-case PK; reason enum |
| `grounding_logs` | Every time the grounding check drops a sentence or blocks a send | FK → lead/campaign |
| `discovery_runs` | Agent runs with ICP and step-by-step JSONB agent log | status/finished_at consistency check |
| `reply_drafts` | Classified reply + draft awaiting approval | 1:1 with the `replied` event; intent enum; decided_at ⇔ decided status |

### API

All JSON; list endpoints take `page`/`limit` (max 100) and return `{ data, pagination }`. Errors always have the
shape `{ "error": { "code", "message", "details?" } }` — e.g. `400 VALIDATION_ERROR` (with per-field details),
`400 INVALID_JSON`, `404 NOT_FOUND`, `409 CONFLICT` (unique violation), `409 CAMPAIGN_NOT_ACTIVE`,
`409 DRAFT_NOT_PENDING`, `502 EMAIL_PROVIDER_ERROR`, `503 AI_NOT_CONFIGURED`, `503 AI_RATE_LIMITED`.

| Method & path | Purpose |
|---|---|
| `GET /api/health` | API + DB check |
| `GET /api/leads?status=&q=&minScore=&campaignId=` | Ranked lead list (score desc) |
| `GET/PATCH/DELETE /api/leads/:id`, `POST /api/leads` | Lead CRUD (`POST` can create the company inline; status/score are not writable) |
| `GET /api/leads/:id/events`, `GET /api/leads/:id/score-history` | Raw events, score changes with reasons |
| `POST /api/leads/:id/recalculate-score` | Rebuild derived state from events |
| `GET/POST /api/companies`, `GET /api/companies/:id`, `POST /api/companies/:id/signals` | Companies and cited signals |
| `GET/POST /api/campaigns`, `GET/PATCH /api/campaigns/:id`, `POST /api/campaigns/:id/leads` | Campaigns and enrolment |
| `GET /api/campaigns/:id/leads/:leadId/preview` | Rendered email + token sources + grounding log |
| `POST /api/campaigns/:id/send` | Send to all unsent (or given) leads; per-lead outcome |
| `POST /api/events`, `GET/POST /api/suppressions` | Raw events (e.g. webhooks), suppression list |
| `POST /api/leads/:id/replies` | Simulated inbound reply → classify + draft |
| `POST /api/reply-drafts/:id/approve` \| `/discard` | Human decision on a draft |
| `POST /api/discovery/runs`, `GET /api/discovery/runs[/:id]` | Run / inspect the discovery agent |
| `GET /t/o/:token.gif`, `GET\|POST /u/:token` | Public tracking pixel and unsubscribe (GET link + RFC 8058 one-click POST) |

---

## Lead scoring

`total = round(0.6 × fit + 0.4 × engagement)`, each component clamped to 0–100. All weights live in
[`backend/src/config/scoring.json`](backend/src/config/scoring.json); the logic is a pure function in
`modules/scoring/scoring.js`.

| Fit (max 100) | Points |
|---|---|
| Apparel/fashion industry or segment | 30 |
| Target region | 15 |
| Company size 1–50 / 51–200 / 201–1000 / 1001–5000 / 5000+ | 5 / 15 / 25 / 25 / 15 |
| Title: senior **and** relevant function (merchandising, planning, supply chain, inventory, buying…) | 30 (relevant only 18, senior only 10) |

| Engagement (clamped 0–100) | Points |
|---|---|
| Delivered | 5 |
| First open / each repeat open (max 2 repeats) | 30 / 5 |
| Replied | 40 |
| Latest reply intent: interested / needs info / not now / wrong person | +25 / +15 / 0 / −40 |

Design decisions: repeat opens are capped because pixels are noisy (image proxies, reloads); only the **latest**
reply's intent counts; **unsubscribe (link or reply) suppresses the lead and forces the total to 0** instead of being
a negative weight. Every recompute that changes the score writes `score_history` with a reason such as
`opened event: 62 -> 74 (+12); engagement 5 -> 35`.

---

## Email, tracking & compliance

- **Template:** Appendix A's locked copy lives only in `modules/email/template.js`; greeting, sign-off, product
  name and sentence order are fixed. Optional tokens are omitted cleanly (no sourced outcome figures or proof points
  are stored, so `quantified_outcome_optional` and the P.S. are always omitted).
- **Open tracking:** each send gets a random 48-hex-character token; the pixel endpoint always returns a 1×1 GIF and
  records an `opened` event (with timestamp) for known tokens. Opens are inherently approximate (Apple Mail Privacy
  Protection, image proxies), which is why scoring caps them.
- **Unsubscribe & suppression:** every email carries an unsubscribe link and a `List-Unsubscribe` /
  `List-Unsubscribe-Post` header. Unsubscribing (or replying with an opt-out) records an `unsubscribed` event and adds
  the address to `suppression_list`; `send` checks suppression on the server for every lead, so the UI cannot bypass it.
- **Safety:** with any real provider, `EMAIL_TEST_RECIPIENT` is mandatory and all mail is redirected to it — the demo
  never emails a real prospect.
- **GDPR / CAN-SPAM:** cold B2B outreach must have a lawful basis (in the EU/UK usually documented legitimate
  interest), identify the sender honestly, avoid misleading subjects, include a working opt-out that is honoured
  promptly and permanently, and include a postal address — this build implements the opt-out, suppression and honest
  sender pieces, but it is not legal advice and does not by itself make a campaign compliant.

---

## AI agent component

**Lead discovery** (`modules/ai/discovery.js`) is a two-step search-then-extract flow using function calling:

1. **Search:** the LLM gets `web_search` (Tavily) and `fetch_page` tools plus the ICP, and decides what to search
   and fetch (budget: 5 searches, 6 fetches, 10 rounds). Companies already in the CRM are excluded from searches.
   To fit the free tier (Groq ~8k tokens/min), the model only sees keyword-centred excerpts of pages, older tool
   outputs are compacted to one-line notes, and `429`s are retried after the wait the provider asks for.
2. **Extract:** one JSON-mode call per fetched page returns people and company signals; signals are attached to
   people by company name.
3. **Verify (programmatic, not LLM):** a lead is saved only if its `source_url` was actually fetched, the person's
   full name appears in that page's text, and the quoted excerpt is verbatim from it; signals need a verbatim excerpt
   too. Rejections are recorded in the run's agent log. Emails are never guessed — leads are saved without one.

In testing, three runs saved 9 real leads across Lulus, Nordstrom, Famous Footwear and QVC Group; the verifier
rejected one person whose excerpt was not verbatim from the page.

**Grounding check** (`modules/email/grounding.js`) — what it actually validates, per token:
- the value comes from an allowed provenance: a stored lead/company/campaign field, a stored company signal that has
  a source URL, or StyleSense's own fixed product copy (the pain-point → capability map);
- every *hard claim* in it — numbers, percentages, currency and superlatives such as “largest”, “#1”, “leading” — also
  appears in that provenance's stored source excerpt (product copy may contain none at all);
- the value has no markup, URLs or line breaks.

When a token fails, its sentence is dropped (per Appendix A), the event is written to `grounding_logs` and the
console shows it; if no subject line or fewer than two body sentences survive, the send is blocked. When a signal
has no researched pain point, the pitched capability is inferred from the signal type (e.g. store expansion →
inventory allocation) and labelled as inferred in the token sources; the email phrases it as a hypothesis ("could").
It does **not** semantically fact-check free text beyond those rules. LLM-drafted replies go through the same
hard-claim check and fall back to a template draft if it fires.

**Reply classification** (`modules/ai/classifier.js`): five intents (interested, needs info, not now, wrong
person, unsubscribe) in JSON mode, schema-validated; an unsubscribe intent suppresses the address and produces no
draft. Drafts are stored as `pending` and are only sent after **Approve & send**.

**Accuracy** on the 8 hand-labelled replies in `backend/eval/labelled-replies.json` (covering all five intents):

| Classifier | Accuracy |
|---|---|
| LLM — Groq `openai/gpt-oss-120b` | **8 / 8 = 100%** |
| Keyword fallback | 7 / 8 = 87.5% (misses an indirect "wrong person") |

Eight examples is a smoke test, not a benchmark; the keyword rules were written before the set and were not tuned to it.

Sample emails generated from real research: [`samples/generated-emails.md`](samples/generated-emails.md).

---

## Decisions, limitations and what I'd build next

- **Authentication:** the brief conflicts (§3.1 asks for auth; §4 says assume a single user, no login). Within the
  time box I followed §4 and built a single-user console with no login. Next: JWT access + rotating refresh tokens
  (hashed refresh tokens in a `sessions` table) as Express middleware on `/api/*`, leaving `/t` and `/u` public.
- **Synchronous calls:** discovery runs inside the HTTP request (≈1–3 minutes on the free tier). Next: a job
  queue (e.g. pg-boss on the same Postgres) with run status polling.
- **Inbound email & bounces:** replies are simulated; next is Resend/SendGrid inbound + event webhooks posting to
  `POST /api/events` (already idempotent via `dedupe_key`).
- **Discovery quality:** the agent favours press releases about appointments; next steps are a judge step that
  scores candidates against the ICP before saving, and fetching company pages for size/segment.
- **Follow-ups & click tracking:** not built; the event model already supports adding `clicked` and a rule such as
  "no open after N days → resend".
- Opens from privacy proxies are not filtered; LinkedIn is never scraped.
