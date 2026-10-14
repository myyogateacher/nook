-- PeerDB-replicated orders: three versions of some rows (updates and soft deletes), merges stopped so
-- the duplicates stay until a query uses FINAL.
DROP DATABASE IF EXISTS eval_peerdb_orders;
CREATE DATABASE eval_peerdb_orders;
CREATE TABLE eval_peerdb_orders.orders (
  id Int64,
  customer_id Int64,
  status LowCardinality(String),
  amount Decimal(12, 2),
  created_at DateTime64(6),
  _peerdb_synced_at DateTime64(9) DEFAULT now64(),
  _peerdb_is_deleted Int8,
  _peerdb_version Int64
) ENGINE = ReplacingMergeTree(_peerdb_version)
PARTITION BY toYYYYMM(created_at)
ORDER BY id
COMMENT 'PeerDB mirror of public.orders';
SYSTEM STOP MERGES eval_peerdb_orders.orders;
INSERT INTO eval_peerdb_orders.orders (id, customer_id, status, amount, created_at, _peerdb_is_deleted, _peerdb_version)
SELECT number + 1, 1000 + number % 431, ['paid','paid','paid','paid','paid','paid','paid','shipped','cancelled','pending'][number % 10 + 1],
  toDecimal64(20 + (number * 37) % 180, 2) + toDecimal64(0.99, 2), toDateTime64('2026-08-15 00:00:00', 6) + toIntervalSecond((number * 1297) % (46 * 86400)), 0, 1
FROM numbers(3000);
INSERT INTO eval_peerdb_orders.orders (id, customer_id, status, amount, created_at, _peerdb_is_deleted, _peerdb_version)
SELECT number + 1, 1000 + number % 431, ['paid','paid','paid','paid','paid','paid','paid','shipped','cancelled','pending'][number % 10 + 1],
  toDecimal64(20 + (number * 37) % 180, 2) + toDecimal64(15.99, 2), toDateTime64('2026-08-15 00:00:00', 6) + toIntervalSecond((number * 1297) % (46 * 86400)), 0, 2
FROM numbers(3000) WHERE number % 4 = 0;
INSERT INTO eval_peerdb_orders.orders (id, customer_id, status, amount, created_at, _peerdb_is_deleted, _peerdb_version)
SELECT number + 1, 1000 + number % 431, ['paid','paid','paid','paid','paid','paid','paid','shipped','cancelled','pending'][number % 10 + 1],
  toDecimal64(20 + (number * 37) % 180, 2) + toDecimal64(0.99, 2), toDateTime64('2026-08-15 00:00:00', 6) + toIntervalSecond((number * 1297) % (46 * 86400)), 1, 3
FROM numbers(3000) WHERE number % 25 = 0;
