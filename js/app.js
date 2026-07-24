/* Boot, auth flow, view routing, event wiring. Mutations flow through mutate(). */
import * as store from './store.js';
import * as api from './api.js';
import * as auth from './auth.js';
import * as oauth from './oauth.js';
import * as S from './stats.js';
import { MONTHS, MONTHS_SHORT, monthTimeline, todayYmd, parseYmd, ymd } from './cal.js';
import { renderRoutines, renderAnalysis, renderWeekStrip, analysisTipHtml } from './render/grid.js';
import { renderArea, renderGauge, renderLeaderboard, renderStreaks } from './render/charts.js';
import { renderDashboard } from './render/dashboard.js';
import { openHabitModal, openSettingsModal, showToast } from './render/modals.js';
import { attachDragOrder, attachLongPressDrag } from './render/dragorder.js';
import { showTip, hideTip } from './render/util.js';

/* Clickjacking guard — GitHub Pages can't send X-Frame-Options headers. */
if (window.top !== window.self) {
  try { window.top.location = window.self.location; } catch { document.documentElement.innerHTML = ''; }
}

let state = store.emptyState();
let allEvents = [];                     // plaintext copy for decrypted export
const now = new Date();
let view = { kind: 'month', y: now.getFullYear(), m: now.getMonth() + 1 };

const $ = id => document.getElementById(id);
const DEFAULT_ACCENT = '#3aa6c2';
const ACCENTS = ['#3aa6c2', '#2ba447', '#a06fe6', '#2057c9', '#7d8ce0', '#c25da0'];

/* mobile board state */
const mqMobile = matchMedia('(max-width: 700px)');
const forceMobile = new URLSearchParams(location.search).has('mobile');  // preview override
const isMobile = () => forceMobile || mqMobile.matches;
let boardMode = localStorage.getItem('monolith.boardMode') || 'week';   // phones only
let wsWeek = null;                                                      // null → week containing today

/* ---------- mutations ---------- */
let demoMode = false;                   // ?demo=1 — seeded board, nothing persisted

function mutate(events) {
  for (const ev of events) {
    ev.seq = state.lastSeq + 1;         // local fold order; file line order is canonical
    store.apply(state, ev);
    allEvents.push(ev);
  }
  if (!demoMode) {
    api.append(events);
    api.cacheState(store.serialize(state));
  }
  renderAll();
}

function checkCtx(date) {
  const today = todayYmd();
  return {
    view: view.kind === 'month' ? `month:${view.y}-${String(view.m).padStart(2, '0')}` : `year:${view.y}`,
    today,
    backfillDays: Math.round((parseYmd(today) - parseYmd(date)) / 86400000),
  };
}

const EXAMPLE_SET = [
  ['Wake up early', '⏰', 7], ['Time with God', '🙏', 7], ['Deep Work', '💻', 5],
  ['No Alcohol', '🍷', 7], ['Cold Shower', '🚿', 6], ['No Porn', '🚫', 7],
  ['Gym', '🏋️', 4], ['Budget tracking', '💰', 3], ['Goal tracking', '📋', 3],
  ['Reading/Meditating', '📖', 5],
];

/* ---------- auth screens ---------- */
let currentSession = null;
let pendingOauth = null;      // creds waiting for the passphrase step after sign-in

function showAuthCard(card) {
  $('appMain').style.display = 'none';
  $('authView').style.display = '';
  for (const id of ['lockCard', 'setupCard', 'oauthFinishCard', 'reauthCard']) {
    $(id).style.display = id === card ? '' : 'none';
  }
}

function showAuth() {
  const locked = auth.hasVault();
  showAuthCard(locked ? 'lockCard' : 'setupCard');
  if (locked) {
    const info = auth.vaultInfo();
    $('lockRepo').textContent = `${info.owner}/${info.repo}`;
    $('lockPass').value = '';
    $('lockPass').focus();
  }
}

function showReauth(mode) {
  showAuthCard('reauthCard');
  $('reauthOauth').style.display = mode === 'oauth' ? '' : 'none';
  $('reauthPatForm').style.display = mode === 'pat' ? '' : 'none';
  $('reauthErr').style.display = 'none';
}

/* Serves every GitHub call: hands out the current token, silently refreshing
   OAuth tokens as they age out; throws AuthExpiredError when unrecoverable. */
async function tokenProvider(force = false) {
  const creds = currentSession?.creds;
  if (!creds) throw new auth.AuthExpiredError('pat');
  if (creds.mode !== 'oauth') {
    if (force) throw new auth.AuthExpiredError('pat');        // a PAT that 401s is dead
    return creds.pat;
  }
  const stale = force || creds.accessExp - Date.now() < 60000;
  if (!stale) return creds.access;
  if (!creds.refresh || (creds.refreshExp && creds.refreshExp < Date.now())) throw new auth.AuthExpiredError('oauth');
  let fresh;
  try {
    fresh = await oauth.refreshTokens(creds.refresh);
  } catch {
    throw new auth.AuthExpiredError('oauth');
  }
  currentSession = await auth.updateCreds(fresh);             // reseal into vault + session
  return fresh.access;
}

async function startApp(session) {
  currentSession = session;
  api.init(session, tokenProvider);
  $('authView').style.display = 'none';
  $('appMain').style.display = '';
  try {
    allEvents = await api.loadAll();
    state = store.emptyState();
    allEvents.forEach((ev, i) => { ev.seq = i + 1; store.apply(state, ev); });
    api.cacheState(store.serialize(state));
  } catch {
    const cached = api.loadCache();
    if (cached) state = store.deserialize(cached);
    allEvents = [];
  }
  renderAll();
}

function authError(el, msg) {
  el.textContent = msg;
  el.style.display = '';
}

/* ---------- rendering ---------- */
function applySettings() {
  document.documentElement.style.setProperty('--accent', state.settings.accent || DEFAULT_ACCENT);
  $('boardTag').textContent = state.settings.boardName || 'daily habit tracker';
}

function renderTabs() {
  const wrap = $('tabs');
  let html = `<div class="month-tab dashboard${view.kind === 'year' ? ' active' : ''}" data-tab="dash">YEAR DASHBOARD</div>`;
  MONTHS_SHORT.forEach((mn, i) => {
    const active = view.kind === 'month' && view.m === i + 1;
    html += `<div class="month-tab${active ? ' active' : ''}" data-tab="${i + 1}">${mn}</div>`;
  });
  wrap.innerHTML = html;
}

function renderAll() {
  applySettings();
  $('yearLabel').textContent = view.y;
  $('viewLabel').textContent = view.kind === 'month'
    ? `${MONTHS[view.m - 1].toUpperCase()} ${view.y}` : `${view.y} DASHBOARD`;
  renderTabs();

  const dot = $('syncDot');
  dot.className = 'sync-dot ' + (api.online ? 'ok' : 'off');
  dot.title = api.online ? 'Synced to GitHub' : `Offline — ${api.queueSize()} change(s) queued, will sync when back online`;

  const monthView = $('monthView'), dashView = $('dashView'), empty = $('emptyState');

  if (state.habits.size === 0) {
    monthView.style.display = 'none';
    dashView.style.display = 'none';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  if (view.kind === 'year') {
    monthView.style.display = 'none';
    dashView.style.display = '';
    renderDashboard(dashView, state, view.y);
    return;
  }

  monthView.style.display = '';
  dashView.style.display = 'none';
  const tl = monthTimeline(view.y, view.m);
  renderArea($('areaChart'), state, view.y, view.m);
  renderGauge($('gauge'), $('gaugeNum'), $('gaugeSub'), state, view.y, view.m);

  const mobile = isMobile();
  $('boardToggle').style.display = mobile ? '' : 'none';
  if (mobile && boardMode === 'week') {
    $('monthGridWrap').style.display = 'none';
    $('weekStrip').style.display = '';
    if (wsWeek === null) {
      const today = todayYmd();
      const idx = Math.floor(tl.findIndex(t => t.date === today) / 7);
      wsWeek = idx >= 0 ? idx : 0;
    }
    renderWeekStrip($('weekStrip'), state, view.y, view.m, tl, wsWeek);
    $('boardToggle').textContent = 'MONTH';
  } else {
    $('weekStrip').style.display = 'none';
    $('monthGridWrap').style.display = '';
    renderRoutines($('routinesTable'), state, view.y, view.m, tl);
    if (mobile) $('boardToggle').textContent = 'WEEK';
  }

  renderAnalysis($('analysisTable'), state, view.y, view.m, tl);
  renderLeaderboard($('leaderboard'), state, view.y, view.m);
  renderStreaks($('streaks'), state);
}

/* ---------- habit modal flows ---------- */
function openNewHabit() {
  openHabitModal({
    onSave: f => {
      mutate([store.makeEvent('habit.create', {
        id: store.newHabitId(), name: f.name, emoji: f.emoji,
        targetPerWeek: f.targetPerWeek, order: state.habits.size,
        createdOn: todayYmd(),
      })]);
    },
  });
}

function openEditHabit(id) {
  const h = state.habits.get(id);
  if (!h) return;
  const checkCount = [...state.checks.values()].filter(s => s.has(id)).length;
  openHabitModal({
    habit: h, checkCount,
    onSave: f => {
      const changes = {};
      if (f.name !== h.name) changes.name = [h.name, f.name];
      if (f.emoji !== h.emoji) changes.emoji = [h.emoji, f.emoji];
      if (f.targetPerWeek !== h.targetPerWeek) changes.targetPerWeek = [h.targetPerWeek, f.targetPerWeek];
      if (Object.keys(changes).length) mutate([store.makeEvent('habit.update', { id, changes })]);
    },
    onArchive: () => {
      mutate([store.makeEvent('habit.archive', { id, on: todayYmd() })]);
      showToast(`Archived "${h.name}"`, () => mutate([store.makeEvent('habit.restore', { id })]));
    },
    onRestore: () => mutate([store.makeEvent('habit.restore', { id })]),
    onDelete: () => {
      const snapshot = { ...h };
      mutate([store.makeEvent('habit.delete', { id, snapshot, checkCount })]);
      showToast(`Deleted "${h.name}"`, () =>
        mutate([store.makeEvent('habit.create', { ...snapshot })]));   // same id → history resurfaces
    },
  });
}

/* ---------- settings ---------- */
function openSettings() {
  openSettingsModal({
    settings: { boardName: state.settings.boardName || '', accent: state.settings.accent || DEFAULT_ACCENT },
    accents: ACCENTS,
    onSave: f => {
      const changes = {};
      if (f.boardName !== (state.settings.boardName || '')) changes.boardName = [state.settings.boardName || '', f.boardName];
      if (f.accent !== (state.settings.accent || DEFAULT_ACCENT)) changes.accent = [state.settings.accent || DEFAULT_ACCENT, f.accent];
      if (Object.keys(changes).length) mutate([store.makeEvent('settings.update', { changes })]);
    },
    onChangePass: async (oldPass, newPass) => {
      await auth.changePassphrase(oldPass, newPass);   // throws user-readable errors
      showToast('Passphrase changed. Other devices will need to be reset and set up again.');
    },
    onExport: () => {
      const payload = {
        format: 'monolith-plain-export/1',
        exportedAt: new Date().toISOString(),
        eventCount: allEvents.length,
        events: allEvents,
        state: store.serialize(state),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `monolith-backup-${todayYmd()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    },
    onLogout: () => {
      auth.logout();
      api.clearLocal();               // plaintext cache + queue leave with the session
      api.deinit();
      state = store.emptyState();
      allEvents = [];
      showAuth();
    },
    onResetDevice: () => {
      auth.resetDevice();
      api.clearLocal();
      api.deinit();
      state = store.emptyState();
      allEvents = [];
      showAuth();
    },
  });
}

/* ---------- event wiring ---------- */
function wire() {
  /* auth */
  $('lockForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('lockErr').style.display = 'none';
    const btn = $('lockBtn');
    btn.disabled = true; btn.textContent = 'Unlocking…';
    try {
      const session = await auth.unlock($('lockPass').value, pendingOauth?.creds || null);
      pendingOauth = null;
      $('lockNote').style.display = 'none';
      await startApp(session);
    } catch (err) {
      if (err.code === 'reauth') showReauth(err.mode);
      else authError($('lockErr'), err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Unlock';
    }
  });

  /* sign in with GitHub — fresh setup and re-auth variants */
  $('setupOauthBtn').addEventListener('click', () => oauth.beginLogin(false));
  $('reauthOauthBtn').addEventListener('click', () => oauth.beginLogin(true));

  /* passphrase step after OAuth sign-in on a fresh device */
  $('oauthFinishForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('oauthFinishErr').style.display = 'none';
    if (!pendingOauth) return showAuth();
    const pass = $('ofPass').value;
    if (pass.length < 10) return authError($('oauthFinishErr'), 'Passphrase must be at least 10 characters.');
    if (pendingOauth.isNew && pass !== $('ofPass2').value) return authError($('oauthFinishErr'), 'Passphrases don’t match.');
    const pick = $('ofRepo').value.split('/');
    const btn = $('oauthFinishBtn');
    btn.disabled = true; btn.textContent = 'Unlocking…';
    try {
      const session = await auth.setup({
        creds: pendingOauth.creds, owner: pick[0], repo: pick[1], passphrase: pass,
      });
      pendingOauth = null;
      await startApp(session);
    } catch (err) {
      authError($('oauthFinishErr'), err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Unlock my data';
    }
  });

  /* re-auth with a fresh manual token (PAT mode) */
  $('reauthPatForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('reauthErr').style.display = 'none';
    const pat = $('reauthToken').value.replace(/\s+/g, '');
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(pat)) return authError($('reauthErr'), 'That doesn’t look like a GitHub token.');
    const btn = $('reauthPatBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      if (currentSession) {
        currentSession = await auth.updateCreds({ mode: 'pat', pat });
        api.init(currentSession, tokenProvider);
        $('authView').style.display = 'none';
        $('appMain').style.display = '';
        await api.flushQueue();
        renderAll();
      } else {
        /* locked: stash the fresh PAT so unlock() uses it instead of the dead one */
        pendingOauth = { creds: { mode: 'pat', pat }, isNew: false };
        showAuth();
        $('lockNote').style.display = '';
      }
    } catch (err) {
      authError($('reauthErr'), err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Save token';
    }
  });
  $('lockReset').addEventListener('click', () => {
    if ($('lockReset').dataset.armed) {
      auth.resetDevice(); api.clearLocal(); showAuth();
      delete $('lockReset').dataset.armed;
      $('lockReset').textContent = 'Reset this device…';
    } else {
      $('lockReset').dataset.armed = '1';
      $('lockReset').textContent = 'Really reset? Wipes this device’s vault (your data on GitHub is untouched)';
    }
  });

  $('setupForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('setupErr').style.display = 'none';
    const pass = $('setupPass').value, pass2 = $('setupPass2').value;
    const repoFull = $('setupRepo').value.trim();
    const pat = $('setupToken').value.replace(/\s+/g, '');   // strip any pasted whitespace/newlines
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(pat)) return authError($('setupErr'), 'That doesn’t look like a GitHub token — it should start with github_pat_. Re-copy the whole value.');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repoFull)) return authError($('setupErr'), 'Repo must look like owner/name, e.g. HenryBrockman17/monolith-data');
    if (pass.length < 10) return authError($('setupErr'), 'Passphrase must be at least 10 characters. A few random words works well.');
    if (pass !== pass2) return authError($('setupErr'), 'Passphrases don’t match.');
    const [owner, repo] = repoFull.split('/');
    const btn = $('setupBtn');
    btn.disabled = true; btn.textContent = 'Setting up…';
    try {
      const session = await auth.setup({ pat, owner, repo, passphrase: pass });
      await startApp(session);
    } catch (err) {
      authError($('setupErr'), err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Set up & unlock';
    }
  });

  /* app chrome */
  $('settingsBtn').addEventListener('click', openSettings);
  $('tabs').addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    view = tab.dataset.tab === 'dash'
      ? { kind: 'year', y: view.y }
      : { kind: 'month', y: view.y, m: Number(tab.dataset.tab) };
    wsWeek = null;
    renderAll();
  });
  $('yearPrev').addEventListener('click', () => { view.y--; wsWeek = null; renderAll(); });
  $('yearNext').addEventListener('click', () => { view.y++; wsWeek = null; renderAll(); });

  /* month view */
  $('monthView').addEventListener('click', e => {
    const cell = e.target.closest('.cb-cell[data-habit]');
    if (cell) {
      if (cell.dataset.future) return;
      const { habit, date } = cell.dataset;
      const value = !S.isChecked(state, habit, date);
      mutate([store.makeEvent('check.set', { habit, date, value, ctx: checkCtx(date) })]);
      return;
    }
    const edit = e.target.closest('[data-edit]');
    if (edit) { openEditHabit(edit.dataset.edit); return; }
    if (e.target.closest('#addRoutine')) openNewHabit();
  });

  $('monthView').addEventListener('mousemove', e => {
    const bar = e.target.closest('[data-abar]');
    if (bar) {
      const tl = monthTimeline(view.y, view.m);
      showTip(analysisTipHtml(state, view.y, view.m, bar.dataset.abar, tl), e.clientX, e.clientY);
      return;
    }
    const zone = e.target.closest('[data-adate]');
    if (zone) {
      const date = zone.dataset.adate;
      const habits = S.visibleHabits(state, view.y, view.m);
      const done = S.dayDone(state, habits, date);
      const goal = S.dayGoal(habits, date);
      const d = parseYmd(date);
      showTip(`<b>${d.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' })}</b>` +
        `<div class="t-sub">${done} of ${goal} habits · ${goal ? Math.round(done / goal * 100) : 0}%</div>`, e.clientX, e.clientY);
      return;
    }
    hideTip();
  });
  $('monthView').addEventListener('mouseleave', hideTip);

  $('dashView').addEventListener('click', e => {
    const col = e.target.closest('[data-goto-month]');
    if (col) { view = { kind: 'month', y: view.y, m: Number(col.dataset.gotoMonth) }; renderAll(); }
  });

  $('addFirst').addEventListener('click', openNewHabit);
  $('loadExample').addEventListener('click', () => {
    const t = todayYmd();
    mutate(EXAMPLE_SET.map(([name, emoji, target], i) =>
      store.makeEvent('habit.create', {
        id: store.newHabitId(), name, emoji, targetPerWeek: target, order: i, createdOn: t,
      })));
  });

  /* merge: rows hidden in this month view keep their absolute positions */
  const commitReorder = domIds => {
    const all = [...state.habits.values()].sort((a, b) => a.order - b.order).map(h => h.id);
    const visible = new Set(domIds);
    let vi = 0;
    const merged = all.map(id => (visible.has(id) ? domIds[vi++] : id));
    mutate([store.makeEvent('habit.reorder', { order: merged })]);
  };
  attachDragOrder($('routinesTable'), {
    rowSelector: 'tr.habit-row', gripSelector: '[data-grip]', onReorder: commitReorder,
  });
  attachLongPressDrag($('weekStrip'), {
    rowSelector: '.ws-row', handleSelector: '.ws-name', onReorder: commitReorder,
  });

  /* mobile board controls */
  $('boardToggle').addEventListener('click', () => {
    boardMode = boardMode === 'week' ? 'month' : 'week';
    localStorage.setItem('monolith.boardMode', boardMode);
    renderAll();
  });
  $('weekStrip').addEventListener('click', e => {
    if (e.target.closest('[data-ws-prev]')) { wsWeek = Math.max(0, wsWeek - 1); renderAll(); }
    else if (e.target.closest('[data-ws-next]')) { wsWeek = wsWeek + 1; renderAll(); }
  });
  mqMobile.addEventListener('change', () => renderAll());

  api.statusListener(() => renderAll());
  api.authExpiredListener(mode => showReauth(mode));
  window.addEventListener('online', () => api.flushQueue());
  setInterval(() => { if (!api.online) api.flushQueue(); }, 15000);
  /* enforce session expiry while the tab stays open */
  setInterval(async () => {
    if (demoMode) return;
    if ($('appMain').style.display !== 'none' && !(await auth.getSession())) {
      api.deinit(); state = store.emptyState(); allEvents = []; showAuth();
    }
  }, 60000);
}

/* ---------- boot ---------- */
async function handleOauthReturn(cb) {
  const creds = await oauth.exchangeCode(cb.code);

  if (auth.hasVault()) {
    /* re-linking an existing account */
    const session = await auth.getSession();
    if (session) {
      currentSession = session;
      currentSession = await auth.updateCreds(creds);
      await startApp(currentSession);
    } else {
      pendingOauth = { creds, isNew: false };
      showAuth();
      $('lockNote').style.display = '';
    }
    return;
  }

  /* fresh device: find the data repo, then ask for the passphrase */
  const repos = (await oauth.discoverRepos(creds.access)).filter(r => r.private);
  if (!repos.length) {
    showAuthCard('setupCard');
    authError($('setupErr'), 'Signed in, but the Monolith app isn’t installed on any private repo. Install it on your data repo (GitHub → Settings → Applications → Monolith → Repository access), then sign in again.');
    return;
  }
  const sel = $('ofRepo');
  sel.innerHTML = repos.map(r => `<option value="${r.owner}/${r.repo}">${r.owner}/${r.repo}</option>`).join('');
  sel.parentElement.style.display = repos.length > 1 ? '' : 'none';

  async function refreshIsNew() {
    const [owner, repo] = sel.value.split('/');
    const gh = new (await import('./gh.js')).GitHubRepo({ token: creds.access, owner, repo });
    const ks = await gh.getFile('keystore.json').catch(() => null);
    pendingOauth = { creds, isNew: !ks };
    $('ofPass2Row').style.display = pendingOauth.isNew ? '' : 'none';
    $('ofNewNote').style.display = pendingOauth.isNew ? '' : 'none';
    $('ofJoinNote').style.display = pendingOauth.isNew ? 'none' : '';
  }
  sel.onchange = refreshIsNew;
  await refreshIsNew();
  showAuthCard('oauthFinishCard');
  $('ofPass').focus();
}

/* Seeded demo board for design work — 45 days of plausible history, no auth,
   no persistence. Open with ?demo=1 */
function buildDemoState() {
  const s = store.emptyState();
  let seed = 1337;
  const rand = () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const start = new Date();
  start.setDate(start.getDate() - 45);
  EXAMPLE_SET.forEach(([name, emoji, target], i) => {
    store.apply(s, { seq: s.lastSeq + 1, type: 'habit.create', data: {
      id: 'demo_' + i, name, emoji, targetPerWeek: target, order: i, createdOn: ymd(start),
    } });
  });
  const today = todayYmd();
  for (const d = new Date(start); ymd(d) <= today; d.setDate(d.getDate() + 1)) {
    EXAMPLE_SET.forEach(([, , target], i) => {
      if (rand() < 0.85 * target / 7) {
        store.apply(s, { seq: s.lastSeq + 1, type: 'check.set', data: { habit: 'demo_' + i, date: ymd(d), value: true } });
      }
    });
  }
  return s;
}

async function boot() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  wire();

  if (new URLSearchParams(location.search).get('demo') === '1') {
    demoMode = true;
    state = buildDemoState();
    $('authView').style.display = 'none';
    $('appMain').style.display = '';
    renderAll();
    return;
  }

  let cb = null;
  try {
    cb = oauth.consumeCallback();
  } catch (e) {
    showAuth();
    authError(auth.hasVault() ? $('lockErr') : $('setupErr'), e.message);
    return;
  }
  if (cb) {
    try {
      await handleOauthReturn(cb);
    } catch (e) {
      showAuth();
      authError(auth.hasVault() ? $('lockErr') : $('setupErr'), `Sign-in failed: ${e.message}`);
    }
    return;
  }

  const session = await auth.getSession();
  if (session) await startApp(session);
  else showAuth();
}

boot();
