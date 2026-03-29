// ============================================================
// agents/improvement.js - Improvement Agent
// Runs weekly. Compares this week vs last week.
// Outputs a ranked improvement list with specific prompt patches.
// ============================================================
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const { SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_API_KEY } = require("../config");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const claude   = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

async function runImprovementAgent() {
  console.log("[ImprovementAgent] Starting weekly analysis...");
  try {
    const now  = new Date();
    const w1start = new Date(now - 7  * 86400000).toISOString();
    const w2start = new Date(now - 14 * 86400000).toISOString();

    // Get this week and last week daily_insights
    const { data: thisWeek } = await supabase
      .from("daily_insights")
      .select("*")
      .gte("report_date", w1start.slice(0,10));

    const { data: lastWeek } = await supabase
      .from("daily_insights")
      .select("*")
      .gte("report_date", w2start.slice(0,10))
      .lt("report_date", w1start.slice(0,10));

    // Aggregate conversion rates
    const avgRate = (rows) => rows.length === 0 ? 0 :
      (rows.reduce((s,r) => s + (parseFloat(r.conversion_rate)||0), 0) / rows.length).toFixed(1);

    const thisRate = avgRate(thisWeek || []);
    const lastRate = avgRate(lastWeek || []);
    const delta = (parseFloat(thisRate) - parseFloat(lastRate)).toFixed(1);

    // Aggregate top objections across the week
    const objMap = {};
    (thisWeek || []).forEach(r => {
      (r.top_objections || []).forEach(o => {
        objMap[o.text] = (objMap[o.text] || 0) + o.count;
      });
    });
    const weeklyObjections = Object.entries(objMap)
      .sort((a,b)=>b[1]-a[1]).slice(0,5)
      .map(([text,count])=>({text,count}));

    // Aggregate all suggestions from the week
    const allSuggestions = (thisWeek||[]).flatMap(r => r.suggestions||[]);

    // Ask Claude for weekly brief + ranked improvements
    const prompt = `You are the product improvement analyst for Ayusomam Herbals sinus bot.

This week vs last week:
- Conversion rate this week: ${thisRate}% (was ${lastRate}% last week, delta: ${delta > 0 ? '+' : ''}${delta}%)
- Days analysed this week: ${(thisWeek||[]).length}

Weekly recurring objections: ${JSON.stringify(weeklyObjections)}

Improvement suggestions collected this week:
${JSON.stringify(allSuggestions.slice(0,15), null, 2)}

Give me a weekly improvement brief in JSON:
{
  "headline": "one sentence summary of this week",
  "trend": "improving|declining|stable",
  "ranked_improvements": [
    {
      "rank": 1,
      "impact": "high|medium|low",
      "area": "prompt|flow|follow-up|language|objection",
      "title": "short title",
      "what_to_do": "specific instruction for what to change",
      "expected_impact": "what improvement to expect"
    }
  ],
  "dont_touch": "what is working well and should NOT be changed"
}
Give top 5 ranked improvements. Be very specific about what to change.`;

    const resp = await claude.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    });

    let brief = {};
    try { brief = JSON.parse(resp.content[0].text.replace(/```json\n?|\n?```/g,'')); }
    catch(_) { brief = { headline: resp.content[0].text }; }

    console.log(`[ImprovementAgent] Done. ${brief.headline || 'Analysis complete'}`);
    console.log(`[ImprovementAgent] Trend: ${brief.trend} | Conv: ${lastRate}% → ${thisRate}%`);
    if (brief.ranked_improvements) {
      brief.ranked_improvements.slice(0,3).forEach(i => {
        console.log(`  [${i.rank}] ${i.impact.toUpperCase()} — ${i.title}`);
      });
    }

    return { brief, thisRate, lastRate, delta };
  } catch (err) {
    console.error("[ImprovementAgent] Error:", err.message);
  }
}

module.exports = { runImprovementAgent };
