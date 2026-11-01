---
name: deploy
description: Deploy a Supabase edge function to the linked project, wa-webhook by default. Use when a function is ready to deploy or the user runs /deploy.
---

# Deploy an edge function

Deploy the function the user names, or `wa-webhook` if none is named.

Run this from the repo root as one command, because shell state does not persist between calls. Never print the token.

```bash
export SUPABASE_ACCESS_TOKEN="$(grep -E '^SUPABASE_ACCESS_TOKEN=' .env | head -n1 | cut -d= -f2- | sed -E "s/^[\"']//; s/[\"']$//")" && supabase functions deploy wa-webhook
```

Report the deployed function URL, which has the form `https://<project-ref>.supabase.co/functions/v1/<function-name>`.
