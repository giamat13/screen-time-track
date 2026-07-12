# Goal Alerts, Export/Import, Monthly Trend — Design

## Context

Screen Time already has per-app + global daily limits (`store.getGoals()` /
`store.getGlobalLimit()`), a 7-day trend comparison (`store.trendAnalysis()`),
and day-of-week stats. Three real gaps were identified and scoped through
brainstorming:

1. Goals are enforced only at end-of-day (for the streak) — there's no live
   alert when a limit is approached or crossed during the day.
2. There is no way to get data out of the app (spreadsheet analysis, backup).
3. The trend comparison is hardcoded to 7-day windows; there's no
   month-over-month view.

## 1. Goal threshold alerts (80% / 100%)

**Where:** `checkGoalAlerts()` in `src/main/main.js`, called from the
existing `onTick` callback inside `startTracker()` (already fires every
`pollInterval` seconds — no new timer).

**Logic:** On each tick, read `store.getToday()`, `store.getGoals()`, and
`store.getGlobalLimit()`. For the global limit and for each per-app goal,
compute `pct = actual / target`. When `pct` crosses 0.8 or 1.0 for the first
time that day, fire `new Notification({ title, body }).show()` (same pattern
already used by `forest`/`breakReminder`).

**Dedup:** An in-memory `Set` (mirrors the existing `remindersFired` set),
keyed `` `${dateKey}|${appName-or-'global'}|${threshold}` ``. Resets
naturally because the date component changes daily; no persistence needed
(an app restart mid-day may re-fire one alert — acceptable).

**Copy:**
- 80%, per-app: "80% of your Chrome limit" / "24m of 30m today"
- 100%, per-app: "Chrome limit reached" / "You've used 30m today"
- 80%/100% global: same phrasing with "your daily screen time limit"

## 2. Export

**IPC:** `data:export(format)` where `format` is `'json' | 'csv'`, handled in
`main.js`, using `dialog.showSaveDialog`.

- **JSON** — the full `store.raw()` object (settings, goals, habits, forest,
  days, everything). This is also the backup format Import reads.
- **CSV** — flattened usage only: header `date,app,seconds`, one row per
  app-per-day across all of `store.raw().days`. (Forest/habits don't fit a
  flat table, so CSV is usage-only.)

**UI:** Settings page gets an "Export Data" control with a format choice
(CSV / JSON), calling the new IPC and showing a toast on success.

## 3. Import

**IPC:** `data:import()` in `main.js`, using `dialog.showOpenDialog` filtered
to `.json`. Parses the file and requires a `days` key to be present
(otherwise reject with an error toast — not a valid backup).

**Confirmation:** Before applying, a native `dialog.showMessageBox` warns
that settings/goals/habits/forest will be fully replaced. Proceeds only on
confirm (destructive, hard to reverse).

**Merge semantics:**
- `days` (usage history): union by date key. On a date that exists in both,
  the **imported** day wins entirely (not a per-app sub-merge).
- Everything else (`settings`, `goals`, `globalLimit`, `goalsSnapshots`,
  `reminders`, `habits`, `otherUsers`, `streaks`, `forest`): **replaced
  wholesale** from the imported file, defaulted the same way `store.load()`
  already defaults missing keys on a fresh load.

**After import:** call the store's streak recompute (`syncStreaks` path via
`getStreaks()`) and `flush()`, then push a full refresh to the renderer
(existing pages just re-fetch via their normal `api.get*` calls).

## 4. Month-over-month trend

**Store:** Generalize `trendAnalysis()` to `trendAnalysis(days = 7)`,
reusing the same `rangeData(days, 0)` vs `rangeData(days, days)` comparison
it already does for 7-day windows. No new logic, just a parameter.

**Wire-up:** `computeDashboard()` in `main.js` adds
`monthTrend: store.trendAnalysis(30)` alongside the existing
`trendAnalysis: store.trendAnalysis()` (7-day, unchanged call).

**UI:** A second stat card on the Stats page, next to the existing Trend
card, using the same markup/CSS pattern and a `renderStatTrend`-style
renderer fed by `monthTrend` instead of `trendAnalysis`.

## Out of scope

- CSV import (JSON only, per decision).
- Per-field conflict resolution in Import beyond what's specified above.
- Configurable alert thresholds (fixed at 80%/100%).
- Scheduled/automatic export.
