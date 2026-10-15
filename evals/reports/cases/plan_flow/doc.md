# Plan upgrades, Q3 2026

## Table

- `eval_plan_flow.plan_changes`: one row per logged plan change: `changed_at` (UTC), `account_id`, `from_plan`, `to_plan`. Plans: free, starter, pro, business.

## Rules

- A retried upgrade is logged twice. Count **accounts** per change (from plan, to plan), not rows.

## Metrics

- **Plan flow**: how accounts moved from plan to plan in Q3 2026 (July–September): accounts per from-plan → to-plan pair, shown as movement between plans.
- **Upgrades**: accounts with a plan change.
