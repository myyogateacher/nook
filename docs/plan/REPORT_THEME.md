# Nook report theme "Ledger": spec for wave 48b

The approved spec (2026-10-13), followed by what was built (§ As built) and where it deviates. Decisions D430–D436, threats T371–T373.

## Goal
Reports look the same whatever model wrote them, because the model never sets colours, sizes or layout. The model chooses only *intent* (what each block is for) and *layout slots*. Nook turns those into this theme.

## Tokens: `shared/reportTheme.ts` (CSS variables plus one ECharts theme built from them)

### Surfaces and ink

| Role | Dark (default) | Light |
|---|---|---|
| Page plane | `#09090a` (app `--bg`) | `#f9f9f7` |
| Card / chart surface | `#111113` (app `--panel`) | `#fcfcfb` |
| Card border (hairline) | `#29292d` | `rgba(11,11,11,.10)` |
| Primary ink | `#ededef` | `#0b0b0b` |
| Secondary ink | `#b4b4ba` | `#52514e` |
| Muted (axis, labels) | `#929299` | `#898781` |
| Gridline (1px solid) | `#1f1f23` | `#e1e0d9` |
| Baseline / axis | `#3a3a40` | `#c3c2b7` |
| Brand accent (UI chrome only, never data) | `#f6c453` | `#b07800` |

### Categorical series, in a fixed order (never cycled)

| Slot | Hue | Dark | Light |
|---|---|---|---|
| 1 | amber | `#c98500` | `#eda100` |
| 2 | blue | `#3987e5` | `#2a78d6` |
| 3 | aqua | `#199e70` | `#1baf7a` |
| 4 | orange | `#d95926` | `#eb6834` |
| 5 | violet | `#9085e9` | `#4a3aa7` |
| 6 | magenta | `#d55181` | `#e87ba4` |
| 7 | green | `#008300` | `#008300` |
| 8 | red | `#e66767` | `#e34948` |

Validated with the dataviz `validate_palette.js`, against surfaces `#111113` (dark) and `#fcfcfb` (light):
- **Dark:** every check passes. Worst adjacent CVD ΔE is 8.6, and the normal-vision floor is 19.7.
- **Light:** passes, with two warnings.
  - Slots 7↔8 have CVD ΔE 7.2, which falls in the floor band. That is legal only with a secondary encoding; a legend plus direct labels are mandatory at 7–8 series.
  - Amber, aqua and magenta are below 3:1 contrast on the light surface. The relief rule applies, which is met because the table view is always available (Inspect → Data).
- **Scatter:** the first 3 slots pass every pair in both modes. Scatter, bubble and small multiples are therefore capped at 3 series.

Out of 5,040 amber-first orders, 202 passed; this one was chosen.

- **Sequential (magnitude):** the blue ramp, 100→700: `#cde2fb #b7d3f6 #9ec5f4 #86b6ef #6da7ec #5598e7 #3987e5 #2a78d6 #256abf #1c5cab #184f95 #104281 #0d366b`. On dark, an ordinal ramp must not go darker than step 600.
- **Diverging:** blue ↔ red with a grey midpoint (dark `#383835`, light `#f0efec`), and an equal number of steps on each side.
- **Status (reserved, never a series):**
  - Colours: good `#0ca30c`, warning `#fab219`, serious `#ec835a`, critical `#d03b3b`.
  - Each always comes with an icon and a label.
  - The text colour for a delta that is up and good is `#0ca30c` on dark and `#006300` on light.
- **Emphasis:** one series in slot 1 (amber), and all others in muted `#4a4a50` (dark) or `#c3c2b7` (light).

### Type and figures
- Font: Inter / system sans (the app's font).
- Sizes:
  - Title: 20/600.
  - Block title: 14/600.
  - Body: 13.
  - Axis and labels: 10–11.
  - KPI value: 26/600, with proportional figures.
  - Hero figure: ≥48/600, at most one per report.
- Use `tabular-nums` only in table columns and on axis ticks.
- Numbers are compacted automatically (1,284 / 12.9K / $4.2M). Units and currency come from the doc's metric definitions where it gives them.

### Marks (fixed)
- Bars:
  - At most 24 px thick.
  - 4 px rounded data end, square at the baseline.
  - A 2 px gap in the surface colour between touching bars and stack segments.
  - Bar charts are always sorted (descending) unless x is ordinal or time.
- Lines: 2 px, round joins. End dots have r=4 and a 2 px ring in the surface colour.
- Area: the series hue at 10 % opacity.
- Grid: 1 px solid, recessive, horizontal only. No dual axes, ever.
- Labels:
  - Direct labels go on line ends, bar tips and extremes only.
  - Text always uses ink tokens, never the series colour.
  - A legend is shown for 2 or more series; a single series has no legend box.
- Tooltip: a crosshair on line and area charts, and per-mark tooltips on bars and dots. Tap shows the tooltip on mobile.
- Texture fill (45°/135°): only under `forced-colors` and for print/export.

### Layout
- Grid:
  - 12 columns at ≥1024 px.
  - 6 columns at 768–1023 px.
  - 1 column at <768 px, where every block is full width.
- Gaps: 10 px gutters, 12–14 px card padding, 10 px card radius.
- Page order: title + narrative, then a KPI strip, then sections. Each section has an optional heading and blocks.
- Block widths: `full` = 12 columns, `half` = 6, `third` = 4. KPIs are sized automatically to fit the strip, with a minimum width of 150 px.
- Chart heights are fixed by kind: line and area 220, bar 28 px per category (minimum 160), pie 220, scatter 260.

## Spec v2 additions (`shared/reports.ts` gets a `specVersion: 2` and a v1 → v2 upgrade on read)
- Each block gets `intent`, which drives the chart choice: `trend | compare | rank | share | distribution | relationship | headline | detail | delta`.
- Each block gets `width`: `full | half | third`. Each block gets an optional `section`. The spec gets `sections[{id, title, summary?}]`.
- Chart blocks get:
  - `emphasis?: seriesValue`, which turns on emphasis mode;
  - `unit?` and `format?`, chosen from an enum: `number | percent | currency:<ISO> | duration`;
  - `upIsGood?`, for KPI deltas;
  - `compareTo?`, for a KPI delta query or column.
- KPI blocks get a sparkline query and column (optional).
- Nothing in the spec can carry colours, pixel sizes, CSS or formatter strings. These are refused by the schema.

## Design rules (run in specValidate; violations go back to the model as a retry, like SQL errors)

Each rule maps a problem to its fix:
1. **intent `trend` with x not a time/date column.** Fix: use `compare`.
2. **intent `share`.** Use a stacked bar, or a pie only when there are ≤5 slices and they sum to the whole.
3. **More than 8 series.** Fold the rest into "Other" (Nook does this automatically, keeping the top 7 plus Other).
4. **Scatter with more than 3 series.** Facet it, or fold into "Other".
5. **A bar chart with more than 20 categories.** Use the top 15 plus "Other", or switch to a table.
6. **A single-value result rendered as a chart.** Change it to a KPI.
7. **Two measures of very different scale on one chart.** Split into two charts (no dual axis).
8. **Missing title, or missing unit or format on a numeric measure.** Reject.
9. **More than 1 hero figure, more than 6 KPIs in the strip, or more than 20 blocks.** Reject.
10. **A pie chart with negative values, or a chart over an empty result.** Reject.

Some rules are fixed automatically without a retry: 3 (top 7 + Other) and 5 (top 15 + Other), along with sorting bars and compacting numbers. These auto-fixes are recorded in the block's Mapping tab.

## Model setting
- **Admin setting "Report generation model":** an admin picks a provider and a model, plus an optional per-report override. Chat keeps its own default.
- **Z.ai GLM-5.3 provider:** OpenAI-compatible, so it is configured in Settings → AI. Its tool-choice compat flags are set from a probe.
- **"Test tool calling" button** on the provider, which probes support for `required` and named tool choice and stores the result in compat. Without this, the wave 46 retry fallback still works.

## As built (branch `reports-w48b`)

**Files.**
- `shared/reportTheme.ts`: every token above, `layoutColumns` / `blockSpan` / `chartHeight`, and the two generated outputs: `reportCssVariables(mode)` (the `--rt-*` variables `ReportView` sets on its root through the CSSOM) and `reportEchartsTheme(mode)` (the one ECharts theme, registered by `charts.tsx` as `nook-ledger`).
- `shared/reports.ts`: spec v2 (`specVersion: 2`, `sections[]`, block `intent` / `width` / `section` / `autoFixes`, chart `emphasis` / `unit` / `format` / `upIsGood` / `compareTo`, KPI `compareTo` / `upIsGood` / `unit` / `hero` / `sparkline`), `upgradeSpec` (v1 → v2 on read, pure), `reportLayout` (page order), `ordinalX`, `isTimeType`.
- `server/reports/specValidate.ts`: the strict v2 schema, `checkDesign` (rules 1–10 and the auto-fixes), the v2 `SPEC_JSON_SCHEMA`; `validateSpec` keeps its signature.
- `src/reports/chartOption.ts` (marks, sorting, folding, emphasis, labels, named formatters, compaction), `charts.tsx` (the registered theme, the aria component for textures), `ReportView.tsx` (narrative, KPI strip, sections, the 12 / 6 / 1 grid), `KpiTile.tsx` (compact value, tone, sparkline), `InspectSheet.tsx` (Mapping: intent, width, unit, emphasis, "Auto-fixed: …"), `reportView.css` (only `--rt-*` variables).
- `server/reports/model.ts` (`reportModelFor`, `resolveReportModel`, the per-report override), migration **053** `report_model`, `probeToolCalling` in `server/agents/providers.ts`, Settings → AI (policy: "Report generation model"; providers: "Test tool calling"), `src/reports/ModelSheet.tsx` (the report's Model sheet).

**Theme source.** The mode is the root's `color-scheme` (the app's one theme signal), re-read by a MutationObserver and the `prefers-color-scheme` / `forced-colors` media queries; nothing reads CSS tokens back from the page any more.

**Layout.** The grid follows the report view's own width (CSS container queries on `.report-view`), so a sidebar does not push a 1,100 px window into 12 columns that do not fit; at 6 columns a `third` spans 3 (half), since three across would be under 240 px.

**Design rules, as numbers.** Rule 2: a pie at most 5 positive slices; rule 7: two measures whose largest absolute values differ by 20× or more; rule 9: 1 hero, 6 KPIs in the strip (KPIs in a section are not in the strip), 20 blocks; compaction from 10,000. Emphasis that names neither a series nor (one series) a category is refused like a rule. Auto-fixes are computed from the first results and stored on the block (`autoFixes`); the chart re-applies them to every refresh, and the Mapping tab lists both.

**Deviations.**
- The spec gives the "up and good" delta text only; "down and bad" (or up when `upIsGood` is false) uses `#f08080` on dark and `#b42318` on light (≥ 4.5:1, tested), the critical hue moved to text contrast.
- Diverging steps beyond the endpoints (`#86b6ef`…`#104281` / `#f0a3a3`…`#a83232`) were chosen here; no v1 chart uses them yet.
- v1's format words (`integer`, `currency`, `bytes`, `duration_s`, `date`, `datetime`, `text`) still validate and render, so stored specs keep their formatting; the model is offered only the v2 enum.
- "Existing stored specs render unchanged" holds for content, order, widths, and formats; KPIs move into the strip and large values compact (48,210.50 → 48.2K, the full value in the tooltip), as the theme requires.
- Migration 053 was needed: `agent_settings` (039) fixes its keys in a CHECK, so the two report-model keys need a rebuild; the per-report override is two `reports` columns. The Messages reservation moves to 054.
