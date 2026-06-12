-- ============================================
-- migration_listings.sql
-- Listings Health V1: wires up the existing listings
-- sync engine (services/listingsService.js) + adds the
-- guided-directory tier.
-- Run in Supabase SQL editor.
-- ============================================

-- Canonical NAP lives on locations (engine design)
ALTER TABLE locations ADD COLUMN IF NOT EXISTS address_line1 TEXT;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS address_line2 TEXT;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS zip TEXT;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'US';
ALTER TABLE locations ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS hours JSONB;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS nap_updated_at TIMESTAMPTZ;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS listing_score INT;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS listing_score_at TIMESTAMPTZ;

-- Per-platform sync state (google | apple | bing)
CREATE TABLE IF NOT EXISTS listing_platforms (
  id                  BIGSERIAL PRIMARY KEY,
  location_id         UUID NOT NULL,
  platform            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'not_connected',
  has_divergence      BOOLEAN NOT NULL DEFAULT false,
  diverged_fields     TEXT[],
  divergence_found_at TIMESTAMPTZ,
  current_name        TEXT,
  current_address     TEXT,
  current_phone       TEXT,
  current_website     TEXT,
  current_hours       JSONB,
  last_synced_at      TIMESTAMPTZ,
  last_sync_result    TEXT,
  last_error          TEXT,
  sync_count          INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_listing_platforms_loc ON listing_platforms (location_id);

-- Sync audit trail
CREATE TABLE IF NOT EXISTS listing_sync_history (
  id           BIGSERIAL PRIMARY KEY,
  location_id  UUID NOT NULL,
  platform     TEXT NOT NULL,
  action       TEXT NOT NULL,
  status       TEXT NOT NULL,
  changes_made JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_listing_history_loc ON listing_sync_history (location_id, created_at DESC);

-- Guided directories (the tier we can't write to via API)
CREATE TABLE IF NOT EXISTS listing_directories (
  id           BIGSERIAL PRIMARY KEY,
  location_id  UUID NOT NULL,
  directory    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'not_setup',
  note         TEXT,
  verified_at  TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, directory)
);
CREATE INDEX IF NOT EXISTS idx_listing_dir_loc ON listing_directories (location_id);
