// Who is signed in: a signed cookie (HMAC-SHA256 with SESSION_SECRET), no session table. It holds the SteamID64,
// the persona name at sign-in and an expiry; HttpOnly + SameSite=Lax (+ Secure on https), 30 days.
// Without SESSION_SECRET a random key is made at start: fine for `npm run dev`, but every sign-in ends on a restart
// (set it on a hosted server, README "Sign in through Steam").
//
// The OpenID round trip's anti-CSRF state uses the same key: a short-lived cookie whose value must come back in
// the return_to Steam signed (auth/routes.js).
import crypto from 'node:crypto';
import { parseCookies } from '../http-util.js';
import { isSteamId } from './steam.js';

export const SESSION_COOKIE = 'lasers_session';
export const STATE_COOKIE = 'lasers_steam_state';
const MAX_AGE = 30 * 24 * 3600; // s
const STATE_AGE = 10 * 60; // s

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function sessions({ secret = process.env.SESSION_SECRET, log = () => {} } = {}) {
  let key = secret && secret.length >= 32 ? Buffer.from(secret) : null;
  if (!key) {
    if (secret) log('auth: SESSION_SECRET is shorter than 32 characters, using a random key instead');
    else log('auth: no SESSION_SECRET, sign-ins last until the server restarts');
    key = crypto.randomBytes(32);
  }
  const mac = (s) => crypto.createHmac('sha256', key).update(s).digest();

  function sign(payload) {
    const body = b64url(JSON.stringify(payload));
    return `${body}.${b64url(mac(body))}`;
  }
  function open(token) {
    if (typeof token !== 'string' || token.length > 2048) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const want = mac(body), got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return p && typeof p === 'object' && Number.isFinite(p.exp) && p.exp > Date.now() / 1000 ? p : null;
    } catch { return null; }
  }
  const cookie = (name, value, maxAge, secure) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

  return {
    // -> { steamId, name } or null
    user(req) {
      const p = open(parseCookies(req)[SESSION_COOKIE]);
      return p && isSteamId(p.sid) ? { steamId: p.sid, name: String(p.n || '').slice(0, 64) } : null;
    },
    signIn(user, secure) {
      return cookie(SESSION_COOKIE, sign({ sid: user.steamId, n: user.name, exp: Math.floor(Date.now() / 1000) + MAX_AGE }), MAX_AGE, secure);
    },
    signOut: (secure) => cookie(SESSION_COOKIE, '', 0, secure),

    // a fresh state for one Steam round trip: [value, Set-Cookie]
    issueState(secure) {
      const v = b64url(crypto.randomBytes(18));
      return [v, cookie(STATE_COOKIE, sign({ s: v, exp: Math.floor(Date.now() / 1000) + STATE_AGE }), STATE_AGE, secure)];
    },
    // the state Steam handed back must be the one this browser was given
    checkState(req, value) {
      const p = open(parseCookies(req)[STATE_COOKIE]);
      return !!(p && typeof value === 'string' && value && p.s === value);
    },
    clearState: (secure) => cookie(STATE_COOKIE, '', 0, secure),
  };
}
