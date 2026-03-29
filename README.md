# Ayusomam Sinus Bot - Clean JavaScript Build v3.0

## Architecture

Single-engine, multi-platform bot for Ayusomam Herbals sinus treatment program.

```
index.js                  → Express server, routes, background jobs
src/
  config.js               → Environment variables, constants
  db.js                   → All Supabase operations
  bot.js                  → Core engine: processMessage, callClaude, updateState
  prompt.js               → Dynamic system prompt with stage/sinus_type injection
  notion.js               → Notion CRM sync (fire-and-forget)
  platforms/
    whatsapp.js           → WhatsApp webhook + message buffering
    instagram.js          → Instagram webhook
    messenger.js          → Facebook Messenger webhook
    website.js            → REST API for website chat widget
```

## Environment Variables (set in Render)

See render.yaml for the full list. All are injected at runtime — no .env file needed in production.

## Database

Run schema.sql once in your Supabase SQL editor to create all tables.

## Deployment

Push to GitHub → Render auto-deploys from main branch.
