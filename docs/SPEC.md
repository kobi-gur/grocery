# Family Grocery Tool Spec (condensed, 2026-10-21)

Full version with diagrams: the Claude doc "Family Grocery Tool Spec 2026-10-21". This file is the copy Claude Code reads.

## Decisions (approved)
| Topic | Decision |
| --- | --- |
| Entry | Plain WhatsApp messages from each family member to one bot (Meta Cloud API, 1:1, no group) |
| Bot number | Meta test number, up to 5 verified recipients. No separate SIM, ever |
| Confirmation | Nothing is added until the sender taps אשר on one batch confirmation listing name, qty, unit per item |
| Quantity | Parsed from free text. Missing qty shows "1 ?". Units: יחידות, גרם, ק"ג, מ"ל, ליטר, אריזה, שקית, בקבוק |
| Bulk | Any length, one per line or comma separated. Photos of handwritten lists use the same path (phase 3) |
| App | PWA, iOS Safari, Hebrew RTL only, home screen, one shared household code, no accounts |
| In-store | Tap removes item (5 s undo). Long-press = לא היה במלאי, stays greyed |
| Done | Opens WhatsApp (wa.me) with unavailable items prefilled to the configured number, then clears the list and saves a trip |
| Favorites | Starred items. Thursday push asks "להוסיף את המועדפים?". No automatic reset or add |
| Catalog seed | Shufersal price-transparency XML |
| Cheapest store | Phase 4. Total the whole basket at 3 to 5 chosen branches (include online "branches"), recommend one, never split |
| Online ordering | Phase 5. "העתק רשימה" + "הזמן אונליין" buttons; Claude in Chrome fills the cart on the laptop |

## Stack (all free tiers)
| Part | Tool | Limit that matters |
| --- | --- | --- |
| Messaging | WhatsApp Cloud API, test number | 1,000 free service messages per number per month |
| Parsing, OCR | Gemini Flash free tier | ~15 req/min, ~1,500/day, non-commercial |
| DB, realtime, functions | Supabase free | 500 MB, pauses after 7 idle days (keep-alive ping every 3 days) |
| Cron | GitHub Actions | 2,000 min/month |
| Hosting | GitHub Pages | static only |
| Push | Web Push (VAPID) from a Supabase function | iOS 16.4+, home-screen PWAs only |
| Outbound to wifey | wa.me deep link | none |

## Flows
Setup: open link in Safari, add to home screen, enter household code, save bot contact, allow notifications.

A. WhatsApp: send text or photo. Bot replies one confirmation (items, qty, unit; "1 ?" when missing; "חדש" when unmatched) with buttons אשר / ערוך. Text reply = correction, new confirmation. Confirm adds all; duplicates merge qty. Records who added.

B. App: type, autocomplete (household history by frequency, then chain catalog), set qty/unit, add. Unknown items create catalog entries. "בדרך כלל קונים" strip of frequent items not on the list. Autocomplete results and the item detail show a product thumbnail when one is available. Source order: chain image by barcode, then Open Food Facts by barcode, then a neutral placeholder. Images are never stored in the database or the repo; Shufersal images are built from the barcode; Open Food Facts needs one lookup per item. The in-store list stays text-only. Tapping a thumbnail opens it full-size as an overlay; tap anywhere to close.

C. In store: grouped by category in store-walk order. Tap = bought, gone, undo toast. Long-press = unavailable. Swipe a list item to reveal controls: - and + around the current quantity, and an ערוך button. Tapping ערוך opens the item panel: larger photo, quantity, unit, and a category picker. Category changes are saved on the catalog item, not just this list, and the item moves to its new group immediately. Swipe must never trigger tap (bought) or long-press (unavailable). Realtime between phones, offline queue. "סיימתי": wa.me message to wifey with unavailable items, trip saved, list cleared. Next list shows "חסר בפעם הקודמת" strip.

D. Favorites: star in app or reply "מועדף". Thursday at a set hour: push "להוסיף את המועדפים לרשימה?", opens app with favorites pre-selected, confirm adds. Deleting from list = this list only; unstar stops it.

E. Cheapest store (phase 4): settings hold 3 to 5 branches. "איפה הכי זול" totals the current list per branch, shows not-found count, pick one. Thursday after favorites: comparison runs automatically; if cheapest is online, "הזמן אונליין" copies list and opens the store site.

F. Online ordering (phase 5): laptop, Chrome, Claude in Chrome adds pasted list to cart, stops on ambiguity. Then "סיימתי".

## Schema
| Table | Key columns |
| --- | --- |
| households | id, code, wifey_phone, reset_weekday (4), reset_hour, default_store_id |
| members | id, household_id, name_he, phone_e164, push_subscription json |
| catalog_items | id, household_id, name_he, aliases_he text[], category_id, default_unit, default_qty, is_favorite, barcode, source (chain/family), times_bought, last_bought_at |
| categories | id, household_id, name_he, sort_order |
| list_items | id, household_id, catalog_item_id, qty, unit, status (pending_confirm/on_list/unavailable), added_by, added_via, created_at |
| pending_batches | id, member_id, raw_text, parsed json, wa_message_id, created_at, expires_at |
| trips | id, household_id, store_id, finished_at, finished_by |
| trip_items | trip_id, catalog_item_id, qty, unit, outcome (bought/unavailable) |
| stores (ph4) | id, chain, branch_name, chain_store_id, online_url |
| prices (ph4) | store_id, barcode, price, as_of |

Rules: unique (household_id, catalog_item_id, status) on list_items; `finish_trip()` moves rows to trip_items, bumps counters, clears list, one transaction; RLS by household code; `pg_trgm` for matching; units enum `unit,g,kg,ml,l,pack,bag,bottle`.

## Bot logic
1. Unknown sender: reply "המספר לא רשום", stop.
2. Open batch + אשר button: insert parsed rows as on_list, reply summary, close batch.
3. Open batch + text: send previous parse + new text to Gemini as a correction, overwrite, re-confirm.
4. New message: Gemini with top-300 catalog names and unit enum, returns `[{name, qty, unit, qty_given, catalog_match}]`.
5. Unmatched rows: trigram > 0.4 attaches, else flag new.
6. Store batch, reply with interactive buttons. Batches expire after 24 h.
7. Photos: same path via Gemini vision, low-confidence lines marked "?".
8. Reply "מועדף" stars every item in the batch.

Hebrew parsing rules for prompt.md: number before or after noun; number words (שני, שתי, שלושה); "חצי קילו" = 0.5 kg; "ק"ג" and "קילו" = kg; name-only line = qty not given.

## Phases and acceptance
1. Schema, seed, PWA, finish_trip, keep-alive. The app deploys to GitHub Pages via an Actions workflow that publishes the app/ folder. Accept: two phones see a tap within 2 s; airplane-mode taps sync; "סיימתי" opens WhatsApp with the right text.
2. wa-webhook, prompt.md, Meta webhook registered, push-thursday edge function (web push, VAPID). Accept: 15-item mixed message parsed with correct units; אשר adds all; a correction changes only the named items.
3. Photo OCR (optional).
4. stores, prices, nightly job, comparison screen. Accept: 20-item list totals at 3 branches in under 3 s.
5. Copy list, open online store, Claude in Chrome recipe.

## Deviations in phase 1
What was built differs from the sections above in these ways. The code is the source of truth for each.
- List status: the enum also has `bought`. A tapped row stays on the server, hidden in the app, so it can be undone until `finish_trip()` moves it to trip_items.
- list_items: extra column `last_op_id`, so a replayed offline operation does not double the qty.
- Access: RLS reads the household code from the `x-household-code` header. Anon has read access only. All app writes go through security definer functions.
- Realtime: the database broadcasts a data-free ping on `household:<uuid>` and clients refetch through RLS, because row-level change events would be hidden without the header.
- "סיימתי": WhatsApp opens only when there is at least one unavailable item and a configured number. With no unavailable items the trip is saved and the list cleared without opening WhatsApp.
- Catalog seed: store 413 (שופרסל ONLINE). PriceFull has no department field, so categories are guessed from keywords in the item name.
- App size: `app/` holds 5 files (the icon is the fifth), one over the "under 5 files" convention in CLAUDE.md.

## Risks
Test number reclaimed → prepaid SIM, one config change. Gemini free tier changes → swap model behind prompt.md, or trigram-only fallback. Supabase pause → keep-alive; app shows "המסד ישן, לחץ להעיר". Push lost after reinstall → re-ask on open; Thursday prompt also as in-app banner. Shufersal image URL formula is reverse-engineered and may stop working → app falls back to Open Food Facts, then placeholder. No other impact.
