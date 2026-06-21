-- Slice 3: a survey send can target a hand-picked list of contacts instead of a
-- whole segment. Scheduled sends store that list so the sweep can replay it.
-- NULL = the send used a segment (the existing behavior).
ALTER TABLE scheduled_survey_sends ADD COLUMN IF NOT EXISTS contact_emails JSONB;
