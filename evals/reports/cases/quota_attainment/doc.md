# Quota attainment, Q3 2026

## Tables

- `eval_quota_attainment.deals`: one row per deal: `deal_id`, `region`, `stage` (`won`, `lost`, or `open`), `amount` in USD, and `closed_at`.
- `eval_quota_attainment.quotas`: the revenue quota per `region` and `quarter` (`2026-Q3` is July–September 2026).

## Rules

- Only **won** deals count as revenue. Q3 2026 is `closed_at` from 2026-07-01 to 2026-09-30.

## Metrics

- **Won revenue per region** against the region's Q3 quota: show each region's revenue next to its target.
- **Attainment**: won revenue divided by quota, per region and for the company, as a percentage.
