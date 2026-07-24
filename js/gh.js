/* Minimal GitHub Contents API client. Token travels only in the
   Authorization header, never in URLs. apiBase is injectable for tests. */

export class GitHubRepo {
  /* Pass either a static `token`, or a `tokenProvider(forceRefresh) → string`
     that refreshes expired OAuth tokens; a 401 triggers one forced-refresh
     retry before giving up. */
  constructor({ token, tokenProvider, owner, repo, apiBase = 'https://api.github.com' }) {
    this.token = token;
    this.tokenProvider = tokenProvider;
    this.owner = owner;
    this.repo = repo;
    this.apiBase = apiBase.replace(/\/$/, '');
  }

  async _auth(force = false) {
    return this.tokenProvider ? this.tokenProvider(force) : this.token;
  }

  async _fetch(path, opts = {}, allowRetry = true) {
    const token = await this._auth();
    const r = await fetch(`${this.apiBase}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.headers || {}),
      },
    });
    if (r.status === 401 && this.tokenProvider && allowRetry) {
      await this._auth(true);                   // throws AuthExpiredError if unrecoverable
      return this._fetch(path, opts, false);
    }
    return r;
  }

  _contents(path) {
    return `/repos/${this.owner}/${this.repo}/contents/${path}`;
  }

  /* → {text, sha} | null (404). Falls back to the blobs API past the 1MB
     contents limit. */
  async getFile(path) {
    const r = await this._fetch(this._contents(path));
    if (r.status === 404) return null;
    if (!r.ok) throw new GhError(r.status, await safeMsg(r));
    const j = await r.json();
    if (j.content !== undefined && j.content !== '') {
      return { text: atobUtf8(j.content), sha: j.sha };
    }
    const blob = await this._fetch(`/repos/${this.owner}/${this.repo}/git/blobs/${j.sha}`);
    if (!blob.ok) throw new GhError(blob.status, await safeMsg(blob));
    const bj = await blob.json();
    return { text: atobUtf8(bj.content), sha: j.sha };
  }

  /* Create or update. Pass sha when updating; 409/422 sha mismatch signals a
     concurrent write — caller refetches and retries. Returns new sha. */
  async putFile(path, text, message, sha) {
    const body = { message, content: btoaUtf8(text) };
    if (sha) body.sha = sha;
    const r = await this._fetch(this._contents(path), { method: 'PUT', body: JSON.stringify(body) });
    if (r.status === 409 || r.status === 422) throw new GhConflict();
    if (!r.ok) throw new GhError(r.status, await safeMsg(r));
    return (await r.json()).content.sha;
  }

  /* → [{name, path, sha}] | [] (404 = directory doesn't exist yet). */
  async listDir(path) {
    const r = await this._fetch(this._contents(path));
    if (r.status === 404) return [];
    if (!r.ok) throw new GhError(r.status, await safeMsg(r));
    const j = await r.json();
    return Array.isArray(j) ? j.map(f => ({ name: f.name, path: f.path, sha: f.sha })) : [];
  }

  /* Cheap auth/repo validation for setup + unlock. */
  async checkAccess() {
    const r = await this._fetch(`/repos/${this.owner}/${this.repo}`);
    if (r.status === 401) return { ok: false, reason: 'Token was rejected (401). Check that it is valid and not expired.' };
    if (r.status === 403) return { ok: false, reason: 'Token lacks permission for this repo (403).' };
    if (r.status === 404) return { ok: false, reason: 'Repo not found (404) — check the name, and that the token is scoped to it.' };
    if (!r.ok) return { ok: false, reason: `GitHub error ${r.status}.` };
    const j = await r.json();
    return { ok: true, private: j.private, pushable: j.permissions?.push !== false };
  }
}

export class GhError extends Error {
  constructor(status, msg) { super(`GitHub ${status}: ${msg}`); this.status = status; }
}
export class GhConflict extends Error {
  constructor() { super('conflict'); }
}

async function safeMsg(r) {
  try { return (await r.json()).message || r.statusText; } catch { return r.statusText; }
}

/* UTF-8-safe base64 (btoa alone breaks on non-ASCII). */
function btoaUtf8(s) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
function atobUtf8(b64) {
  const clean = b64.replace(/\n/g, '');
  return new TextDecoder().decode(Uint8Array.from(atob(clean), c => c.charCodeAt(0)));
}
