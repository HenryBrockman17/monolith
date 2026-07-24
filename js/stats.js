/* All derived numbers, as pure functions of (state, view). See PLAN.md §5. */
import { monthKey, monthDates, todayYmd, daysInMonth } from './cal.js';

function activeOn(h, date) {
  return date >= h.createdOn && (!h.archivedOn || date < h.archivedOn);
}

/* Habits shown in a month view: existed by month end, not archived before it started. */
export function visibleHabits(state, y, m) {
  const start = `${monthKey(y, m)}-01`;
  const end = `${monthKey(y, m)}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
  return [...state.habits.values()]
    .filter(h => h.createdOn <= end && (!h.archivedOn || h.archivedOn >= start))
    .sort((a, b) => a.order - b.order);
}

export function isChecked(state, habitId, date) {
  const set = state.checks.get(date);
  return !!set && set.has(habitId);
}

export function activeDays(h, y, m) {
  return monthDates(y, m).filter(d => activeOn(h, d)).length;
}

export function monthGoal(h, y, m) {
  return Math.max(1, Math.round(h.targetPerWeek / 7 * activeDays(h, y, m)));
}

export function doneFor(state, h, y, m) {
  return monthDates(y, m).filter(d => isChecked(state, h.id, d)).length;
}

/* Leaderboard denominator: current month → expected so far; past → full goal. */
export function expectedToDate(h, y, m) {
  const today = todayYmd();
  const cur = today.slice(0, 7) === monthKey(y, m);
  if (!cur) return monthGoal(h, y, m);
  const elapsed = monthDates(y, m).filter(d => d <= today && activeOn(h, d)).length;
  return Math.max(1, Math.round(h.targetPerWeek / 7 * elapsed));
}

/* Per-day counts over a set of habits (used for any date, incl. spillover). */
export function dayDone(state, habits, date) {
  return habits.filter(h => activeOn(h, date) && isChecked(state, h.id, date)).length;
}
export function dayGoal(habits, date) {
  return habits.filter(h => activeOn(h, date)).length;
}

/* Consecutive checked days ending today (crosses month boundaries freely). */
export function streak(state, h) {
  let n = 0;
  const d = new Date();
  for (;;) {
    const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!isChecked(state, h.id, s)) break;
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/* Longest run of consecutive checked days that touches the given year. */
export function longestStreakInYear(state, h, y) {
  let best = 0, run = 0;
  const d = new Date(y, 0, 1);
  const end = new Date(y + 1, 0, 1);
  for (; d < end; d.setDate(d.getDate() + 1)) {
    const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    run = isChecked(state, h.id, s) ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

export function monthTotals(state, y, m) {
  const habits = visibleHabits(state, y, m);
  const totalGoal = habits.reduce((n, h) => n + monthGoal(h, y, m), 0);
  const totalDone = habits.reduce((n, h) => n + doneFor(state, h, y, m), 0);
  return { habits, totalGoal, totalDone };
}
