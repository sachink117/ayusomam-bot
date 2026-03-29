// ============================================================
// config.js - Environment variables and constants
// All values come from Render environment at runtime
// ============================================================
require("dotenv").config();

module.exports = {
  // AI
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,

  // Database
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,

  // Meta webhook verification
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN,
  META_APP_SECRET: process.env.META_APP_SECRET,

  // WhatsApp
  WA_PHONE_NUMBER_ID: process.env.WA_PHONE_NUMBER_ID,
  WA_ACCESS_TOKEN: process.env.WA_ACCESS_TOKEN,

  // Instagram
  IG_ACCESS_TOKEN: process.env.IG_ACCESS_TOKEN,
  IG_PAGE_ID: process.env.IG_PAGE_ID,

  // Facebook Messenger
  FB_PAGE_ACCESS_TOKEN: process.env.FB_PAGE_ACCESS_TOKEN,
  FB_PAGE_ID: process.env.FB_PAGE_ID,

  // Notion CRM (optional)
  NOTION_API_KEY: process.env.NOTION_API_KEY,
  NOTION_DATABASE_ID: process.env.NOTION_DATABASE_ID,

  // Email alerts
  ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,

  // ---- Conversation constants ----

  // Valid conversation stages in order
  STAGES: ["initiated", "qualifier", "duration", "discharge", "reveal", "insight", "close", "objection", "converted"],

  // Sinus types detected during qualifier stage
  SINUS_TYPES: ["kaphavata_allergic", "vata_dry", "pitta_inflammatory", "kapha_congestive", "tridosha_chronic"],

  // Treatment plans
  PLANS: {
    starter: { id: "starter_499",  label: "7-Day Starter",  price: 499  },
    core:    { id: "core_1299",    label: "14-Day Core",     price: 1299 },
  },

  // WhatsApp message buffering window (ms)
  // Waits this long after the last message before processing, to combine split messages
  WA_BUFFER_MS: 8000,

  // Claude model to use
  CLAUDE_MODEL: "claude-sonnet-4-6",
  CLAUDE_MAX_TOKENS: 300,

  // How many recent messages to send to Claude
  HISTORY_LIMIT: 20,

  // Hours of silence before a follow-up is sent
  FOLLOWUP_HOURS: 24,
};
