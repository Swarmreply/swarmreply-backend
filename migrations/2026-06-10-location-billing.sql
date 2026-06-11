-- Run this in the Supabase SQL editor BEFORE deploying the code changes.
-- Adds billing-sync tracking + idempotency to locations.

ALTER TABLE locations ADD COLUMN IF NOT EXISTS billing_synced BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- A retried "create location" request with the same key can never duplicate
CREATE UNIQUE INDEX IF NOT EXISTS locations_customer_idem_key
  ON locations (customer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
