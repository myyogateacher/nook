-- Q3 2026 deals per region and the regions' quotas. Lost and open deals are in the same table.
DROP DATABASE IF EXISTS eval_quota_attainment;
CREATE DATABASE eval_quota_attainment;
CREATE TABLE eval_quota_attainment.deals (
  deal_id UInt32,
  region LowCardinality(String),
  stage LowCardinality(String),
  amount Decimal(12, 2),
  closed_at Date
) ENGINE = MergeTree ORDER BY (region, closed_at) COMMENT 'One row per deal; stage is won, lost, or open';
CREATE TABLE eval_quota_attainment.quotas (
  region LowCardinality(String),
  quarter String,
  quota Decimal(12, 2)
) ENGINE = MergeTree ORDER BY (region, quarter) COMMENT 'Revenue quota per region and quarter';
INSERT INTO eval_quota_attainment.deals
SELECT number, ['EMEA', 'Americas', 'APAC', 'LATAM'][number % 4 + 1],
  multiIf(number % 5 < 3, 'won', number % 5 = 3, 'lost', 'open'),
  toDecimal64(1000 + (number * 37) % 900, 2),
  toDate('2026-07-01') + toIntervalDay(number % 92)
FROM numbers(800);
INSERT INTO eval_quota_attainment.quotas VALUES
  ('EMEA', '2026-Q3', 300000), ('Americas', '2026-Q3', 250000), ('APAC', '2026-Q3', 180000), ('LATAM', '2026-Q3', 120000),
  ('EMEA', '2026-Q2', 280000), ('Americas', '2026-Q2', 240000), ('APAC', '2026-Q2', 170000), ('LATAM', '2026-Q2', 110000);
