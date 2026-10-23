-- StyleSense AI initial schema.
-- Raw facts (companies, leads, signals, email_events) are kept separate from derived state
-- (lead_scores, leads.status), which is always recomputable from email_events.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- discovery
CREATE TABLE discovery_runs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  icp          JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  agent_log    JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(agent_log) = 'array'),
  leads_found  INTEGER NOT NULL DEFAULT 0 CHECK (leads_found >= 0),
  error        TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  CHECK ((status = 'running') = (finished_at IS NULL))
);

-- ---------------------------------------------------------------- companies
CREATE TABLE companies (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL CHECK (btrim(name) <> ''),
  domain      TEXT UNIQUE CHECK (domain = lower(domain) AND domain !~ '^https?://'),
  website     TEXT,
  industry    TEXT,
  region      TEXT,
  size_band   TEXT CHECK (size_band IN ('1-50', '51-200', '201-1000', '1001-5000', '5000+')),
  segment     TEXT,            -- e.g. "DTC brand", "retailer"; fills {{company_segment}}
  raw         JSONB NOT NULL DEFAULT '{}',  -- raw scraped/extracted payload
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER companies_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Researched, source-cited facts about a company. The only material outreach may quote.
CREATE TABLE company_signals (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      BIGINT NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('launch', 'expansion', 'hiring', 'markdowns', 'stockouts',
                                                'returns', 'funding', 'leadership', 'sustainability', 'other')),
  pain_point      TEXT CHECK (pain_point IN ('overstock', 'returns', 'slow_trends', 'stockouts')),
  summary_short   TEXT NOT NULL CHECK (char_length(summary_short) BETWEEN 3 AND 60),   -- {{observed_signal_short}}
  sentence        TEXT NOT NULL CHECK (char_length(sentence) BETWEEN 10 AND 300),     -- {{observed_signal_sentence}}
  source_url      TEXT NOT NULL CHECK (source_url ~ '^https?://'),
  source_excerpt  TEXT NOT NULL CHECK (btrim(source_excerpt) <> ''),  -- verbatim text the claim rests on
  observed_at     DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX company_signals_company_idx ON company_signals (company_id);

-- ---------------------------------------------------------------- leads
CREATE TABLE leads (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id        BIGINT NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  discovery_run_id  BIGINT REFERENCES discovery_runs (id) ON DELETE SET NULL,
  first_name        TEXT NOT NULL CHECK (btrim(first_name) <> ''),
  last_name         TEXT,
  title             TEXT NOT NULL CHECK (btrim(title) <> ''),
  email             TEXT UNIQUE CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  linkedin_url      TEXT CHECK (linkedin_url ~ '^https?://'),
  source_url        TEXT NOT NULL CHECK (source_url ~ '^https?://'),
  source_excerpt    TEXT,
  -- Derived from email_events by the scoring service; never written directly by API clients.
  status            TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'sent', 'opened', 'replied', 'suppressed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One person per company (case-insensitive).
CREATE UNIQUE INDEX leads_person_unique ON leads (company_id, lower(first_name), lower(coalesce(last_name, '')));
CREATE INDEX leads_company_idx ON leads (company_id);
CREATE INDEX leads_status_idx ON leads (status);
CREATE TRIGGER leads_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- campaigns
CREATE TABLE campaigns (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  icp                   JSONB NOT NULL DEFAULT '{}',
  subject_variant       SMALLINT NOT NULL DEFAULT 1 CHECK (subject_variant BETWEEN 1 AND 3),
  sender_name           TEXT NOT NULL CHECK (btrim(sender_name) <> ''),
  proposed_time_window  TEXT,      -- optional {{proposed_time_window}}, e.g. "next Tuesday or Wednesday"
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER campaigns_updated_at BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE campaign_leads (
  campaign_id  BIGINT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  lead_id      BIGINT NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, lead_id)
);
CREATE INDEX campaign_leads_lead_idx ON campaign_leads (lead_id);

-- ---------------------------------------------------------------- email
CREATE TABLE email_messages (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id              BIGINT NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  campaign_id          BIGINT REFERENCES campaigns (id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('outreach', 'reply')),
  to_email             TEXT NOT NULL,      -- the lead's address
  delivered_to         TEXT NOT NULL,      -- actual recipient (test inbox redirect in development)
  subject              TEXT NOT NULL,
  body_text            TEXT NOT NULL,
  body_html            TEXT NOT NULL,
  tracking_token       TEXT NOT NULL UNIQUE CHECK (char_length(tracking_token) >= 32),
  provider             TEXT NOT NULL,
  provider_message_id  TEXT,
  grounding            JSONB NOT NULL DEFAULT '{}',
  sent_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Outreach always belongs to a campaign the lead is enrolled in.
  CHECK (kind = 'reply' OR campaign_id IS NOT NULL),
  FOREIGN KEY (campaign_id, lead_id) REFERENCES campaign_leads (campaign_id, lead_id) ON DELETE CASCADE
);
-- A lead receives at most one outreach email per campaign.
CREATE UNIQUE INDEX email_messages_one_outreach ON email_messages (campaign_id, lead_id) WHERE kind = 'outreach';
CREATE INDEX email_messages_lead_idx ON email_messages (lead_id);

-- Append-only raw event log. Scores are derived from this table.
CREATE TABLE email_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id      BIGINT NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  message_id   BIGINT REFERENCES email_messages (id) ON DELETE SET NULL,
  type         TEXT NOT NULL CHECK (type IN ('delivered', 'opened', 'replied', 'unsubscribed')),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload      JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  dedupe_key   TEXT UNIQUE,       -- idempotency for provider/webhook re-deliveries
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_events_lead_idx ON email_events (lead_id, occurred_at);
CREATE INDEX email_events_message_idx ON email_events (message_id);

CREATE TABLE suppression_list (
  email            TEXT PRIMARY KEY CHECK (email = lower(email)),
  reason           TEXT NOT NULL CHECK (reason IN ('unsubscribe_link', 'reply_unsubscribe', 'manual')),
  source_event_id  BIGINT REFERENCES email_events (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every time the grounding check blocks or drops a token.
CREATE TABLE grounding_logs (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id          BIGINT NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  campaign_id      BIGINT REFERENCES campaigns (id) ON DELETE SET NULL,
  token            TEXT NOT NULL,
  attempted_value  TEXT,
  rule             TEXT NOT NULL,
  action           TEXT NOT NULL CHECK (action IN ('dropped_sentence', 'omitted_optional', 'blocked_send')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX grounding_logs_lead_idx ON grounding_logs (lead_id);

-- ---------------------------------------------------------------- derived scoring state
CREATE TABLE lead_scores (
  lead_id      BIGINT PRIMARY KEY REFERENCES leads (id) ON DELETE CASCADE,
  fit          SMALLINT NOT NULL CHECK (fit BETWEEN 0 AND 100),
  engagement   SMALLINT NOT NULL CHECK (engagement BETWEEN 0 AND 100),
  total        SMALLINT NOT NULL CHECK (total BETWEEN 0 AND 100),
  breakdown    JSONB NOT NULL DEFAULT '[]',
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lead_scores_total_idx ON lead_scores (total DESC);

CREATE TABLE score_history (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id         BIGINT NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  event_id        BIGINT REFERENCES email_events (id) ON DELETE SET NULL,  -- NULL = initial / manual recompute
  previous_total  SMALLINT CHECK (previous_total BETWEEN 0 AND 100),
  new_total       SMALLINT NOT NULL CHECK (new_total BETWEEN 0 AND 100),
  fit             SMALLINT NOT NULL CHECK (fit BETWEEN 0 AND 100),
  engagement      SMALLINT NOT NULL CHECK (engagement BETWEEN 0 AND 100),
  reason          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX score_history_lead_idx ON score_history (lead_id, created_at);

-- ---------------------------------------------------------------- replies
CREATE TABLE reply_drafts (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id         BIGINT NOT NULL UNIQUE REFERENCES email_events (id) ON DELETE CASCADE,  -- the 'replied' event
  lead_id          BIGINT NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  intent           TEXT NOT NULL CHECK (intent IN ('interested', 'needs_info', 'not_now', 'wrong_person', 'unsubscribe')),
  classifier       TEXT NOT NULL CHECK (classifier IN ('llm', 'keyword')),
  rationale        TEXT NOT NULL,
  draft_body       TEXT,          -- NULL for unsubscribe: we never reply to an opt-out
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'discarded', 'not_applicable')),
  sent_message_id  BIGINT REFERENCES email_messages (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at       TIMESTAMPTZ,
  CHECK ((status IN ('pending', 'not_applicable')) = (decided_at IS NULL)),
  CHECK (draft_body IS NOT NULL OR status = 'not_applicable')
);
CREATE INDEX reply_drafts_lead_idx ON reply_drafts (lead_id);
