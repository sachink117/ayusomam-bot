// ============================================================
// index.js - Entry point
// Express server + platform routes + scheduled agent jobs
// ============================================================
require("dotenv").config();
const express = require("express");

const { WEBHOOK_VERIFY_TOKEN } = require("./src/config");
const { router: waRouter, sendWhatsApp } = require("./src/platforms/whatsapp");
const { router: igRouter, sendInstagram } = require("./src/platforms/instagram");
const { router: fbRouter, sendMessenger } = require("./src/platforms/messenger");
const { router: webRouter } = require("./src/platforms/website");
const { getStaleConversations, logFollowUp, getPendingThankYous, markThankYouSent } = require("./src/db");
const { processMessage } = require("./src/bot");

// Agents
const { runFunnelAgent }      = require("./src/agents/funnel");
const { runInsightsAgent }    = require("./src/agents/insights");
const { runImprovementAgent } = require("./src/agents/improvement");

const app  = express();
const PORT = process.env.PORT || 3000;

// ---- Raw body capture (HMAC signature verification) ----
app.use((req, res, next) => {
  let raw = "";
  req.on("data", chunk => raw += chunk);
  req.on("end", () => { req.rawBody = raw; next(); });
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- Health check ----
app.get("/", (req, res) => res.json({ status: "ok", service: "Ayusomam Sinus Bot v3", ts: new Date() }));

// ---- Platform Routes ----
app.use("/whatsapp", waRouter);
app.use("/instagram", igRouter);
app.use("/messenger", fbRouter);
app.use("/website",   webRouter);

// ---- Insights API ----
// GET /insights          → today's insights
// GET /insights/:date    → specific date (YYYY-MM-DD)
// GET /insights/trigger/funnel    → manually run funnel agent
// GET /insights/trigger/insights  → manually run insights agent
// GET /insights/trigger/improve   → manually run improvement agent
const { createClient } = require("@supabase/supabase-js");
const { SUPABASE_URL, SUPABASE_KEY } = require("./src/config");
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.get("/insights/trigger/funnel", async (req, res) => {
  const result = await runFunnelAgent();
  res.json({ ok: true, result });
});
app.get("/insights/trigger/insights", async (req, res) => {
  const result = await runInsightsAgent();
  res.json({ ok: true, result });
});
app.get("/insights/trigger/improve", async (req, res) => {
  const result = await runImprovementAgent();
  res.json({ ok: true, result });
});
app.get("/insights/:date?", async (req, res) => {
  const date = req.params.date || new Date().toISOString().slice(0,10);
  const { data, error } = await supabase.from("daily_insights").select("*").eq("report_date", date).single();
  if (error) return res.status(404).json({ error: "No insights for this date", date });
  res.json(data);
});

// ---- Leads API (for viewing lead profiles) ----
// GET /leads             → recent leads with profiles
// GET /leads/:platform   → filter by platform
app.get("/leads/:platform?", async (req, res) => {
  let query = supabase
    .from("conversations")
    .select("*, lead_profiles(*)")
    .order("last_message_at", { ascending: false })
    .limit(50);
  if (req.params.platform) query = query.eq("platform", req.params.platform);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---- Background Jobs ----

async function runFollowUps() {
  try {
    const stale = await getStaleConversations();
    for (const conv of stale) {
      // Personalised follow-up based on sinus type and stage
      const sinusHook = {
        kaphavata_allergic: "Aapki allergic sinus problem ke baare mein soch raha tha.",
        pitta_inflammatory: "Thick discharge waali problem ke baare mein soch raha tha.",
        vata_dry:           "Aapke dry sinus ke baare mein soch raha tha.",
        kapha_congestive:   "Aapki heavy congestion ke baare mein soch raha tha.",
        tridosha_chronic:   "Aapki chronic sinus problem ke baare mein soch raha tha.",
      };
      const hook = sinusHook[conv.sinus_type] || "Aapke baare mein soch raha tha.";
      const name = conv.name ? ` ${conv.name.split(" ")[0]}` : "";
      const msg  = `${hook}${name} — kya aap abhi bhi sinus se pareshan hain? Main help kar sakta hoon.`;
      try {
        if (conv.platform === "whatsapp")  await sendWhatsApp(conv.user_id, msg);
        if (conv.platform === "instagram") await sendInstagram(conv.user_id, msg);
        if (conv.platform === "messenger") await sendMessenger(conv.user_id, msg);
        await logFollowUp(conv.id, msg);
        console.log(`[FollowUp] Sent to ${conv.platform}/${conv.name||conv.user_id}`);
      } catch(e) { console.error(`[FollowUp] Failed:`, e.message); }
    }
  } catch(err) { console.error("[FollowUp] Error:", err.message); }
}

async function runThankYous() {
  try {
    const pending = await getPendingThankYous();
    for (const buyer of pending) {
      const msg = buyer.plan === "core_1299"
        ? "Shukriya! Aapka 14-Day Core Protocol aaj courier se bhej raha hoon. Tracking kal tak bhejunga. 🙏"
        : "Shukriya! Aapka 7-Day Starter Protocol aaj courier se bhej raha hoon. Tracking kal tak bhejunga. 🙏";
      try {
        if (buyer.platform === "whatsapp")  await sendWhatsApp(buyer.user_id, msg);
        if (buyer.platform === "instagram") await sendInstagram(buyer.user_id, msg);
        if (buyer.platform === "messenger") await sendMessenger(buyer.user_id, msg);
        await markThankYouSent(buyer.id);
      } catch(e) { console.error(`[ThankYou] Failed:`, e.message); }
    }
  } catch(err) { console.error("[ThankYou] Error:", err.message); }
}

function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => { try { await fetch(`${url}/`); } catch(_) {} }, 10 * 60 * 1000);
}

// ---- Start Server ----
app.listen(PORT, () => {
  console.log(`[Server] Ayusomam Sinus Bot v3 on port ${PORT}`);

  // Customer-facing jobs (every 1 hour)
  setInterval(runFollowUps, 60 * 60 * 1000);
  setInterval(runThankYous, 60 * 60 * 1000);

  // Intelligence agents
  // Funnel Agent:      daily at 7:00am
  // Insights Agent:    daily at 8:00am
  // Improvement Agent: every Sunday

  function scheduleDaily(hour, fn, name) {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next - now;
    setTimeout(() => { fn(); setInterval(fn, 24 * 60 * 60 * 1000); }, delay);
    console.log(`[Scheduler] ${name} scheduled in ${Math.round(delay/60000)} min`);
  }

  function scheduleWeekly(dayOfWeek, hour, fn, name) {
    const now = new Date();
    const next = new Date(now);
    const daysUntil = (dayOfWeek - now.getDay() + 7) % 7 || 7;
    next.setDate(now.getDate() + daysUntil);
    next.setHours(hour, 0, 0, 0);
    const delay = next - now;
    setTimeout(() => { fn(); setInterval(fn, 7 * 24 * 60 * 60 * 1000); }, delay);
    console.log(`[Scheduler] ${name} scheduled in ${Math.round(delay/3600000)} hr`);
  }

  scheduleDaily(7, runFunnelAgent,   "FunnelAgent");
  scheduleDaily(8, runInsightsAgent, "InsightsAgent");
  scheduleWeekly(0, 9, runImprovementAgent, "ImprovementAgent"); // Sunday 9am

  startKeepAlive();

  // Run once at startup (with delay to let DB connections settle)
  setTimeout(runFollowUps, 5000);
  setTimeout(runThankYous, 5000);
});
