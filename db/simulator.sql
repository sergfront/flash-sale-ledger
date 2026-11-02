CREATE TABLE IF NOT EXISTS payment_ledger (
  provider_key text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('CAPTURE','REFUND')),
  order_id uuid NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  status text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED')),
  original_key text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
