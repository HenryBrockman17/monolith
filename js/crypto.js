/* End-to-end encryption primitives (WebCrypto only, no dependencies).
   - KEK: key derived from the user's passphrase (PBKDF2-SHA256, 600k iters)
   - DEK: random 256-bit data key; encrypts every event line (AES-256-GCM)
   - The KEK wraps the DEK (stored in the repo's keystore.json) and the PAT
     (stored only in this device's vault). GitHub only ever sees ciphertext. */

export const KDF_ITERATIONS = 600000;

const te = new TextEncoder();
const td = new TextDecoder();

export function b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
export function unb64(s) {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function deriveKek(passphrase, saltB64, iterations = KDF_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', te.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  /* extractable so the session can hold the KEK and re-seal rotated OAuth
     tokens into the vault without re-asking for the passphrase */
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    true, ['encrypt', 'decrypt'],
  );
}

export async function exportKeyB64(key) {
  return b64(await crypto.subtle.exportKey('raw', key));
}
export async function importKek(rawB64) {
  return crypto.subtle.importKey('raw', unb64(rawB64), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

export async function generateDek() {
  const raw = randomBytes(32);
  return { key: await importDek(b64(raw)), rawB64: b64(raw) };
}
export async function importDek(rawB64) {
  return crypto.subtle.importKey('raw', unb64(rawB64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/* Generic seal/open: returns/consumes {iv, ct} (base64). Every seal gets a
   fresh random 96-bit IV; GCM auth doubles as tamper + wrong-key detection. */
export async function seal(key, str) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(str));
  return { iv: b64(iv), ct: b64(ct) };
}
export async function open(key, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return td.decode(pt);   // throws OperationError on wrong key / tampering
}

/* ---------- keystore.json (lives in the private data repo) ---------- */
export async function createKeystore(passphrase) {
  const saltB64 = b64(randomBytes(16));
  const kek = await deriveKek(passphrase, saltB64);
  const dek = await generateDek();
  return {
    dek: dek.key,
    keystore: {
      v: 1,
      kdf: { algo: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt: saltB64 },
      dek: await seal(kek, dek.rawB64),
      created: new Date().toISOString(),
    },
  };
}

export async function unlockKeystore(passphrase, keystore) {
  const kek = await deriveKek(passphrase, keystore.kdf.salt, keystore.kdf.iterations);
  const rawB64 = await open(kek, keystore.dek);   // throws if passphrase is wrong
  return { kek, dek: await importDek(rawB64), dekRawB64: rawB64 };
}

/* Re-wrap the DEK under a new passphrase (passphrase change). */
export async function rewrapKeystore(keystore, dekRawB64, newPassphrase) {
  const saltB64 = b64(randomBytes(16));
  const kek = await deriveKek(newPassphrase, saltB64);
  return {
    kek,
    keystore: {
      ...keystore,
      kdf: { algo: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt: saltB64 },
      dek: await seal(kek, dekRawB64),
      rotated: new Date().toISOString(),
    },
  };
}
