-- ============================================================
-- Ayusomam Sinus Bot - Supabase Schema
-- Run this once in your Supabase SQL editor
-- ============================================================

-- Conversations: one row per customer per platform
CREATE TABLE IF NOT EXISTS conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform      TEXT NOT NULL,          -- whatsapp | instagram | messenger | website
  user_id       TEXT NOT NULL,          -- platform-specific user ID
  stage         TEXT NOT NULL DEFAULT 'initiated',
  sinus_type    TEXT,                   -- kaphavata_allergic | vata_dry | pitta_inflammatory | kapha_congestive | tridosha_chronic
  plan          TEXT,                   -- starter_499 | core_1299
  language      TEXT NOT NULL DEFAULT 'hinglish',
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  converted_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(platform, user_id)
);

-- Messages: full conversation history
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Buyers: converted customers
CREATE TABLE IF NOT EXISTS buyers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  platform        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  plan            TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  thank_you_sent  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Follow-ups: scheduled re-engagement messages
CREATE TABLE IF NOT EXISTS follow_ups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  scheduled_at    TIMESTAMPTZ NOT NULL,
  sent_at         TIMESTAMPTZ,
  message         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_conversations_platform_user ON conversations(platform, user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_stage ON conversations(stage);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_follow_ups_scheduled ON follow_ups(scheduled_at) WHERE sent_at IS NULL;
