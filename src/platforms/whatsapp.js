// platforms/whatsapp.js - WhatsApp handler
// Name comes from contacts[].profile.name in the webhook payload (no extra API call needed)
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const { WEBHOOK_VERIFY_TOKEN, META_APP_SECRET, WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, WA_BUFFER_MS } = require("../config");
const { processMessage, processPaymentScreenshot } = require("../bot");

const router = express.Router();
const msgBuffer = new Map();
// userId → name (cached from contacts[] in first webhook event)
const nameCache = new Map();

router.get("/", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) return res.send(challenge);
  res.sendStatus(403);
});

router.post("/", (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    if (!change?.messages) return;

    // WhatsApp provides display name in contacts[] alongside messages[]
    const contacts = change.contacts || [];
    for (const c of contacts) {
      if (c.wa_id && c.profile?.name) nameCache.set(c.wa_id, c.profile.name);
    }

    for (const msg of change.messages) {
      const userId = msg.from;
      const name = nameCache.get(userId) || null;
      if (msg.type === "text") bufferMessage(userId, msg.text.body, name);
      else if (msg.type === "image") handleImage(userId);
    }
  } catch (err) {
    console.error("[WhatsApp] parse error:", err.message);
  }
});

function bufferMessage(userId, text, name) {
  if (!msgBuffer.has(userId)) msgBuffer.set(userId, { timer: null, messages: [], name });
  const entry = msgBuffer.get(userId);
  entry.messages.push(text);
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    const combined = entry.messages.join(" ");
    const n = entry.name;
    msgBuffer.delete(userId);
    handleText(userId, combined, n);
  }, WA_BUFFER_MS);
}

async function handleText(userId, text, name) {
  console.log(`[WhatsApp] ${name||userId}: ${text}`);
  try {
    const reply = await processMessage("whatsapp", userId, text, name);
    await sendWhatsApp(userId, reply);
  } catch (err) { console.error(`[WhatsApp] handleText error:`, err.message); }
}

async function handleImage(userId) {
  try {
    const reply = await processPaymentScreenshot("whatsapp", userId);
    if (reply) await sendWhatsApp(userId, reply);
  } catch (err) { console.error(`[WhatsApp] handleImage error:`, err.message); }
}

async function sendWhatsApp(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${WA_PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) { console.error("[WhatsApp] send failed:", err.response?.data || err.message); }
}

function verifySignature(req) {
  if (!META_APP_SECRET) return true;
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody || "").digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

module.exports = { router, sendWhatsApp };
