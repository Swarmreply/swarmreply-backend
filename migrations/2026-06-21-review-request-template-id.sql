-- Associate each review_request with the specific survey template it was sent
-- for, so a survey campaign can send any survey (not just the account default).
-- NULL means "use the account default" — backward-compatible with every
-- existing row and with the automatic review-request flow.
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS template_id UUID;
