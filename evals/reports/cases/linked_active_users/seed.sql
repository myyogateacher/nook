-- Sessions of users, some internal (staff and test accounts); short sessions do not count toward activity.
DROP DATABASE IF EXISTS eval_linked_active_users;
CREATE DATABASE eval_linked_active_users;
CREATE TABLE eval_linked_active_users.users (
  user_id UInt64,
  email String,
  is_internal UInt8 COMMENT '1 for staff accounts',
  created_at DateTime
) ENGINE = MergeTree ORDER BY user_id COMMENT 'One row per account';
CREATE TABLE eval_linked_active_users.sessions (
  session_id UInt64,
  user_id UInt64,
  started_at DateTime,
  duration_s UInt32
) ENGINE = MergeTree PARTITION BY toYYYYMM(started_at) ORDER BY (started_at, user_id) COMMENT 'One row per app session';
INSERT INTO eval_linked_active_users.users
SELECT number + 1, number % 37 = 0 ? concat('qa', toString(number), '@nook.test') : concat('user', toString(number), '@example.com'), number % 50 = 0 ? 1 : 0, toDateTime('2026-01-01 00:00:00') + toIntervalHour(number)
FROM numbers(900);
INSERT INTO eval_linked_active_users.sessions
SELECT number + 1, 1 + (number * 7) % 900, toDateTime('2026-09-17 00:00:00') + toIntervalSecond((number * 3001) % (14 * 86400)), [20, 45, 90, 300, 1200, 30, 600][number % 7 + 1]
FROM numbers(6000);
