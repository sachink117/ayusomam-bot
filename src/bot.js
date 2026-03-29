// bot.js - Core bot engine
const Anthropic = require("@anthropic-ai/sdk");
const { ANTHROPIC_API_KEY, CLAUDE_MODEL, CLAUDE_MAX_TOKENS } = require("./config");
const { getOrCreateConversation, updateConversation, updateName, logMessage, getRecentMessages, resetConversation, createBuyer, logFunnelEvent, logObjection } = require("./db");
const { getSystemPrompt } = require("./prompt");
const { crmUpsertLead, crmMarkConverted } = require("./notion");
const { detectPaymentInText, isPaymentStage, getOnboardingMessage, getPendingMessage } = require("./payment");
const { profileLead } = require("./agents/profiler");

const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const RESTART_KEYWORDS = ["restart", "reset", "start over", "shuru", "naya", "dobara"];
const BUY_KEYWORDS = ["haan", "ha", "yes", "buy", "kharid", "order", "ready", "le lo", "bhejo", "send", "payment", "chahiye", "lena hai"];

// === NAME DETECTION ===
const NAME_PATTERNS = [
  /(?:mera|meri)\s+naam\s+([A-Za-z\u0900-\u097F]+)\s*(?:hai|h|he|hain)?/i,
  /(?:main|mai)\s+([A-Za-z\u0900-\u097F]+)\s+(?:hoon|hun|hu)/i,
  /(?:my name is|i am|i'm|call me)\s+([A-Za-z\u0900-\u097F]+)/i,
  /naam\s+([A-Za-z\u0900-\u097F]+)\s*(?:hai|h|he)?/i,
];
const NOT_A_NAME = new Set(["theek","ok","okay","haan","nahi","hai","hun","hoon","aap","main","mein","ek","do","teen","yes","no","sure","thanks","hello","hi","bye","good","bad"]);

function extractNameFromText(text) {
  const isCorrecting = /\b(nahi|nai|not|wrong|actually|sahi|correction)\b/i.test(text);
  for (const p of NAME_PATTERNS) {
    const m = text.match(p);
    if (m) {
      const c = m[1].trim();
      if (c.length >= 2 && !NOT_A_NAME.has(c.toLowerCase())) {
        return { name: c.charAt(0).toUpperCase() + c.slice(1), isCorrecting };
      }
    }
  }
  return null;
}

// === LANGUAGE DETECTION ===
function detectExplicitSwitch(text) {
  const l = text.toLowerCase().trim();
  if (/hindi\s*(me|mein|mai|main|m)\b/.test(l) || l === "hindi") return "hindi";
  if (/\bin english\b/.test(l) || /english\s*(me|mein|please|m)\b/.test(l) || l === "english") return "english";
  return null;
}

const SCRIPT_LANGS = [
  {pattern:/[\u0900-\u097F]/,lang:"hindi"},{pattern:/[\u0600-\u06FF]/,lang:"arabic"},
  {pattern:/[\u0400-\u04FF]/,lang:"russian"},{pattern:/[\u4E00-\u9FFF]/,lang:"chinese"},
  {pattern:/[\u3040-\u30FF]/,lang:"japanese"},{pattern:/[\uAC00-\uD7AF]/,lang:"korean"},
  {pattern:/[\u0980-\u09FF]/,lang:"bengali"},{pattern:/[\u0A80-\u0AFF]/,lang:"gujarati"},
  {pattern:/[\u0C00-\u0C7F]/,lang:"telugu"},{pattern:/[\u0B80-\u0BFF]/,lang:"tamil"},
  {pattern:/[\u0D00-\u0D7F]/,lang:"malayalam"},{pattern:/[\u0A00-\u0A7F]/,lang:"punjabi"},
];
const HINGLISH_WORDS = ["hai","hain","hoon","mera","meri","aap","kya","nahi","nai","bhi","ke","ka","ki","se","aur","lekin","bohot","bahut","accha","theek","yeh","woh","toh","bolo","batao"];

function detectLanguage(text) {
  for (const {pattern,lang} of SCRIPT_LANGS) if (pattern.test(text)) return lang;
  const l = text.toLowerCase();
  if (HINGLISH_WORDS.some(w => new RegExp(`\\b${w}\\b`).test(l))) return "hinglish";
  if (/^[a-zA-Z0-9\s.,!?'"()\-:;]+$/.test(text.trim()) && text.trim().split(/\s+/).length >= 3) return "english";
  return "hinglish";
}

// === STATE MACHINE ===
function getNextStage(stage, msg) {
  const l = msg.toLowerCase();
  if (RESTART_KEYWORDS.some(k=>l.includes(k))) return "initiated";
  if (["close","objection"].includes(stage) && BUY_KEYWORDS.some(k=>l.includes(k))) return "close";
  return {initiated:"qualifier",qualifier:"duration",duration:"discharge",discharge:"reveal",reveal:"insight",insight:"close",close:"objection",objection:"close",payment_pending:"payment_pending",converted:"converted"}[stage] || stage;
}

function detectSinusType(messages) {
  const t = messages.map(m=>m.content).join(" ").toLowerCase();
  if (t.match(/sneezing|allerg|season|watery/)) return "kaphavata_allergic";
  if (t.match(/dry|no discharge|one.?sided/))  return "vata_dry";
  if (t.match(/yellow|green|thick.*discharge|facial pain/)) return "pitta_inflammatory";
  if (t.match(/congestion|heavy|white.*mucus|after.*meal/)) return "kapha_congestive";
  if (t.match(/years|chronic|tried many/)) return "tridosha_chronic";
  return null;
}

function getPlanForSinusType(st) {
  return ["kaphavata_allergic","pitta_inflammatory","tridosha_chronic"].includes(st) ? "core_1299" : "starter_499";
}

// === CLAUDE CALL ===
async function callClaude(conv, history, userText) {
  const system = getSystemPrompt(conv);
  let msgs = (history||[]).map(m=>({role:m.role,content:m.content}));
  while (msgs.length>0 && msgs[0].role!=="user") msgs.shift();
  if (msgs.length===0 || msgs[msgs.length-1].role==="assistant") msgs.push({role:"user",content:userText});
  const r = await claude.messages.create({model:CLAUDE_MODEL,max_tokens:CLAUDE_MAX_TOKENS,system,messages:msgs});
  return r.content[0].text;
}

// === PAYMENT SCREENSHOT ===
async function processPaymentScreenshot(platform, userId) {
  try {
    let conv = await getOrCreateConversation(platform, userId);
    if (!isPaymentStage(conv.stage)) return null;
    conv = await updateConversation(conv.id, {stage:"payment_pending"});
    await logMessage(conv.id,"user","[Payment screenshot received]");
    const reply = getPendingMessage(conv.language);
    await logMessage(conv.id,"assistant",reply);
    // Run profiler in background to extract structured lead data
    profileLead(conv.id, conv.stage).catch(()=>{});
    crmUpsertLead(conv).catch(()=>{});
    return reply;
  } catch(err) {
    console.error(`[Bot] screenshot error [${platform}/${userId}]:`,err.message);
    return null;
  }
}

// === MAIN ENTRY POINT ===
// metaName: display name from WhatsApp contacts[] or FB/IG Graph API
async function processMessage(platform, userId, userText, metaName = null) {
  try {
    let conv = await getOrCreateConversation(platform, userId, metaName);

    // Restart
    if (RESTART_KEYWORDS.some(k=>userText.toLowerCase().includes(k))) {
      conv = await resetConversation(conv.id);
      return langMsg(conv.language,"restart");
    }

    // Language
    const newLang = detectExplicitSwitch(userText) || detectLanguage(userText);
    if (newLang !== conv.language) conv = await updateConversation(conv.id,{language:newLang});

    // Name detection & correction
    const nm = extractNameFromText(userText);
    if (nm && (!conv.name || nm.isCorrecting)) {
      conv = await updateName(conv.id, nm.name, nm.isCorrecting ? "corrected" : "self");
      console.log(`[Bot] Name ${nm.isCorrecting?"corrected":"detected"}: "${nm.name}" [${platform}/${userId}]`);
    }

    // Payment detection
    if (isPaymentStage(conv.stage)) {
      const payment = detectPaymentInText(userText);
      if (payment) {
        await logMessage(conv.id,"user",userText);
        if (payment.confirmed) {
          const plan = conv.plan || "starter_499";
          const price = plan==="core_1299" ? 1299 : 499;
          conv = await updateConversation(conv.id,{stage:"converted",converted_at:new Date().toISOString()});
          await createBuyer(conv.id,platform,userId,plan,price,conv.name);
          const msg = getOnboardingMessage(plan,conv.language);
          await logMessage(conv.id,"assistant",msg);
          crmMarkConverted(conv).catch(()=>{}); crmUpsertLead(conv).catch(()=>{});
          return msg;
        } else {
          conv = await updateConversation(conv.id,{stage:"payment_pending"});
          const msg = getPendingMessage(conv.language);
          await logMessage(conv.id,"assistant",msg);
          crmUpsertLead(conv).catch(()=>{});
          return msg;
        }
      }
    }

    // Normal flow
    await logMessage(conv.id,"user",userText);
    const history = await getRecentMessages(conv.id);
    const nextStage = getNextStage(conv.stage,userText);
    const updates = {stage:nextStage, message_count:(conv.message_count||0)+1};
    if (!conv.sinus_type && ["discharge","reveal","insight","close"].includes(nextStage)) {
      const st = detectSinusType(history);
      if (st) { updates.sinus_type=st; updates.plan=getPlanForSinusType(st); }
    }
    conv = await updateConversation(conv.id,updates);
    // Log funnel event for analytics
    if (nextStage !== conv.stage) logFunnelEvent(conv.id, platform, conv.stage, nextStage).catch(()=>{});
    // Detect objections
    const objWords = ["sochenge","will think","expensive","mehenga","kaam karega","will it work","sure nahi"];
    if (["close","objection"].includes(nextStage) && objWords.some(w=>lower.includes(w))) {
      logObjection(conv.id, userText.slice(0,100), nextStage).catch(()=>{});
    }
    const reply = await callClaude(conv,history,userText);
    await logMessage(conv.id,"assistant",reply);
    // Run profiler in background to extract structured lead data
    profileLead(conv.id, conv.stage).catch(()=>{});
    crmUpsertLead(conv).catch(()=>{});
    return reply;
  } catch(err) {
    console.error(`[Bot] error [${platform}/${userId}]:`,err.message);
    return "Ek second — kuch technical issue aa gaya. Thodi der mein dobara message karein.";
  }
}

function langMsg(lang, key) {
  const m = {restart:{hindi:"नमस्ते! फिर से शुरू करते हैं। सिनस की मुख्य समस्या क्या है?",hinglish:"Namaste! Naye sire se shuru karte hain. Aapki main sinus problem kya hai?",english:"Hello! Let us start fresh. What is your main sinus concern?"}};
  return (m[key]||{})[lang] || (m[key]||{}).hinglish || "Let us start again.";
}

module.exports = { processMessage, processPaymentScreenshot };

