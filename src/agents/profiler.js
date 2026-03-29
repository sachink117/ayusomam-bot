// ============================================================
// agents/profiler.js - Lead Profiler Agent
// Runs after every conversation update (called from bot.js).
// Extracts structured clinical data from message history and
// stores it in lead_profiles for easy viewing and follow-up.
// ============================================================
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const { SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_API_KEY } = require("../config");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const claude   = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Only profile at these stages (enough data to extract from)
const PROFILE_STAGES = ["discharge", "reveal", "insight", "close", "objection", "payment_pending", "converted"];

/**
 * Extract and save structured profile from conversation.
 * Called as fire-and-forget after message processing.
 */
async function profileLead(convId, stage) {
  if (!PROFILE_STAGES.includes(stage)) return;

  try {
    // Get messages
    const { data: msgs } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true });

    if (!msgs || msgs.length < 4) return; // not enough data yet

    const transcript = msgs.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n");

    const prompt = `Extract structured clinical data from this sinus consultation transcript.

TRANSCRIPT:
${transcript}

Return ONLY valid JSON (no markdown):
{
  "symptoms": ["symptom1", "symptom2"],
  "duration_text": "as mentioned by patient",
  "duration_months": <estimated integer or null>,
  "discharge_type": "clear|yellow|green|thick|dry|none|unknown",
  "triggers": ["trigger1", "trigger2"],
  "highlights": ["DNS", "polyp", "surgery history", "failed antibiotics", "seasonal allergy", etc — only if mentioned],
  "previous_treatments": ["treatment1"],
  "severity": "mild|moderate|severe",
  "notes": "one sentence clinical summary"
}
If information is not mentioned, use empty array [] or null. Do not invent data.`;

    const resp = await claude.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 400,
      messages: [{ role: "user", content: prompt }]
    });

    let profile = {};
    try { profile = JSON.parse(resp.content[0].text.replace(/```json\n?|\n?```/g,'')); }
    catch(_) { return; } // silently skip if parsing fails

    // Upsert into lead_profiles
    await supabase.from("lead_profiles").upsert({
      conversation_id: convId,
      symptoms:         profile.symptoms        || [],
      duration_text:    profile.duration_text   || null,
      duration_months:  profile.duration_months || null,
      discharge_type:   profile.discharge_type  || null,
      triggers:         profile.triggers        || [],
      highlights:       profile.highlights      || [],
      previous_treatments: profile.previous_treatments || [],
      severity:         profile.severity        || null,
      notes:            profile.notes           || null,
      updated_at:       new Date().toISOString(),
    }, { onConflict: "conversation_id" });

    console.log(`[Profiler] Updated profile for conv ${convId.slice(0,8)}...`);
  } catch (err) {
    // Fire-and-forget — never crash the main bot
    console.error("[Profiler] Error:", err.message);
  }
}

module.exports = { profileLead };
