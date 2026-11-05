// Who you are on this server: signed in through Steam (server/auth/), or not. Signing in is a page navigation to
// /api/auth/steam/login (Steam's own page, then back to /?signin=ok); the session is an HttpOnly cookie, so the page
// only ever knows what /api/auth/me says.
import { fetchJson } from '../lib/fetch.js';
import { cleanText } from '../lib/room-rules.js';

export const account = { user: null, known: false }; // user: { steamId, name }
const listeners = new Set();
const emit = () => { for (const f of listeners) f(account); };

export const signedIn = () => !!account.user;
export const onAccount = (f) => { listeners.add(f); return () => listeners.delete(f); };
export const SIGN_IN_URL = '/api/auth/steam/login';

const STEAM_ID = /^\d{17}$/;

export async function loadAccount() {
  try {
    const j = await fetchJson('/api/auth/me', { cache: 'no-store' });
    const u = j?.user;
    account.user = u && STEAM_ID.test(u.steamId) ? { steamId: u.steamId, name: cleanText(u.name, 32) || 'Steam player' } : null;
  } catch {
    account.user = null; // no server (a static host): signed out
  }
  account.known = true;
  emit();
}

export async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  account.user = null;
  emit();
}
