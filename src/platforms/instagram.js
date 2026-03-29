// ============================================================
// platforms/instagram.js - Instagram Messenger handler
// ============================================================
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const { WEBHOOK_VERIFY_TOKEN, META_APP_SECRET, IG_ACCESS_TOKEN, IG_PAGE_ID } = require("../config");
const { processMessage } = require("../bot");

const router = express.Router();

// ---- Webhook Verification ----
router.get("/", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("[Instagram] Webhook verified");
    return res.send(challenge);
  }
  res.sendStatus(403);
});

// ---- Incoming Messages ----
router.post("/", async (req, res) => {
  if (!verifySignature(req)) {
    console.warn("[Instagram] Invalid signature");
    return res.sendStatus(401);
  }

  res.sendStatus(200); // Acknowledge immediately

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const event of entry.messaging || []) {
        // Skip echo messages (sent by the page itself)
        if (event.message?.is_echo) continue;
        if (!event.message?.text) continue;

        const userId = event.sender.id;
        const text = event.message.text;

        console.log(`[Instagram] ${userId}: ${text}`);
        const reply = await processMessage("instagram", userId, text);
        await sendInstagram(userId, reply);
      }
    }
  } catch (err) {
    console.error("[Instagram] Webhook error:", err.message);
  }
});

// ---- Send Message ----
async function sendInstagram(recipientId, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${IG_PAGE_ID}/messages`,
      { recipient: { id: recipientId }, message: { text } },
      { headers: { Authorization: `Bearer ${IG_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[Instagram] send failed:", err.response?.data || err.message);
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

module.exports = { router, sendInstagram };
