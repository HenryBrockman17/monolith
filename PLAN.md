# Monolith — Functionality Plan

Source-of-truth design: `index.html` (static mockup, July 2026).
This document defines every behavior for the functional build.

---

## 1. Architecture

**Vanilla HTML/CSS/JS, no build step.** The mockup already renders everything
procedurally from a data model; the functional app keeps that shape:

```
monolith/
  index.html        app shell + styles
  js/
    store.js        storage schema, load/save, migrations, import/export
    state.js        app state (current view) + derived stats (pure functions)
    render/
      grid.js       routines grid
      analysis.js   overview/analysis section
      charts.js     area chart, donut, leaderboard, streaks
      dashboard.js  year dashboard view
      modals.js     habit editor, confirm dialogs
    app.js          event wiring, re-render orchestration
```

Rendering model: **state → render(state)**. Every mutation (toggle a check,
edit a habit) updates the store, persists to localStorage, and re-renders the
affected sections. No framework needed at this scale; if it ever hurts,
porting to React is straightforward because stats are already pure functions.

## 2. Data model (localStorage)

> **Superseded by STORAGE.md** — the canonical store is now an append-only
> event log on disk; the shape below survives as the derived in-memory/cache
> projection the renderers read.

Single key `monolith.v1`:

```json
{
  "version": 1,
  "habits": [
    {
      "id": "h_x7f2",            // random slug, never reused
      "name": "Gym",
      "emoji": "🏋️",
      "targetPerWeek": 4,         // 1–7, the variable weekly goal
      "createdOn": "2026-07-01",  // first day the habit is tracked
      "archivedOn": null,         // set instead of deleting
      "order": 6
    }
  ],
  "checks": {
    "2026-07-24": ["h_x7f2", "h_a1b2"]   // date → ids checked that day
  },
  "settings": { "weekStart": 0 }          // 0 = Sunday (fixed for v1)
}
```

Why this shape:
- **Checks keyed by real date** — month views, spillover days, streaks, and
  the year dashboard all read the same map. Editing "June 30 from the July
  view" is the same operation as editing it from the June view.
- **Archive, don't delete** — archiving hides a habit from new months but
  keeps history so past months and the year dashboard stay truthful.
  Hard delete exists but warns that all history is removed.
- **`createdOn`** — stats for a month only "expect" a habit from its creation
  date forward (see §5).
- **`version`** — migration hook for future schema changes.

## 3. Core interactions

### 3.1 Toggling a check
- Click any checkbox cell → toggle → persist → live-recompute everything on
  the page (row stats, daily bars, weekly progress, area chart, donut,
  leaderboard, streaks).
- **Past days: always editable**, in any month, including spillover days
  (they write to the real date, i.e. the neighboring month's data).
- **Future days: locked** (cursor `not-allowed`, tooltip "Future day").
  You can't pre-check tomorrow.
- Today's column stays visually highlighted.
- Cells of archived habits in past months render read-only-looking but are
  still clickable (history correction is allowed).

### 3.2 Adding a routine
- A ghost row "+ Add routine" sits under the last habit row in the grid.
- Clicking it opens the **habit editor** (modal):
  - Name (required, ≤ 40 chars)
  - Emoji (optional free-text field, anything goes)
  - Weekly target: 1–7 stepper, default 7 ("How many days a week?")
- Save → habit appears at the bottom of the grid immediately; `createdOn` =
  today. All goals/denominators for the current month prorate from that date.

### 3.3 Editing a routine
- Click a habit's name cell → same modal, pre-filled, plus:
  - **Archive** — hides from current/future months, history preserved.
    Archived habits are listed in a collapsed "Archived" section of the
    manage view and can be restored.
  - **Delete** — double-confirm ("removes N checks across M months"), erases
    the habit and all its checks.
- **Reorder**: drag handle on the name cell (fallback: ↑/↓ buttons in the
  modal). Order is global, applies to all views.
- **Changing the weekly target**: v1 is retroactive-simple — the current
  target is used everywhere it's displayed, including past months. The
  tradeoff (past months' % shift) is accepted for simplicity; if it bothers
  us later, v2 adds effective-dated targets (`[{from: "2026-07-01", n: 4}]`)
  without a schema break.

### 3.4 Month navigation
- Header: `‹ 2026 ›` year switcher. Tabs: JAN–DEC + YEAR DASHBOARD.
- Any month of any year is viewable and editable. "Today" highlight and
  future-locking only apply where they actually fall.
- A month before the earliest habit's `createdOn` shows an empty-state note
  instead of a dead grid.
- Current month is the default view on load.

### 3.5 Empty state (first run)
- No habits → the grid area shows a centered prompt: short explainer +
  "Add your first routine" button opening the habit editor.
- Optionally a "Load example set" button that seeds the 10 habits from the
  mockup (with the user's own targets to fill in).

## 4. Calendar mechanics

- Weeks are **Sunday-aligned** (per design): a month view spans from the
  Sunday on/before the 1st to the Saturday on/after the last day.
- Spillover days (previous/next month) render dimmed with a month tag,
  are editable, count toward **weekly** progress, and are excluded from all
  **monthly** stats. (Already proven in the mockup.)
- Months spanning **6 calendar weeks** (e.g. a 31-day month starting Fri/Sat)
  get a 6th week band — requires adding a 6th validated band color.
- All date math in local time via `YYYY-MM-DD` strings; no timezone
  conversions, no Date-serialization traps.

## 5. Stats definitions (single source of truth in `state.js`)

For a viewed month with D days, habit h with target t, created c:

- `activeDays(h, month)` — July days ≥ `createdOn` and < archive date.
- `monthGoal(h)` = round(t / 7 × activeDays) — the GOAL denominator.
- `done(h)` = checks on in-month days.
- `open(h)` = max(0, monthGoal − done).
- `habitPct(h)` = done / monthGoal.
- `expectedToDate(h)` = round(t / 7 × elapsed active days) — leaderboard
  denominator for the **current** month; past months use `monthGoal`.
- `dayDone(d)` = habits checked on d; `dayGoal(d)` = habits active on d.
- Weekly progress = Σ dayDone over the Sun–Sat week (incl. spillover) /
  Σ dayGoal over the week.
- Streak(h) = consecutive checked days ending today, crossing month
  boundaries freely. (Streaks stay day-based even for < 7×/wk habits — the
  panel is labeled so it reads as "days in a row", not goal adherence.)
- Donut = Σ done / Σ monthGoal. Area chart = dayDone/dayGoal per in-month day.

Rounding: display percentages `Math.round`; bars use exact fractions.

## 6. Year dashboard

Replaces the placeholder tab. Read-only view for the selected year:
- **Hero row**: total checks, overall yearly %, longest streak, best month.
- **Monthly completion** — 12 columns (monthly % of goal), current month
  highlighted; click a column → jumps to that month view.
- **Habit × month table** — one row per habit (incl. archived, marked),
  cells show monthly %, sequential color scale; yearly % per habit at the
  row end.
- **Yearly Top 10** — same leaderboard, year denominator.

## 7. Data safety

> **Superseded by STORAGE.md** (backup tiers, integrity, import/export).

- **Autosave** on every mutation (single localStorage write, debounced 100ms).
- **Export**: button in header → downloads `monolith-backup-YYYY-MM-DD.json`.
- **Import**: file picker; validates schema + version; previews ("3 habits,
  412 checks, Jan–Jul 2026") before replacing; import merges never silently —
  it's replace-with-confirm in v1.
- **Undo toast** for destructive actions: archiving and deleting a habit show
  a 6-second "Undo" toast before the delete actually commits.

## 8. Build phases

1. **Data layer** — store.js + state.js with the schema and all stats as pure
   functions; unit-testable in isolation. Wire the existing mockup renderers
   to read from it (seeded demo data behind a flag).
2. **Interactive grid** — check toggling with live recompute; future-locking;
   month/year navigation over real dates (incl. 6-week months).
3. **Habit management** — add/edit modal, archive/restore, delete w/ undo,
   reorder, empty state.
4. **Year dashboard.**
5. **Data safety & polish** — export/import, undo toasts, responsive pass
   (grid scrolls horizontally on narrow screens; tabs wrap), favicon/title.

Each phase leaves the app usable.

## 9. Explicitly out of scope (v1)

- Accounts, sync, or any backend (localStorage only; export = backup).
- Notifications/reminders.
- Per-habit schedules ("Mon/Wed/Fri") — the weekly target is count-based,
  not day-specific.
- Notes/journaling per day.
- Light theme (the design is committedly dark).
