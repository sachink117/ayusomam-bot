-- ============================================================
-- Ayusomam Sinus Bot - Full Schema v2
-- ============================================================

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  name            TEXT,
  name_source     TEXT,              -- meta | self | corrected
  stage           TEXT NOT NULL DEFAULT 'initiated',
  sinus_type      TEXT,
  plan            TEXT,
  language        TEXT NOT NULL DEFAULT 'hinglish',
  message_count   INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  converted_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(platform, user_id)
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lead profiles: structured clinical data extracted from conversation
CREATE TABLE IF NOT EXISTS lead_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE UNIQUE,
  symptoms        TEXT[],            -- array: ['sneezing','watery discharge','morning worse']
  duration_text   TEXT,              -- raw: "3 saal se"
  duration_months INTEGER,           -- parsed: 36
  discharge_type  TEXT,              -- clear | yellow | green | thick | dry | none
  triggers        TEXT[],            -- ['cold weather','AC','dust','season change']
  highlights      TEXT[],            -- clinical flags: ['DNS','polyp','surgery history','failed antibiotics']
  previous_treatments TEXT[],        -- ['antihistamines','nasal spray','steam']
  severity        TEXT,              -- mild | moderate | severe
  notes           TEXT,              -- free-text from agent analysis
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Funnel events: every stage transition is logged here
CREATE TABLE IF NOT EXISTS funnel_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,
  from_stage      TEXT,
  to_stage        TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Objections: each unique objection captured during close/objection stage
CREATE TABLE IF NOT EXISTS objections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  objection_text  TEXT NOT NULL,
  stage           TEXT NOT NULL,
  resolved        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Daily insights: output from InsightsAgent and FunnelAgent
CREATE TABLE IF NOT EXISTS daily_insights (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date     DATE NOT NULL UNIQUE,
  funnel_summary  JSONB,             -- stage counts, drop-offs, biggest leak
  top_objections  JSONB,             -- [{text, count}]
  sinus_type_mix  JSONB,             -- {kaphavata:40, vata:20, ...}
  language_mix    JSONB,             -- {hinglish:60, hindi:30, english:10}
  conversion_rate NUMERIC(5,2),
  suggestions     JSONB,             -- [{priority, area, suggestion, action}]
  raw_analysis    TEXT,              -- full Claude analysis text
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Buyers
CREATE TABLE IF NOT EXISTS buyers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  platform        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  name            TEXT,
  plan            TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  thank_you_sent  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Follow-ups
CREATE TABLE IF NOT EXISTS follow_ups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  scheduled_at    TIMESTAMPTZ NOT NULL,
  sent_at         TIMESTAMPTZ,
  message         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_conversations_platform_user   ON conversations(platform, user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_stage           ON conversations(stage);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message    ON conversations(last_message_at);
CREATE INDEX IF NOT EXISTS idx_conversations_name            ON conversations(name);
CREATE INDEX IF NOT EXISTS idx_messages_conversation         ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_funnel_events_stage           ON funnel_events(to_stage, created_at);
CREATE INDEX IF NOT EXISTS idx_funnel_events_conv            ON funnel_events(conversation_id);
CREATE INDEX IF NOT EXISTS idx_objections_text               ON objections(created_at);
CREATE INDEX IF NOT EXISTS idx_daily_insights_date           ON daily_insights(report_date);
CREATE INDEX IF NOT EXISTS idx_follow_ups_scheduled          ON follow_ups(scheduled_at) WHERE sent_at IS NULL;

-- ============================================================
-- Migration (run if tables already exist)
-- ============================================================
-- ALTER TABLE conversations ADD COLUMN IF NOT EXISTS name TEXT;
-- ALTER TABLE conversations ADD COLUMN IF NOT EXISTS name_source TEXT;
-- ALTER TABLE buyers       ADD COLUMN IF NOT EXISTS name TEXT;
-- CREATE TABLE IF NOT EXISTS lead_profiles (...);  (see above)
-- CREATE TABLE IF NOT EXISTS funnel_events (...);
-- CREATE TABLE IF NOT EXISTS objections (...);
-- CREATE TABLE IF NOT EXISTS daily_insights (...);
