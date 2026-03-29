// ============================================================
// routes/api.js  —  Dashboard REST API
// All endpoints prefixed /api/*
// ============================================================
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { SUPABASE_URL, SUPABASE_KEY } = require("../config");
const { sendWhatsApp }   = require("../platforms/whatsapp");
const { sendInstagram }  = require("../platforms/instagram");
const { sendMessenger }  = require("../platforms/messenger");
const { logMessage }     = require("../db");

const router = express.Router();
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── GET /api/stats  —  dashboard header numbers ──────────────
router.get("/stats", async (req, res) => {
  try {
    const since24h = new Date(Date.now() - 24*3600000).toISOString();

    const [total, today, converted, pending] = await Promise.all([
      supabase.from("conversations").select("id", { count:"exact", head:true }),
      supabase.from("conversations").select("id", { count:"exact", head:true }).gte("created_at", since24h),
      supabase.from("conversations").select("id", { count:"exact", head:true }).eq("stage","converted"),
      supabase.from("conversations").select("id", { count:"exact", head:true }).eq("stage","payment_pending"),
    ]);

    // Stage distribution — ALL TIME
    const { data: stageCounts } = await supabase
      .from("conversations").select("stage");
    const stages = {};
    (stageCounts||[]).forEach(r => { stages[r.stage] = (stages[r.stage]||0)+1; });

    // Plan distribution (starter vs core) from converted leads
    const { data: planData } = await supabase
      .from("conversations").select("plan").eq("stage","converted");
    const plans = { starter_499: 0, core_1299: 0 };
    (planData||[]).forEach(r => { if (r.plan) plans[r.plan] = (plans[r.plan]||0)+1; });

    // Platform distribution — ALL TIME
    const { data: platData } = await supabase
      .from("conversations").select("platform");
    const platforms = {};
    (platData||[]).forEach(r => { platforms[r.platform] = (platforms[r.platform]||0)+1; });

    res.json({
      total:     total.count     || 0,
      today:     today.count     || 0,
      converted: converted.count || 0,
      pending:   pending.count   || 0,
      stages,
      platforms,
      plans,
    });
  } catch(err) { res.status(500).json({error: err.message}); }
});

// ── GET /api/conversations  —  paginated lead list ───────────
router.get("/conversations", async (req, res) => {
  try {
    const { platform, stage, search, limit=30, offset=0 } = req.query;

    let q = supabase
      .from("conversations")
      .select("*, lead_profiles(*)")
      .order("last_message_at", { ascending:false })
      .range(parseInt(offset), parseInt(offset)+parseInt(limit)-1);

    if (platform) q = q.eq("platform", platform);
    if (stage)    q = q.eq("stage",    stage);
    if (search)   q = q.ilike("name",  `%${search}%`);

    let { data, error } = await q;

    // If lead_profiles table doesn't exist, fall back to simple query
    if (error && error.message && error.message.includes("lead_profiles")) {
      let q2 = supabase
        .from("conversations")
        .select("*")
        .order("last_message_at", { ascending:false })
        .range(parseInt(offset), parseInt(offset)+parseInt(limit)-1);
      if (platform) q2 = q2.eq("platform", platform);
      if (stage)    q2 = q2.eq("stage",    stage);
      if (search)   q2 = q2.ilike("name",  `%${search}%`);
      const res2 = await q2;
      data = res2.data;
      error = res2.error;
    }

    if (error) return res.status(500).json({error: error.message});
    // Enrich each conversation with the last message preview
    const convList = data || [];
    if (convList.length > 0) {
      const ids = convList.map(c => c.id);
      const { data: lastMsgs } = await supabase
        .from('messages')
        .select('conversation_id, content, created_at')
        .in('conversation_id', ids)
        .order('created_at', { ascending: false });
      const lastMap = {};
      (lastMsgs || []).forEach(m => { if (!lastMap[m.conversation_id]) lastMap[m.conversation_id] = m.content; });
      convList.forEach(c => { c.last_message_preview = (lastMap[c.id]||'').slice(0,120) || null; });
    }
    res.json({ conversations: convList, total: convList.length });
  } catch(err) { res.status(500).json({error: err.message}); }
});

// ── GET /api/conversations/:id  —  single conv + messages ────
router.get("/conversations/:id", async (req, res) => {
  try {
    const { id } = req.params;

    let convRes = await supabase.from("conversations").select("*, lead_profiles(*)").eq("id", id).single();

    // Fallback if lead_profiles missing
    if (convRes.error && convRes.error.message && convRes.error.message.includes("lead_profiles")) {
      convRes = await supabase.from("conversations").select("*").eq("id", id).single();
    }

    const msgRes = await supabase.from("messages").select("*").eq("conversation_id", id).order("created_at");

    if (convRes.error) return res.status(404).json({error:"Not found"});
    res.json({ conversation: convRes.data, messages: msgRes.data||[] });
  } catch(err) { res.status(500).json({error: err.message}); }
});

// ── POST /api/conversations/:id/reply  ────────────────────────
router.post("/conversations/:id/reply", async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({error:"text required"});

    const { data: conv } = await supabase
      .from("conversations").select("*").eq("id", id).single();
    if (!conv) return res.status(404).json({error:"Conversation not found"});

    if (conv.platform === "whatsapp")  await sendWhatsApp(conv.user_id,  text);
    if (conv.platform === "instagram") await sendInstagram(conv.user_id, text);
    if (conv.platform === "messenger") await sendMessenger(conv.user_id, text);

    await logMessage(id, "assistant", text);
    res.json({ ok:true, platform: conv.platform, to: conv.user_id });
  } catch(err) { res.status(500).json({error: err.message}); }
});

// ── GET /api/funnel  —  ALL-TIME funnel (uses current stage) ──
router.get("/funnel", async (req, res) => {
  try {
    const STAGES = ["initiated","qualifier","duration","discharge","reveal","insight","close","objection","payment_pending","converted"];

    // Try funnel_events first (more accurate journey tracking)
    let { data: events } = await supabase
      .from("funnel_events").select("conversation_id, to_stage");

    // Get all conversations
    const { data: allConvs } = await supabase
      .from("conversations").select("id, stage");

    const total = (allConvs||[]).length || 1;

    let maxStage = {};
    if (events && events.length > 0) {
      events.forEach(e => {
        const cur = maxStage[e.conversation_id];
        if (!cur || STAGES.indexOf(e.to_stage) > STAGES.indexOf(cur)) {
          maxStage[e.conversation_id] = e.to_stage;
        }
      });
    } else {
      // Use current stage as proxy for highest stage reached
      (allConvs||[]).forEach(c => { maxStage[c.id] = c.stage; });
    }

    // Count cumulative reach for each stage
    const reached = {};
    STAGES.forEach(s => reached[s] = 0);
    Object.values(maxStage).forEach(s => {
      const idx = STAGES.indexOf(s);
      if (idx < 0) return;
      for (let i = 0; i <= idx; i++) reached[STAGES[i]]++;
    });

    const rows = STAGES.map(s => ({
      stage: s,
      count: reached[s] || 0,
      pct:   total > 0 ? Math.round((reached[s]||0) / total * 100) : 0,
    }));

    res.json({ total, rows, since: "all-time" });
  } catch(err) { res.status(500).json({error: err.message}); }
});

// ── GET /api/insights  —  recent daily insights ──────────────
router.get("/insights", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("daily_insights")
      .select("*")
      .order("report_date", { ascending:false })
      .limit(7);
    if (error) return res.json([]);
    res.json(data || []);
  } catch(err) { res.json([]); }
});

// ── GET /api/insights/trigger/:type  —  manual agent trigger ──
router.get("/insights/trigger/:type", async (req, res) => {
  try {
    const { runFunnelAgent }      = require("../agents/funnel");
    const { runInsightsAgent }    = require("../agents/insights");
    const { runImprovementAgent } = require("../agents/improvement");
    const agentMap = {
      funnel:      runFunnelAgent,
      insights:    runInsightsAgent,
      improvement: runImprovementAgent,
      followup:    async () => ({ ok: true, note: "Follow-up runs from scheduler" }),
    };
    const fn = agentMap[req.params.type];
    if (!fn) return res.status(400).json({error:"Unknown agent"});
    const result = await fn();
    res.json({ ok:true, result });
  } catch(err) { res.status(500).json({error: err.message}); }
});

// ── POST /api/conversations/:id/mark-converted  ──────────────
router.post("/conversations/:id/mark-converted", async (req, res) => {
  try {
    const { id } = req.params;
    const { plan } = req.body;
    await supabase.from("conversations")
      .update({ stage:"converted", converted_at: new Date().toISOString(), plan: plan||"starter_499" })
      .eq("id", id);
    res.json({ ok:true });
  } catch(err) { res.status(500).json({error: err.message}); }
});

// ── GET /api/agents  —  agent status overview ─────────────────
router.get("/agents", async (req, res) => {
  try {
    const { data: latest } = await supabase
      .from("daily_insights")
      .select("report_date, conversion_rate, top_objections")
      .order("report_date", { ascending:false })
      .limit(1)
      .single();

    const { count: staleCount } = await supabase
      .from("conversations")
      .select("id", { count:"exact", head:true })
      .lt("last_message_at", new Date(Date.now() - 24*3600000).toISOString())
      .not("stage", "in", "(converted,payment_pending)");

    res.json({
      funnel:      { lastRun: latest?.report_date || null, schedule: "Daily 7am" },
      insights:    { lastRun: latest?.report_date || null, schedule: "Daily 8am" },
      followup:    { staleLeads: staleCount || 0, schedule: "Every 1hr" },
      improvement: { schedule: "Weekly Sunday", lastInsight: latest?.top_objections?.[0] || null },
    });
  } catch(err) {
    res.json({
      funnel: { lastRun: null, schedule: "Daily 7am" },
      insights: { lastRun: null, schedule: "Daily 8am" },
      followup: { staleLeads: 0, schedule: "Every 1hr" },
      improvement: { schedule: "Weekly Sunday" },
    });
  }
});

module.exports = router;
