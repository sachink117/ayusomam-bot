// ============================================================
// platforms/whatsapp.js - WhatsApp Cloud API handler
// Handles text messages (with buffering) and image messages (payment screenshots)
// ============================================================
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const { WEBHOOK_VERIFY_TOKEN, META_APP_SECRET, WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, WA_BUFFER_MS } = require("../config");
const { processMessage, processPaymentScreenshot } = require("../bot");

const router = express.Router();

// In-memory buffer: userId → { timer, messages[] }
const msgBuffer = new Map();

// ---- Webhook Verification ----
router.get("/", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("[WhatsApp] Webhook verified");
    return res.send(challenge);
  }
  res.sendStatus(403);
});

// ---- Incoming Messages ----
router.post("/", (req, res) => {
  if (!verifySignature(req)) {
    console.warn("[WhatsApp] Invalid signature");
    return res.sendStatus(401);
  }

  res.sendStatus(200); // Acknowledge immediately (Meta requires 200 within 20s)

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    if (!change?.messages) return;

    for (const msg of change.messages) {
      const userId = msg.from;

      if (msg.type === "text") {
        // Buffer text messages to combine rapid multi-part messages
        bufferMessage(userId, msg.text.body);

      } else if (msg.type === "image") {
        // Image received — treat as potential payment screenshot
        handleImage(userId);

      }
      // All other types (video, audio, sticker, location) are silently ignored
    }
  } catch (err) {
    console.error("[WhatsApp] Webhook parse error:", err.message);
  }
});

// ---- Message Buffering ----

function bufferMessage(userId, text) {
  if (!msgBuffer.has(userId)) {
    msgBuffer.set(userId, { timer: null, messages: [] });
  }
  const entry = msgBuffer.get(userId);
  entry.messages.push(text);

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    const combined = entry.messages.join(" ");
    msgBuffer.delete(userId);
    handleText(userId, combined);
  }, WA_BUFFER_MS);
}

async function handleText(userId, text) {
  console.log(`[WhatsApp] text from ${userId}: ${text}`);
  try {
    const reply = await processMessage("whatsapp", userId, text);
    await sendWhatsApp(userId, reply);
  } catch (err) {
    console.error(`[WhatsApp] handleText error for ${userId}:`, err.message);
  }
}

async function handleImage(userId) {
  console.log(`[WhatsApp] image from ${userId}`);
  try {
    const reply = await processPaymentScreenshot("whatsapp", userId);
    if (reply) await sendWhatsApp(userId, reply);
    // If reply is null, the image was outside payment stage — silently ignore
  } catch (err) {
    console.error(`[WhatsApp] handleImage error for ${userId}:`, err.message);
  }
}

// ---- Send Message ----
async function sendWhatsApp(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${WA_PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[WhatsApp] send failed:", err.response?.data || err.message);
  }
}

// ---- HMAC Signature Verification ----
function verifySignature(req) {
  if (!META_APP_SECRET) return true;
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody || "").digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

module.exports = { router, sendWhatsApp };
