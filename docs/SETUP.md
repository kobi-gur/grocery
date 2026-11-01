# Setup cookbook: accounts, keys, wiring

Do these yourself, in order. Each step says what to copy and where it goes. Total time about 45 minutes. Claude Code cannot do these for you (they need your phone, your browser logins, and your Meta identity), and it should not see the key values in chat; paste them into `.env` directly.

Create `.env` at the repo root first (it is gitignored):

```
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_PROJECT_REF=
SUPABASE_ACCESS_TOKEN=
GEMINI_API_KEY=
WA_PHONE_NUMBER_ID=
WA_ACCESS_TOKEN=
WA_VERIFY_TOKEN=
WA_APP_SECRET=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
HOUSEHOLD_CODE=
WIFEY_PHONE_E164=
```

## 1. GitHub (5 min)
1. Create a new private repo named `grocery`. Push this starter kit to it.
2. Settings > Pages > Source: GitHub Actions. Note the URL (`https://<you>.github.io/grocery/`). This is the app link the family installs.
3. Settings > Secrets and variables > Actions: add `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` after step 2 below (the Pages deploy and the keep-alive job need them).

## 2. Supabase (10 min)
1. supabase.com, sign in with GitHub, New project, name `grocery`, region Frankfurt (closest to Israel), free plan. Save the database password somewhere safe; you rarely need it.
2. Project Settings > API: copy Project URL → `SUPABASE_URL`, anon public key → `SUPABASE_ANON_KEY`, service_role key → `SUPABASE_SERVICE_ROLE_KEY`. Project Settings > General: Reference ID → `SUPABASE_PROJECT_REF`.
3. Install the CLI on the laptop: `brew install supabase/tap/supabase`. Then `supabase login` (opens browser) and, from the repo root, `supabase link --project-ref <ref>`.
4. Database > Extensions: enable `pg_trgm` (Claude Code's first migration also does this; enabling it here avoids a permission surprise).

## 3. Gemini (3 min)
1. aistudio.google.com, sign in with a Google account, Get API key, Create API key in a new project.
2. Copy → `GEMINI_API_KEY`. Do not enable billing on that Google Cloud project; that is what keeps it on the free tier.
3. In Supabase: Edge Functions > Secrets, add `GEMINI_API_KEY` with the same value. Edge functions read secrets from there, not from `.env`.

## 4. WhatsApp Cloud API (15 min, the fiddly one)
1. developers.facebook.com, log in with your personal Facebook account, My Apps > Create App > Other > Business. Name it `Grocery Bot`. You may be asked to create or pick a Meta Business Portfolio; create one with any name.
2. On the app dashboard, add the WhatsApp product.
3. WhatsApp > API Setup. You will see a Test number and a "From" phone number ID. Copy the Phone number ID → `WA_PHONE_NUMBER_ID`.
4. Under "To", add recipient numbers: each family member's phone in international format (+9725...). Each person gets a WhatsApp code to confirm. Maximum 5.
5. Generate a temporary access token for testing. For a token that does not expire: Business Settings (business.facebook.com) > Users > System Users > Add, role Admin, Assign assets: your app with full control, Generate token with scopes `whatsapp_business_messaging` and `whatsapp_business_management`. Copy → `WA_ACCESS_TOKEN`.
6. App Settings > Basic: copy App Secret → `WA_APP_SECRET` (used to verify webhook signatures).
7. Invent a random string → `WA_VERIFY_TOKEN` (any 30 characters).
8. Add all four WA_ values as Supabase Edge Function secrets as well.
9. Webhook registration happens after Claude Code deploys `wa-webhook` (phase 2): WhatsApp > Configuration > Webhook, Callback URL `https://<ref>.supabase.co/functions/v1/wa-webhook`, Verify token = your `WA_VERIFY_TOKEN`, subscribe to the `messages` field.
10. Tell the family to save the test number as a contact ("קניות") and send it one message first. The first message opens the 24-hour window; the bot can only reply inside it.

Known quirk: Meta test numbers can be rotated or retired. If the bot stops replying, check API Setup for a new number. Nothing else changes.

## 5. Web Push keys (2 min)
Run on the laptop: `npx web-push generate-vapid-keys`. Copy both → `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`. Add the private key as a Supabase Edge Function secret; the public key goes into `app/app.js` (Claude Code reads it from `.env` when building).

## 6. Household (1 min)
- `HOUSEHOLD_CODE`: a short word the family types once, e.g. `bait2026`.
- `WIFEY_PHONE_E164`: the number the unavailable-items message goes to, e.g. `+9725XXXXXXX`.

## 7. Shufersal catalog seed (phase 1, Claude Code does it)
The price-transparency files are public, no account needed. Shufersal's portal lists per-branch `PriceFull` and `Promo` files as gzipped XML. Claude Code's `supabase/seed/shufersal.ts` downloads one branch's `PriceFull` file and loads it. You only need to tell it the branch (store id) you shop at; find it by browsing the Shufersal transparency portal and matching the branch name.

## 8. Phase 4 later: price-comparison branches
For each chosen branch you need the chain and the chain's store id from its transparency portal. Chains publish through a few different portals (Shufersal has its own; several others use shared hosting with a login that is published on the portal page). Collect: chain name, store id, branch display name, online store URL if ordering online. Claude Code will ask for this list when phase 4 starts.

## Claude Code itself
- `brew install --cask claude-code` or the installer at code.claude.com, then `claude` in the repo root.
- First command: `/init` is not needed; CLAUDE.md already exists. Run `/context` and confirm `CLAUDE.md` and `docs/SPEC.md` appear under Memory files.
- Permission mode: use the default (asks before edits) for phase 1 so you learn what it does, then switch to auto mode for later phases.
