/* Vault + session management.
   - vault (localStorage, per device): repo coords + credentials (PAT or OAuth
     token pair) encrypted under the passphrase-derived KEK. Survives logout.
   - session (localStorage): unlocked DEK + creds + KEK with an expiry the app
     enforces (SESSION_DAYS). Deleted on expiry/logout — the exposure window.
     The KEK rides along so rotated OAuth tokens can be re-sealed into the
     vault without re-asking for the passphrase.
   - keystore.json (in the private data repo): the wrapped DEK, shared by all
     devices. Wrong passphrase = GCM decrypt failure = no entry. */
import * as C from './crypto.js';
import { GitHubRepo } from './gh.js';

const VAULT_KEY = 'monolith.vault';
const SESSION_KEY = 'monolith.session';
export const SESSION_DAYS = 30;

export class AuthExpiredError extends Error {
  constructor(mode) { super('auth expired'); this.code = 'reauth'; this.mode = mode; }
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

export function hasVault() { return !!readJson(VAULT_KEY); }
export function vaultInfo() {
  const v = readJson(VAULT_KEY);
  return v ? { owner: v.owner, repo: v.repo, mode: v.mode || 'pat' } : null;
}

export function credsToken(creds) { return creds.mode === 'oauth' ? creds.access : creds.pat; }

export async function getSession() {
  const s = readJson(SESSION_KEY);
  if (!s) return null;
  if (Date.now() > s.exp) { localStorage.removeItem(SESSION_KEY); return null; }
  return {
    creds: s.creds, owner: s.owner, repo: s.repo, apiBase: s.apiBase,
    dek: await C.importDek(s.dekRawB64), dekRawB64: s.dekRawB64, kekRawB64: s.kekRawB64,
  };
}

async function writeSession({ creds, dekRawB64, kekRawB64, owner, repo, apiBase }) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    creds, dekRawB64, kekRawB64, owner, repo, apiBase, exp: Date.now() + SESSION_DAYS * 86400000,
  }));
}

export function logout() { localStorage.removeItem(SESSION_KEY); }

export function resetDevice() {
  for (const k of [VAULT_KEY, SESSION_KEY, 'monolith.queue', 'monolith.cache']) {
    localStorage.removeItem(k);
  }
}

async function writeVault(kek, { creds, owner, repo, apiBase, kdf }) {
  localStorage.setItem(VAULT_KEY, JSON.stringify({
    v: 2, mode: creds.mode, owner, repo, apiBase, kdf,
    encCreds: await C.seal(kek, JSON.stringify(creds)),
  }));
}

/* Replace stored credentials (rotated OAuth tokens, or a fresh PAT) without
   touching anything else. Requires an active session (it carries the KEK). */
export async function updateCreds(newCreds) {
  const s = readJson(SESSION_KEY);
  const vault = readJson(VAULT_KEY);
  if (!s || !vault) throw new Error('No active session.');
  const kek = await C.importKek(s.kekRawB64);
  vault.encCreds = await C.seal(kek, JSON.stringify(newCreds));
  vault.mode = newCreds.mode;
  delete vault.encPat;                                     // clear any v1 leftover
  localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  s.creds = newCreds;
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  return getSession();
}

/* First run on a device. creds = {mode:'pat', pat} or {mode:'oauth', access,
   refresh, accessExp, refreshExp}. Joins or creates the repo keystore. */
export async function setup({ creds, pat, owner, repo, passphrase, apiBase = 'https://api.github.com' }) {
  if (!creds) creds = { mode: 'pat', pat };               // back-compat call shape
  const gh = new GitHubRepo({ token: credsToken(creds), owner, repo, apiBase });
  const access = await gh.checkAccess().catch(e => ({
    ok: false,
    reason: `Could not reach GitHub (${e?.message || 'network error'}). Hard-refresh this page (Shift+Reload) and re-copy the token if it repeats.`,
  }));
  if (!access.ok) throw new Error(access.reason);
  if (!access.private) throw new Error('That repo is PUBLIC. Your data would be world-readable (even encrypted, commit times leak your activity). Make it private first.');
  if (!access.pushable) throw new Error('These credentials have read access but not write access to this repo.');

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

  await writeVault(kek, { creds, owner, repo, apiBase, kdf: keystore.kdf });
  await writeSession({ creds, dekRawB64, kekRawB64: await C.exportKeyB64(kek), owner, repo, apiBase });
  return getSession();
}

/* Later opens: passphrase → vault creds → repo keystore → DEK → session.
   overrideCreds: fresh tokens from a re-auth that happened while locked.
   Throws AuthExpiredError when credentials are dead (NOT a passphrase problem). */
export async function unlock(passphrase, overrideCreds = null) {
  const vault = readJson(VAULT_KEY);
  if (!vault) throw new Error('No vault on this device — set it up first.');

  const kek = await C.deriveKek(passphrase, vault.kdf.salt, vault.kdf.iterations);
  let creds;
  try {
    if (vault.encCreds) creds = JSON.parse(await C.open(kek, vault.encCreds));
    else if (vault.encPat) creds = { mode: 'pat', pat: await C.open(kek, vault.encPat) };   // v1 vault
    else throw new Error('empty vault');
  } catch {
    throw new Error('Wrong passphrase. (If you changed it on another device, reset this device and set up again.)');
  }
  if (overrideCreds) creds = overrideCreds;

  /* OAuth access tokens live ~8h — refresh before touching the repo. */
  if (creds.mode === 'oauth' && creds.accessExp - Date.now() < 60000 && !overrideCreds) {
    if (!creds.refresh || (creds.refreshExp && creds.refreshExp < Date.now())) throw new AuthExpiredError('oauth');
    const oauth = await import('./oauth.js');
    try {
      creds = await oauth.refreshTokens(creds.refresh);
    } catch {
      throw new AuthExpiredError('oauth');
    }
  }

  const gh = new GitHubRepo({ token: credsToken(creds), owner: vault.owner, repo: vault.repo, apiBase: vault.apiBase });
  let ksFile;
  try {
    ksFile = await gh.getFile('keystore.json');
  } catch (e) {
    if (e && e.status === 401) throw new AuthExpiredError(creds.mode);
    throw new Error('Could not reach GitHub — check your connection and try again.');
  }
  if (!ksFile) throw new Error('keystore.json is missing from the data repo — was it deleted?');
  let dekRawB64;
  try {
    ({ dekRawB64 } = await C.unlockKeystore(passphrase, JSON.parse(ksFile.text)));
  } catch {
    throw new Error('Passphrase opens this device but not the repo keystore — it was probably changed on another device. Reset this device and set up again.');
  }

  await writeVault(kek, { creds, owner: vault.owner, repo: vault.repo, apiBase: vault.apiBase, kdf: vault.kdf });
  await writeSession({
    creds, dekRawB64, kekRawB64: await C.exportKeyB64(kek),
    owner: vault.owner, repo: vault.repo, apiBase: vault.apiBase,
  });
  return getSession();
}

/* Rotate the passphrase: rewrap DEK in the repo keystore + creds in this vault.
   Other devices will need a reset (their vaults hold the old KEK's wrapping). */
export async function changePassphrase(oldPass, newPass) {
  const session = await getSession();
  if (!session) throw new Error('Session expired — unlock first.');
  const vault = readJson(VAULT_KEY);
  const gh = new GitHubRepo({ token: credsToken(session.creds), owner: vault.owner, repo: vault.repo, apiBase: vault.apiBase });

  const ksFile = await gh.getFile('keystore.json');
  const keystore = JSON.parse(ksFile.text);
  try {
    await C.unlockKeystore(oldPass, keystore);
  } catch {
    throw new Error('Current passphrase is incorrect.');
  }

  const { kek, keystore: rotated } = await C.rewrapKeystore(keystore, session.dekRawB64, newPass);
  await gh.putFile('keystore.json', JSON.stringify(rotated, null, 2), 'monolith: rotate keystore passphrase', ksFile.sha);
  await writeVault(kek, { creds: session.creds, owner: vault.owner, repo: vault.repo, apiBase: vault.apiBase, kdf: rotated.kdf });
  const s = readJson(SESSION_KEY);
  s.kekRawB64 = await C.exportKeyB64(kek);
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}
