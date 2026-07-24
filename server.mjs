#!/usr/bin/env node
/* Monolith local server — static files + append-only event log API.
   Run: node server.mjs   (then open http://localhost:8377)
   Data lives as plain files in ./data — see STORAGE.md. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const EVENTS = path.join(DATA, 'events');
const SNAPS = path.join(DATA, 'snapshots');
const PORT = Number(process.env.PORT) || 8377;

fs.mkdirSync(EVENTS, { recursive: true });
fs.mkdirSync(SNAPS, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

/* ---------- event log ---------- */
function yearFiles() {
  return fs.readdirSync(EVENTS).filter(f => /^\d{4}\.jsonl$/.test(f)).sort();
}
function readAllEvents(since = 0) {
  const out = [];
  for (const f of yearFiles()) {
    const text = fs.readFileSync(path.join(EVENTS, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }   // truncated tail line
      if (ev.seq > since) out.push(ev);
    }
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}
let lastSeq = readAllEvents(0).reduce((m, e) => Math.max(m, e.seq), 0);

function appendEvents(events) {
  for (const ev of events) {
    ev.seq = ++lastSeq;
    const year = new Date(ev.t || Date.now()).getFullYear();
    const file = path.join(EVENTS, `${year}.jsonl`);
    const fd = fs.openSync(file, 'a');
    fs.writeSync(fd, JSON.stringify(ev) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  }
  return lastSeq;
}

/* If latest.json belongs to a past month, freeze it as that month's permanent
   snapshot before it gets overwritten. */
function freezeMonthlySnapshot() {
  const latest = path.join(SNAPS, 'latest.json');
  if (!fs.existsSync(latest)) return;
  try {
    const snap = JSON.parse(fs.readFileSync(latest, 'utf8'));
    const m = (snap.at || '').slice(0, 7);
    const now = new Date();
    const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (/^\d{4}-\d{2}$/.test(m) && m < cur) {
      const frozen = path.join(SNAPS, `${m}.json`);
      if (!fs.existsSync(frozen)) fs.copyFileSync(latest, frozen);
    }
  } catch { /* unreadable latest — leave it for inspection */ }
}

/* ---------- http ---------- */
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(buf);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => { chunks.push(c); if (chunks.length > 4096) req.destroy(); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (u.pathname === '/api/log' && req.method === 'GET') {
      const since = Number(u.searchParams.get('since')) || 0;
      return send(res, 200, { events: readAllEvents(since), lastSeq });
    }

    if (u.pathname === '/api/append' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const events = Array.isArray(body.events) ? body.events : [];
      if (!events.length) return send(res, 400, { error: 'no events' });
      freezeMonthlySnapshot();
      const seq = appendEvents(events);
      return send(res, 200, { lastSeq: seq });
    }

    if (u.pathname === '/api/snapshot' && req.method === 'GET') {
      const latest = path.join(SNAPS, 'latest.json');
      if (!fs.existsSync(latest)) return send(res, 404, { error: 'no snapshot' });
      return send(res, 200, fs.readFileSync(latest));
    }

    if (u.pathname === '/api/snapshot' && req.method === 'PUT') {
      const body = await readBody(req);
      JSON.parse(body);                                    // validate before writing
      freezeMonthlySnapshot();
      const tmp = path.join(SNAPS, '.latest.tmp');
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, path.join(SNAPS, 'latest.json')); // atomic on APFS
      return send(res, 200, { ok: true });
    }

    if (u.pathname === '/api/export' && req.method === 'GET') {
      const events = readAllEvents(0);
      const jsonl = events.map(e => JSON.stringify(e)).join('\n');
      const latest = path.join(SNAPS, 'latest.json');
      const snapshot = fs.existsSync(latest) ? JSON.parse(fs.readFileSync(latest, 'utf8')) : null;
      const payload = {
        format: 'monolith-export/1', exportedAt: new Date().toISOString(),
        eventCount: events.length, lastSeq,
        sha256: crypto.createHash('sha256').update(jsonl).digest('hex'),
        events, snapshot,
      };
      const name = `monolith-backup-${new Date().toISOString().slice(0, 10)}.json`;
      return send(res, 200, JSON.stringify(payload), 'application/json; charset=utf-8',
        { 'Content-Disposition': `attachment; filename="${name}"` });
    }

    /* ---------- static ---------- */
    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) return send(res, 403, { error: 'forbidden' });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' });
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (err) {
    return send(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`Monolith running at http://localhost:${PORT}  (log seq ${lastSeq})`);
});
