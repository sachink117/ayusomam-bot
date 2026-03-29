// ============================================================
// payment.js - Payment detection and onboarding messages
//
// Three payment scenarios:
//   1. Razorpay  → payment ID / link in message → auto-confirm → onboarding
//   2. Screenshot → image received at payment stage → payment_pending → admin confirms
//   3. UPI (GPay/Paytm/PhonePe/etc) → customer says "paid via GPay" → payment_pending → admin confirms
//
// Only payment_pending needs manual admin action.
// Razorpay is instant-confirmed automatically.
// ============================================================
const { RAZORPAY_LINK_499, RAZORPAY_LINK_1299 } = require("./config");

// ---- Razorpay detection ----
// Razorpay payment IDs look like: pay_QxXyZaB1234567 or order_QxXyZaB1234567
const RAZORPAY_ID_PATTERN = /\b(pay|order)_[A-Za-z0-9]{14,}\b/i;

// ---- UPI / other payment method keywords ----
const UPI_KEYWORDS = [
  "gpay", "google pay", "paytm", "phonepe", "phone pe",
  "bhim", "upi", "neft", "imps", "rtgs",
  "bank transfer", "transfer kar diya", "transferred",
  "paid", "payment done", "payment kar diya", "payment bhej diya",
  "paise bhej diye", "bhej diya", "send kar diya",
  "done", "ho gaya", "ho gayi", "complete",
];

// ---- Screenshot / image handling ----
// Called by platform handlers when an image message is received.
// Returns true if the conversation is in a payment-relevant stage.
function isPaymentStage(stage) {
  return ["close", "objection", "payment_pending"].includes(stage);
}

/**
 * Analyse a text message for payment signals.
 *
 * Returns:
 *   { type: "razorpay", confirmed: true,  paymentId }   → auto-confirm
 *   { type: "upi",      confirmed: false, method }       → payment_pending (needs admin)
 *   null                                                  → not a payment message
 */
function detectPaymentInText(text) {
  if (!text) return null;

  // 1. Razorpay payment ID in message
  const rpMatch = text.match(RAZORPAY_ID_PATTERN);
  if (rpMatch) {
    return { type: "razorpay", confirmed: true, paymentId: rpMatch[0] };
  }

  // 2. Razorpay link shared back (customer copying the link URL)
  if (text.includes("rzp.io") || text.includes("razorpay.com")) {
    return { type: "razorpay", confirmed: true, paymentId: null };
  }

  // 3. UPI / other payment keywords
  const lower = text.toLowerCase();
  for (const kw of UPI_KEYWORDS) {
    if (lower.includes(kw)) {
      // Identify which method if possible
      let method = "upi";
      if (lower.includes("gpay") || lower.includes("google pay")) method = "GPay";
      else if (lower.includes("paytm"))   method = "Paytm";
      else if (lower.includes("phonepe") || lower.includes("phone pe")) method = "PhonePe";
      else if (lower.includes("bhim"))    method = "BHIM";
      else if (lower.includes("neft") || lower.includes("imps") || lower.includes("rtgs")) method = "Bank Transfer";
      return { type: "upi", confirmed: false, method };
    }
  }

  return null;
}

/**
 * Get the correct Razorpay payment link for a plan.
 * Falls back gracefully if env var not set.
 */
function getPaymentLink(plan) {
  if (plan === "core_1299")  return RAZORPAY_LINK_1299 || null;
  if (plan === "starter_499") return RAZORPAY_LINK_499  || null;
  return null;
}

// ============================================================
// Onboarding messages — sent immediately after payment confirmed
// ============================================================

const ONBOARDING = {
  starter_499: {
    hindi: `🌿 भुगतान प्राप्त हो गया! बहुत-बहुत धन्यवाद।

आपका 7-Day Starter Protocol अभी तैयार हो रहा है। आज ही कूरियर से भेज देंगे।

📦 *आपके प्रोटोकॉल में शामिल है:*
• Sitopaladi Churna (सिनस क्लींजिंग के लिए)
• Tulsi + Adrak drops (immunity के लिए)
• नाक की भाप का सही तरीका — instruction card के साथ

📲 ट्रैकिंग नंबर कल तक WhatsApp पर भेज दूंगा।
कोई सवाल हो तो यहीं पूछें — मैं हमेशा available हूं। 🙏`,

    hinglish: `🌿 Payment mil gayi! Bahut shukriya.

Aapka 7-Day Starter Protocol taiyar ho raha hai. Aaj hi courier se bhej denge.

📦 *Aapke protocol mein shamil hai:*
• Sitopaladi Churna (sinus cleansing ke liye)
• Tulsi + Adrak drops (immunity ke liye)
• Naak ki bhap ka sahi tarika — instruction card ke saath

📲 Tracking number kal tak WhatsApp par bhej dunga.
Koi sawaal ho toh yahan poochhen — main hamesha available hoon. 🙏`,

    english: `🌿 Payment received! Thank you so much.

Your 7-Day Starter Protocol is being prepared and will be dispatched today.

📦 *Your protocol includes:*
• Sitopaladi Churna (sinus cleansing)
• Tulsi + Adrak drops (immunity support)
• Steam therapy guide — printed instruction card

📲 I'll send you the tracking number on WhatsApp by tomorrow.
Feel free to ask me anything — I'm always here. 🙏`,
  },

  core_1299: {
    hindi: `🌿 भुगतान प्राप्त हो गया! बहुत-बहुत धन्यवाद।

आपका 14-Day Core Protocol तैयार हो रहा है। आज ही कूरियर से भेज देंगे।

📦 *आपके प्रोटोकॉल में शामिल है:*
• Sitopaladi + Trikatu Churna (deep cleansing)
• Shadbindu Tail (नाक के drops)
• Yashtimadhu + Guduchi capsules (anti-inflammatory)
• 14-दिन का step-by-step routine card

📲 ट्रैकिंग नंबर कल तक WhatsApp पर भेज दूंगा।
14 दिन में clearly फर्क महसूस होगा। कोई सवाल हो तो यहीं पूछें। 🙏`,

    hinglish: `🌿 Payment mil gayi! Bahut shukriya.

Aapka 14-Day Core Protocol taiyar ho raha hai. Aaj hi courier se bhej denge.

📦 *Aapke protocol mein shamil hai:*
• Sitopaladi + Trikatu Churna (deep cleansing)
• Shadbindu Tail (naak ke drops)
• Yashtimadhu + Guduchi capsules (anti-inflammatory)
• 14-din ka step-by-step routine card

📲 Tracking number kal tak WhatsApp par bhej dunga.
14 din mein clearly fark feel hoga. Koi sawaal ho toh yahan poochhen. 🙏`,

    english: `🌿 Payment received! Thank you so much.

Your 14-Day Core Protocol is being prepared and will be dispatched today.

📦 *Your protocol includes:*
• Sitopaladi + Trikatu Churna (deep sinus cleansing)
• Shadbindu Tail (nasal drops)
• Yashtimadhu + Guduchi capsules (anti-inflammatory)
• 14-day step-by-step routine card

📲 I'll send you the tracking number on WhatsApp by tomorrow.
You should feel a clear difference within 14 days. I'm here if you have any questions. 🙏`,
  },
};

/**
 * Message sent when screenshot/UPI is received but needs admin confirmation.
 */
const PENDING_MSG = {
  hindi: `✅ आपका भुगतान स्क्रीनशॉट / नोटिफिकेशन मिल गया। 

हम 1-2 घंटे में verify करके आपका प्रोटोकॉल dispatch कर देंगे। 🙏`,
  hinglish: `✅ Aapka payment screenshot / notification mil gaya.

Hum 1-2 ghante mein verify karke aapka protocol dispatch kar denge. 🙏`,
  english: `✅ Your payment screenshot / notification has been received.

We will verify and dispatch your protocol within 1-2 hours. 🙏`,
};

/**
 * Get onboarding message for a confirmed payment.
 */
function getOnboardingMessage(plan, language) {
  const msgs = ONBOARDING[plan] || ONBOARDING["starter_499"];
  return msgs[language] || msgs["hinglish"];
}

/**
 * Get payment-pending acknowledgement message.
 */
function getPendingMessage(language) {
  return PENDING_MSG[language] || PENDING_MSG["hinglish"];
}

module.exports = {
  detectPaymentInText,
  isPaymentStage,
  getPaymentLink,
  getOnboardingMessage,
  getPendingMessage,
};
