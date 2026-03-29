// ============================================================
// agents/insights.js - Insights Agent
// Reads all conversations from last 24h, finds patterns in:
//   - objections, sinus types, language, drop points
// Generates actionable suggestions and saves to daily_insights.
// ============================================================
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const { SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_API_KEY } = require("../config");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const claude   = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

async function runInsightsAgent() {
  console.log("[InsightsAgent] Starting...");
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // 1. Get yesterday's conversations with their messages
    const { data: convs } = await supabase
      .from("conversations")
      .select("id, platform, stage, sinus_type, plan, language, converted_at, name")
      .gte("last_message_at", since);

    if (!convs || convs.length === 0) {
      console.log("[InsightsAgent] No conversations in last 24h.");
      return;
    }

    // 2. Get all messages for these conversations
    const convIds = convs.map(c => c.id);
    const { data: msgs } = await supabase
      .from("messages")
      .select("conversation_id, role, content, created_at")
      .in("conversation_id", convIds)
      .order("created_at", { ascending: true });

    // Group messages by conversation
    const msgMap = {};
    (msgs || []).forEach(m => {
      if (!msgMap[m.conversation_id]) msgMap[m.conversation_id] = [];
      msgMap[m.conversation_id].push(`${m.role.toUpperCase()}: ${m.content}`);
    });

    // 3. Extract objections from objections table
    const { data: objections } = await supabase
      .from("objections")
      .select("objection_text, resolved")
      .gte("created_at", since);

    const objCount = {};
    (objections || []).forEach(o => {
      const k = o.objection_text.toLowerCase().slice(0, 50);
      objCount[k] = (objCount[k] || 0) + 1;
    });
    const topObjections = Object.entries(objCount)
      .sort((a,b) => b[1]-a[1]).slice(0,5)
      .map(([text, count]) => ({ text, count }));

    // 4. Language and sinus mix
    const langMix = {}, sinusMix = {};
    convs.forEach(c => {
      langMix[c.language]    = (langMix[c.language]    || 0) + 1;
      if (c.sinus_type) sinusMix[c.sinus_type] = (sinusMix[c.sinus_type] || 0) + 1;
    });

    // 5. Build representative sample of conversations (max 10 for Claude)
    const sample = convs.slice(0, 10).map(c => ({
      stage:    c.stage,
      language: c.language,
      sinus_type: c.sinus_type,
      converted: !!c.converted_at,
      messages: (msgMap[c.id] || []).slice(-6).join("\n"), // last 6 messages
    }));

    // 6. Ask Claude for pattern analysis
    const prompt = `You are an expert sales coach for Ayusomam Herbals, an Ayurvedic sinus brand.
Analyse these ${convs.length} customer conversations from the last 24 hours and give me actionable insights.

Language mix: ${JSON.stringify(langMix)}
Sinus type mix: ${JSON.stringify(sinusMix)}
Top objections seen: ${JSON.stringify(topObjections)}

Sample conversations:
${sample.map((s,i) => `--- Conversation ${i+1} (stage: ${s.stage}, converted: ${s.converted}) ---\n${s.messages}`).join('\n\n')}

Provide insights in this JSON format:
{
  "patterns": ["pattern 1", "pattern 2", "pattern 3"],
  "winning_phrases": ["phrase that worked well"],
  "problem_areas": ["specific issue to fix"],
  "prompt_suggestions": [
    { "area": "objection handling", "current_problem": "...", "suggested_addition": "..." }
  ],
  "tomorrow_focus": "one thing to focus on improving tomorrow"
}
Keep each item under 2 sentences. Be specific and actionable.`;

    const resp = await claude.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 800,
      messages: [{ role: "user", content: prompt }]
    });

    let analysis = {};
    try { analysis = JSON.parse(resp.content[0].text.replace(/```json\n?|\n?```/g,'')); }
    catch(_) { analysis = { raw: resp.content[0].text }; }

    // 7. Save/merge into daily_insights
    const today = new Date().toISOString().slice(0,10);
    const existing = await supabase.from("daily_insights").select("*").eq("report_date", today).single();

    const suggestions = (analysis.prompt_suggestions || []).map((s,i) => ({
      priority: i + 10,
      area: s.area,
      suggestion: s.suggested_addition,
      action: "update prompt"
    }));

    await supabase.from("daily_insights").upsert({
      report_date: today,
      top_objections: topObjections,
      language_mix:   langMix,
      sinus_type_mix: sinusMix,
      suggestions: [...(existing.data?.suggestions || []), ...suggestions],
      raw_analysis: JSON.stringify(analysis),
    }, { onConflict: "report_date" });

    console.log(`[InsightsAgent] Done. Analysed ${convs.length} conversations. Top objection: ${topObjections[0]?.text || "none"}`);
    return analysis;
  } catch (err) {
    console.error("[InsightsAgent] Error:", err.message);
  }
}

module.exports = { runInsightsAgent };
