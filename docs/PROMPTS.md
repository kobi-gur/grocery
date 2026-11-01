# Prompts for Claude Code, one per phase

Paste each block as a single message at the start of a fresh session. Finish a phase and pass its acceptance check before starting the next. If Claude Code asks a product question, the answer is in `docs/SPEC.md`; point it there rather than improvising.

## Session 0: orientation (run once, 5 minutes)

```
Read CLAUDE.md and docs/SPEC.md. Do not write any code yet. Tell me in 10 lines what you understand the product to be, what phase 1 delivers, and which items in docs/SETUP.md you need me to have completed before you can start phase 1. Then stop.
```

Check its summary against your own understanding. If anything is off, fix docs/SPEC.md now; it is cheaper than fixing code later.

## Phase 1: list, catalog, app

```
Phase 1 from docs/SPEC.md. .env is filled for Supabase and GitHub; Supabase CLI is linked.

Build in this order, committing after each step:
1. supabase/migrations/0001_schema.sql: all eight tables, the unit enum, pg_trgm, RLS keyed on a household code passed as a request header, and the finish_trip() function. Apply it with /db-migrate.
2. supabase/seed/shufersal.ts: download the Shufersal PriceFull file for branch <STORE_ID>, parse the gzipped XML, upsert catalog_items with source = chain, barcode, name_he, and a category guessed from the item's department field. Run it once and tell me how many items landed.
3. The PWA in app/: Hebrew RTL, home-screen manifest, service worker with an offline write queue, Supabase realtime. Screens per SPEC flows B, C, D (favorites star and the Thursday selection screen, without the push itself). Use plain JS, no build step.
4. .github/workflows/keep-alive.yml: every 3 days, select 1 from households using the service role key from GitHub secrets.
5. Deploy the app to GitHub Pages and give me the URL.

Then run the phase 1 acceptance check from the spec with me: tell me exactly what to do on two phones and what you expect to see.
```

## Phase 2: WhatsApp entry

```
Phase 2 from docs/SPEC.md. .env and Supabase secrets hold the WA_ and GEMINI values. Phase 1 passed.

1. supabase/functions/wa-webhook/index.ts: GET verification handshake; POST with signature check against WA_APP_SECRET; the bot logic in the spec's "Bot logic" section, including pending batches, interactive reply buttons אשר / ערוך, text corrections, 24-hour expiry, and "מועדף".
2. supabase/functions/wa-webhook/prompt.md with the Hebrew parsing rules from the spec. Output must be strict JSON.
3. Catalog matching: exact, alias, pg_trgm > 0.4, then Gemini's pick among the top 3, else flag new. No catalog writes before confirmation.
4. A local test path: the /wa-test skill posts a fake inbound payload to the function served locally.
5. Deploy with /deploy and tell me the webhook URL to register in Meta.

Then run the phase 2 acceptance check: give me a 15-item Hebrew test message that mixes units and number words, and tell me the expected confirmation text.
```

## Phase 3: photo OCR (optional)

```
Phase 3 from docs/SPEC.md. Extend wa-webhook to accept image messages: fetch the media via the Cloud API media endpoint, pass it to Gemini with the same prompt plus "this is a photo of a handwritten Hebrew shopping list", and mark lines Gemini reports as low confidence with "?" in the confirmation. Keep the text path unchanged. Test with the three sample photos I will put in docs/samples/.
```

## Phase 4: cheapest store

```
Phase 4 from docs/SPEC.md. Branches: <paste the list from SETUP step 8>.

1. Migration 0002: stores and prices tables.
2. .github/workflows/prices.yml: nightly at 03:00 Asia/Jerusalem, download each branch's PriceFull file, upsert prices by barcode with as_of. Keep prices to the chosen branches only; the DB must stay well under 500 MB.
3. App: settings screen to pick branches, "איפה הכי זול" screen with totals per branch and not-found counts, store selection for the trip. Thursday flow: run the comparison after favorites are confirmed, show "הזמן אונליין" when the cheapest is an online store.
4. Acceptance: a 20-item list totals at 3 branches in under 3 seconds.
```

## Phase 5: online ordering

```
Phase 5 from docs/SPEC.md. Add "העתק רשימה" (plain text, one item per line with quantity) and make "הזמן אונליין" copy the list and open stores.online_url. Then write docs/ORDER-ONLINE.md: the exact Claude in Chrome prompt I paste on the laptop to add the copied list to the cart, with the instruction to stop and ask on any ambiguous product.
```

## Useful one-liners during any phase

- `What does the spec say about X?` before changing behavior.
- `Run the acceptance check for this phase and report what fails.`
- `Show me the exact Hebrew strings in the app and flag any that are not natural Hebrew.`
- `/doctor prompt-audit` once a month to catch stale instructions in CLAUDE.md.
