// ============================================================
// agents/funnel.js - Funnel Agent
// Runs daily. Calculates stage-by-stage drop-offs for the last 7 days,
// finds the biggest leak, and saves structured results to daily_insights.
// ============================================================
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const { SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_API_KEY } = require("../config");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const claude   = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const STAGE_ORDER = [
  "initiated","qualifier","duration","discharge",
  "reveal","insight","close","objection","payment_pending","converted"
];

async function runFunnelAgent() {
  console.log("[FunnelAgent] Starting...");
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Count conversations per stage in last 7 days
    const { data: convs } = await supabase
      .from("conversations")
      .select("stage, platform, sinus_type, converted_at")
      .gte("created_at", since);

    if (!convs || convs.length === 0) { console.log("[FunnelAgent] No data yet."); return; }

    // Build stage counts
    const stageCounts = {};
    STAGE_ORDER.forEach(s => stageCounts[s] = 0);
    // Count by max stage reached (use funnel_events if available, else current stage)
    const { data: events } = await supabase
      .from("funnel_events")
      .select("conversation_id, to_stage")
      .gte("created_at", since);

    if (events && events.length > 0) {
      // Use funnel_events for accurate counts
      const maxStage = {};
      events.forEach(e => {
        const cur = maxStage[e.conversation_id];
        const curIdx = cur ? STAGE_ORDER.indexOf(cur) : -1;
        const newIdx = STAGE_ORDER.indexOf(e.to_stage);
        if (newIdx > curIdx) maxStage[e.conversation_id] = e.to_stage;
      });
      Object.values(maxStage).forEach(s => { if (stageCounts[s] !== undefined) stageCounts[s]++; });
    } else {
      // Fallback: use current stage on conversations
      convs.forEach(c => { if (stageCounts[c.stage] !== undefined) stageCounts[c.stage]++; });
    }

    // Cumulative counts (everyone who reached stage X also reached all prior stages)
    const total = convs.length;
    const cumulative = {};
    let running = total;
    STAGE_ORDER.forEach(s => { cumulative[s] = running; running = Math.max(0, running - stageCounts[s]); });
    cumulative["initiated"] = total;

    // Drop-offs between stages
    const dropOffs = [];
    for (let i = 1; i < STAGE_ORDER.length; i++) {
      const from = STAGE_ORDER[i-1], to = STAGE_ORDER[i];
      const fromCount = cumulative[from] || 0;
      const toCount   = cumulative[to]   || 0;
      const drop = fromCount > 0 ? Math.round((fromCount - toCount) / fromCount * 100) : 0;
      dropOffs.push({ from, to, fromCount, toCount, dropPct: drop });
    }

    const biggestLeak = dropOffs.reduce((a,b) => b.dropPct > a.dropPct ? b : a, dropOffs[0]);
    const conversionRate = total > 0 ? ((cumulative["converted"] || 0) / total * 100).toFixed(1) : 0;

    // Platform + sinus type mix
    const platformMix = {}, sinusMix = {};
    convs.forEach(c => {
      platformMix[c.platform] = (platformMix[c.platform] || 0) + 1;
      if (c.sinus_type) sinusMix[c.sinus_type] = (sinusMix[c.sinus_type] || 0) + 1;
    });

    // 2. Ask Claude for interpretation and fix suggestion
    const prompt = `You are a conversion optimisation analyst for Ayusomam Herbals, an Ayurvedic sinus treatment brand.

Here is the 7-day funnel data:
Total leads: ${total}
Stage counts (cumulative): ${JSON.stringify(cumulative, null, 2)}
Drop-offs: ${JSON.stringify(dropOffs, null, 2)}
Biggest leak: ${biggestLeak.from} → ${biggestLeak.to} (${biggestLeak.dropPct}% drop)
Conversion rate: ${conversionRate}%
Platform mix: ${JSON.stringify(platformMix)}
Sinus type mix: ${JSON.stringify(sinusMix)}

Give me:
1. A 2-sentence summary of the funnel health
2. The single most impactful fix for the biggest leak (be specific — what exact message or prompt change)
3. Two other quick wins

Be concise and actionable. Format as JSON:
{
  "summary": "...",
  "biggest_leak_fix": { "stage": "...", "issue": "...", "fix": "..." },
  "quick_wins": ["...", "..."]
}`;

    const resp = await claude.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 600,
      messages: [{ role: "user", content: prompt }]
    });
    let analysis = {};
    try { analysis = JSON.parse(resp.content[0].text.replace(/```json\n?|\n?```/g,'')); }
    catch(_) { analysis = { summary: resp.content[0].text }; }

    // 3. Save to daily_insights
    const today = new Date().toISOString().slice(0,10);
    const funnel_summary = { total, stageCounts, cumulative, dropOffs, biggestLeak, conversionRate };
    await supabase.from("daily_insights").upsert({
      report_date: today,
      funnel_summary,
      sinus_type_mix: sinusMix,
      conversion_rate: parseFloat(conversionRate),
      suggestions: analysis.biggest_leak_fix ? [
        { priority: 1, area: "funnel", suggestion: analysis.biggest_leak_fix.fix, action: `Fix ${analysis.biggest_leak_fix.stage} stage` },
        ...((analysis.quick_wins||[]).map((w,i) => ({ priority: i+2, area:"funnel", suggestion:w, action:"review" })))
      ] : [],
      raw_analysis: JSON.stringify(analysis),
    }, { onConflict: "report_date" });

    console.log(`[FunnelAgent] Done. Conversion: ${conversionRate}%. Biggest leak: ${biggestLeak.from}→${biggestLeak.to} (${biggestLeak.dropPct}%)`);
    return { conversionRate, biggestLeak, analysis };
  } catch (err) {
    console.error("[FunnelAgent] Error:", err.message);
  }
}

module.exports = { runFunnelAgent };
