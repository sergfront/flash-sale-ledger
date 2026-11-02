CREATE TABLE IF NOT EXISTS products (
  sku text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  image_url text,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS inventory (
  sku text PRIMARY KEY REFERENCES products(sku),
  total integer NOT NULL CHECK (total >= 0),
  available integer NOT NULL CHECK (available >= 0),
  reserved integer NOT NULL CHECK (reserved >= 0),
  sold integer NOT NULL CHECK (sold >= 0),
  CHECK (total = available + reserved + sold)
);

CREATE TABLE IF NOT EXISTS carts (
  user_id text PRIMARY KEY,
  version integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS cart_items (
  user_id text NOT NULL REFERENCES carts(user_id) ON DELETE CASCADE,
  sku text NOT NULL REFERENCES products(sku),
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 10),
  PRIMARY KEY (user_id, sku)
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING_PAYMENT','PAYMENT_REVIEW','CONFIRMED','PAYMENT_FAILED','CANCELLED','EXPIRED','REFUND_PENDING','REFUNDED')),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency char(3) NOT NULL,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS orders_user_created_idx ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, updated_at);
CREATE TABLE IF NOT EXISTS order_items (
  order_id uuid NOT NULL REFERENCES orders(id),
  sku text NOT NULL REFERENCES products(sku),
  name text NOT NULL,
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_id, sku)
);

CREATE TABLE IF NOT EXISTS reservations (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  status text NOT NULL CHECK (status IN ('HELD','CONSUMED','RELEASED')),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS reservations_due_idx ON reservations(expires_at) WHERE status = 'HELD';
CREATE TABLE IF NOT EXISTS reservation_items (
  order_id uuid NOT NULL REFERENCES reservations(order_id),
  sku text NOT NULL REFERENCES inventory(sku),
  quantity integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_id, sku)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  order_id uuid REFERENCES orders(id),
  response_code integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS payment_operations (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  kind text NOT NULL CHECK (kind IN ('CAPTURE','REFUND')),
  provider_key text NOT NULL UNIQUE,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  status text NOT NULL CHECK (status IN ('QUEUED','IN_FLIGHT','SUCCEEDED','FAILED','UNKNOWN')),
  occurred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (order_id, kind, provider_key)
);
CREATE INDEX IF NOT EXISTS payment_ops_order_idx ON payment_operations(order_id);

CREATE TABLE IF NOT EXISTS provider_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider, event_id)
);
CREATE TABLE IF NOT EXISTS inbox (
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer, event_id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','LEASED','DONE')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS outbox_ready_idx ON outbox(available_at, created_at) WHERE status <> 'DONE';

CREATE TABLE IF NOT EXISTS inventory_movements (
  id uuid PRIMARY KEY,
  sku text NOT NULL REFERENCES inventory(sku),
  order_id uuid REFERENCES orders(id),
  kind text NOT NULL,
  available_delta integer NOT NULL,
  reserved_delta integer NOT NULL,
  sold_delta integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS reconciliation_cases (
  id uuid PRIMARY KEY,
  order_id uuid REFERENCES orders(id),
  kind text NOT NULL,
  details jsonb NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
