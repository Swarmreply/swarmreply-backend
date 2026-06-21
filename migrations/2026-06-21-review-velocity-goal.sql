-- Cleanup: customer-settable monthly review goal for the Review Velocity report.
-- Nullable — when unset the dashboard falls back to a default target of 25/month.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS review_goal INTEGER;
