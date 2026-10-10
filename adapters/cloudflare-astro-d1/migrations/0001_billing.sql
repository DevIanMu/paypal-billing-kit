CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'paypal',
  provider_sub_id TEXT UNIQUE,
  plan TEXT NOT NULL,
  cycle TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_end TEXT,
  reminded_period TEXT,
  switch_target TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sub_user ON subscriptions(user_id, status);

CREATE TABLE IF NOT EXISTS credit_packs (
  user_id TEXT PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'paypal',
  provider_order_id TEXT UNIQUE,
  amount TEXT,
  currency TEXT DEFAULT 'USD',
  status TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT,
  processed_at TEXT DEFAULT (datetime('now'))
);
