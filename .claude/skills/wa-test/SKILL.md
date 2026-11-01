---
name: wa-test
description: Send a fake WhatsApp inbound message to the locally served wa-webhook function and show the bot's reply. Use to test parsing without a real phone.
argument-hint: "<hebrew message text>"
allowed-tools: Bash(curl *) Bash(supabase functions serve *) Read
---
Test the webhook locally with the message: $ARGUMENTS
1. If supabase functions serve wa-webhook --env-file .env is not running, start it in the background.
2. POST to http://localhost:54321/functions/v1/wa-webhook a Cloud API messages payload with text.body = the argument, from = the first phone in members, a fresh wamid. Sign with WA_APP_SECRET from .env in X-Hub-Signature-256, or set WA_SKIP_SIGNATURE=1 for local runs if the function supports it.
3. Show the function log and the exact reply body the bot would send.
4. If the argument is אשר, send it as an interactive button reply with id confirm instead of text.
5. Never write to the live project; local serve must point at a test household.
