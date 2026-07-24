/* Monolith auth worker — the one server-side step OAuth requires.
   Exchanges login codes / refresh tokens for GitHub tokens by attaching the
   client secret (which must never reach the browser). Stores nothing, logs
   nothing, passes through only the token fields the app needs.
   Deploy: wrangler deploy   Secret: wrangler secret put GITHUB_CLIENT_SECRET */

const ALLOWED_ORIGINS = [
  'https://henrybrockman17.github.io',
  'http://localhost:8377',              // local dev — remove if you never dev locally
];

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
}

async function githubToken(env, params) {
  const r = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      ...params,
    }),
  });
  const j = await r.json();
  if (j.error) return { error: j.error, error_description: j.error_description };
  /* pass through only what the app needs */
  return {
    access_token: j.access_token,
    expires_in: j.expires_in,
    refresh_token: j.refresh_token,
    refresh_token_expires_in: j.refresh_token_expires_in,
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = { ...cors(origin), 'Content-Type': 'application/json' };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'method' }), { status: 405, headers });

    const url = new URL(request.url);
    let body;
    try { body = await request.json(); } catch { body = {}; }

    let result;
    if (url.pathname === '/exchange' && body.code) {
      result = await githubToken(env, { code: body.code });
    } else if (url.pathname === '/refresh' && body.refresh_token) {
      result = await githubToken(env, { grant_type: 'refresh_token', refresh_token: body.refresh_token });
    } else {
      return new Response(JSON.stringify({ error: 'bad request' }), { status: 400, headers });
    }

    return new Response(JSON.stringify(result), { status: result.error ? 400 : 200, headers });
  },
};
