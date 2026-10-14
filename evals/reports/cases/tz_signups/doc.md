# Signups by day (IST)

The growth team works in India, and every daily number is reported on the **Asia/Kolkata** calendar (IST, UTC+5:30).

## Table

- `eval_tz_signups.signups`: one row per signup; `created_at` is stored in UTC.

## Rules

- A signup belongs to the IST day of its `created_at`: convert with `toDate(created_at, 'Asia/Kolkata')` (or `toTimeZone`). A signup at 2026-09-14 20:00 UTC is on 2026-09-15 in IST.
- The period is September 2026 in IST: IST days 2026-09-01 to 2026-09-30.

## Metrics

- **Signups**: the number of signups in the period.
- **Daily signups**: signups per IST day across the period, as a trend.
- **Busiest day**: the IST day with the most signups, and its count.
