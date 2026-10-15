-- Plan changes in Q3 2026. Some accounts retry a failed upgrade, so a change can be logged twice.
DROP DATABASE IF EXISTS eval_plan_flow;
CREATE DATABASE eval_plan_flow;
CREATE TABLE eval_plan_flow.plan_changes (
  changed_at DateTime,
  account_id UInt32,
  from_plan LowCardinality(String),
  to_plan LowCardinality(String)
) ENGINE = MergeTree ORDER BY (account_id, changed_at) COMMENT 'One row per logged plan change';
INSERT INTO eval_plan_flow.plan_changes
SELECT toDateTime('2026-07-01 00:00:00') + toIntervalSecond(number * 7907 % (90 * 86400)), number,
  multiIf(number % 10 < 5, 'free', number % 10 < 8, 'starter', 'pro'),
  multiIf(number % 10 < 3, 'starter', number % 10 < 5, 'pro', number % 10 < 7, 'pro', 'business')
FROM numbers(600);
INSERT INTO eval_plan_flow.plan_changes
SELECT toDateTime('2026-07-01 00:05:00') + toIntervalSecond(number * 7907 % (90 * 86400)), number, 'free', 'starter'
FROM numbers(600) WHERE number % 10 < 3 AND number % 4 = 0;
