// ============================================================
// bot.js - Core bot engine
// ALL platforms call processMessage() from here.
// Fix a bug here → fixed on WhatsApp + Instagram + Messenger + Website simultaneously.
// ============================================================
const Anthropic = require("@anthropic-ai/sdk");
const { ANTHROPIC_API_KEY, CLAUDE_MODEL, CLAUDE_MAX_TOKENS } = require("./config");
const { getOrCreateConversation, updateConversation, logMessage, getRecentMessages, resetConversation, createBuyer } = require("./db");
const { getSystemPrompt } = require("./prompt");
const { crmUpsertLead, crmMarkConverted } = require("./notion");
const { detectPaymentInText, isPaymentStage, getOnboardingMessage, getPendingMessage } = require("./payment");

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Keywords that restart the conversation
const RESTART_KEYWORDS = ["restart", "reset", "start over", "shuru", "naya", "dobara"];

// Keywords that indicate purchase intent (trigger close/objection → payment link share)
const BUY_KEYWORDS = ["haan", "ha", "yes", "buy", "kharid", "order", "ready", "le lo", "bhejo", "send", "payment", "chahiye", "lena hai"];

// ============================================================
// Language Detection & Switching
// ============================================================

function detectExplicitSwitch(text) {
  const lower = text.toLowerCase().trim();
  if (/hindi\s*(me|mein|mai|main|m)\b/.test(lower) || lower === "hindi") return "hindi";
  if (
    /\bin english\b/.test(lower) ||
    /english\s*(me|mein|mai|main|please|m)\b/.test(lower) ||
    /\bspeak english\b/.test(lower) ||
    lower === "english"
  ) return "english";
  return null;
}

const SCRIPT_LANGS = [
  { pattern: /[\u0900-\u097F]/, lang: "hindi"     },
  { pattern: /[\u0600-\u06FF]/, lang: "arabic"    },
  { pattern: /[\u0400-\u04FF]/, lang: "russian"   },
  { pattern: /[\u4E00-\u9FFF]/, lang: "chinese"   },
  { pattern: /[\u3040-\u30FF]/, lang: "japanese"  },
  { pattern: /[\uAC00-\uD7AF]/, lang: "korean"    },
  { pattern: /[\u0370-\u03FF]/, lang: "greek"     },
  { pattern: /[\u0590-\u05FF]/, lang: "hebrew"    },
  { pattern: /[\u0E00-\u0E7F]/, lang: "thai"      },
  { pattern: /[\u0980-\u09FF]/, lang: "bengali"   },
  { pattern: /[\u0A80-\u0AFF]/, lang: "gujarati"  },
  { pattern: /[\u0C00-\u0C7F]/, lang: "telugu"    },
  { pattern: /[\u0B80-\u0BFF]/, lang: "tamil"     },
  { pattern: /[\u0D00-\u0D7F]/, lang: "malayalam" },
  { pattern: /[\u0A00-\u0A7F]/, lang: "punjabi"   },
];

const HINGLISH_WORDS = [
  "hai", "hain", "hoon", "mera", "meri", "aap", "kya",
  "nahi", "nai", "bhi", "ke", "ka", "ki", "se", "aur",
  "lekin", "bohot", "bahut", "accha", "theek", "bilkul",
  "iska", "uska", "yeh", "woh", "kuch", "sab", "sirf",
  "abhi", "phir", "toh", "bolo", "batao", "samajh",
];

function detectLanguage(text) {
  for (const { pattern, lang } of SCRIPT_LANGS) {
    if (pattern.test(text)) return lang;
  }
  const lower = text.toLowerCase();
  if (HINGLISH_WORDS.some(w => new RegExp(`\\b${w}\\b`).test(lower))) return "hinglish";
  if (/^[a-zA-Z0-9\s.,!?'"()\-:;]+$/.test(text.trim()) && text.trim().split(/\s+/).length >= 3) return "english";
  return "hinglish";
}

// ============================================================
// State Machine
// ============================================================

function getNextStage(currentStage, userMessage) {
  const lower = userMessage.toLowerCase();

  if (RESTART_KEYWORDS.some(k => lower.includes(k))) return "initiated";

  // Buy intent at close/objection → stay in close (Claude will share payment link)
  // Actual conversion happens when payment is detected
  if (["close", "objection"].includes(currentStage) && BUY_KEYWORDS.some(k => lower.includes(k))) {
    return "close"; // Claude shares the payment link now; conversion happens after payment
  }

  const flow = {
    "initiated":       "qualifier",
    "qualifier":       "duration",
    "duration":        "discharge",
    "discharge":       "reveal",
    "reveal":          "insight",
    "insight":         "close",
    "close":           "objection",
    "objection":       "close",
    "payment_pending": "payment_pending", // stays here until admin confirms
    "converted":       "converted",
  };

  return flow[currentStage] || currentStage;
}

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

// ============================================================
// Claude AI Call
// ============================================================

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

// ============================================================
// Payment Screenshot Handler
// Called directly by platform handlers when an IMAGE message is received
// ============================================================

/**
 * processPaymentScreenshot - called when customer sends an image at payment stage
 * Returns the reply to send back, or null if we should ignore the image.
 */
async function processPaymentScreenshot(platform, userId) {
  try {
    let conv = await getOrCreateConversation(platform, userId);

    // Only treat images as payment proof if we're in a payment-relevant stage
    if (!isPaymentStage(conv.stage)) return null;

    // Move to payment_pending and acknowledge
    conv = await updateConversation(conv.id, { stage: "payment_pending" });
    await logMessage(conv.id, "user", "[Payment screenshot received]");

    const reply = getPendingMessage(conv.language);
    await logMessage(conv.id, "assistant", reply);

    // Sync CRM
    crmUpsertLead(conv).catch(() => {});

    return reply;
  } catch (err) {
    console.error(`[Bot] processPaymentScreenshot error [${platform}/${userId}]:`, err.message);
    return null;
  }
}

// ============================================================
// Main Entry Point
// ============================================================

/**
 * processMessage - called by all platform handlers
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
    const explicitLang = detectExplicitSwitch(userText);
    const newLang = explicitLang || detectLanguage(userText);
    if (newLang !== conv.language) {
      conv = await updateConversation(conv.id, { language: newLang });
      console.log(`[Bot] Language: ${conv.language} → ${newLang} [${platform}/${userId}]`);
    }

    // 4. Payment detection — check BEFORE normal flow
    //    If customer is in payment stage and says "paid via GPay" etc → handle it
    if (isPaymentStage(conv.stage)) {
      const payment = detectPaymentInText(userText);
      if (payment) {
        console.log(`[Bot] Payment detected: type=${payment.type} confirmed=${payment.confirmed} [${platform}/${userId}]`);
        await logMessage(conv.id, "user", userText);

        if (payment.confirmed) {
          // Razorpay auto-confirmed → convert immediately
          const plan = conv.plan || "starter_499";
          const price = plan === "core_1299" ? 1299 : 499;
          conv = await updateConversation(conv.id, { stage: "converted", converted_at: new Date().toISOString() });
          await createBuyer(conv.id, platform, userId, plan, price);
          const onboarding = getOnboardingMessage(plan, conv.language);
          await logMessage(conv.id, "assistant", onboarding);
          crmMarkConverted(conv).catch(() => {});
          crmUpsertLead(conv).catch(() => {});
          return onboarding;
        } else {
          // GPay / Paytm / UPI — needs admin verification
          conv = await updateConversation(conv.id, { stage: "payment_pending" });
          const pending = getPendingMessage(conv.language);
          await logMessage(conv.id, "assistant", pending);
          crmUpsertLead(conv).catch(() => {});
          return pending;
        }
      }
    }

    // 5. Log user message
    await logMessage(conv.id, "user", userText);

    // 6. Fetch recent history for Claude
    const history = await getRecentMessages(conv.id);

    // 7. Advance state machine
    const nextStage = getNextStage(conv.stage, userText);
    const updates = {
      stage: nextStage,
      message_count: (conv.message_count || 0) + 1,
    };

    // 8. Detect sinus type in later stages
    if (!conv.sinus_type && ["discharge", "reveal", "insight", "close"].includes(nextStage)) {
      const detected = detectSinusType(history);
      if (detected) {
        updates.sinus_type = detected;
        updates.plan = getPlanForSinusType(detected);
      }
    }

    // 9. Save state
    conv = await updateConversation(conv.id, updates);

    // 10. Get Claude reply
    const reply = await callClaude(conv, history, userText);

    // 11. Log reply
    await logMessage(conv.id, "assistant", reply);

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
    },
  };
  return (msgs[key] || {})[lang] || (msgs[key] || {}).hinglish || "Let us start again.";
}

module.exports = { processMessage, processPaymentScreenshot };
