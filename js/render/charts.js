/* Area chart, month donut, leaderboard, streaks. */
import { esc, pctRound } from './util.js';
import { monthDates, todayYmd, MONTHS } from '../cal.js';
import * as S from '../stats.js';

export function renderArea(svg, state, y, m) {
  const dates = monthDates(y, m);
  const habits = S.visibleHabits(state, y, m);
  const today = todayYmd();
  const W = 1000, H = 220, padL = 44, padR = 14, padT = 12, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const dim = dates.length;
  const x = i => padL + (i / (dim - 1)) * iw;
  const yy = v => padT + (1 - v) * ih;

  let g = '';
  [0, 0.25, 0.5, 0.75, 1].forEach(v => {
    g += `<line x1="${padL}" y1="${yy(v)}" x2="${W - padR}" y2="${yy(v)}" stroke="var(--grid-line)" stroke-width="1"/>`;
    g += `<text x="${padL - 8}" y="${yy(v) + 3.5}" text-anchor="end" font-size="10" fill="var(--ink-muted)">${v * 100}%</text>`;
  });
  for (let i = 0; i < dim; i++) {
    if ((i + 1) % 5 === 0 || i === 0) {
      g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--ink-muted)">${i + 1}</text>`;
    }
  }

  const pts = [];
  for (let i = 0; i < dim; i++) {
    if (dates[i] > today) break;
    const goal = S.dayGoal(habits, dates[i]);
    pts.push([x(i), yy(goal ? S.dayDone(state, habits, dates[i]) / goal : 0), dates[i]]);
  }

  if (pts.length >= 2) {
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = line + ` L ${pts[pts.length - 1][0].toFixed(1)} ${yy(0)} L ${pts[0][0].toFixed(1)} ${yy(0)} Z`;
    g += `<path d="${area}" fill="var(--w1)" opacity="0.13"/>`;
    g += `<path d="${line}" fill="none" stroke="var(--w1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = pts[pts.length - 1];
    const goal = S.dayGoal(habits, last[2]);
    g += `<circle cx="${last[0]}" cy="${last[1]}" r="4.5" fill="var(--w1)" stroke="var(--page)" stroke-width="2"/>`;
    g += `<text x="${Math.min(last[0] + 8, W - 40)}" y="${last[1] - 8}" font-size="11" font-weight="600" fill="var(--ink)">${goal ? pctRound(S.dayDone(state, habits, last[2]), goal) : 0}%</text>`;
  } else {
    g += `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="var(--ink-muted)">No days tracked yet</text>`;
  }

  for (let i = 0; i < pts.length; i++) {
    g += `<rect x="${x(i) - iw / dim / 2}" y="${padT}" width="${iw / dim}" height="${ih}" fill="transparent" data-adate="${pts[i][2]}"/>`;
  }
  svg.innerHTML = g;
}

export function renderGauge(svgEl, numEl, subEl, state, y, m) {
  const { totalGoal, totalDone } = S.monthTotals(state, y, m);
  const pct = totalGoal ? totalDone / totalGoal : 0;
  const r = 48, c = 2 * Math.PI * r;
  svgEl.innerHTML = `
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="11"/>
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--w1)" stroke-width="11"
      stroke-linecap="round" stroke-dasharray="${(pct * c).toFixed(1)} ${c.toFixed(1)}"
      transform="rotate(-90 60 60)"/>
    <text x="60" y="66" text-anchor="middle" font-size="17" font-weight="700" fill="var(--ink)">${Math.round(pct * 100)}%</text>`;
  numEl.textContent = `${totalDone}/${totalGoal}`;
  const today = todayYmd();
  const cur = today.slice(0, 7) === `${y}-${String(m).padStart(2, '0')}`;
  subEl.textContent = `checks toward ${MONTHS[m - 1]} goal${cur ? ` · day ${Number(today.slice(8))} of ${monthDates(y, m).length}` : ''}`;
}

export function renderLeaderboard(el, state, y, m) {
  const habits = S.visibleHabits(state, y, m);
  const rows = habits.map(h => {
    const done = S.doneFor(state, h, y, m);
    const exp = S.expectedToDate(h, y, m);
    return { h, pct: Math.min(100, pctRound(done, exp)) };
  }).sort((a, b) => b.pct - a.pct).slice(0, 10);

  el.innerHTML = rows.length ? rows.map((r, i) => `
    <div class="lb-row">
      <div class="lb-rank">${i + 1}</div>
      <div class="lb-name">${esc(r.h.name)} ${esc(r.h.emoji)}</div>
      <div class="lb-bar"><i style="width:${r.pct}%"></i></div>
      <div class="lb-pct">${r.pct}%</div>
    </div>`).join('')
    : '<div class="muted-note">No routines yet.</div>';
}

export function renderStreaks(el, state) {
  const today = todayYmd();
  const habits = [...state.habits.values()].filter(h => !h.archivedOn).sort((a, b) => a.order - b.order);
  const rows = habits.map(h => {
    const window14 = [];
    const d = new Date();
    d.setDate(d.getDate() - 13);
    for (let i = 0; i < 14; i++) {
      const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      window14.push(S.isChecked(state, h.id, s));
      d.setDate(d.getDate() + 1);
    }
    return { h, streak: S.streak(state, h), window14 };
  }).sort((a, b) => b.streak - a.streak);

  el.innerHTML = rows.length ? rows.map(r => `
    <div class="streak-row">
      <div class="streak-name">${esc(r.h.name)} ${esc(r.h.emoji)}</div>
      <div class="streak-days">${r.window14.map(on => `<div class="streak-dot${on ? ' on' : ''}"></div>`).join('')}</div>
      <div class="streak-count"><b>${r.streak}</b> day${r.streak === 1 ? '' : 's'}</div>
    </div>`).join('')
    : '<div class="muted-note">No routines yet.</div>';
}
