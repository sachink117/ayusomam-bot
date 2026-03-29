// ============================================================
// platforms/messenger.js - Facebook Messenger handler
// ============================================================
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const { WEBHOOK_VERIFY_TOKEN, META_APP_SECRET, FB_PAGE_ACCESS_TOKEN, FB_PAGE_ID } = require("../config");
const { processMessage } = require("../bot");

const router = express.Router();

// ---- Webhook Verification ----
router.get("/", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("[Messenger] Webhook verified");
    return res.send(challenge);
  }
  res.sendStatus(403);
});

// ---- Incoming Messages ----
router.post("/", async (req, res) => {
  if (!verifySignature(req)) {
    console.warn("[Messenger] Invalid signature");
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

        console.log(`[Messenger] ${userId}: ${text}`);
        const reply = await processMessage("messenger", userId, text);
        await sendMessenger(userId, reply);
      }
    }
  } catch (err) {
    console.error("[Messenger] Webhook error:", err.message);
  }
});

// ---- Send Message ----
async function sendMessenger(recipientId, text) {
  try {
    await axios.post(
      "https://graph.facebook.com/v19.0/me/messages",
      { recipient: { id: recipientId }, message: { text } },
      {
        headers: { "Content-Type": "application/json" },
        params: { access_token: FB_PAGE_ACCESS_TOKEN },
      }
    );
  } catch (err) {
    console.error("[Messenger] send failed:", err.response?.data || err.message);
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

module.exports = { router, sendMessenger };
