-- ============================================================
-- Phase 2 -- survey foundation (additive; safe to re-run)
-- Creates survey_templates, which the modular survey builder (Phase 3)
-- reads and writes. No existing table is touched, so this cannot affect
-- the live review-request or survey flows.
--
-- Scope model: an account-level template (scope='account', is_default=true)
-- applies to every location by default. Phase 5 adds per-location overrides
-- (scope='location' with a location_id).
-- ============================================================

CREATE TABLE IF NOT EXISTS survey_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL,
  name         TEXT NOT NULL DEFAULT 'Untitled survey',
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  scope        TEXT NOT NULL DEFAULT 'account' CHECK (scope IN ('account', 'location')),
  location_id  UUID,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_survey_templates_customer
  ON survey_templates (customer_id);

CREATE INDEX IF NOT EXISTS idx_survey_templates_location
  ON survey_templates (customer_id, location_id);

-- At most one account-level default template per customer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_templates_account_default
  ON survey_templates (customer_id)
  WHERE scope = 'account' AND is_default;
