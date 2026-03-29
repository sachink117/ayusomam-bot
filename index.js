// ============================================================
// index.js - Entry point
// Sets up Express server, mounts platform routes, starts background jobs
// ============================================================
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");

const { WEBHOOK_VERIFY_TOKEN } = require("./src/config");
const { router: waRouter, sendWhatsApp } = require("./src/platforms/whatsapp");
const { router: igRouter, sendInstagram } = require("./src/platforms/instagram");
const { router: fbRouter, sendMessenger } = require("./src/platforms/messenger");
const { router: webRouter } = require("./src/platforms/website");
const { getStaleConversations, logFollowUp, getPendingThankYous, markThankYouSent } = require("./src/db");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Raw body capture (needed for HMAC signature verification) ----
app.use((req, res, next) => {
  let raw = "";
  req.on("data", chunk => raw += chunk);
  req.on("end", () => {
    req.rawBody = raw;
    next();
  });
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- Health check ----
app.get("/", (req, res) => res.json({ status: "ok", service: "Ayusomam Sinus Bot v3", ts: new Date() }));

// ---- Platform Routes ----
app.use("/whatsapp", waRouter);
app.use("/instagram", igRouter);
app.use("/messenger", fbRouter);
app.use("/website", webRouter);

// ---- Background Jobs ----

/**
 * Follow-up job: runs every 1 hour
 * Finds conversations silent for 24h and sends a gentle re-engagement message
 */
async function runFollowUps() {
  try {
    const stale = await getStaleConversations();
    for (const conv of stale) {
      const msg = "Aapke baare mein soch raha tha — kya aapki sinus ki problem abhi bhi hai? Main help kar sakta hoon.";
      try {
        if (conv.platform === "whatsapp")  await sendWhatsApp(conv.user_id, msg);
        if (conv.platform === "instagram") await sendInstagram(conv.user_id, msg);
        if (conv.platform === "messenger") await sendMessenger(conv.user_id, msg);
        await logFollowUp(conv.id, msg);
        console.log(`[FollowUp] Sent to ${conv.platform}/${conv.user_id}`);
      } catch (e) {
        console.error(`[FollowUp] Failed for ${conv.platform}/${conv.user_id}:`, e.message);
      }
    }
  } catch (err) {
    console.error("[FollowUp] runFollowUps error:", err.message);
  }
}

/**
 * Thank-you job: runs every 1 hour
 * Sends a thank-you to newly converted customers who haven't received one yet
 */
async function runThankYous() {
  try {
    const pending = await getPendingThankYous();
    for (const buyer of pending) {
      const msg = buyer.plan === "core_1299"
        ? "Shukriya! Aapka 14-Day Core Protocol order confirm ho gaya. Aaj bhej deta hoon. Koi bhi sawaal ho toh seedha yahan poochh sakte hain!"
        : "Shukriya! Aapka 7-Day Starter Protocol order confirm ho gaya. Aaj bhej deta hoon!";
      try {
        if (buyer.platform === "whatsapp")  await sendWhatsApp(buyer.user_id, msg);
        if (buyer.platform === "instagram") await sendInstagram(buyer.user_id, msg);
        if (buyer.platform === "messenger") await sendMessenger(buyer.user_id, msg);
        await markThankYouSent(buyer.id);
        console.log(`[ThankYou] Sent to ${buyer.platform}/${buyer.user_id}`);
      } catch (e) {
        console.error(`[ThankYou] Failed for ${buyer.platform}/${buyer.user_id}:`, e.message);
      }
    }
  } catch (err) {
    console.error("[ThankYou] runThankYous error:", err.message);
  }
}

/**
 * Keep-alive: pings itself every 10 minutes to prevent Render free-tier sleep
 */
function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      await fetch(`${url}/`);
    } catch (_) { /* ignore */ }
  }, 10 * 60 * 1000);
}

// ---- Start Server ----
app.listen(PORT, () => {
  console.log(`[Server] Ayusomam Sinus Bot v3 running on port ${PORT}`);

  // Start background jobs
  setInterval(runFollowUps, 60 * 60 * 1000);   // every 1 hour
  setInterval(runThankYous, 60 * 60 * 1000);   // every 1 hour
  startKeepAlive();

  // Run once at startup
  setTimeout(runFollowUps, 5000);
  setTimeout(runThankYous, 5000);
});
