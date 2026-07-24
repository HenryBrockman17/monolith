/* Routines grid + Overview/Analysis table. */
import { esc, WEEK_COLORS, weeksOf, pctRound } from './util.js';
import { todayYmd, MONTHS_SHORT } from '../cal.js';
import * as S from '../stats.js';

const MON_FULL = Object.fromEntries(MONTHS_SHORT.map((s, i) =>
  [s, ['January','February','March','April','May','June','July','August','September','October','November','December'][i]]));

function activeOn(h, date) {
  return date >= h.createdOn && (!h.archivedOn || date < h.archivedOn);
}

function headerRows(weeks, today, leftCells, rightCells) {
  const gapH = i => (i < weeks.length - 1 ? '<th class="week-gap"></th>' : '');
  let html = '';

  html += `<tr>${leftCells.band}`;
  weeks.forEach((w, i) => {
    html += `<th class="week-band" colspan="7" style="background:${WEEK_COLORS[i]}">WEEK ${i + 1}</th>${gapH(i)}`;
  });
  html += `<th class="week-gap"></th>${rightCells.band}</tr>`;

  html += `<tr>${leftCells.mon}`;
  weeks.forEach((w, i) => {
    let d = 0;
    while (d < w.length) {
      const mon = w[d].mon, inM = w[d].inMonth;
      let span = 0;
      while (d + span < w.length && w[d + span].mon === mon) span++;
      html += `<th class="mon-tag" colspan="${span}">${inM ? '' : mon}</th>`;
      d += span;
    }
    html += gapH(i);
  });
  html += `<th class="week-gap"></th>${rightCells.mon}</tr>`;

  html += `<tr>${leftCells.wd}`;
  weeks.forEach((w, i) => {
    for (const t of w) html += `<th class="day-head${t.date === today ? ' today' : ''}${t.inMonth ? '' : ' spill'}">${t.wd}</th>`;
    html += gapH(i);
  });
  html += `<th class="week-gap"></th>${rightCells.wd}</tr>`;

  html += `<tr>${leftCells.num}`;
  weeks.forEach((w, i) => {
    for (const t of w) html += `<th class="day-num${t.date === today ? ' today' : ''}${t.inMonth ? '' : ' spill'}">${t.n}</th>`;
    html += gapH(i);
  });
  html += `<th class="week-gap"></th>${rightCells.num}</tr>`;

  return html;
}

export function renderRoutines(el, state, y, m, tl) {
  const weeks = weeksOf(tl);
  const today = todayYmd();
  const habits = S.visibleHabits(state, y, m);
  const gripTh = '<th class="grip-cell"></th>';
  const nameTh = '<th class="rt-name"></th>';
  const goalTh = '<th class="rt-goal"></th>';

  let html = headerRows(weeks, today,
    {
      band: gripTh + nameTh + goalTh, mon: gripTh + nameTh + goalTh,
      wd: gripTh + nameTh + '<th class="rt-goal" style="font-size:10px;color:var(--ink-muted)">GOAL</th>',
      num: gripTh + nameTh + goalTh,
    },
    {
      band: '<th colspan="4"></th>', mon: '<th colspan="4"></th>',
      wd: '<th class="stat-head">DONE</th><th class="stat-head">OPEN</th><th class="stat-head">%</th><th class="stat-head" style="text-align:left">PROGRESS</th>',
      num: '<th colspan="4"></th>',
    });

  for (const h of habits) {
    const done = S.doneFor(state, h, y, m);
    const goal = S.monthGoal(h, y, m);
    const open = Math.max(0, goal - done);
    const pct = Math.min(100, pctRound(done, goal));
    const archived = h.archivedOn ? ' <span class="archived-tag">archived</span>' : '';
    html += `<tr class="habit-row" data-habit-row="${h.id}">` +
      `<td class="grip-cell"><span class="grip" data-grip="${h.id}" title="Drag to reorder" aria-label="Drag to reorder">☰</span></td>` +
      `<td class="rt-name" data-edit="${h.id}" title="Edit routine">${esc(h.name)} ${esc(h.emoji)}${archived}</td>` +
      `<td class="rt-goal">${h.targetPerWeek}×/wk</td>`;
    weeks.forEach((w, wi) => {
      for (const t of w) {
        const on = S.isChecked(state, h.id, t.date);
        const future = t.date > today;
        const inactive = !activeOn(h, t.date);
        const spill = !t.inMonth;
        if (inactive && future) {
          html += '<td class="cb-cell"><div class="cb inactive"></div></td>';
        } else {
          /* pre-creation past days stay editable (backfill) — dimmer, and they
             don't count toward the goal denominator */
          html += `<td class="cb-cell" data-habit="${h.id}" data-date="${t.date}"${future ? ' data-future="1"' : ''}>` +
            `<div class="cb${on ? ' checked' : ''}${future ? ' future' : ''}${spill || inactive ? ' spill' : ''}">${on ? '✓' : ''}</div></td>`;
        }
      }
      if (wi < weeks.length - 1) html += '<td class="week-gap"></td>';
    });
    html += `<td class="week-gap"></td>
      <td class="stat-cell">${done}</td>
      <td class="stat-cell">${open}</td>
      <td class="stat-cell stat-pct">${pct}%</td>
      <td class="stat-bar-cell"><div class="stat-bar"><i style="width:${pct}%"></i></div></td></tr>`;
  }

  const width = weeks.length * 7 + weeks.length + 4;
  html += `<tr class="add-row"><td class="grip-cell"></td><td class="rt-name" id="addRoutine">+ Add routine</td><td colspan="${width}"></td></tr>`;

  el.innerHTML = html;
}

/* Mobile board: one Sun–Sat week, thumb-sized cells. Same data attributes as
   the month grid, so all existing click delegation just works. */
export function renderWeekStrip(el, state, y, m, tl, weekIdx) {
  const weeks = weeksOf(tl);
  const wi = Math.max(0, Math.min(weekIdx, weeks.length - 1));
  const w = weeks[wi];
  const today = todayYmd();
  const habits = S.visibleHabits(state, y, m);
  const first = w[0], last = w[6];
  const range = `${first.mon} ${first.n} – ${last.mon === first.mon ? '' : last.mon + ' '}${last.n}`;

  let html = `
  <div class="ws-head">
    <button class="ws-nav" data-ws-prev ${wi === 0 ? 'disabled' : ''}>‹</button>
    <div class="ws-label" style="color:${WEEK_COLORS[wi]}">WEEK ${wi + 1} · ${range}</div>
    <button class="ws-nav" data-ws-next ${wi === weeks.length - 1 ? 'disabled' : ''}>›</button>
  </div>
  <div class="ws-days">${w.map(t =>
    `<div class="ws-day${t.date === today ? ' today' : ''}${t.inMonth ? '' : ' spill'}"><span>${t.wd[0]}</span><b>${t.n}</b></div>`).join('')}
  </div>`;

  for (const h of habits) {
    const done = w.filter(t => S.isChecked(state, h.id, t.date)).length;
    const archived = h.archivedOn ? ' <span class="archived-tag">archived</span>' : '';
    html += `<div class="ws-row" data-habit-row="${h.id}">
      <div class="ws-name" data-edit="${h.id}">${esc(h.name)} ${esc(h.emoji)}${archived}</div>
      <div class="ws-count${done >= h.targetPerWeek ? ' hit' : ''}">${done}/${h.targetPerWeek}</div>
      <div class="ws-cells">`;
    for (const t of w) {
      const on = S.isChecked(state, h.id, t.date);
      const future = t.date > today;
      const spill = !t.inMonth || !activeOn(h, t.date);
      if (future) {
        html += `<div class="ws-cell"><div class="cb future"></div></div>`;
      } else {
        html += `<div class="ws-cell cb-cell" data-habit="${h.id}" data-date="${t.date}"><div class="cb${on ? ' checked' : ''}${spill ? ' spill' : ''}">${on ? '✓' : ''}</div></div>`;
      }
    }
    html += '</div></div>';
  }
  html += '<div class="ws-add" id="addRoutine">+ Add routine</div>';
  el.innerHTML = html;
}

export function renderAnalysis(el, state, y, m, tl) {
  const weeks = weeksOf(tl);
  const today = todayYmd();
  const habits = S.visibleHabits(state, y, m);
  const lbl = '<th class="an-label"></th>';
  const gap = i => (i < weeks.length - 1 ? '<td class="week-gap"></td>' : '');

  let html = headerRows(weeks, today,
    { band: lbl, mon: lbl, wd: lbl, num: lbl },
    { band: '', mon: '', wd: '', num: '' });
  /* headerRows appends a trailing right gap + cells; harmless empties here */

  const dd = {}, dg = {};
  for (const t of tl) {
    dd[t.date] = S.dayDone(state, habits, t.date);
    dg[t.date] = S.dayGoal(habits, t.date);
  }

  html += '<tr><td class="an-label">Analysis</td>';
  weeks.forEach((w, i) => {
    for (const t of w) {
      const v = dd[t.date], g = dg[t.date];
      const hpx = g ? Math.round(v / g * 72) : 0;
      const op = t.inMonth ? 1 : 0.45;
      html += `<td class="an-bar-cell" data-abar="${t.date}">${v ? `<div class="an-bar" style="height:${hpx}px;background:${WEEK_COLORS[i]};opacity:${op}"></div>` : ''}</td>`;
    }
    html += gap(i);
  });
  html += '</tr>';

  const rows = [
    { label: 'Done', fn: t => dd[t.date], dim: false },
    { label: 'Goal', fn: t => dg[t.date], dim: true },
    { label: 'Open', fn: t => Math.max(0, dg[t.date] - dd[t.date]), dim: true },
  ];
  for (const r of rows) {
    html += `<tr><td class="an-label">${r.label}</td>`;
    weeks.forEach((w, i) => {
      for (const t of w) html += `<td class="an-num${r.dim || !t.inMonth ? ' dim' : ''}">${r.fn(t)}</td>`;
      html += gap(i);
    });
    html += '</tr>';
  }

  html += '<tr><td class="an-label">Weekly progress</td>';
  weeks.forEach((w, i) => {
    let wkDone = 0, wkGoal = 0;
    for (const t of w) { wkDone += dd[t.date]; wkGoal += dg[t.date]; }
    const pct = pctRound(wkDone, wkGoal);
    html += `<td class="wk-cell" colspan="7">
      <span class="wk-frac">${wkDone}/${wkGoal}</span>
      <span class="wk-pct" style="margin-left:8px">${pct}%</span>
      <div class="wk-bar"><i style="width:${pct}%;background:${WEEK_COLORS[i]}"></i></div>
    </td>${gap(i)}`;
  });
  html += '</tr>';

  el.innerHTML = html;
  el.dataset.tooltipReady = '1';
}

export function analysisTipHtml(state, y, m, date, tl) {
  const habits = S.visibleHabits(state, y, m);
  const t = tl.find(x => x.date === date);
  const v = S.dayDone(state, habits, date);
  const g = S.dayGoal(habits, date);
  return `<b>${t.wd} ${MON_FULL[t.mon]} ${t.n}</b><div class="t-sub">${v} done · ${Math.max(0, g - v)} open</div>`;
}
