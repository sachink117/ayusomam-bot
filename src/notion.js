// ============================================================
// notion.js - Notion CRM sync (optional, fire-and-forget)
// If NOTION_API_KEY is not set, all functions are no-ops
// ============================================================
const { Client } = require("@notionhq/client");
const { NOTION_API_KEY, NOTION_DATABASE_ID } = require("./config");

// Only initialise the client if the key is present
const notion = NOTION_API_KEY ? new Client({ auth: NOTION_API_KEY }) : null;

/**
 * Upsert a lead in Notion CRM.
 * Searches for existing page by userId, updates if found, creates if not.
 * Errors are caught and logged — never throws to the caller.
 */
async function crmUpsertLead(conv) {
  if (!notion || !NOTION_DATABASE_ID) return; // Notion not configured

  try {
    const props = {
      "Name":      { title: [{ text: { content: conv.name || conv.user_id } }] },
      "Platform":  { select: { name: conv.platform } },
      "Stage":     { select: { name: conv.stage } },
      "Language":  { select: { name: conv.language } },
    };
    if (conv.sinus_type) props["Sinus Type"] = { select: { name: conv.sinus_type } };
    if (conv.plan)       props["Plan"]        = { select: { name: conv.plan } };

    // Search for existing page
    const search = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      filter: { property: "Name", title: { equals: conv.user_id } },
    });

    if (search.results.length > 0) {
      await notion.pages.update({ page_id: search.results[0].id, properties: props });
    } else {
      await notion.pages.create({ parent: { database_id: NOTION_DATABASE_ID }, properties: props });
    }
  } catch (err) {
    console.error("[Notion] crmUpsertLead failed:", err.message);
  }
}

/**
 * Mark a lead as converted in Notion CRM
 */
async function crmMarkConverted(conv) {
  if (!notion || !NOTION_DATABASE_ID) return;

  try {
    const search = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      filter: { property: "Name", title: { equals: conv.user_id } },
    });
    if (search.results.length > 0) {
      await notion.pages.update({
        page_id: search.results[0].id,
        properties: {
          "Stage":        { select: { name: "converted" } },
          "Converted At": { date: { start: new Date().toISOString() } },
        },
      });
    }
  } catch (err) {
    console.error("[Notion] crmMarkConverted failed:", err.message);
  }
}

module.exports = { crmUpsertLead, crmMarkConverted };

