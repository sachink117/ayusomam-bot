// ============================================================
// config.js - Environment variables and constants
// Variable names match the existing Render environment
// ============================================================
require("dotenv").config();

module.exports = {
  // AI
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,

  // Database - Render uses SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,

  // Meta webhook verification
  WEBHOOK_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || process.env.WEBHOOK_VERIFY_TOKEN,
  META_APP_SECRET:      process.env.META_APP_SECRET,

  // WhatsApp - Render uses WHATSAPP_ prefix
  WA_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID,
  WA_ACCESS_TOKEN:    process.env.WHATSAPP_ACCESS_TOKEN    || process.env.WA_ACCESS_TOKEN,

  // Instagram - Render uses INSTAGRAM_ prefix
  IG_ACCESS_TOKEN: process.env.INSTAGRAM_PAGE_ACCESS_TOKEN || process.env.IG_ACCESS_TOKEN,
  IG_PAGE_ID:      process.env.IG_PAGE_ID,
  IG_VERIFY_TOKEN: process.env.INSTAGRAM_VERIFY_TOKEN,

  // Facebook Messenger - Render uses MESSENGER_ prefix
  FB_PAGE_ACCESS_TOKEN: process.env.MESSENGER_PAGE_ACCESS_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN,
  FB_PAGE_ID:           process.env.FB_PAGE_ID,
  FB_VERIFY_TOKEN:      process.env.MESSENGER_VERIFY_TOKEN,

  // Notion CRM (optional) - Render uses NOTION_TOKEN / NOTION_CRM_DB
  NOTION_API_KEY:     process.env.NOTION_TOKEN       || process.env.NOTION_API_KEY,
  NOTION_DATABASE_ID: process.env.NOTION_CRM_DB      || process.env.NOTION_DATABASE_ID,

  // Payment links - Render uses PAYMENT_LINK_ prefix
  RAZORPAY_LINK_499:  process.env.PAYMENT_LINK_499  || process.env.RAZORPAY_LINK_499,
  RAZORPAY_LINK_1299: process.env.PAYMENT_LINK_1299 || process.env.RAZORPAY_LINK_1299,

  // ---- Conversation constants ----
  STAGES: ["initiated","qualifier","duration","discharge","reveal","insight","close","objection","payment_pending","converted"],
  SINUS_TYPES: ["kaphavata_allergic","vata_dry","pitta_inflammatory","kapha_congestive","tridosha_chronic"],
  PLANS: {
    starter: { id: "starter_499",  label: "7-Day Starter",  price: 499  },
    core:    { id: "core_1299",    label: "14-Day Core",     price: 1299 },
  },

  WA_BUFFER_MS:     8000,
  CLAUDE_MODEL:     "claude-sonnet-4-6",
  CLAUDE_MAX_TOKENS: 300,
  HISTORY_LIMIT:    20,
  FOLLOWUP_HOURS:   24,
};
