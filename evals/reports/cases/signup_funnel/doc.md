# Signup funnel, September 2026

## Table

- `eval_signup_funnel.events`: product events, one row per event: `user_id`, `event_name`, `ts` (UTC). Events repeat when a page reloads.

## The funnel

| Step | Event |
| --- | --- |
| 1. Pricing | `visit_pricing` |
| 2. Signup started | `start_signup` |
| 3. Email verified | `verify_email` |
| 4. First project | `first_project` |

## Rules

- Count **people** (distinct `user_id`), never events.
- A person reaches step N only if, in September 2026, they did step N's event **and every earlier step's** event. Someone who started a signup without visiting pricing is not in the funnel.
- The period is September 2026 (UTC).

## Metrics

- **Users at each step**: the people who reached the step.
- **Step conversion**: users at step N divided by users at step N−1 (a ratio).
- **Overall conversion**: users at step 4 divided by users at step 1.
