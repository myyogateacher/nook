# Retention by signup cohort, June–September 2026

## Table

- `eval_cohort_retention.activity`: one row per user and month the user was active: `user_id`, `signup_date`, `active_date`. Every user is active in their signup month.

## Metrics

- **Cohort**: the calendar month of `signup_date`. **Cohort size**: the users who signed up in that month.
- **Retention**: for each cohort and each month since signup (0, 1, 2, 3; month 0 is the signup month), the users of the cohort active in that month divided by the cohort size, as a percentage. Show every cohort against every month since signup, so cohorts can be compared month by month.
- **Signups**: users per cohort.
