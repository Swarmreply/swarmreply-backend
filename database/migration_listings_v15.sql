-- ============================================
-- migration_listings_v15.sql
-- Listings Health V1.5: automated NAP scanning for
-- guided directories (Yelp, Foursquare, Facebook page).
-- Run in Supabase SQL editor AFTER migration_listings.sql.
-- ============================================

ALTER TABLE listing_directories ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE listing_directories ADD COLUMN IF NOT EXISTS found_name TEXT;
ALTER TABLE listing_directories ADD COLUMN IF NOT EXISTS found_phone TEXT;
ALTER TABLE listing_directories ADD COLUMN IF NOT EXISTS found_address TEXT;
ALTER TABLE listing_directories ADD COLUMN IF NOT EXISTS found_website TEXT;
ALTER TABLE listing_directories ADD COLUMN IF NOT EXISTS diverged_fields TEXT[];
