// ============================================================
// db.js - All Supabase database operations
// ============================================================
const { createClient } = require("@supabase/supabase-js");
const { SUPABASE_URL, SUPABASE_KEY, HISTORY_LIMIT, FOLLOWUP_HOURS } = require("./config");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- Conversations ----

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

async function createConversation(platform, userId, language = "hinglish", name = null, nameSource = null) {
  const { data, error } = await supabase
    .from("conversations")
    .insert({ platform, user_id: userId, stage: "initiated", language, name, name_source: nameSource })
    .select()
    .single();
  if (error) throw new Error("[DB] createConversation: " + error.message);
  return data;
}

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
 * Get or create conversation.
 * If name is provided (from Meta API) and the conversation is new, save it.
 * If conversation exists and we now have a Meta name but didn't before, update it.
 */
async function getOrCreateConversation(platform, userId, metaName = null) {
  const existing = await getConversation(platform, userId);
  if (existing) {
    // If we just got a Meta name and the conversation has none yet, update it
    if (metaName && !existing.name) {
      return updateConversation(existing.id, { name: metaName, name_source: "meta" });
    }
    return existing;
  }
  return createConversation(platform, userId, "hinglish", metaName, metaName ? "meta" : null);
}

/**
 * Update customer name — called when customer self-reports or corrects their name.
 * source: "self" (first time) | "corrected" (they corrected a wrong name)
 */
async function updateName(convId, name, source = "self") {
  return updateConversation(convId, { name, name_source: source });
}

// ---- Messages ----

async function logMessage(convId, role, content) {
  const { error } = await supabase
    .from("messages")
    .insert({ conversation_id: convId, role, content });
  if (error) console.error("[DB] logMessage:", error.message);
}

async function getRecentMessages(convId, limit = HISTORY_LIMIT) {
  const { data, error } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", convId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) { console.error("[DB] getRecentMessages:", error.message); return []; }
  return (data || []).reverse();
}

// ---- Follow-ups ----

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

async function logFollowUp(convId, message) {
  const { error } = await supabase
    .from("follow_ups")
    .insert({ conversation_id: convId, scheduled_at: new Date().toISOString(), message });
  if (error) console.error("[DB] logFollowUp:", error.message);
}

// ---- Buyers ----

async function createBuyer(convId, platform, userId, plan, amount, name = null) {
  const { error } = await supabase
    .from("buyers")
    .insert({ conversation_id: convId, platform, user_id: userId, plan, amount, name });
  if (error) console.error("[DB] createBuyer:", error.message);
}

async function getPendingThankYous() {
  const { data, error } = await supabase
    .from("buyers")
    .select("*")
    .eq("thank_you_sent", false);
  if (error) { console.error("[DB] getPendingThankYous:", error.message); return []; }
  return data || [];
}

async function markThankYouSent(buyerId) {
  const { error } = await supabase
    .from("buyers")
    .update({ thank_you_sent: true })
    .eq("id", buyerId);
  if (error) console.error("[DB] markThankYouSent:", error.message);
}

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
  updateName,
  logMessage,
  getRecentMessages,
  getStaleConversations,
  logFollowUp,
  createBuyer,
  getPendingThankYous,
  markThankYouSent,
  resetConversation,
};
