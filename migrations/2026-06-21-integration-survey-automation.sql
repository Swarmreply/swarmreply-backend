-- 5b-1: an integration's automated follow-up can be a review request (default,
-- unchanged) or an NPS survey. When 'survey', a job-completion event schedules
-- the chosen survey to the contact (via scheduled_survey_sends) instead of a
-- review request. survey_template_id NULL = the account's default survey.
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS follow_up_type TEXT NOT NULL DEFAULT 'review_request';
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS survey_template_id UUID;
