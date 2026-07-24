/* GitHub App OAuth: login redirect, code exchange (via the auth worker),
   silent token refresh, and installed-repo discovery.
   The client secret never exists here — only in the worker. */

export const OAUTH = {
  clientId: 'REPLACE_CLIENT_ID',
  workerBase: 'https://REPLACE.workers.dev',
};
export function configure(cfg) { Object.assign(OAUTH, cfg); }   // tests / future config

const STATE_KEY = 'monolith.oauthState';
const REAUTH_KEY = 'monolith.reauth';

export function beginLogin(reauth = false) {
  const state = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
  sessionStorage.setItem(STATE_KEY, state);
  if (reauth) sessionStorage.setItem(REAUTH_KEY, '1');
  else sessionStorage.removeItem(REAUTH_KEY);
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', OAUTH.clientId);
  u.searchParams.set('state', state);
  location.href = u.toString();
}

/* Call once on boot. Returns {code, reauth} if we're returning from GitHub,
   null otherwise. Strips the code from the URL/history either way. */
export function consumeCallback() {
  const p = new URLSearchParams(location.search);
  const code = p.get('code'), state = p.get('state');
  if (!code) return null;
  const expected = sessionStorage.getItem(STATE_KEY);
  const reauth = sessionStorage.getItem(REAUTH_KEY) === '1';
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(REAUTH_KEY);
  history.replaceState(null, '', location.pathname);      // code must not linger in the URL
  if (!expected || state !== expected) {
    throw new Error('Login state mismatch — the sign-in was not started by this page. Try again.');
  }
  return { code, reauth };
}

function normalize(j) {
  return {
    mode: 'oauth',
    access: j.access_token,
    refresh: j.refresh_token || null,
    accessExp: Date.now() + (Number(j.expires_in) || 8 * 3600) * 1000,
    refreshExp: j.refresh_token ? Date.now() + (Number(j.refresh_token_expires_in) || 180 * 86400) * 1000 : 0,
  };
}

async function workerPost(path, body) {
  const r = await fetch(OAUTH.workerBase + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error || !j.access_token) {
    throw new Error(j.error_description || j.error || `Auth service error (${r.status})`);
  }
  return normalize(j);
}

export function exchangeCode(code) { return workerPost('/exchange', { code }); }
export function refreshTokens(refreshToken) { return workerPost('/refresh', { refresh_token: refreshToken }); }

/* Repos the Monolith GitHub App is installed on, for this user. */
export async function discoverRepos(accessToken, apiBase = 'https://api.github.com') {
  const gh = path => fetch(apiBase + path, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
  }).then(r => (r.ok ? r.json() : Promise.reject(new Error(`GitHub ${r.status}`))));

  const inst = await gh('/user/installations');
  const repos = [];
  for (const i of inst.installations || []) {
    const rs = await gh(`/user/installations/${i.id}/repositories`);
    for (const r of rs.repositories || []) {
      repos.push({ owner: r.owner.login, repo: r.name, private: r.private });
    }
  }
  return repos;
}
