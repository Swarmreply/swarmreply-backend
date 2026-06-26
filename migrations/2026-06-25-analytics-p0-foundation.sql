-- ============================================================================
-- Analytics P0 foundation — the irreversible "start the clock" capture.
--
-- (1) analytics_daily_snapshot: one row per active account per day, holding the
--     state metrics that CANNOT be reconstructed retroactively. This is what
--     powers every trend line, retention cohort, activation-funnel timing, and
--     point-in-time ("as of") view in the analytics center. The nightly job
--     (scheduler.snapshot.js) writes today's row; ON CONFLICT keeps it idempotent.
--
-- (2) First-touch acquisition attribution on customers — also not derivable
--     after the fact, so it must be captured at signup from this point forward.
--
-- Idempotent (IF NOT EXISTS everywhere); safe to re-run. Applied automatically
-- on the next Railway boot via database/migrate.js — do NOT run by hand.
-- ============================================================================

-- ── (1) Daily per-account snapshot ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analytics_daily_snapshot (
  snapshot_date            DATE        NOT NULL,
  customer_id              UUID        NOT NULL,

  -- account / billing state
  status                   TEXT,
  plan                     TEXT,
  is_demo                  BOOLEAN     DEFAULT false,
  is_paying                BOOLEAN     DEFAULT false,   -- stripe_subscription_id present
  account_age_days         INTEGER,

  -- footprint
  location_count           INTEGER     DEFAULT 0,
  integration_count        INTEGER     DEFAULT 0,
  integrations_connected   TEXT[]      DEFAULT '{}',
  contact_count            INTEGER     DEFAULT 0,
  opted_out_count          INTEGER     DEFAULT 0,

  -- outcomes
  review_count             INTEGER     DEFAULT 0,
  avg_rating               NUMERIC(3,2),
  requests_total           INTEGER     DEFAULT 0,
  requests_completed       INTEGER     DEFAULT 0,
  survey_responses         INTEGER     DEFAULT 0,
  ai_visibility_score      NUMERIC,

  -- activation funnel — day-granular state. The first snapshot_date on which a
  -- flag flips true IS that account's milestone date (time-to-value per cohort).
  onboarding_started       BOOLEAN     DEFAULT false,
  onboarding_completed     BOOLEAN     DEFAULT false,
  has_location             BOOLEAN     DEFAULT false,
  has_integration          BOOLEAN     DEFAULT false,
  has_first_request        BOOLEAN     DEFAULT false,
  has_first_review         BOOLEAN     DEFAULT false,

  captured_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_date, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_snap_date     ON analytics_daily_snapshot (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_snap_customer ON analytics_daily_snapshot (customer_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_snap_plan     ON analytics_daily_snapshot (snapshot_date, plan);

-- ── (2) First-touch acquisition attribution ────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS signup_source  TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS utm_source     TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS utm_medium     TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS utm_campaign   TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS utm_term       TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS utm_content    TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS gclid          TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS referrer       TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS landing_path   TEXT;
