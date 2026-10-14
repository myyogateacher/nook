-- Signups stored in UTC; the business day is Asia/Kolkata (UTC+5:30). Evening UTC signups belong to
-- the next IST day, and the evening hours are busier on some days.
DROP DATABASE IF EXISTS eval_tz_signups;
CREATE DATABASE eval_tz_signups;
CREATE TABLE eval_tz_signups.signups (
  user_id UInt64,
  created_at DateTime('UTC') COMMENT 'Signup time, UTC',
  country LowCardinality(String),
  plan LowCardinality(String)
) ENGINE = MergeTree PARTITION BY toYYYYMM(created_at) ORDER BY (created_at, user_id) COMMENT 'One row per signup';
INSERT INTO eval_tz_signups.signups
SELECT number + 1,
  toDateTime('2026-08-31 00:00:00', 'UTC') + toIntervalSecond(intDiv(number, 40) * 86400 + ((number * 7919) % 86400)),
  ['IN','IN','IN','US','GB','DE'][number % 6 + 1], ['free','free','pro','team'][number % 4 + 1]
FROM numbers(1240);
INSERT INTO eval_tz_signups.signups
SELECT 100000 + number, toDateTime('2026-09-14 19:00:00', 'UTC') + toIntervalSecond(number * 97), 'IN', 'free'
FROM numbers(45);
