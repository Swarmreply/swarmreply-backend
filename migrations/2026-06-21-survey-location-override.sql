-- 5c-1: at most one survey override per location. The account default already
-- has its own uniqueness (uq_survey_templates_account_default). This makes
-- per-location resolution deterministic. Safe to add: no location-scoped
-- surveys exist yet (everything is scope='account').
CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_templates_location_override
  ON survey_templates (customer_id, location_id)
  WHERE scope = 'location';
