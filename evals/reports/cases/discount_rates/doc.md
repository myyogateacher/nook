# Discounts, September 2026

## Table

- `eval_discount_rates.orders`: one row per order: `list_price` (USD, before discount), `discount_rate`, and the `coupon` used (empty when none).

`discount_rate` is a **fraction**, not a percentage: `0.15` means 15 % off. Orders without a discount have `0`.

## Metrics

- **Average discount**: the average `discount_rate` over **discounted orders only** (`discount_rate > 0`). Show it as a percentage.
- **Discounted share**: discounted orders divided by all orders. Show it as a percentage.
- **Discount cost** (USD): the sum of `list_price * discount_rate`.
- **Discount cost by coupon**: discount cost per coupon, largest first.
