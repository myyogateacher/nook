-- A four-step signup funnel. Events repeat (page reloads), some users skip a step, and some events
-- fall outside September.
DROP DATABASE IF EXISTS eval_signup_funnel;
CREATE DATABASE eval_signup_funnel;
CREATE TABLE eval_signup_funnel.events (
  user_id UInt64,
  event_name LowCardinality(String),
  ts DateTime
) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (event_name, ts, user_id) COMMENT 'Product analytics events';
INSERT INTO eval_signup_funnel.events
SELECT u, 'visit_pricing', toDateTime('2026-09-01 08:00:00') + toIntervalSecond((u * 3571) % (29 * 86400)) + toIntervalSecond(r * 60)
FROM (SELECT number AS u, arrayJoin(range(1 + number % 3)) AS r FROM numbers(2000));
INSERT INTO eval_signup_funnel.events
SELECT u, 'start_signup', toDateTime('2026-09-01 09:00:00') + toIntervalSecond((u * 3571) % (29 * 86400)) + toIntervalSecond(r * 30)
FROM (SELECT number AS u, arrayJoin(range(1 + number % 2)) AS r FROM numbers(2000)) WHERE u % 5 IN (0, 1, 2);
INSERT INTO eval_signup_funnel.events
SELECT number, 'start_signup', toDateTime('2026-09-10 10:00:00') + toIntervalSecond(number * 600) FROM numbers(2000, 150);
INSERT INTO eval_signup_funnel.events
SELECT number, 'verify_email', toDateTime('2026-09-01 10:00:00') + toIntervalSecond((number * 3571) % (29 * 86400))
FROM numbers(2000) WHERE number % 5 IN (0, 1) OR number % 10 = 3;
INSERT INTO eval_signup_funnel.events
SELECT number, 'first_project', toDateTime('2026-09-01 12:00:00') + toIntervalSecond((number * 3571) % (29 * 86400))
FROM numbers(2000) WHERE number % 5 = 0 OR number % 10 = 1 AND number % 20 = 1;
