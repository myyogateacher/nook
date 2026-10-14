# Metric definitions: engagement

## Who counts

- Internal accounts never count: `users.is_internal = 1`, and any email ending in `@nook.test` (QA accounts).

## Qualifying session

A session of **60 seconds or more** (`duration_s >= 60`) by a user who counts.

## Active user (weekly)

A user is **active** in a week when they have **at least 3 qualifying sessions** that started in that week.
The week ending 2026-09-30 runs from 2026-09-24 00:00 to 2026-09-30 23:59:59 UTC.
