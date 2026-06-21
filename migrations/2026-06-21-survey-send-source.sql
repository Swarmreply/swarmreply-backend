-- 5b-3: label each scheduled survey send by where it came from, so the Scheduled
-- sends view can tell automation apart from manual sends. Existing rows → 'manual'.
-- Values: 'manual' | 'integration' | 'csv_import'.
ALTER TABLE scheduled_survey_sends ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
