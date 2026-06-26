-- ============================================================================
-- Analytics P1 — per-account MRR (cents) on the daily snapshot.
--
-- Captured nightly by scheduler.snapshot.js from the active-location count via
-- the graduated pricing model, so revenue movement and retention can be derived
-- by diffing snapshots over time. Matches the admin Revenue page's definition
-- of MRR (active locations, active non-demo accounts).
--
-- Idempotent; runs automatically on boot via database/migrate.js.
-- ============================================================================

ALTER TABLE analytics_daily_snapshot
  ADD COLUMN IF NOT EXISTS mrr_cents INTEGER NOT NULL DEFAULT 0;
