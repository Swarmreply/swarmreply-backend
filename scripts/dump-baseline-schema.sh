#!/bin/bash
# Captures the live Supabase schema (the tables that were created by hand
# before the migration runner existed) into database/baseline-schema.sql, so a
# fresh database (staging, disaster recovery) can be rebuilt from the repo.
# Schema only, no customer data.
#
# It is deliberately NOT written to /migrations: the runner would try to apply
# it to production on the next boot and constraints that already exist would
# make the boot fail.
#
# To build a fresh database:  psql "$NEW_DATABASE_URL" -f database/baseline-schema.sql
# then boot the backend once so /migrations apply on top.
#
# Usage:  DATABASE_URL='postgres://...' ./scripts/dump-baseline-schema.sh
# Needs pg_dump 15+ (brew install postgresql@16), or run `supabase db dump`.
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to the Supabase connection string}"
OUT="database/baseline-schema.sql"
pg_dump "$DATABASE_URL" --schema-only --schema=public --no-owner --no-privileges > "$OUT"
echo "Wrote $OUT. Review it, then commit."
