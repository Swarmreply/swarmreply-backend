-- Scheduled survey campaign sends. A survey campaign can now be queued for a
-- future time instead of sending immediately. The every-minute scheduler sweep
-- (surveyCampaignService.processDueScheduledSurveySends) claims due rows and
-- runs the exact same send path as an immediate send.
--
-- status: pending -> sending -> sent | failed   (or pending -> canceled)
CREATE TABLE IF NOT EXISTS scheduled_survey_sends (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID NOT NULL,
  location_id        UUID,
  survey_template_id UUID,                          -- NULL = account default survey
  segment            TEXT NOT NULL DEFAULT 'all',
  send_at            TIMESTAMPTZ NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  result             JSONB,                          -- {sent,failed,skipped,audience,...} after running
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at            TIMESTAMPTZ
);

-- The sweep query: pending rows whose time has come.
CREATE INDEX IF NOT EXISTS idx_scheduled_survey_sends_due
  ON scheduled_survey_sends (status, send_at);

-- The owner's "upcoming sends" list.
CREATE INDEX IF NOT EXISTS idx_scheduled_survey_sends_customer
  ON scheduled_survey_sends (customer_id, status, send_at);
