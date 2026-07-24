# Monolith — Storage Architecture

Goal: **all tracking, forever, losslessly.** Any information the app can show —
or that a future feature might want — must be recreatable from what's stored.
This supersedes PLAN.md §2 (data model) and §7 (data safety); PLAN.md's
state shape survives as the *derived cache*, not the source of truth.

---

## 1. Core principle: the event log is the truth

The canonical store is an **append-only log of events**: every user action is
recorded as an immutable fact with full metadata, and never rewritten. The
"current state" (habits, which boxes are checked) is just a **projection** —
a fold over the log — cached for fast rendering and rebuildable from scratch
at any time.

Why this is the right call here:

- **Nothing is ever lost.** Unchecking a box doesn't erase that you once
  checked it; renaming "Gym" doesn't erase what it used to be called;
  deleting a habit leaves its whole history in the log. State-only storage
  destroys information on every edit — a log never does.
- **It answers questions the app doesn't ask yet.** "Did I actually check
  things daily, or backfill the whole week on Sunday?" "What was my target
  when I earned that 97% in March?" "What did the board look like on Aug 3?"
  All replayable later, even though no current screen shows them.
- **It fixes PLAN.md's retroactive-target compromise for free.** Target
  changes are events with timestamps, so past months can be scored against
  the target *that was in effect then* — no schema change needed, ever.
- **It's naturally robust.** Append-only files can't be half-overwritten;
  a crash can at worst truncate the final line, which is detectable and
  recoverable. And it's diff-friendly: every backup/sync only grows.

Cost: trivial. An event is ~150 bytes of JSON; heavy use (~12 events/day)
is **< 1 MB per year uncompressed**. Decades of tracking fit in a few MB.

## 2. Event schema

One JSON object per line (JSONL). Every event carries an envelope:

```json
{
  "seq": 1042,                     // strictly increasing, gap = corruption signal
  "id": "e_m3kq9x",                // globally unique (ULID-style: sortable)
  "t": 1753372815123,              // ms epoch, when the action happened
  "tz": "America/Los_Angeles",     // IANA zone + captured offset at write time
  "app": "monolith/1.0.0",         // app version that wrote it (schema forensics)
  "type": "check.set",
  "data": { ... }                  // type-specific payload
}
```

### Event types and payloads

**Tracking:**
- `check.set` — `{ habit, date, value }` plus context:
  - `ctx.view` — where it was done from (`"month:2026-07"`, `"month:2026-08"`
    via a spillover cell, etc.)
  - `ctx.today` — the real date at the time of the click
  - `ctx.backfillDays` — `today − date` (0 = logged same-day). This single
    field preserves the entire "when did I actually record this" dimension.

**Habit lifecycle:** (every payload includes enough to invert the operation)
- `habit.create` — full initial snapshot `{ id, name, emoji, targetPerWeek, order }`
- `habit.update` — diffs only, old and new: `{ id, changes: { targetPerWeek: [4, 5] } }`
- `habit.archive` / `habit.restore` — `{ id }`
- `habit.delete` — `{ id, snapshot, checkCount }`. A tombstone: the habit's
  final state rides along, and its `check.set` history remains in the log
  untouched — projections simply stop surfacing it. True erasure never happens.
- `habit.reorder` — `{ order: [ids…] }` (full list; tiny and unambiguous)

**Administrative:**
- `settings.update` — diffs, old and new
- `data.import` — `{ source, counts, mode: "replace" }` + the pre-import
  state is snapshotted first (see §4), so imports are undoable
- `meta.migration` — `{ from, to }` when the schema version ever bumps
- `meta.note` — free-form; escape hatch for anything future

Schema rule: **event types are never redefined, only added.** A v1 event must
parse identically forever; new meaning = new type name. That's what makes a
ten-year-old log replayable.

## 3. Physical layout: plain files on disk

Browser storage (localStorage/IndexedDB) is the wrong *home* for
forever-data: it's per-browser, invisible to backups, and one
"Clear browsing data" away from gone. Monolith already runs from a local
server, so the server grows a few tiny endpoints and the data lives as
**real files in the project directory**:

```
monolith/
  data/
    events/
      2026.jsonl              # one append-only log per year
      2027.jsonl
    snapshots/
      2026-12.json            # projected state as of an instant (see §4)
      latest.json             # rolling snapshot, rewritten atomically
    exports/                  # user-triggered full backups (see §6)
      monolith-2026-07-24.json
```

- **Server**: a ~100-line Node (or Python) script — static file serving plus
  `GET /api/log?since=seq`, `POST /api/append` (single or batched events,
  returns the committed `seq`), `GET/PUT /api/snapshot`. Append uses
  `O_APPEND` + fsync; `latest.json` is written to a temp file and renamed
  (atomic on APFS), so neither can be half-written.
- **Why files win**: Time Machine picks them up automatically; they're
  greppable and human-readable; they can live in a git repo (`git init
  monolith/data` = free versioned offsite backup via any remote); and no
  browser or vendor owns them.
- **Client cache**: the browser keeps the current projection + last-seen
  `seq` in localStorage purely for instant startup and offline tolerance.
  If the server is unreachable, checks queue in localStorage (marked
  unsynced in the UI) and flush on reconnect. The cache is disposable by
  design — losing it costs nothing but a refetch.

## 4. Projection & snapshots

- On load: fetch `latest.json` + any events after its `seq`, fold them in,
  render. Cold start with no snapshot = replay the year's log (thousands of
  events folds in milliseconds).
- The server refreshes `latest.json` after every ~500 appends, and freezes a
  permanent `YYYY-MM.json` snapshot at each month boundary and before every
  import. Monthly snapshots are never overwritten — they double as
  point-in-time checkpoints ("the board exactly as of Dec 1").
- **Any historical view** = nearest snapshot ≤ T, plus events up to T. This
  is how "show me my board as of any date" stays O(small) forever.

## 5. Integrity

- `seq` must increase by exactly 1 per event within a year-file; the loader
  verifies on read. A gap or unparseable line ⇒ the app flags it and
  recovers: valid prefix + last good snapshot, with the damaged tail
  preserved as `2026.jsonl.corrupt-<date>` for inspection, never silently
  discarded.
- A truncated final line (crash mid-append) is dropped and re-requested from
  the client's unsynced queue — the one place the two stores overlap, by
  design.
- Every export embeds `{ eventCount, lastSeq, sha256 }` of the log range it
  contains, so a backup's completeness is verifiable before restoring it.

## 6. Backup tiers

| Tier | What | When | Protects against |
|---|---|---|---|
| 1 | `data/` files on disk | continuous | browser data loss (total) |
| 2 | Time Machine / OS backup of `data/` | automatic | disk failure, bad edits |
| 3 | git repo in `data/` + remote (optional but recommended) | app auto-commits weekly | machine loss; adds history browsing |
| 4 | Manual export (single JSON: full log + snapshot + checksum) | on demand from header | everything; portable/offline copy |

Restore = point the app at a `data/` directory or import a Tier-4 file.
Import always snapshots the current state first and logs a `data.import`
event — so even a bad restore is itself undoable.

## 7. What this makes recreatable (the acceptance test)

From `data/` alone, with no other information:

- The exact board — checks, habits, names, targets, order — for **any month,
  as it would have appeared on any given day**.
- Every stat on every screen (they're pure functions of the projection).
- Full edit history of every habit: names, emoji, targets over time — so
  historical percentages can be scored against the rules in effect then.
- Recording behavior: same-day vs. backfilled checks, via `ctx.backfillDays`.
- Everything about deleted habits except their surfacing in the UI.
- When and from where every backup/import happened.

If a proposed change to the storage design breaks any line above, the
change is wrong.

## 8. Build impact

Slots into PLAN.md Phase 1 (it *is* the data layer):

1. Event schema + fold/projection as pure functions (`store.js`) — testable
   with fixture logs.
2. The tiny server (static + append/log/snapshot endpoints, atomic writes).
3. Client queue/sync + localStorage cache.
4. Snapshotting + integrity checks.
5. Export/import (Tier 4) and optional git auto-commit (Tier 3).

Phases 2–5 of PLAN.md are unchanged — they just call `append(event)` instead
of mutating state directly.
