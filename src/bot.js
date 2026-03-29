// ============================================================
// bot.js - Core bot engine
// ALL platforms call processMessage() from here.
// Fix a bug here → fixed on WhatsApp + Instagram + Messenger + Website simultaneously.
// ============================================================
const Anthropic = require("@anthropic-ai/sdk");
const { ANTHROPIC_API_KEY, CLAUDE_MODEL, CLAUDE_MAX_TOKENS } = require("./config");
const { getOrCreateConversation, updateConversation, logMessage, getRecentMessages, resetConversation } = require("./db");
const { getSystemPrompt } = require("./prompt");
const { crmUpsertLead, crmMarkConverted } = require("./notion");

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Keywords that restart the conversation
const RESTART_KEYWORDS = ["restart", "reset", "start over", "shuru", "naya", "dobara"];

// Keywords that indicate purchase intent (trigger converted stage)
const BUY_KEYWORDS = ["haan", "ha", "yes", "buy", "kharid", "order", "ready", "le lo", "bhejo", "send", "payment"];

// ============================================================
// Language Detection & Switching
//
// Priority order:
//   1. Explicit switch command ("hindi me batao" / "in english") → always wins
//   2. Devanagari script detected → hindi
//   3. Known non-latin script detected → map to language
//   4. Pure Latin text with NO Hindi/Urdu keywords → english
//   5. Default fallback → hinglish (keeps the conversation natural for Indian users)
// ============================================================

/**
 * Check for explicit "please switch language" commands.
 * These override auto-detection entirely.
 * Returns: language string, or null if no explicit command found.
 */
function detectExplicitSwitch(text) {
  const lower = text.toLowerCase().trim();

  // → Hindi (Devanagari)
  if (/hindi\s*(me|mein|mai|main|m)\b/.test(lower) || lower === "hindi") return "hindi";

  // → English
  if (
    /\bin english\b/.test(lower) ||
    /english\s*(me|mein|mai|main|please|m)\b/.test(lower) ||
    /\bspeak english\b/.test(lower) ||
    /\bwrite english\b/.test(lower) ||
    lower === "english"
  ) return "english";

  return null; // no explicit command
}

/**
 * Unicode script blocks for script-based language detection.
 * Add more as needed.
 */
const SCRIPT_LANGS = [
  { pattern: /[\u0900-\u097F]/, lang: "hindi"     },  // Devanagari
  { pattern: /[\u0600-\u06FF]/, lang: "arabic"    },  // Arabic / Urdu
  { pattern: /[\u0400-\u04FF]/, lang: "russian"   },  // Cyrillic
  { pattern: /[\u4E00-\u9FFF]/, lang: "chinese"   },  // CJK Chinese
  { pattern: /[\u3040-\u30FF]/, lang: "japanese"  },  // Hiragana/Katakana
  { pattern: /[\uAC00-\uD7AF]/, lang: "korean"    },  // Hangul
  { pattern: /[\u0370-\u03FF]/, lang: "greek"     },  // Greek
  { pattern: /[\u0590-\u05FF]/, lang: "hebrew"    },  // Hebrew
  { pattern: /[\u0E00-\u0E7F]/, lang: "thai"      },  // Thai
  { pattern: /[\u0980-\u09FF]/, lang: "bengali"   },  // Bengali
  { pattern: /[\u0A80-\u0AFF]/, lang: "gujarati"  },  // Gujarati
  { pattern: /[\u0C00-\u0C7F]/, lang: "telugu"    },  // Telugu
  { pattern: /[\u0B80-\u0BFF]/, lang: "tamil"     },  // Tamil
  { pattern: /[\u0D00-\u0D7F]/, lang: "malayalam" },  // Malayalam
  { pattern: /[\u0A00-\u0A7F]/, lang: "punjabi"   },  // Gurmukhi (Punjabi)
];

// Common Hindi/Urdu words written in Latin (Hinglish markers)
const HINGLISH_WORDS = [
  "hai", "hain", "hoon", "mera", "meri", "mera", "aap", "kya",
  "nahi", "nai", "nahi", "bhi", "ke", "ka", "ki", "se", "aur",
  "lekin", "bohot", "bahut", "accha", "theek", "bilkul", "zaroor",
  "iska", "uska", "unka", "yeh", "woh", "kuch", "sab", "sirf",
  "abhi", "phir", "fir", "toh", "bolo", "batao", "samajh",
];

/**
 * Auto-detect language from message content.
 * Returns detected language string.
 */
function detectLanguage(text) {
  // 1. Script-based detection (most reliable)
  for (const { pattern, lang } of SCRIPT_LANGS) {
    if (pattern.test(text)) return lang;
  }

  // 2. Hinglish keyword detection — if any Hindi word in Latin script → hinglish
  const lower = text.toLowerCase();
  if (HINGLISH_WORDS.some(w => {
    // word boundary check to avoid false matches inside longer words
    const re = new RegExp(`\\b${w}\\b`);
    return re.test(lower);
  })) return "hinglish";

  // 3. Pure Latin with no Hindi markers → english
  // (only switch to english if the message is at least 3 words long, to avoid
  //  short single-word messages like "ok" flipping the language)
  if (/^[a-zA-Z0-9\s.,!?'"()\-:;]+$/.test(text.trim()) && text.trim().split(/\s+/).length >= 3) {
    return "english";
  }

  // 4. Default: hinglish (works for Indian customers on all platforms)
  return "hinglish";
}

// ---- State Machine ----

/**
 * Advance the conversation stage based on the current stage and user message.
 */
function getNextStage(currentStage, userMessage) {
  const lower = userMessage.toLowerCase();

  if (RESTART_KEYWORDS.some(k => lower.includes(k))) return "initiated";

  if (["close", "objection"].includes(currentStage) && BUY_KEYWORDS.some(k => lower.includes(k))) {
    return "converted";
  }

  const flow = {
    "initiated":  "qualifier",
    "qualifier":  "duration",
    "duration":   "discharge",
    "discharge":  "reveal",
    "reveal":     "insight",
    "insight":    "close",
    "close":      "objection",
    "objection":  "close",
    "converted":  "converted",
  };

  return flow[currentStage] || currentStage;
}

/**
 * Determine sinus type from conversation history via keyword matching.
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

function getPlanForSinusType(sinusType) {
  return ["kaphavata_allergic", "pitta_inflammatory", "tridosha_chronic"].includes(sinusType)
    ? "core_1299"
    : "starter_499";
}

// ---- Claude AI Call ----

/**
 * Call Claude with conversation history and dynamic system prompt.
 * Guards against empty/assistant-ending history (prevents canned reply bug).
 */
async function callClaude(conv, history, userText) {
  const system = getSystemPrompt(conv);

  let msgs = (history || []).map(m => ({ role: m.role, content: m.content }));
  while (msgs.length > 0 && msgs[0].role !== "user") msgs.shift();

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
      return languageMsg(conv.language, "restart");
    }

    // 3. Language detection
    //    Explicit switch command ("hindi me batao" / "in english") takes priority.
    //    Otherwise auto-detect; default is hinglish.
    const explicitLang = detectExplicitSwitch(userText);
    const newLang = explicitLang || detectLanguage(userText);

    if (newLang !== conv.language) {
      conv = await updateConversation(conv.id, { language: newLang });
      console.log(`[Bot] Language: ${conv.language} → ${newLang} [${platform}/${userId}]`);
    }

    // 4. Log user message
    await logMessage(conv.id, "user", userText);

    // 5. Fetch recent history for Claude
    const history = await getRecentMessages(conv.id);

    // 6. Advance state machine
    const nextStage = getNextStage(conv.stage, userText);
    const updates = {
      stage: nextStage,
      message_count: (conv.message_count || 0) + 1,
    };

    // 7. Try to detect sinus type in later stages
    if (!conv.sinus_type && ["discharge", "reveal", "insight", "close"].includes(nextStage)) {
      const detected = detectSinusType(history);
      if (detected) {
        updates.sinus_type = detected;
        updates.plan = getPlanForSinusType(detected);
      }
    }

    // 8. Save updated state
    conv = await updateConversation(conv.id, updates);

    // 9. Get Claude reply
    const reply = await callClaude(conv, history, userText);

    // 10. Log assistant reply
    await logMessage(conv.id, "assistant", reply);

    // 11. Handle conversion
    if (nextStage === "converted" && !conv.converted_at) {
      await updateConversation(conv.id, { converted_at: new Date().toISOString() });
      crmMarkConverted(conv).catch(() => {});
    }

    // 12. Sync Notion CRM (fire-and-forget)
    crmUpsertLead(conv).catch(() => {});

    return reply;
  } catch (err) {
    console.error(`[Bot] processMessage error [${platform}/${userId}]:`, err.message);
    return "Ek second — kuch technical issue aa gaya. Thodi der mein dobara message karein.";
  }
}

// ---- Language-specific system messages ----
function languageMsg(lang, key) {
  const msgs = {
    restart: {
      hindi:    "नमस्ते! फिर से शुरू करते हैं। आपको सबसे ज़्यादा कौन सी सिनस की समस्या है?",
      hinglish: "Namaste! Naye sire se shuru karte hain. Aapki main sinus problem kya hai?",
      english:  "Hello! Let us start fresh. What is your main sinus concern?",
      arabic:   "مرحبا! لنبدأ من جديد. ما هي مشكلة الجيوب الأنفية الرئيسية لديك؟",
    },
  };
  // Use detected language if available, otherwise hinglish
  return (msgs[key] || {})[lang] || (msgs[key] || {}).hinglish || "Let us start again.";
}

module.exports = { processMessage };
