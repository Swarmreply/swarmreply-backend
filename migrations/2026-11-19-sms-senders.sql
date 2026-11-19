-- Per-customer SMS senders (one toll-free number per customer account).
--
-- Each customer fills in their business details once (sms_business_profiles).
-- The backend then buys a toll-free number for them through Twilio and submits
-- a toll-free verification (sms_senders). Outbound texts to that customer's
-- contacts are only sent from their own number, and only once it is approved.
--
-- Nothing in this file sends texts or spends money. Provisioning only runs
-- when SMS_PROVISIONING_ENABLED=true, and sending only when SMS_ENABLED=true.

CREATE TABLE IF NOT EXISTS sms_business_profiles (
  customer_id                UUID PRIMARY KEY,
  legal_business_name        TEXT NOT NULL,
  doing_business_as          TEXT,
  business_type              TEXT NOT NULL DEFAULT 'PRIVATE_PROFIT',
                             -- PRIVATE_PROFIT | PUBLIC_PROFIT | SOLE_PROPRIETOR | NON_PROFIT | GOVERNMENT
  ein                        TEXT,          -- required unless SOLE_PROPRIETOR
  website                    TEXT NOT NULL,
  street_address             TEXT NOT NULL,
  city                       TEXT NOT NULL,
  state                      TEXT NOT NULL,
  postal_code                TEXT NOT NULL,
  country                    TEXT NOT NULL DEFAULT 'US',
  contact_first_name         TEXT NOT NULL,
  contact_last_name          TEXT NOT NULL,
  contact_email              TEXT NOT NULL,
  contact_phone              TEXT NOT NULL, -- E.164
  monthly_volume             TEXT NOT NULL DEFAULT '1,000',
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sms_senders (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id                UUID NOT NULL,
  phone_number               TEXT,          -- E.164, set once purchased
  phone_number_sid           TEXT,          -- Twilio PNxxxx
  verification_sid           TEXT,          -- Twilio HHxxxx (toll-free verification)
  status                     TEXT NOT NULL DEFAULT 'pending',
                             -- pending        : row created, nothing bought yet
                             -- number_purchased: number bought, verification not yet submitted
                             -- submitted      : verification sent to Twilio (PENDING_REVIEW / IN_REVIEW)
                             -- approved       : TWILIO_APPROVED — texts can be sent from this number
                             -- rejected       : TWILIO_REJECTED — customer must fix their profile
                             -- failed         : provisioning error (see last_error), retried by scheduler
                             -- released       : number given back to Twilio (cancelled account)
  twilio_status              TEXT,          -- raw Twilio verification status
  rejection_reason           TEXT,
  edit_allowed               BOOLEAN,
  last_error                 TEXT,
  attempts                   INTEGER NOT NULL DEFAULT 0,
  submitted_at               TIMESTAMPTZ,
  approved_at                TIMESTAMPTZ,
  released_at                TIMESTAMPTZ,
  last_checked_at            TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one live (not released) sender per customer.
CREATE UNIQUE INDEX IF NOT EXISTS sms_senders_one_live_per_customer
  ON sms_senders (customer_id) WHERE status <> 'released';

-- Inbound texts are routed to a customer by the number they were sent to.
CREATE UNIQUE INDEX IF NOT EXISTS sms_senders_phone_number_live
  ON sms_senders (phone_number) WHERE status <> 'released' AND phone_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS sms_senders_status ON sms_senders (status);

-- Inbound messages (STOP/START/HELP and anything else people text back).
CREATE TABLE IF NOT EXISTS sms_inbound_messages (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id                UUID,
  from_number                TEXT NOT NULL,
  to_number                  TEXT NOT NULL,
  body                       TEXT,
  message_sid                TEXT,
  action                     TEXT,          -- opt_out | opt_in | help | none
  received_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sms_inbound_messages_customer
  ON sms_inbound_messages (customer_id, received_at DESC);
