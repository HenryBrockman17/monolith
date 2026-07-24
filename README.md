# 🗿 Monolith

A personal, end-to-end encrypted daily habit tracker. Static web app (GitHub
Pages) + a private GitHub repo as the storage backend. No server, no accounts,
no third-party services — GitHub only ever stores ciphertext.

## How it works

- **App** (this repo, public): plain HTML/JS, no dependencies, served by
  GitHub Pages.
- **Data** (a separate *private* repo): an append-only log of encrypted
  events — `events/2026.jsonl` — plus `keystore.json` (the wrapped data key).
  Every sync is a commit; the git history is the audit trail.
- **Crypto**: your passphrase → PBKDF2-SHA256 (600k iters) → AES-256-GCM key
  that wraps a random data key. Every event line is sealed with the data key
  before it leaves the browser. The GitHub token is stored on-device only,
  encrypted under the same passphrase. Sessions last 30 days, app-enforced.
- **Offline**: changes queue (already encrypted) in the browser and flush
  when back online. A service worker caches the app shell.

There is **no passphrase recovery** — losing the passphrase loses the data
(keep decrypted exports: Settings → Export decrypted backup).

## Setup (once per person)

1. Create a **private** repo for your data, e.g. `monolith-data`. Nothing in it.
2. Create a **fine-grained personal access token**
   (GitHub → Settings → Developer settings → Fine-grained tokens):
   - Repository access: *Only select repositories* → your data repo
   - Permissions: *Contents → Read and write* — nothing else
   - Expiration: up to you; you'll paste a fresh one when it expires
3. Open the app, fill in token + `owner/data-repo` + a passphrase (10+ chars).
   The app validates access, refuses public repos, and creates the keystore.

Additional devices: same three fields, same passphrase. The device joins the
existing keystore.

## Local mirror (recommended)

Keep a full copy of the (encrypted) data repo on your machine:

```sh
tools/mirror.sh                 # clone/pull to ~/Documents/Projects/monolith-data
node tools/decrypt-export.mjs ~/Documents/Projects/monolith-data   # plaintext export
```

## Development

```sh
node server.mjs                 # static serving at http://localhost:8377
node tools/test-e2e.mjs         # headless crypto/auth/sync test suite
```

`mockup.html` is the frozen design reference. `PLAN.md` / `STORAGE.md` are the
design docs (STORAGE.md's file-layout sections describe the original
local-server backend; the GitHub backend in `js/api.js` + `js/gh.js` is the
same event-log design with GitHub as the transport).

## Security properties

- Token: in `Authorization` header only, never in URLs; stored encrypted;
  scoped to one repo.
- Data: AES-256-GCM per line, fresh IV each seal; tampering fails decryption.
- CSP: scripts self-only, connections limited to `api.github.com`; no
  third-party code at all. Frame-busting against clickjacking.
- All user text is HTML-escaped on render; no `eval`, no `innerHTML` of
  unescaped input.
- Wrong passphrase = GCM auth failure — there is nothing to brute-force
  server-side because there is no server.
