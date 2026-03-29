// ============================================================
// platforms/website.js - REST API for website chat widget
// POST /website/chat { sessionId, message } → { reply, stage }
// ============================================================
const express = require("express");
const { processMessage } = require("../bot");

const router = express.Router();

router.post("/chat", async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!sessionId || !message) {
    return res.status(400).json({ error: "sessionId and message are required" });
  }

  try {
    const reply = await processMessage("website", sessionId, message);
    res.json({ reply, stage: "ok" });
  } catch (err) {
    console.error("[Website] chat error:", err.message);
    res.status(500).json({ error: "Internal error. Please try again." });
  }
});

module.exports = { router };
