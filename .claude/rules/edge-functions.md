---
paths:
  - "supabase/functions/**"
---
# Edge function rules
- Deno runtime, TypeScript. Supabase client from npm:@supabase/supabase-js@2.
- Secrets via Deno.env.get; fail fast with a clear log line if one is missing.
- Always return 200 to Meta within 5 seconds, even on internal errors, or Meta retries and the family gets duplicate confirmations.
- Verify X-Hub-Signature-256 against WA_APP_SECRET on every POST.
- Gemini: model from env GEMINI_MODEL (default a Flash model), temperature 0, responseMimeType application/json. One retry on 429 after 2 s, then fall back to trigram-only matching and say so in the confirmation ("זוהה בלי AI").
- Log raw inbound text and parsed JSON at info level; never log tokens or full phone numbers (mask to last 4 digits).
