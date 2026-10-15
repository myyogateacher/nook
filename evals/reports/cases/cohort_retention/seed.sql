-- Monthly activity of users who signed up June–September 2026: one row per user and active month.
DROP DATABASE IF EXISTS eval_cohort_retention;
CREATE DATABASE eval_cohort_retention;
CREATE TABLE eval_cohort_retention.activity (
  user_id UInt32,
  signup_date Date,
  active_date Date
) ENGINE = MergeTree ORDER BY (user_id, active_date) COMMENT 'One row per user and month the user was active';
INSERT INTO eval_cohort_retention.activity
SELECT number AS user_id,
  toDate('2026-06-01') + toIntervalMonth(number % 4) + toIntervalDay(number % 28) AS signup_date,
  addMonths(toStartOfMonth(toDate('2026-06-01') + toIntervalMonth(number % 4)), k) + toIntervalDay((number * 7) % 28) AS active_date
FROM numbers(1200) ARRAY JOIN range(0, 4 - toUInt8(number % 4)) AS k
WHERE (number % 10) < 10 - 3 * k;
