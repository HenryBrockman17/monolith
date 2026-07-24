#!/usr/bin/env node
/* Decrypt a mirrored data repo into plaintext JSON — no browser needed.
   Usage: node tools/decrypt-export.mjs <path-to-data-repo-clone> [out.json]
   Prompts for the passphrase (hidden input). */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const { subtle } = globalThis.crypto;

const repoDir = process.argv[2];
const outPath = process.argv[3] || `monolith-plain-${new Date().toISOString().slice(0, 10)}.json`;
if (!repoDir || !fs.existsSync(path.join(repoDir, 'keystore.json'))) {
  console.error('Usage: node tools/decrypt-export.mjs <path-to-data-repo-clone> [out.json]');
  console.error('       (the directory must contain keystore.json)');
  process.exit(1);
}

function askHidden(q) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const orig = rl._writeToOutput;
    rl.question(q, a => { rl._writeToOutput = orig; rl.close(); process.stdout.write('\n'); resolve(a); });
    rl._writeToOutput = s => { if (s.includes(q)) rl.output.write(q); };
  });
}

const unb64 = s => Uint8Array.from(Buffer.from(s, 'base64'));

async function open(key, box) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return new TextDecoder().decode(pt);
}

const keystore = JSON.parse(fs.readFileSync(path.join(repoDir, 'keystore.json'), 'utf8'));
const passphrase = await askHidden('Passphrase: ');

const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
const kek = await subtle.deriveKey(
  { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(keystore.kdf.salt), iterations: keystore.kdf.iterations },
  base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
);

let dekRaw;
try {
  dekRaw = await open(kek, keystore.dek);
} catch {
  console.error('Wrong passphrase.');
  process.exit(1);
}
const dek = await subtle.importKey('raw', unb64(dekRaw), { name: 'AES-GCM' }, false, ['decrypt']);

const eventsDir = path.join(repoDir, 'events');
const events = [];
const seen = new Set();
if (fs.existsSync(eventsDir)) {
  for (const f of fs.readdirSync(eventsDir).filter(f => /^\d{4}\.jsonl$/.test(f)).sort()) {
    for (const line of fs.readFileSync(path.join(eventsDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(await open(dek, JSON.parse(line)));
        if (ev.id && seen.has(ev.id)) continue;
        if (ev.id) seen.add(ev.id);
        events.push(ev);
      } catch { console.warn('skipping unreadable line in', f); }
    }
  }
}

fs.writeFileSync(outPath, JSON.stringify({
  format: 'monolith-plain-export/1',
  exportedAt: new Date().toISOString(),
  eventCount: events.length,
  events,
}, null, 2));
console.log(`Decrypted ${events.length} events → ${outPath}`);
