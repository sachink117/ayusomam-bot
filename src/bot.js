// ============================================================
// bot.js - Core bot engine
// ALL platforms call processMessage() from here.
// Fix a bug here → fixed on WhatsApp + Instagram + Messenger + Website simultaneously.
// ============================================================
const Anthropic = require("@anthropic-ai/sdk");
const { ANTHROPIC_API_KEY, CLAUDE_MODEL, CLAUDE_MAX_TOKENS, STAGES } = require("./config");
const { getOrCreateConversation, updateConversation, logMessage, getRecentMessages, resetConversation } = require("./db");
const { getSystemPrompt } = require("./prompt");
const { crmUpsertLead, crmMarkConverted } = require("./notion");

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Keywords that restart the conversation
const RESTART_KEYWORDS = ["restart", "reset", "start over", "shuru", "naya", "dobara"];

// Keywords that indicate purchase intent (trigger converted stage)
const BUY_KEYWORDS = ["haan", "ha", "yes", "buy", "kharid", "order", "ready", "le lo", "bhejo", "send", "payment"];

// ---- Language Detection ----

/**
 * Detect language from message text.
 * Priority: Devanagari script → hindi, hinglish keywords → hinglish, else english
 */
function detectLanguage(text) {
  if (/[\u0900-\u097F]/.test(text)) return "hindi";
  const hinglishWords = ["hai", "hain", "mera", "meri", "aap", "kya", "nahi", "nai", "bhi", "ke", "ka", "ki", "se", "aur", "lekin", "bohot", "bahut"];
  const lower = text.toLowerCase();
  if (hinglishWords.some(w => lower.includes(w))) return "hinglish";
  return "english";
}

// ---- State Machine ----

/**
 * Advance the conversation stage based on the current stage and user message.
 * Returns the new stage (or same stage if no transition needed).
 */
function getNextStage(currentStage, userMessage) {
  const lower = userMessage.toLowerCase();

  // Check for restart
  if (RESTART_KEYWORDS.some(k => lower.includes(k))) return "initiated";

  // Check for buy intent at close/objection stages
  if (["close", "objection"].includes(currentStage) && BUY_KEYWORDS.some(k => lower.includes(k))) {
    return "converted";
  }

  // Linear flow through early stages
  const flow = {
    "initiated":  "qualifier",
    "qualifier":  "duration",
    "duration":   "discharge",
    "discharge":  "reveal",
    "reveal":     "insight",
    "insight":    "close",
    "close":      "objection",   // if no buy detected above
    "objection":  "close",       // loop back to close
    "converted":  "converted",   // stay converted
  };

  return flow[currentStage] || currentStage;
}

/**
 * Determine sinus type from conversation history.
 * Simple keyword matching — Claude handles the nuanced detection via prompting.
 * This is a fallback for structured data storage.
 */
function detectSinusType(messages) {
  const text = messages.map(m => m.content).join(" ").toLowerCase();

  if (text.match(/sneezing|allerg|season|watery|morning worse/)) return "kaphavata_allergic";
  if (text.match(/dry|no discharge|one.?sided|wind/))             return "vata_dry";
  if (text.match(/yellow|green|thick.*discharge|facial pain|fever/)) return "pitta_inflammatory";
  if (text.match(/congestion|heavy|white.*mucus|after.*meal/))    return "kapha_congestive";
  if (text.match(/years|chronic|tried many|multiple treatment/))  return "tridosha_chronic";

  return null;
}

/**
 * Determine recommended plan based on sinus type
 */
function getPlanForSinusType(sinusType) {
  const corePlan = ["kaphavata_allergic", "pitta_inflammatory", "tridosha_chronic"];
  if (corePlan.includes(sinusType)) return "core_1299";
  return "starter_499";
}

// ---- Claude AI Call ----

/**
 * Call Claude with conversation history and system prompt.
 * Guards against empty history or history ending with an assistant message.
 */
async function callClaude(conv, history, userText) {
  const system = getSystemPrompt(conv);

  // Build messages array from history
  let msgs = (history || []).map(m => ({ role: m.role, content: m.content }));

  // Remove any leading assistant messages (Claude API requires user first)
  while (msgs.length > 0 && msgs[0].role !== "user") msgs.shift();

  // Guard: if history is empty or ends with assistant, inject current user message
  // This prevents the "Namaste!" / hardcoded fallback bug
  if (msgs.length === 0 || msgs[msgs.length - 1].role === "assistant") {
    msgs.push({ role: "user", content: userText });
  }

  const response = await claude.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    system,
    messages: msgs,
  });

  return response.content[0].text;
}

// ---- Main Entry Point ----

/**
 * processMessage - called by all platform handlers
 *
 * @param {string} platform  - "whatsapp" | "instagram" | "messenger" | "website"
 * @param {string} userId    - platform-specific user ID
 * @param {string} userText  - the message from the customer
 * @returns {string}         - the bot reply to send back
 */
async function processMessage(platform, userId, userText) {
  try {
    // 1. Get or create conversation
    let conv = await getOrCreateConversation(platform, userId);

    // 2. Handle restart keyword
    const lower = userText.toLowerCase();
    if (RESTART_KEYWORDS.some(k => lower.includes(k))) {
      conv = await resetConversation(conv.id);
      return language(conv.language, "restart");
    }

    // 3. Detect and update language if changed
    const detectedLang = detectLanguage(userText);
    if (detectedLang !== conv.language) {
      conv = await updateConversation(conv.id, { language: detectedLang });
    }

    // 4. Log user message
    await logMessage(conv.id, "user", userText);

    // 5. Get recent conversation history for Claude
    const history = await getRecentMessages(conv.id);

    // 6. Advance state machine
    const nextStage = getNextStage(conv.stage, userText);
    const updates = {
      stage: nextStage,
      message_count: (conv.message_count || 0) + 1,
    };

    // 7. Try to detect sinus type in discharge/reveal stages
    if (!conv.sinus_type && ["discharge", "reveal", "insight", "close"].includes(nextStage)) {
      const detected = detectSinusType(history);
      if (detected) {
        updates.sinus_type = detected;
        updates.plan = getPlanForSinusType(detected);
      }
    }

    // 8. Update conversation with new state
    conv = await updateConversation(conv.id, updates);

    // 9. Call Claude for reply
    const reply = await callClaude(conv, history, userText);

    // 10. Log assistant reply
    await logMessage(conv.id, "assistant", reply);

    // 11. Handle conversion
    if (nextStage === "converted" && !conv.converted_at) {
      await updateConversation(conv.id, { converted_at: new Date().toISOString() });
      crmMarkConverted(conv).catch(() => {}); // fire-and-forget
    }

    // 12. Sync to Notion CRM (fire-and-forget, never blocks reply)
    crmUpsertLead(conv).catch(() => {});

    return reply;
  } catch (err) {
    console.error(`[Bot] processMessage error [${platform}/${userId}]:`, err.message);
    // Return a safe fallback so the customer sees something
    return "Ek second — kuch technical issue aa gaya. Thodi der mein dobara message karein.";
  }
}

// ---- Language-specific system messages ----
function language(lang, key) {
  const msgs = {
    restart: {
      hindi:    "नमस्ते! फिर से शुरू करते हैं। आपको सबसे ज़्यादा कौन सी सिनस की समस्या है?",
      hinglish: "Namaste! Naye sire se shuru karte hain. Aapki main sinus problem kya hai?",
      english:  "Hello! Let's start fresh. What's your main sinus concern?",
    },
  };
  return (msgs[key] || {})[lang] || msgs[key]?.hinglish || "Let's start again.";
}

module.exports = { processMessage };
