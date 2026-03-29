// ============================================================
// db.js - All Supabase database operations
// Single place for DB logic - change here, affects all platforms
// ============================================================
const { createClient } = require("@supabase/supabase-js");
const { SUPABASE_URL, SUPABASE_KEY, HISTORY_LIMIT, FOLLOWUP_HOURS } = require("./config");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- Conversations ----

/**
 * Get existing conversation or return null
 */
async function getConversation(platform, userId) {
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("platform", platform)
    .eq("user_id", userId)
    .single();
  if (error && error.code !== "PGRST116") console.error("[DB] getConversation:", error.message);
  return data || null;
}

/**
 * Create a new conversation row
 */
async function createConversation(platform, userId, language = "hinglish") {
  const { data, error } = await supabase
    .from("conversations")
    .insert({ platform, user_id: userId, stage: "initiated", language })
    .select()
    .single();
  if (error) throw new Error("[DB] createConversation: " + error.message);
  return data;
}

/**
 * Update any fields on a conversation
 * Usage: await updateConversation(conv.id, { stage: "reveal", sinus_type: "vata_dry" })
 */
async function updateConversation(convId, fields) {
  fields.last_message_at = new Date().toISOString();
  const { data, error } = await supabase
    .from("conversations")
    .update(fields)
    .eq("id", convId)
    .select()
    .single();
  if (error) throw new Error("[DB] updateConversation: " + error.message);
  return data;
}

/**
 * Get or create conversation — the main entry point used by bot.js
 */
async function getOrCreateConversation(platform, userId) {
  const existing = await getConversation(platform, userId);
  if (existing) return existing;
  return createConversation(platform, userId);
}

// ---- Messages ----

/**
 * Log a single message (user or assistant) to the messages table
 */
async function logMessage(convId, role, content) {
  const { error } = await supabase
    .from("messages")
    .insert({ conversation_id: convId, role, content });
  if (error) console.error("[DB] logMessage:", error.message);
}

/**
 * Fetch the last N messages for a conversation (chronological order)
 */
async function getRecentMessages(convId, limit = HISTORY_LIMIT) {
  const { data, error } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", convId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) { console.error("[DB] getRecentMessages:", error.message); return []; }
  return (data || []).reverse(); // return oldest-first
}

// ---- Follow-ups ----

/**
 * Get conversations that have gone silent for FOLLOWUP_HOURS and have no pending follow-up
 */
async function getStaleConversations() {
  const cutoff = new Date(Date.now() - FOLLOWUP_HOURS * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .lt("last_message_at", cutoff)
    .not("stage", "in", '("converted","initiated")')
    .is("converted_at", null);
  if (error) { console.error("[DB] getStaleConversations:", error.message); return []; }
  return data || [];
}

/**
 * Record that a follow-up was sent
 */
async function logFollowUp(convId, message) {
  const { error } = await supabase
    .from("follow_ups")
    .insert({ conversation_id: convId, scheduled_at: new Date().toISOString(), message });
  if (error) console.error("[DB] logFollowUp:", error.message);
}

// ---- Buyers ----

/**
 * Create a buyer record when a customer converts
 */
async function createBuyer(convId, platform, userId, plan, amount) {
  const { error } = await supabase
    .from("buyers")
    .insert({ conversation_id: convId, platform, user_id: userId, plan, amount });
  if (error) console.error("[DB] createBuyer:", error.message);
}

/**
 * Get buyers who haven't received a thank-you message yet
 */
async function getPendingThankYous() {
  const { data, error } = await supabase
    .from("buyers")
    .select("*")
    .eq("thank_you_sent", false);
  if (error) { console.error("[DB] getPendingThankYous:", error.message); return []; }
  return data || [];
}

/**
 * Mark a buyer's thank-you as sent
 */
async function markThankYouSent(buyerId) {
  const { error } = await supabase
    .from("buyers")
    .update({ thank_you_sent: true })
    .eq("id", buyerId);
  if (error) console.error("[DB] markThankYouSent:", error.message);
}

/**
 * Reset a conversation back to initiated (used when customer sends restart keyword)
 */
async function resetConversation(convId) {
  return updateConversation(convId, {
    stage: "initiated",
    sinus_type: null,
    plan: null,
    message_count: 0,
  });
}

module.exports = {
  getOrCreateConversation,
  updateConversation,
  logMessage,
  getRecentMessages,
  getStaleConversations,
  logFollowUp,
  createBuyer,
  getPendingThankYous,
  markThankYouSent,
  resetConversation,
};
