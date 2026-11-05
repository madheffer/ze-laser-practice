// /api/auth/: sign in through Steam (auth/steam.js), who you are, sign out.
//
//   GET  /api/auth/steam/login      the browser goes here (a link, not a fetch): off to Steam with a fresh state
//   GET  /api/auth/steam/callback   Steam sends the browser back here; on success the session cookie is set and the
//                                   page reloads at /?signin=ok (or /?signin=failed)
//   GET  /api/auth/me               -> { user: { steamId, name } | null }
//   POST /api/auth/logout           clears the session cookie (same-origin only)
//
// STEAM_RETURN_HOST (e.g. https://lasers.example.com, no trailing slash): the public origin Steam returns to. Unset,
// it is this request's own scheme + Host (fine for localhost and a single-domain host).
import { json, redirect, sameOriginWrite, isHttps, clientAddress, rateGate } from '../http-util.js';

const HOST = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i;
const CALLBACK = '/api/auth/steam/callback';

// auth: { steam (auth/steam.js), sessions (auth/session.js), store, returnHost, ipHeader, log }
export function authRoutes({ steam, sessions, store, returnHost = '', ipHeader = '', log = () => {} }) {
  const gate = rateGate(1000); // a callback per address per second: each one costs a request to Steam
  const configured = (() => {
    if (!returnHost) return '';
    try { const u = new URL(returnHost); return u.origin; } catch { log(`auth: STEAM_RETURN_HOST "${returnHost}" is not a URL, ignoring it`); return ''; }
  })();
  const originOf = (req) => {
    if (configured) return configured;
    const host = String(req.headers.host || '');
    return HOST.test(host) ? `${isHttps(req) ? 'https' : 'http'}://${host}` : '';
  };
  const secureFor = (req) => isHttps(req) || configured.startsWith('https:');

  async function callback(req, res, url) {
    const secure = secureFor(req);
    const fail = (why) => { log(`auth: steam sign-in refused (${why})`); redirect(res, '/?signin=failed', { 'set-cookie': sessions.clearState(secure) }); };
    if (!gate(clientAddress(req, ipHeader))) return fail('rate');
    const origin = originOf(req);
    if (!origin) return fail('host');
    const p = {};
    for (const [k, v] of url.searchParams) if (k.startsWith('openid.') && !Object.hasOwn(p, k)) p[k] = v;
    const shape = steam.validate(p, `${origin}${CALLBACK}`);
    if (!shape.ok) return fail(shape.reason);
    // our state: the copy in the return_to Steam signed, the live query's copy, and this browser's cookie must agree
    const state = steam.signedReturnQuery(p).get('cs') || '';
    if (!state || url.searchParams.get('cs') !== state || !sessions.checkState(req, state)) return fail('state');
    if (!(await steam.verify(p))) return fail('verify');
    const steamId = steam.steamIdOf(p['openid.claimed_id']);
    if (!steamId) return fail('claim');
    const user = await steam.profile(steamId);
    await store.upsertPlayer(user).catch((e) => log(`auth: could not store the player: ${e.message}`));
    redirect(res, '/?signin=ok', { 'set-cookie': [sessions.signIn(user, secure), sessions.clearState(secure)] });
  }

  // -> true when it answered
  return async (req, res, url) => {
    const path = url.pathname;
    if (path === '/api/auth/me' && req.method === 'GET') {
      const u = sessions.user(req);
      json(res, 200, { user: u ? { steamId: u.steamId, name: u.name } : null });
      return true;
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      if (!sameOriginWrite(req)) { json(res, 403, { error: 'cross-site' }); return true; }
      json(res, 200, { ok: true }, { 'set-cookie': sessions.signOut(secureFor(req)) });
      return true;
    }
    if (path === '/api/auth/steam/login' && req.method === 'GET') {
      const origin = originOf(req);
      if (!origin) { json(res, 400, { error: 'bad host' }); return true; }
      const [state, cookie] = sessions.issueState(secureFor(req));
      redirect(res, steam.loginUrl(`${origin}${CALLBACK}?cs=${encodeURIComponent(state)}`, `${origin}/`), { 'set-cookie': cookie });
      return true;
    }
    if (path === CALLBACK && req.method === 'GET') { await callback(req, res, url); return true; }
    return false;
  };
}
