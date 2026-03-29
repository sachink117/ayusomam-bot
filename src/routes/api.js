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
    const since7d  = new Date(Date.now() - 7*86400000).toISOString();

    const [total, today, converted, pending] = await Promise.all([
      supabase.from("conversations").select("id", { count:"exact", head:true }),
      supabase.from("conversations").select("id", { count:"exact", head:true }).gte("created_at", since24h),
      supabase.from("conversations").select("id", { count:"exact", head:true }).eq("stage","converted"),
      supabase.from("conversations").select("id", { count:"exact", head:true }).eq("stage","payment_pending"),
    ]);

    // Stage distribution for mini funnel
    const { data: stageCounts } = await supabase
      .from("conversations")
      .select("stage")
      .gte("created_at", since7d);

    const stages = {};
    (stageCounts||[]).forEach(r => { stages[r.stage] = (stages[r.stage]||0)+1; });

    // Platform distribution
    const { data: platData } = await supabase
      .from("conversations").select("platform").gte("created_at", since7d);
    const platforms = {};
    (platData||[]).forEach(r => { platforms[r.platform] = (platforms[r.platform]||0)+1; });

    res.json({
      total:     total.count     || 0,
      today:     today.count     || 0,
      converted: converted.count || 0,
      pending:   pending.count   || 0,
      stages,
      platforms,
    });
  } catch(err) { res.status(500).json({error: err.message}); }
});

// ── GET /api/conversations  —  paginated lead list ───────────
// Query: ?platform=whatsapp&stage=close&search=Rahul&limit=30&offset=0
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

    const { data, error, count } = await q;
    if (error) return res.status(500).json({error: error.message});
    res.json({ conversations: data||[], total: count||0 });
  } catch(err) { res.status(500).json({error: err.message}); }
});

// ── GET /api/conversations/:id  —  single conv + messages ────
router.get("/conversations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [convRes, msgRes] = await Promise.all([
      supabase.from("conversations").select("*, lead_profiles(*)").eq("id", id).single(),
      supabase.from("messages").select("*").eq("conversation_id", id).order("created_at"),
    ]);
    if (convRes.error) return res.status(404).json({error:"Not found"});
    res.json({ conversation: convRes.data, messages: msgRes.data||[] });
  } catch(err) { res.status(500).json({error: err.message}); }
});

// ── POST /api/conversations/:id/reply  —  send a manual reply ─
router.post("/conversations/:id/reply", async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({error:"text required"});

    const { data: conv } = await supabase
      .from("conversations").select("*").eq("id", id).single();
    if (!conv) return res.status(404).json({error:"Conversation not found"});

    // Send via correct platform
    if (conv.platform === "whatsapp")  await sendWhatsApp(conv.user_id,  text);
    if (conv.platform === "instagram") await sendInstagram(conv.user_id, text);
    if (conv.platform === "messenger") await sendMessenger(conv.user_id, text);
    // website: just log it — no send channel

    // Log to DB
    await logMessage(id, "assistant", text);

    res.json({ ok:true, platform: conv.platform, to: conv.user_id });
  } catch(err) { res.status(500).json({error: err.message}); }
});

// ── GET /api/funnel  —  7-day funnel data ────────────────────
router.get("/funnel", async (req, res) => {
  try {
    const since = new Date(Date.now() - 7*86400000).toISOString();
    const STAGES = ["initiated","qualifier","duration","discharge","reveal","insight","close","objection","payment_pending","converted"];

    // Use funnel_events for accurate counts
    const { data: events } = await supabase
      .from("funnel_events").select("conversation_id, to_stage").gte("created_at", since);

    // Fallback to conversations.stage
    const { data: convs } = await supabase
      .from("conversations").select("stage, converted_at").gte("created_at", since);

    const maxStage = {};
    if (events && events.length > 0) {
      events.forEach(e => {
        const cur = maxStage[e.conversation_id];
        if (!cur || STAGES.indexOf(e.to_stage) > STAGES.indexOf(cur)) maxStage[e.conversation_id] = e.to_stage;
      });
    } else {
      (convs||[]).forEach((c,i) => { maxStage[i] = c.stage; });
    }

    const total = (convs||[]).length || Object.keys(maxStage).length || 1;
    const reached = {};
    STAGES.forEach(s => reached[s] = 0);
    Object.values(maxStage).forEach(s => {
      // everyone who reached stage X also reached all prior stages
      const idx = STAGES.indexOf(s);
      for (let i=0; i<=idx; i++) reached[STAGES[i]]++;
    });

    const rows = STAGES.map(s => ({
      stage: s,
      count: reached[s] || 0,
      pct:   total > 0 ? Math.round((reached[s]||0)/total*100) : 0,
    }));

    res.json({ total, rows, since });
  } catch(err) { res.status(500).json({error: err.message}); }
});

// ── GET /api/insights  —  today + recent daily insights ──────
router.get("/insights", async (req, res) => {
  try {
    const { data } = await supabase
      .from("daily_insights")
      .select("*")
      .order("report_date", { ascending:false })
      .limit(7);
    res.json(data || []);
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

module.exports = router;
