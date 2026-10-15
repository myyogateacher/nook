# Onboarding funnel, September 2026

## Table

- `eval_onboarding_funnel.onboarding_events`: one row per onboarding event: `ts` (UTC), `account_id`, and `event`, one of `workspace_created`, `teammate_invited`, `data_connected`, `first_report`.

## Rules

- An account can send the same event more than once (reconnecting a data source sends `data_connected` again). Count **accounts**, not events.

## Metrics

- **Onboarding funnel**: accounts that reached each step, in this order: 1. Workspace created, 2. Teammate invited, 3. Data connected, 4. First report. Show how many accounts make it from each step to the next.
- **Activation rate**: accounts with a first report divided by accounts that created a workspace, as a percentage.
