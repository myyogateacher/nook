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
- Review fixes (2026-10-13): **H1** `checkDesign` / `validateSpec` take `changedBlockIds`; with it, the per-block rules (1, 2, 4, 6, 7, 8, 10, emphasis) apply only to new or changed blocks, while rule 9's totals and the auto-fixes cover every block. Upgraded v1 blocks carry `legacy: true` (exempt until edited; their bars keep row order); a full generation strips it. **M1** a report's override needs a role that may create agents and chat, a provider from `providerChoices()`, and a model from `allowedReportModels` (the provider's default, the admin's report model, models Test saw) unless the admin turns on "Report owners may type any model name" (`reportModelFreeText`). **M2** the probe stores `false` only after a 400 or a 2xx without the probe call; timeouts, network errors, 429, 5xx, and auth errors are "inconclusive" and leave the flag; an unknown provider is 404. **M3** string x values that read as periods (YYYY-MM, YYYY-MM-DD, YYYY-Www, quarters, month names) are ordinal. KPIs gain `compareLabel` (plain text ≤ 60; default "vs previous period", never a column name). The Mapping tab lists this build's auto-fixes and marks recorded ones that no longer apply "at save". 053 checks `foreign_key_check(agent_settings)` before its rebuild. The report page is up to 1,280 px wide, prose at 70ch, KPI titles wrap to two lines.
- Migration 053 was needed: `agent_settings` (039) fixes its keys in a CHECK, so the two report-model keys need a rebuild; the per-report override is two `reports` columns. The Messages reservation moves to 054.

## Chart kinds, round 2 (2026-10-14, D462–D468)

Eleven kinds and two variants, drawn by `src/reports/chartKinds.ts` from theme tokens and named formatters only (the Mapping tab shows `ƒ name`), and checked by `checkDesign` rules 11–23.

### Kinds, intents, and fields

| Kind | Intent | Fields | Draws |
|---|---|---|---|
| `heatmap` | matrix | `x` columns, `x2` rows, `y [value]`; `cohort?`, `midpoint?` | Cells in 7 sequential steps (diverging when values straddle `midpoint`); values in cells (percent with format percent) in black or white by contrast; a stepped scale under it; scrolls inside the tile below 26 px a cell. Cohorts keep row order and scale from period 1 on. |
| `calendar` | trend | `x` date, `y [value]` | A day grid (one range up to ~7 months, else one per year), sequential steps, the same scale. |
| `funnel` | conversion | `x` stage, `y [value]` | Stages in row order, ordinal ramp, labels in one column with conversion from the previous stage; tooltip also shows share of the first. |
| `gauge` | attainment | `y [value]`, `target` or `max` | An HTML meter: value, a same-ramp track, the target tick; with a target, a status (On target, Near target, Below target; reversed with `upIsGood: false`) always as icon + label, the fill in that status colour only then. |
| `bullet` | attainment | `x`, `y [actual]`, `target`, `ranges?` (≤ 3) | Neutral bands, the actual as a thin slot-1 bar, the target as an ink tick; one value axis. |
| `treemap` | share | `x` group, `x2?` subgroup, `y [value]` | Categorical hues for groups only (subgroups wear their group's); > 8 groups fold to top 7 + Other (auto); tiny tiles go unlabelled. |
| `sankey` | flow | `x` source, `x2` target, `y [flow]` | Nodes in slot 2, links a neutral wash lifted on hover. |
| `boxplot` | distribution | `x`, `y [raw]` or `y [min, q1, median, q3, max]` | Quartiles by Nook (linear interpolation), Tukey whiskers, outliers as dots. |
| `histogram` | distribution | `y [raw column]` (no x) | Freedman–Diaconis bins, 5–50 (Sturges when the IQR is 0), touching bars with the 2 px gap. |
| `waterfall` | delta | `x` step, `y [signed change]`; `start?`, `total?` | Rises and falls on the diverging poles (never status colours), totals neutral grey; steps in row order; signed labels where they fit. |
| `combo` | compare / trend | `x`, `y [bar, line]`, `yUnits [u, u]` | A bar and a line on one value axis; different units are refused. |
| `stack` on area and bars | share | `stack: normal | percent` | Stacked areas (band wash 24 %) and 100 % stacked bars (shares, tooltip with value). |
| `facet` on line, bar, area | any | `facet` column | Small multiples: ≤ 12 panels (top 11 + Other), one shared y scale, 2 / 3 / 4 columns by tile width. |

### Rules (refused like SQL errors unless marked auto)

11. A round-2 kind and its intent go together both ways (funnel ↔ conversion, sankey ↔ flow, gauge / bullet ↔ attainment, heatmap ↔ matrix, histogram / boxplot ↔ distribution, treemap ↔ share, waterfall ↔ delta, calendar ↔ trend, combo ↔ compare or trend).
12. Heatmap at most 40 × 40 cells; both axes ordered (dates, numbers, periods, weekdays, numbered steps such as Week 3).
13. Calendar over a Date / DateTime x, at most 2 years.
14. Funnel 2–8 stages, values never increasing (the hint says to order rows by stage; Nook never re-sorts).
15. Gauge from a one-row result, with a target column or a max above 0 (rule 6 does not turn it into a KPI).
16. Treemap positive values; more than 8 groups fold (auto).
17. Sankey at most 30 nodes and 60 links, no negative flows, no cycles (the cycle is named).
18. Box plot at most 20 categories; precomputed boxes ordered min ≤ q1 ≤ median ≤ q3 ≤ max; raw values get quartiles (auto).
19. Histogram at least 5 values; its bins are recorded (auto).
20. Waterfall 2–25 steps.
21. Combo: one unit for both measures (`yUnits`); rule 7's scale check still applies. There is never a second axis.
22. Bullet ranges ascend; at most 15 categories.
23. Facet needs at least 2 values; more than 12 fold (auto). Rules 3 and 4 (auto): a line over 8 or a scatter over 3 series of a series column becomes small multiples.

Shape checks: each round-2 field only on its kinds; `series`, `compareTo`, `emphasis` not on the new kinds; `facet` not with `series`; the measures each kind takes.

### Routing table (taught to both agents)

| The question | Kind |
|---|---|
| Cohort retention | heatmap (`cohort: true`, format percent) |
| Conversion steps | funnel |
| Target attainment | gauge (one value) or bullet (per category) |
| Composition over time | area with `stack: percent` |
| Flow between states | sankey |
| Distribution | histogram (raw values) or boxplot (per category) |
| Contribution to change | waterfall |
| One trend split by many groups | line with `facet` |
| Daily values over a long span | calendar |
| A share of a whole | stacked_bar, bar or area with `stack: percent`, treemap, or a pie of at most 5 slices |
| An ordered list | horizontal_bar |
| Two measures per row | scatter |
| Categories side by side | bar (the fallback, not the default) |

### Picking the kind from the data (2026-10-15, D488)

The routing table alone left reports mostly bar and line, so the agents also read what each result's data fits.

- **Data-shape advisor** (`server/reports/shapeAdvisor.ts`, pure): every `run_sql` result in generation and edit carries a `shape` line of at most 300 characters, the most specific kind first, for example `shape: stages=5 decreasing → funnel fits; also bar`. The signals and what they suggest:

| Signal in the result | Fits |
|---|---|
| Stage-like labels (a `stage`/`step`/`funnel`/`phase` column, or labels `1.`, `Step 2`) with 2–8 values that never rise | funnel |
| One row of 3+ decreasing counts | funnel, after unpivoting to one row per stage |
| One row with a value and a target/goal/quota/budget (or max/capacity) column | gauge; otherwise a KPI |
| A category, an actual, and a target column, at most 15 rows | bullet |
| Two text columns named from/to (source/target, prev/next) or sharing values, at most 30 nodes | sankey |
| Two ordered dimensions (dates, periods, weekdays, period-offset integers such as `month_number`) and a value | heatmap (a cohort matrix when one is a cohort date and the other an offset) |
| 20+ raw values of one measure | histogram (or boxplot) |
| 20+ rows over at most 20 categories, 5+ per category, or min/q1/median/q3/max columns | boxplot |
| Signed values per step with a change-like name (delta, change, net) or start/total rows | waterfall |
| A date and more than 8 series | line with facet |
| A Date with 60+ days and one measure | calendar (also line, area) |
| Values in 0–1 (not all integers) | a note: format percent; 0–100 with a rate name: divide by 100 |

- **Planner**: each chart todo names its intent (a kpi todo defaults to headline, a table to detail).
- **Kind check** (once per run, never a try): a done todo whose block's kind does not serve its planned intent, and, when more than 70 % of the charts are bar or line, the bar and line blocks whose data the advisor saw fit a specific kind, by name (`f → funnel (5 stages, decreasing)`). Submitting the same spec again is accepted: the check only names kinds the data fits and never forces one.

### Tokens added
`sequentialRamp(mode, n)` (low end toward the surface), `ordinalRamp(mode, n)` (≥ 2:1: from step 250 on light, to step 600 on dark), `divergingRamp(mode)`, `METER` (fill `#3987e5` / `#2a78d6`, track `#184f95` / `#cde2fb`), `BULLET_BANDS` (dark `#2f2f35 #25252a #1c1c20`, light `#d6d5cc #e4e3dc #efeee9`), `waterfallColors` (diverging poles, total = muted ink), `inkOn(fill)` (black or white), `MARKS.stackedAreaOpacity` 0.24, heights per kind. Texture fills under forced colours apply to every ECharts kind through the aria decal; the HTML meter hatches its fill.
