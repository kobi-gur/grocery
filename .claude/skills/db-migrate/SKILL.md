---
name: db-migrate
description: Apply new SQL migrations from supabase/migrations to the linked Supabase project. Use when a migration is ready to apply or the user runs /db-migrate.
---

# Apply migrations

Migrations are append-only. Never edit an applied migration; add a new one.

Run this from the repo root as one command, because shell state does not persist between calls. Never print the token.

```bash
export SUPABASE_ACCESS_TOKEN="$(grep -E '^SUPABASE_ACCESS_TOKEN=' .env | head -n1 | cut -d= -f2- | sed -E "s/^[\"']//; s/[\"']$//")" && supabase db push
```

If the CLI prompts for the database password, stop and ask the user to type it in the Terminal pane.

Report which migrations were applied, or that the database was already up to date.
