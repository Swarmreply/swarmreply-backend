# Database migrations

These run **automatically** every time the backend boots on Railway — you do
**not** run SQL by hand in Supabase anymore. This is what prevents the class of
bug where a column is missing in production because a migration was forgotten.

## How it works

On startup (`server.js` → `startServer` → `runMigrations` in
`database/migrate.js`) the backend:

1. ensures a `schema_migrations` ledger table exists,
2. looks at every `*.sql` file in this folder, sorted by name,
3. applies any that aren't in the ledger yet, **each in its own transaction**,
4. records each one it applies.

If a migration fails, the backend **refuses to boot** and logs the exact file
and error in the Railway deploy logs. That is intentional — it's safer to stop
than to serve on a half-applied schema. Fix the SQL file and redeploy.

## Adding a migration

1. Create a new file here named `YYYY-MM-DD-short-description.sql`
   (the date prefix sets the order — use today's date).
2. Write **idempotent** SQL so a re-run is always safe:
   - `CREATE TABLE IF NOT EXISTS ...`
   - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`
   - `CREATE INDEX IF NOT EXISTS ...`
3. Commit it. The next Railway deploy applies it on boot.

## Note on existing tables

Tables created earlier directly in Supabase (customers, locations, reviews,
review_requests, review_request_sends, review_templates, survey_responses, …)
already exist in production. New migrations are additive from here forward;
over time, bring older tables under migration control by adding
`... IF NOT EXISTS` definitions for them.
