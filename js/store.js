/* Event fold: the projection is a pure function of the log. See STORAGE.md. */

export function emptyState() {
  return {
    habits: new Map(),          // id -> {id,name,emoji,targetPerWeek,order,createdOn,archivedOn}
    checks: new Map(),          // 'YYYY-MM-DD' -> Set(habitId)  (kept even for deleted habits)
    settings: { weekStart: 0 },
    lastSeq: 0,
  };
}

export function apply(state, ev) {
  state.lastSeq = Math.max(state.lastSeq, ev.seq || 0);
  const d = ev.data || {};
  switch (ev.type) {
    case 'habit.create':
      state.habits.set(d.id, {
        id: d.id, name: d.name, emoji: d.emoji || '',
        targetPerWeek: d.targetPerWeek, order: d.order ?? state.habits.size,
        createdOn: d.createdOn, archivedOn: d.archivedOn ?? null,
      });
      break;
    case 'habit.update': {
      const h = state.habits.get(d.id);
      if (h) for (const [k, pair] of Object.entries(d.changes || {})) h[k] = pair[1];
      break;
    }
    case 'habit.archive': { const h = state.habits.get(d.id); if (h) h.archivedOn = d.on; break; }
    case 'habit.restore': { const h = state.habits.get(d.id); if (h) h.archivedOn = null; break; }
    case 'habit.delete': state.habits.delete(d.id); break;   // checks stay — tombstone in event
    case 'habit.reorder':
      (d.order || []).forEach((id, i) => { const h = state.habits.get(id); if (h) h.order = i; });
      break;
    case 'check.set': {
      let set = state.checks.get(d.date);
      if (d.value) {
        if (!set) { set = new Set(); state.checks.set(d.date, set); }
        set.add(d.habit);
      } else if (set) {
        set.delete(d.habit);
        if (!set.size) state.checks.delete(d.date);
      }
      break;
    }
    case 'settings.update':
      for (const [k, pair] of Object.entries(d.changes || {})) state.settings[k] = pair[1];
      break;
    default: break;   // forward-compat: unknown event types are ignored, never fatal
  }
  return state;
}

export function makeEvent(type, data) {
  return {
    id: 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    t: Date.now(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    app: 'monolith/1.0.0',
    type, data,
  };
}

export function newHabitId() {
  return 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ---------- snapshot (de)serialization ---------- */
export function serialize(state) {
  return {
    at: new Date().toISOString(),
    lastSeq: state.lastSeq,
    habits: [...state.habits.values()],
    checks: Object.fromEntries([...state.checks].map(([d, s]) => [d, [...s]])),
    settings: state.settings,
  };
}

export function deserialize(snap) {
  const state = emptyState();
  state.lastSeq = snap.lastSeq || 0;
  for (const h of snap.habits || []) state.habits.set(h.id, { ...h });
  for (const [d, ids] of Object.entries(snap.checks || {})) state.checks.set(d, new Set(ids));
  Object.assign(state.settings, snap.settings || {});
  return state;
}
