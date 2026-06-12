-- ============================================
-- migration_send_timing.sql
-- Scheduled review-request queue: integrations now
-- schedule sends (anchor + customer-configured delay)
-- instead of firing instantly.
-- Run in Supabase SQL editor.
-- ============================================

CREATE TABLE IF NOT EXISTS scheduled_review_requests (
  id            BIGSERIAL PRIMARY KEY,
  integration_id BIGINT NOT NULL,
  provider      TEXT   NOT NULL,
  contact       JSONB  NOT NULL,
  event_id      TEXT,            -- integration_events.id (kept loose-typed)
  external_ref  TEXT,            -- e.g. calendly_<invitee> / acuity_appt_<id>; used for cancel/reschedule
  send_at       TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | canceled
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_srr_due
  ON scheduled_review_requests (status, send_at);

CREATE INDEX IF NOT EXISTS idx_srr_ref
  ON scheduled_review_requests (provider, external_ref)
  WHERE status = 'pending';
