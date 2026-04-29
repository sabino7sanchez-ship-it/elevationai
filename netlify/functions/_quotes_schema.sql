-- ==================================================================
-- RIVVEN — `quotes` table for /.netlify/functions/quote-submit
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
-- Safe to re-run (uses IF NOT EXISTS / CREATE POLICY IF NOT EXISTS where supported).
-- Pairs with: _supabase_schema.sql (activity_events).
-- ==================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------------
-- TABLE: quotes
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quotes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id           TEXT NOT NULL UNIQUE,        -- RVQ-YYYYMMDD-XXXXXX
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now(),

  -- Lead identity
  name               TEXT NOT NULL,
  email              TEXT NOT NULL,
  phone              TEXT,
  business_name      TEXT,
  industry           TEXT NOT NULL,

  -- Quote contents
  tier               TEXT NOT NULL,               -- Basic | Professional | Growth
  addons             TEXT[] DEFAULT '{}'::TEXT[],
  timeline           TEXT NOT NULL DEFAULT 'standard',  -- standard | rush
  total              NUMERIC(10,2) NOT NULL,
  deposit            NUMERIC(10,2) NOT NULL,

  -- Stripe state
  stripe_session_id  TEXT,
  stripe_url         TEXT,
  paid_at            TIMESTAMPTZ,
  payment_amount     NUMERIC(10,2),

  -- Pipeline state
  status             TEXT NOT NULL DEFAULT 'sent',
                       -- sent | stripe_failed | viewed | paid_deposit | paid_full | won | lost | expired
  stage              TEXT,                        -- discover | call_booked | proposal | close | onboarded
  lost_reason        TEXT,

  -- Audit
  source             TEXT,                        -- quote.html | demo-page | etc.
  referer            TEXT,
  user_agent         TEXT,
  ip                 TEXT,

  -- Recovery: if any external step failed, store the error here for replay
  dead_letter        JSONB,
  notes              TEXT
);

-- ------------------------------------------------------------------
-- INDEXES
-- ------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_quotes_created   ON quotes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_email     ON quotes(email);
CREATE INDEX IF NOT EXISTS idx_quotes_phone     ON quotes(phone);
CREATE INDEX IF NOT EXISTS idx_quotes_status    ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_quotes_industry  ON quotes(industry);
CREATE INDEX IF NOT EXISTS idx_quotes_tier      ON quotes(tier);
CREATE INDEX IF NOT EXISTS idx_quotes_quote_id  ON quotes(quote_id);

-- ------------------------------------------------------------------
-- AUTO-UPDATE updated_at
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION quotes_set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quotes_updated_at ON quotes;
CREATE TRIGGER trg_quotes_updated_at
  BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION quotes_set_updated_at();

-- ------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ------------------------------------------------------------------
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;

-- Service-role writes (function uses SUPABASE_SERVICE_ROLE_KEY which bypasses RLS).
-- Authenticated dashboard users can read.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'quotes' AND policyname = 'auth_can_read_quotes'
  ) THEN
    CREATE POLICY "auth_can_read_quotes"
      ON quotes FOR SELECT
      USING (auth.role() = 'authenticated');
  END IF;
END $$;

-- ------------------------------------------------------------------
-- HELPER VIEW: pipeline dashboard snapshot
-- ------------------------------------------------------------------
CREATE OR REPLACE VIEW quotes_pipeline_v AS
SELECT
  status,
  COUNT(*)                                    AS count,
  SUM(total)                                  AS total_value,
  SUM(CASE WHEN status = 'paid_deposit' THEN deposit ELSE 0 END) AS deposits_collected,
  AVG(total)                                  AS avg_quote,
  MIN(created_at)                             AS oldest,
  MAX(created_at)                             AS newest
FROM quotes
GROUP BY status
ORDER BY count DESC;

-- ------------------------------------------------------------------
-- SMOKE TEST (uncomment to verify after deploy)
-- ------------------------------------------------------------------
-- INSERT INTO quotes (quote_id, name, email, industry, tier, total, deposit, source, status)
-- VALUES ('RVQ-SMOKETEST', 'Smoke Test', 'smoke@rivven.ai', 'Other', 'Basic', 897, 449, 'sql-smoketest', 'sent');
-- SELECT * FROM quotes WHERE quote_id = 'RVQ-SMOKETEST';
-- DELETE FROM quotes WHERE quote_id = 'RVQ-SMOKETEST';
