-- Onboarding steps: every account creates a workspace; fewer invite, connect data, and build a report.
-- Some accounts reconnect their data source, so the connect step has repeated events.
DROP DATABASE IF EXISTS eval_onboarding_funnel;
CREATE DATABASE eval_onboarding_funnel;
CREATE TABLE eval_onboarding_funnel.onboarding_events (
  ts DateTime,
  account_id UInt32,
  event LowCardinality(String)
) ENGINE = MergeTree ORDER BY (account_id, ts) COMMENT 'One row per onboarding event';
INSERT INTO eval_onboarding_funnel.onboarding_events
SELECT toDateTime('2026-09-01 00:00:00') + toIntervalSecond(number * 2311 % (29 * 86400)), number, 'workspace_created' FROM numbers(1000);
INSERT INTO eval_onboarding_funnel.onboarding_events
SELECT toDateTime('2026-09-01 06:00:00') + toIntervalSecond(number * 2311 % (29 * 86400)), number, 'teammate_invited' FROM numbers(1000) WHERE number % 10 < 6;
INSERT INTO eval_onboarding_funnel.onboarding_events
SELECT toDateTime('2026-09-01 12:00:00') + toIntervalSecond(number * 2311 % (29 * 86400)), number, 'data_connected' FROM numbers(1000) WHERE number % 10 < 3;
INSERT INTO eval_onboarding_funnel.onboarding_events
SELECT toDateTime('2026-09-01 13:00:00') + toIntervalSecond(number * 2311 % (29 * 86400)), number, 'data_connected' FROM numbers(1000) WHERE number % 10 = 0;
INSERT INTO eval_onboarding_funnel.onboarding_events
SELECT toDateTime('2026-09-01 18:00:00') + toIntervalSecond(number * 2311 % (29 * 86400)), number, 'first_report' FROM numbers(1000) WHERE number % 20 < 3;
