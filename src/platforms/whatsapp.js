// ============================================================
// platforms/whatsapp.js - WhatsApp Cloud API handler
// Includes message buffering to combine rapid multi-part messages
// ============================================================
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const { WEBHOOK_VERIFY_TOKEN, META_APP_SECRET, WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, WA_BUFFER_MS } = require("../config");
const { processMessage } = require("../bot");

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
  // Verify HMAC signature
  if (!verifySignature(req)) {
    console.warn("[WhatsApp] Invalid signature");
    return res.sendStatus(401);
  }

  // Acknowledge immediately (Meta requires 200 within 20s)
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    if (!change?.messages) return;

    for (const msg of change.messages) {
      if (msg.type !== "text") continue; // ignore media for now
      const userId = msg.from;
      const text = msg.text.body;

      bufferMessage(userId, text);
    }
  } catch (err) {
    console.error("[WhatsApp] Webhook parse error:", err.message);
  }
});

// ---- Message Buffering ----
// Waits WA_BUFFER_MS after the last message, then combines and processes all buffered messages

function bufferMessage(userId, text) {
  if (!msgBuffer.has(userId)) {
    msgBuffer.set(userId, { timer: null, messages: [] });
  }
  const entry = msgBuffer.get(userId);
  entry.messages.push(text);

  // Reset the timer on every new message
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    const combined = entry.messages.join(" ");
    msgBuffer.delete(userId);
    handleMessage(userId, combined);
  }, WA_BUFFER_MS);
}

async function handleMessage(userId, text) {
  console.log(`[WhatsApp] ${userId}: ${text}`);
  try {
    const reply = await processMessage("whatsapp", userId, text);
    await sendWhatsApp(userId, reply);
  } catch (err) {
    console.error(`[WhatsApp] handleMessage error for ${userId}:`, err.message);
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
    console.error("[WhatsApp] sendWhatsApp failed:", err.response?.data || err.message);
  }
}

// ---- HMAC Signature Verification ----
function verifySignature(req) {
  if (!META_APP_SECRET) return true; // skip in dev if not set
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody || "").digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

module.exports = { router, sendWhatsApp };
