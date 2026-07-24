/* Sync layer: encrypted append-only log in the private GitHub data repo.
   Events are sealed with the DEK the moment they're queued, so the offline
   queue in localStorage is ciphertext too. GitHub only ever sees ciphertext;
   each flush is one commit — the git history is the audit trail. */
import { GitHubRepo, GhConflict } from './gh.js';
import { seal, open } from './crypto.js';

const QUEUE_KEY = 'monolith.queue';
const CACHE_KEY = 'monolith.cache';

let gh = null;
let dek = null;

export let online = true;
let onStatusChange = () => {};
export function statusListener(fn) { onStatusChange = fn; }
function setOnline(v) { if (online !== v) { online = v; onStatusChange(online, queueSize()); } }

export function init(session) {
  gh = new GitHubRepo({ token: session.pat, owner: session.owner, repo: session.repo, apiBase: session.apiBase });
  dek = session.dek;
}
export function deinit() { gh = null; dek = null; }

function loadQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch { return []; } }
function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
export function queueSize() { return loadQueue().length; }

/* ---------- read ---------- */
export async function loadAll() {
  const files = await gh.listDir('events');
  const logs = files.filter(f => /^\d{4}\.jsonl$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  const events = [];
  const seen = new Set();
  for (const f of logs) {
    const file = await gh.getFile(f.path);
    if (!file) continue;
    for (const line of file.text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(await open(dek, JSON.parse(line)));
        if (ev.id && seen.has(ev.id)) continue;          // retry-duplicate guard
        if (ev.id) seen.add(ev.id);
        events.push(ev);
      } catch { /* unreadable line: skip, never fatal (see STORAGE.md §5) */ }
    }
  }
  setOnline(true);
  return events;
}

/* ---------- write ---------- */
export async function append(events) {
  const q = loadQueue();
  for (const ev of events) {
    const { seq, ...payload } = ev;                       // seq is local bookkeeping only
    const line = JSON.stringify(await seal(dek, JSON.stringify(payload)));
    q.push({ year: new Date(ev.t).getFullYear(), id: ev.id, line });
  }
  saveQueue(q);
  return flushQueue();
}

let flushing = null;
export function flushQueue() {
  if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  if (!gh) return false;
  let q = loadQueue();
  if (!q.length) { setOnline(true); return true; }

  const years = [...new Set(q.map(item => item.year))].sort();
  try {
    for (const year of years) {
      const items = q.filter(i => i.year === year);
      const path = `events/${year}.jsonl`;
      for (let attempt = 0; ; attempt++) {
        const existing = await gh.getFile(path);
        const text = (existing ? existing.text.replace(/\n?$/, '\n') : '') + items.map(i => i.line).join('\n') + '\n';
        try {
          await gh.putFile(path, text, `monolith: ${items.length} event${items.length === 1 ? '' : 's'}`, existing?.sha);
          break;
        } catch (e) {
          if (e instanceof GhConflict && attempt < 3) continue;   // another device wrote — refetch & retry
          throw e;
        }
      }
      q = q.filter(i => i.year !== year);
      saveQueue(q);
    }
    setOnline(true);
    return true;
  } catch {
    setOnline(false);
    onStatusChange(false, loadQueue().length);
    return false;
  }
}

/* ---------- local plaintext cache (fast/offline boot; cleared on logout) ---------- */
export function cacheState(snap) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(snap)); } catch { /* cache is optional */ }
}
export function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; }
}
export function clearLocal() {
  localStorage.removeItem(CACHE_KEY);
  localStorage.removeItem(QUEUE_KEY);
}
