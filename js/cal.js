/* Calendar helpers — all local-time, all 'YYYY-MM-DD' strings. */
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTHS_SHORT = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function todayYmd() { return ymd(new Date()); }
export function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }   // m is 1-based
export function monthKey(y, m) { return `${y}-${String(m).padStart(2, '0')}`; }
export function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }

/* Timeline for a month view: from the Sunday on/before the 1st to the
   Saturday on/after the last day. 4–6 full Sun–Sat weeks. */
export function monthTimeline(y, m) {
  const first = new Date(y, m - 1, 1);
  const start = new Date(y, m - 1, 1 - first.getDay());
  const dim = daysInMonth(y, m);
  const last = new Date(y, m - 1, dim);
  const end = new Date(y, m - 1, dim + (6 - last.getDay()));
  const tl = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    tl.push({
      date: ymd(d), n: d.getDate(), wd: WEEKDAYS[d.getDay()],
      inMonth: d.getMonth() === m - 1 && d.getFullYear() === y,
      mon: MONTHS_SHORT[d.getMonth()],
    });
  }
  return tl;
}

export function monthDates(y, m) {
  const dim = daysInMonth(y, m);
  const out = [];
  for (let d = 1; d <= dim; d++) out.push(`${monthKey(y, m)}-${String(d).padStart(2, '0')}`);
  return out;
}
