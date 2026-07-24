#!/usr/bin/env node
/* Headless end-to-end test: crypto + auth + sync against a mock GitHub
   Contents API. Run: node tools/test-e2e.mjs */
import http from 'node:http';
import crypto from 'node:crypto';

/* ---------- localStorage shim ---------- */
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
};

const auth = await import('../js/auth.js');
const api = await import('../js/api.js');
const store = await import('../js/store.js');

/* ---------- mock GitHub Contents API ---------- */
const files = new Map();   // path -> {content: text, sha}
const sha1 = t => crypto.createHash('sha1').update(t).digest('hex');
let putCount = 0;

let refreshCounter = 0;
const mock = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  /* mock auth worker */
  if (req.url === '/refresh' || req.url === '/exchange') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      if (req.url === '/refresh' && j.refresh_token === 'rtk_dead') return send(400, { error: 'bad_refresh_token' });
      refreshCounter++;
      send(200, {
        access_token: `atk_${refreshCounter}`, expires_in: 28800,
        refresh_token: `rtk_${refreshCounter}`, refresh_token_expires_in: 15552000,
      });
    });
    return;
  }

  /* dead-token simulation */
  if ((req.headers.authorization || '').includes('DEADTOKEN')) return send(401, { message: 'Bad credentials' });

  const m = req.url.match(/^\/repos\/([^/]+)\/([^/]+)(\/contents\/(.+))?$/);
  if (!m) return send(404, { message: 'not found' });

  if (!m[3]) return send(200, { private: true, permissions: { push: true } });

  const path = decodeURIComponent(m[4]);
  if (req.method === 'GET') {
    const f = files.get(path);
    if (f) return send(200, { content: Buffer.from(f.content).toString('base64'), sha: f.sha });
    /* directory listing */
    const kids = [...files.keys()].filter(p => p.startsWith(path + '/'));
    if (kids.length) {
      return send(200, kids.map(p => ({ name: p.slice(path.length + 1), path: p, sha: files.get(p).sha })));
    }
    return send(404, { message: 'Not Found' });
  }
  if (req.method === 'PUT') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      const existing = files.get(path);
      if (existing && j.sha !== existing.sha) return send(409, { message: 'sha mismatch' });
      if (!existing && j.sha) return send(422, { message: 'sha provided for new file' });
      const content = Buffer.from(j.content, 'base64').toString('utf8');
      const f = { content, sha: sha1(content) };
      files.set(path, f);
      putCount++;
      return send(existing ? 200 : 201, { content: { sha: f.sha } });
    });
    return;
  }
  send(405, { message: 'method' });
});

await new Promise(r => mock.listen(0, '127.0.0.1', r));
const apiBase = `http://127.0.0.1:${mock.address().port}`;

/* ---------- assertions ---------- */
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name); }
}
async function throws(fn, name, msgPart) {
  try { await fn(); failed++; console.error('  ✗', name, '(did not throw)'); }
  catch (e) {
    if (!msgPart || String(e.message).toLowerCase().includes(msgPart.toLowerCase())) { passed++; console.log('  ✓', name); }
    else { failed++; console.error('  ✗', name, `(wrong error: ${e.message})`); }
  }
}

const PASS = 'correct horse battery';
const PAT = 'github_pat_TESTTOKEN';

console.log('setup & keystore');
const session = await auth.setup({ pat: PAT, owner: 'o', repo: 'r', passphrase: PASS, apiBase });
ok(!!session && session.creds.pat === PAT, 'setup returns a session with the PAT');
const ks = files.get('keystore.json');
ok(!!ks, 'keystore.json created in repo');
ok(!ks.content.includes(PAT), 'keystore does not contain the PAT');
ok(JSON.parse(ks.content).kdf.iterations >= 600000, 'PBKDF2 iterations >= 600k');
ok(!localStorage.getItem('monolith.vault').includes(PAT), 'vault does not contain plaintext PAT');

console.log('append / encryption at rest');
api.init(session);
const evs = [
  store.makeEvent('habit.create', { id: 'h_1', name: 'Gym', emoji: '🏋️', targetPerWeek: 4, order: 0, createdOn: '2026-07-24' }),
  store.makeEvent('check.set', { habit: 'h_1', date: '2026-07-24', value: true, ctx: { today: '2026-07-24', backfillDays: 0 } }),
];
ok(await api.append(evs), 'append flushes');
const year = new Date().getFullYear();
const log = files.get(`events/${year}.jsonl`);
ok(!!log && log.content.trim().split('\n').length === 2, 'two lines in the year log');
ok(!log.content.includes('Gym') && !log.content.includes('h_1'), 'log is ciphertext (no plaintext leakage)');
ok(JSON.parse(log.content.trim().split('\n')[0]).iv?.length > 0, 'lines are {iv, ct} envelopes');

console.log('loadAll / decryption');
let loaded = await api.loadAll();
ok(loaded.length === 2, 'loadAll returns 2 events');
ok(loaded[0].data.name === 'Gym', 'decrypted payload matches');

console.log('concurrent-writer conflict');
/* another device appends directly */
const other = files.get(`events/${year}.jsonl`);
const foreign = other.content + JSON.stringify({ iv: 'AAAA', ct: 'AAAA' }) + '\n';
files.set(`events/${year}.jsonl`, { content: foreign, sha: sha1(foreign) });
ok(await api.append([store.makeEvent('check.set', { habit: 'h_1', date: '2026-07-23', value: true, ctx: {} })]),
  'append succeeds after foreign write');
ok(files.get(`events/${year}.jsonl`).content.trim().split('\n').length === 4, 'merged file has all 4 lines');
loaded = await api.loadAll();
ok(loaded.length === 3, 'loadAll skips the unreadable foreign line, keeps 3 real events');

console.log('lock / unlock');
auth.logout();
ok(await auth.getSession() === null, 'logout clears session');
await throws(() => auth.unlock('wrong passphrase!!'), 'unlock rejects wrong passphrase', 'wrong passphrase');
const s2 = await auth.unlock(PASS);
ok(!!s2 && s2.creds.pat === PAT, 'unlock restores session from passphrase');

console.log('session expiry (30 days, app-enforced)');
const raw = JSON.parse(localStorage.getItem('monolith.session'));
ok(raw.exp > Date.now() + 29 * 86400000 && raw.exp < Date.now() + 31 * 86400000, 'expiry ~30 days out');
raw.exp = Date.now() - 1000;
localStorage.setItem('monolith.session', JSON.stringify(raw));
ok(await auth.getSession() === null, 'expired session is deleted on read');
await auth.unlock(PASS);

console.log('second device joins');
const vaultBackup = localStorage.getItem('monolith.vault');
localStorage.removeItem('monolith.vault');
localStorage.removeItem('monolith.session');
await throws(() => auth.setup({ pat: PAT, owner: 'o', repo: 'r', passphrase: 'different pass 123', apiBase }),
  'setup with wrong passphrase against existing keystore fails', 'doesn’t open it');
const s3 = await auth.setup({ pat: PAT, owner: 'o', repo: 'r', passphrase: PASS, apiBase });
ok(!!s3, 'setup with correct passphrase joins existing keystore');
api.init(s3);
ok((await api.loadAll()).length === 3, 'second device reads the same data');

console.log('passphrase change');
await throws(() => auth.changePassphrase('nope nope nope', 'brand new passphrase'), 'rejects wrong current passphrase', 'incorrect');
await auth.changePassphrase(PASS, 'brand new passphrase');
auth.logout();
await throws(() => auth.unlock(PASS), 'old passphrase no longer unlocks', 'wrong passphrase');
const s4 = await auth.unlock('brand new passphrase');
ok(!!s4, 'new passphrase unlocks');
api.init(s4);
ok((await api.loadAll()).length === 3, 'data intact after rotation');

console.log('offline queue');
api.init({ ...s4, apiBase: 'http://127.0.0.1:1' });   // dead endpoint
const offlineEv = store.makeEvent('check.set', { habit: 'h_1', date: '2026-07-22', value: true, ctx: {} });
ok(await api.append([offlineEv]) === false, 'append while offline returns false');
ok(api.queueSize() === 1, 'event waits in queue');
ok(api.online === false, 'status is offline');
api.init(s4);                                          // back online
ok(await api.flushQueue(), 'queue flushes on reconnect');
ok(api.queueSize() === 0, 'queue empty after flush');
ok((await api.loadAll()).length === 4, 'offline event arrived');

console.log('duplicate-line guard');
const cur = files.get(`events/${year}.jsonl`);
const lines = cur.content.trim().split('\n');
const dup = cur.content + lines[lines.length - 1] + '\n';   // same ciphertext line twice
files.set(`events/${year}.jsonl`, { content: dup, sha: sha1(dup) });
ok((await api.loadAll()).length === 4, 'duplicate line deduped by event id');

console.log('oauth mode: setup, rotation, stale-unlock refresh');
const oauthMod = await import('../js/oauth.js');
oauthMod.configure({ workerBase: apiBase });
auth.resetDevice();
const oCreds = { mode: 'oauth', access: 'atk_0', refresh: 'rtk_0', accessExp: Date.now() + 8 * 3600e3, refreshExp: Date.now() + 180 * 86400e3 };
const os1 = await auth.setup({ creds: oCreds, owner: 'o', repo: 'r', passphrase: 'brand new passphrase', apiBase });
ok(!!os1 && os1.creds.mode === 'oauth', 'oauth setup opens a session');
ok(!localStorage.getItem('monolith.vault').includes('atk_0'), 'vault does not contain plaintext access token');
api.init(os1);
ok((await api.loadAll()).length === 4, 'oauth session reads the data');

const os2 = await auth.updateCreds({ ...oCreds, access: 'atk_new', refresh: 'rtk_new' });
ok(os2.creds.access === 'atk_new', 'updateCreds swaps session creds');
auth.logout();
const os3 = await auth.unlock('brand new passphrase');
ok(os3.creds.access === 'atk_new', 'rotated creds survive lock/unlock (vault was resealed)');

await auth.updateCreds({ ...oCreds, access: 'atk_stale', accessExp: Date.now() - 1000 });
auth.logout();
const before = refreshCounter;
const os4 = await auth.unlock('brand new passphrase');
ok(refreshCounter === before + 1 && os4.creds.access === `atk_${refreshCounter}`, 'unlock with stale access token silently refreshes');

await auth.updateCreds({ mode: 'oauth', access: 'atk_x', refresh: 'rtk_dead', accessExp: Date.now() - 1000, refreshExp: Date.now() + 86400e3 });
auth.logout();
await throws(() => auth.unlock('brand new passphrase'), 'dead refresh token raises AuthExpiredError, not wrong-passphrase', 'auth expired');

console.log('401 retry via tokenProvider');
const { GitHubRepo } = await import('../js/gh.js');
let providedFresh = false;
const gh401 = new GitHubRepo({
  tokenProvider: async force => { if (force) providedFresh = true; return providedFresh ? 'goodtoken' : 'DEADTOKEN'; },
  owner: 'o', repo: 'r', apiBase,
});
const ksf = await gh401.getFile('keystore.json');
ok(!!ksf && providedFresh, 'a 401 triggers one forced refresh and the retry succeeds');

mock.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
