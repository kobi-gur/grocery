# Grocery (רשימת קניות משפחתית)

Family grocery list: WhatsApp bot for entry, Hebrew-only iOS PWA for shopping, Supabase for data. Zero running cost. Full spec: @docs/SPEC.md. Setup and keys: see `docs/SETUP.md` (read only when a key or account is missing).

## Non-negotiables
- Every service stays on its free tier. Never add a paid dependency, paid API, or a server that needs a credit card. If a task seems to need one, stop and say so.
- UI language is Hebrew only, RTL. No English strings in the app except code identifiers.
- The WhatsApp bot never sends a message on its own. It only replies inside the 24-hour window after a family member writes. Reminders go through the PWA's push notifications.
- Nothing enters `list_items` from WhatsApp until the sender taps אשר.
- The list resets only on "סיימתי". Never auto-clear, never auto-add favorites without the Thursday prompt being accepted.
- No em dashes in any text, code comments, or UI copy.
- Secrets live only in `.env` (gitignored) and in Supabase/GitHub secrets. Never commit a key, never print one.

## Layout
```
app/                  PWA, static, deployed to GitHub Pages
  index.html          single page, RTL
  app.js              UI, Supabase client, offline queue
  sw.js               service worker
  manifest.json
supabase/
  migrations/         SQL, numbered 0001_...
  functions/
    wa-webhook/       WhatsApp inbound + Gemini parse + confirmation
    push-thursday/    weekly favorites prompt (cron via GitHub Actions)
  seed/shufersal.ts   one-off catalog seed from price-transparency XML
.github/workflows/    keep-alive.yml, prices.yml (phase 4)
docs/                 SPEC.md, SETUP.md, PROMPTS.md
```

## Commands
- The Supabase CLI authenticates via `SUPABASE_ACCESS_TOKEN` from `.env`. Export it in the same shell command as any `supabase` call, and never print it.
- `supabase db push` applies migrations to the linked project (use `/db-migrate`)
- `supabase functions deploy wa-webhook` deploys the webhook (use `/deploy`)
- `supabase functions serve wa-webhook --env-file .env` runs it locally
- `npx serve app` previews the PWA locally
- `/wa-test "חלב, 2 ק\"ג עגבניות"` sends a fake inbound message to the local webhook

## Conventions
- TypeScript for edge functions (Deno). Plain JS, no framework, no build step, for the PWA. Keep the app under 5 files.
- Supabase JS client v2 via CDN in the PWA. Realtime channel per household.
- Units are the enum `unit, g, kg, ml, l, pack, bag, bottle`. Hebrew display names live in `app/app.js` only.
- Catalog matching order: exact name, alias, `pg_trgm` similarity > 0.4, then Gemini. Never create a catalog item from a WhatsApp message before confirmation.
- The Gemini prompt is `supabase/functions/wa-webhook/prompt.md`. Change parsing behavior there, not in code.
- Migrations are append-only. Never edit an applied migration; add a new one.
- Every phase ends with the acceptance check in `docs/SPEC.md`. Do not start the next phase until it passes.
- Commit directly to `main`. Do not create branches unless asked for one.

## When unsure
- Product behavior question: the answer is in `docs/SPEC.md`. If it is not there, ask, do not guess.
- A step needs a human (create an account, paste a key, verify a phone number): stop, say exactly what to do, wait.
