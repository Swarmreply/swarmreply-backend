-- 5c-2: contacts can belong to a location, so non-integration sends (manual and
-- CSV) resolve the right per-location survey. Nullable — unassigned contacts
-- fall back to the campaign/primary location at send time.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS location_id UUID;
CREATE INDEX IF NOT EXISTS idx_contacts_location ON contacts (customer_id, location_id);
