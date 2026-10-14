# Weekly engagement

A weekly look at how many people really use the app, for the week ending 2026-09-30.

## Tables

- `eval_linked_active_users.users`: one row per account.
- `eval_linked_active_users.sessions`: one row per app session: `user_id`, `started_at` (UTC), `duration_s`.

## Metrics

- **Weekly active users (WAU)**: as defined on the [metric definitions page]({{link:metrics}}). Do not use a simpler definition: the page's rules decide who counts.
- **Qualifying sessions**: the sessions that count toward activity under the same page's rules, in the same week.
