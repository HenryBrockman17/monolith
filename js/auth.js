/* Vault + session management.
   - vault (localStorage, per device): repo coords + PAT encrypted under the
     passphrase-derived KEK. Survives logout.
   - session (localStorage): unlocked DEK + PAT with an expiry the app
     enforces (SESSION_DAYS). Deleted on expiry/logout — the exposure window.
   - keystore.json (in the private data repo): the wrapped DEK, shared by all
     devices. Wrong passphrase = GCM decrypt failure = no entry. */
import * as C from './crypto.js';
import { GitHubRepo } from './gh.js';

const VAULT_KEY = 'monolith.vault';
const SESSION_KEY = 'monolith.session';
export const SESSION_DAYS = 30;

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

export function hasVault() { return !!readJson(VAULT_KEY); }
export function vaultInfo() {
  const v = readJson(VAULT_KEY);
  return v ? { owner: v.owner, repo: v.repo } : null;
}

export async function getSession() {
  const s = readJson(SESSION_KEY);
  if (!s) return null;
  if (Date.now() > s.exp) { localStorage.removeItem(SESSION_KEY); return null; }
  return {
    pat: s.pat, owner: s.owner, repo: s.repo, apiBase: s.apiBase,
    dek: await C.importDek(s.dekRawB64), dekRawB64: s.dekRawB64,
  };
}

function writeSession({ pat, dekRawB64, owner, repo, apiBase }) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    pat, dekRawB64, owner, repo, apiBase, exp: Date.now() + SESSION_DAYS * 86400000,
  }));
}

export function logout() { localStorage.removeItem(SESSION_KEY); }

export function resetDevice() {
  for (const k of [VAULT_KEY, SESSION_KEY, 'monolith.queue', 'monolith.cache']) {
    localStorage.removeItem(k);
  }
}

/* First run on a device: validate access, join or create the keystore,
   store the encrypted vault, open a session. Throws Error with a
   user-presentable message on any failure. */
export async function setup({ pat, owner, repo, passphrase, apiBase = 'https://api.github.com' }) {
  const gh = new GitHubRepo({ token: pat, owner, repo, apiBase });
  const access = await gh.checkAccess().catch(e => ({
    ok: false,
    reason: `Could not reach GitHub (${e?.message || 'network error'}). Hard-refresh this page (Shift+Reload) and re-copy the token if it repeats.`,
  }));
  if (!access.ok) throw new Error(access.reason);
  if (!access.private) throw new Error('That repo is PUBLIC. Your data would be world-readable (even encrypted, commit times leak your activity). Make it private first.');
  if (!access.pushable) throw new Error('Token has read access but not write access to this repo. Re-create it with Contents: Read and write.');

  const existing = await gh.getFile('keystore.json');
  let dekRawB64, kek, keystore;
  if (existing) {
    keystore = JSON.parse(existing.text);
    let unlocked;
    try {
      unlocked = await C.unlockKeystore(passphrase, keystore);
    } catch {
      throw new Error('This repo already has a keystore and that passphrase doesn’t open it. Use the same passphrase you set up the first device with.');
    }
    ({ kek, dekRawB64 } = { kek: unlocked.kek, dekRawB64: unlocked.dekRawB64 });
  } else {
    /* keep the created keystore in memory — a GET right after the PUT can 404
       (GitHub's contents API is eventually consistent on fresh files) */
    const created = await C.createKeystore(passphrase);
    keystore = created.keystore;
    await gh.putFile('keystore.json', JSON.stringify(keystore, null, 2), 'monolith: initialize keystore');
    kek = await C.deriveKek(passphrase, keystore.kdf.salt);
    dekRawB64 = await C.open(kek, keystore.dek);
  }
  localStorage.setItem(VAULT_KEY, JSON.stringify({
    v: 1, owner, repo, apiBase,
    kdf: keystore.kdf,
    encPat: await C.seal(kek, pat),
  }));
  writeSession({ pat, dekRawB64, owner, repo, apiBase });
  return getSession();
}

/* Later opens: passphrase → vault PAT → repo keystore → DEK → session. */
export async function unlock(passphrase) {
  const vault = readJson(VAULT_KEY);
  if (!vault) throw new Error('No vault on this device — set it up first.');

  let pat;
  try {
    const kek = await C.deriveKek(passphrase, vault.kdf.salt, vault.kdf.iterations);
    pat = await C.open(kek, vault.encPat);
  } catch {
    throw new Error('Wrong passphrase. (If you changed it on another device, reset this device and set up again with your token.)');
  }

  const gh = new GitHubRepo({ token: pat, owner: vault.owner, repo: vault.repo, apiBase: vault.apiBase });
  const ksFile = await gh.getFile('keystore.json').catch(e => { throw new Error(friendlyGh(e)); });
  if (!ksFile) throw new Error('keystore.json is missing from the data repo — was it deleted?');
  let dekRawB64;
  try {
    ({ dekRawB64 } = await C.unlockKeystore(passphrase, JSON.parse(ksFile.text)));
  } catch {
    throw new Error('Passphrase opens this device but not the repo keystore — it was probably changed on another device. Reset this device and set up again.');
  }

  writeSession({ pat, dekRawB64, owner: vault.owner, repo: vault.repo, apiBase: vault.apiBase });
  return getSession();
}

/* Rotate the passphrase: rewrap DEK in the repo keystore + PAT in this vault.
   Other devices will need a reset (their vaults hold the old KEK's wrapping). */
export async function changePassphrase(oldPass, newPass) {
  const session = await getSession();
  if (!session) throw new Error('Session expired — unlock first.');
  const vault = readJson(VAULT_KEY);
  const gh = new GitHubRepo({ token: session.pat, owner: vault.owner, repo: vault.repo, apiBase: vault.apiBase });

  const ksFile = await gh.getFile('keystore.json');
  const keystore = JSON.parse(ksFile.text);
  try {
    await C.unlockKeystore(oldPass, keystore);
  } catch {
    throw new Error('Current passphrase is incorrect.');
  }

  const { kek, keystore: rotated } = await C.rewrapKeystore(keystore, session.dekRawB64, newPass);
  await gh.putFile('keystore.json', JSON.stringify(rotated, null, 2), 'monolith: rotate keystore passphrase', ksFile.sha);
  localStorage.setItem(VAULT_KEY, JSON.stringify({
    ...vault, kdf: rotated.kdf, encPat: await C.seal(kek, session.pat),
  }));
}

function friendlyGh(e) {
  if (e && e.status === 401) return 'GitHub rejected the stored token — it may have expired. Reset this device and set up with a fresh token.';
  return 'Could not reach GitHub — check your connection and try again.';
}
