-- ============================================================
-- Phase 3a -- modular survey responses (additive; safe to re-run)
-- Adds storage for arbitrary survey answers and links responses to a template
-- and (for campaign sends) a survey send. NO hard foreign keys are used, so
-- this is safe regardless of the existing survey_responses column types.
-- ============================================================

-- A stable UUID on each response that survey_answers can reference, plus the
-- columns the decoupled survey campaigns (Phase 3c) populate. ADD COLUMN with a
-- volatile default backfills every existing row with a unique value.
ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS uid            UUID DEFAULT gen_random_uuid();
ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS template_id    UUID;
ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS survey_send_id UUID;
ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS channel        TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_responses_uid
  ON survey_responses (uid);

-- One row per answered block. answer_text / answer_number / answer_options are
-- populated according to block_type (open_text, nps, rating, star, smiley,
-- multiple_choice, yes_no). This is what lets the Responses Explorer (Phase 4)
-- filter and group by any single question's answer.
CREATE TABLE IF NOT EXISTS survey_answers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  response_uid   UUID NOT NULL,
  block_id       TEXT,
  block_type     TEXT NOT NULL,
  question_text  TEXT,
  answer_text    TEXT,
  answer_number  NUMERIC,
  answer_options TEXT[],
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_survey_answers_response
  ON survey_answers (response_uid);

CREATE INDEX IF NOT EXISTS idx_survey_answers_block
  ON survey_answers (response_uid, block_id);
