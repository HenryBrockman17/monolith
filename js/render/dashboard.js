/* Year dashboard: hero stats, monthly completion, habit × month table, yearly top 10. */
import { esc, pctRound } from './util.js';
import { MONTHS, MONTHS_SHORT, todayYmd } from '../cal.js';
import * as S from '../stats.js';

export function renderDashboard(el, state, y) {
  const today = todayYmd();
  const curMonth = Number(today.slice(5, 7));
  const curYear = Number(today.slice(0, 4));

  const perMonth = [];
  for (let m = 1; m <= 12; m++) perMonth.push(S.monthTotals(state, y, m));

  const yearDone = perMonth.reduce((n, t) => n + t.totalDone, 0);
  /* year goal counts only months that have started */
  const startedMonths = perMonth.filter((_, i) => y < curYear || (y === curYear && i + 1 <= curMonth));
  const yearGoal = startedMonths.reduce((n, t) => n + t.totalGoal, 0);

  let bestMonth = null, bestPct = -1;
  perMonth.forEach((t, i) => {
    if (!t.totalDone) return;
    const p = pctRound(t.totalDone, t.totalGoal);
    if (p > bestPct) { bestPct = p; bestMonth = i; }
  });

  const allHabits = [...state.habits.values()].sort((a, b) => a.order - b.order);
  let longest = { n: 0, h: null };
  for (const h of allHabits) {
    const n = S.longestStreakInYear(state, h, y);
    if (n > longest.n) longest = { n, h };
  }

  let html = `
  <div class="dash-hero">
    <div class="tile"><div class="tile-label">Total checks</div><div class="tile-value">${yearDone.toLocaleString()}</div><div class="tile-sub">${y}</div></div>
    <div class="tile"><div class="tile-label">Year completion</div><div class="tile-value">${pctRound(yearDone, yearGoal)}%</div><div class="tile-sub">of goal, months to date</div></div>
    <div class="tile"><div class="tile-label">Best month</div><div class="tile-value">${bestMonth !== null ? MONTHS[bestMonth] : '—'}</div><div class="tile-sub">${bestMonth !== null ? bestPct + '% of goal' : 'no data yet'}</div></div>
    <div class="tile"><div class="tile-label">Longest streak</div><div class="tile-value">${longest.n || '—'}</div><div class="tile-sub">${longest.h ? esc(longest.h.name) + ' ' + esc(longest.h.emoji) : 'no data yet'}</div></div>
  </div>`;

  /* monthly completion columns */
  html += '<div class="card"><h2>Monthly completion</h2><div class="dash-months">';
  perMonth.forEach((t, i) => {
    const p = t.totalGoal ? pctRound(t.totalDone, t.totalGoal) : 0;
    const cur = y === curYear && i + 1 === curMonth;
    html += `
      <div class="dash-mcol${cur ? ' cur' : ''}" data-goto-month="${i + 1}" title="Open ${MONTHS[i]}">
        <div class="dash-mpct">${t.totalDone ? p + '%' : ''}</div>
        <div class="dash-mbar"><i style="height:${p}%"></i></div>
        <div class="dash-mname">${MONTHS_SHORT[i]}</div>
      </div>`;
  });
  html += '</div></div>';

  /* habit × month table */
  html += '<div class="card"><h2>Habits by month</h2><div class="scroll-x"><table class="dash-table"><tr><th class="dt-name"></th>';
  for (let i = 0; i < 12; i++) html += `<th class="dt-mon">${MONTHS_SHORT[i]}</th>`;
  html += '<th class="dt-year">YEAR</th></tr>';
  for (const h of allHabits) {
    html += `<tr><td class="dt-name">${esc(h.name)} ${esc(h.emoji)}${h.archivedOn ? ' <span class="archived-tag">archived</span>' : ''}</td>`;
    let hDone = 0, hGoal = 0;
    for (let m = 1; m <= 12; m++) {
      const visible = S.visibleHabits(state, y, m).some(v => v.id === h.id);
      if (!visible) { html += '<td class="dt-cell empty"></td>'; continue; }
      const done = S.doneFor(state, h, y, m);
      const goal = S.monthGoal(h, y, m);
      const started = y < curYear || (y === curYear && m <= curMonth);
      if (started) { hDone += done; hGoal += goal; }
      const p = Math.min(100, pctRound(done, goal));
      const alpha = done ? (0.12 + 0.55 * p / 100).toFixed(2) : 0;
      html += `<td class="dt-cell" style="background:rgba(29,156,184,${alpha})">${done ? p + '%' : ''}</td>`;
    }
    html += `<td class="dt-year">${hGoal ? Math.min(100, pctRound(hDone, hGoal)) + '%' : '—'}</td></tr>`;
  }
  html += '</table></div></div>';

  /* yearly top 10 */
  const ranked = allHabits.map(h => {
    let done = 0, goal = 0;
    for (let m = 1; m <= 12; m++) {
      if (!(y < curYear || (y === curYear && m <= curMonth))) continue;
      if (!S.visibleHabits(state, y, m).some(v => v.id === h.id)) continue;
      done += S.doneFor(state, h, y, m);
      goal += m === curMonth && y === curYear ? S.expectedToDate(h, y, m) : S.monthGoal(h, y, m);
    }
    return { h, pct: goal ? Math.min(100, pctRound(done, goal)) : 0, any: done > 0 };
  }).filter(r => r.any).sort((a, b) => b.pct - a.pct).slice(0, 10);

  html += '<div class="card"><h2>Top habits — ' + y + '</h2>';
  html += ranked.length ? ranked.map((r, i) => `
    <div class="lb-row">
      <div class="lb-rank">${i + 1}</div>
      <div class="lb-name">${esc(r.h.name)} ${esc(r.h.emoji)}</div>
      <div class="lb-bar"><i style="width:${r.pct}%"></i></div>
      <div class="lb-pct">${r.pct}%</div>
    </div>`).join('') : '<div class="muted-note">Nothing tracked this year yet.</div>';
  html += '</div>';

  el.innerHTML = html;
}
