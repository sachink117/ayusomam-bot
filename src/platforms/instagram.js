// platforms/instagram.js
// Fetches sender name from Graph API on first message, caches it
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const { WEBHOOK_VERIFY_TOKEN, META_APP_SECRET, IG_ACCESS_TOKEN, IG_PAGE_ID } = require("../config");
const { processMessage } = require("../bot");

const router = express.Router();
const nameCache = new Map(); // senderId → name

router.get("/", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) return res.send(challenge);
  res.sendStatus(403);
});

router.post("/", async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    for (const entry of (req.body?.entry || [])) {
      for (const event of (entry.messaging || [])) {
        if (event.message?.is_echo || !event.message?.text) continue;
        const userId = event.sender.id;
        const text   = event.message.text;
        const name   = await getOrFetchName(userId, IG_ACCESS_TOKEN);
        console.log(`[Instagram] ${name||userId}: ${text}`);
        const reply = await processMessage("instagram", userId, text, name);
        await sendInstagram(userId, reply);
      }
    }
  } catch (err) { console.error("[Instagram] error:", err.message); }
});

// Fetch name from Graph API and cache it
async function getOrFetchName(senderId, accessToken) {
  if (nameCache.has(senderId)) return nameCache.get(senderId);
  try {
    const r = await axios.get(`https://graph.facebook.com/v19.0/${senderId}`, {
      params: { fields: "name", access_token: accessToken }
    });
    const name = r.data?.name || null;
    if (name) nameCache.set(senderId, name);
    return name;
  } catch (_) { return null; } // silently ignore — name is optional
}

async function sendInstagram(recipientId, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${IG_PAGE_ID}/messages`,
      { recipient: { id: recipientId }, message: { text } },
      { headers: { Authorization: `Bearer ${IG_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) { console.error("[Instagram] send failed:", err.response?.data || err.message); }
}

function verifySignature(req) {
  if (!META_APP_SECRET) return true;
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody || "").digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

module.exports = { router, sendInstagram };
