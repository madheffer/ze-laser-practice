// Sign in through Steam: OpenID 2.0 (Steam has no OAuth), the same flow and checks as vpkstuff's SteamService
// (vpkstuff/dotnet/VpkStuff.Backend/Services/Steam/SteamService.cs):
//   1. redirect to steamcommunity.com/openid/login (identifier_select: Steam picks the account)
//   2. the callback's assertion is bound to US before anything else: mode id_res, Steam's op_endpoint, our own
//      return_to, a signature over the trusted fields, a response_nonce never seen before
//   3. Steam itself confirms it (check_authentication: is_valid:true)
//   4. the SteamID64 comes out of claimed_id (17 digits, anchored), the persona from GetPlayerSummaries
// Every outbound call has a 10 s timeout so a Steam outage can't stall the server.
//
// STEAM_API_KEY (https://steamcommunity.com/dev/apikey) is for the persona name and avatar; without it sign-in still
// works, the name falls back to "Steam player" + the id's tail and there is no avatar (vpkstuff turns sign-in off).
const OPENID = 'https://steamcommunity.com/openid/login';
const SUMMARIES = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/';
const CLAIMED_ID = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const STEAM_ID = /^\d{17}$/;
// a Steam avatar: its CDN, a 40-hex hash, a jpg (the browser checks the same: app/account.js; the page's CSP
// img-src allows these two hosts and no others, server/http-policy.js)
export const AVATAR_URL = /^https:\/\/avatars\.(?:akamai\.)?steamstatic\.com\/[0-9a-f]{40}(?:_medium|_full)?\.jpg$/;
const NONCE_TTL = 10 * 60 * 1000;
const MAX_NONCES = 50000;
const TIMEOUT = 10000;

export const isSteamId = (v) => typeof v === 'string' && STEAM_ID.test(v);

export function steamOpenId({ apiKey = '', log = () => {} } = {}) {
  const seen = new Map(); // response_nonce -> when

  // expired ones first; past MAX_NONCES the oldest go anyway (insertion order), so a flood can't grow it without end.
  // Steam's own check_authentication still refuses a reused assertion, so dropping an old nonce early is safe.
  function pruneNonces() {
    if (seen.size <= MAX_NONCES) return;
    const cutoff = Date.now() - NONCE_TTL;
    for (const [k, t] of seen) if (t < cutoff) seen.delete(k);
    for (const k of seen.keys()) { if (seen.size <= MAX_NONCES) break; seen.delete(k); }
  }

  return {
    // returnTo: our absolute callback URL (with our state in its query); realm: a prefix of it
    loginUrl(returnTo, realm) {
      const q = new URLSearchParams({
        'openid.ns': 'http://specs.openid.net/auth/2.0',
        'openid.mode': 'checkid_setup',
        'openid.return_to': returnTo,
        'openid.realm': realm,
        'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
        'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
      });
      return `${OPENID}?${q}`;
    },

    // p: the callback's openid.* params; expectedReturnTo: our callback URL without a query.
    // -> { ok, reason }. Checked before Steam is asked, so a captured or relayed assertion is refused.
    validate(p, expectedReturnTo) {
      if (p['openid.mode'] !== 'id_res') return { ok: false, reason: 'mode' };
      if (!String(p['openid.op_endpoint'] || '').toLowerCase().startsWith('https://steamcommunity.com/openid')) return { ok: false, reason: 'op_endpoint' };
      let rt;
      try { rt = new URL(p['openid.return_to']); } catch { return { ok: false, reason: 'return_to' }; }
      if (`${rt.origin}${rt.pathname}`.toLowerCase() !== expectedReturnTo.toLowerCase()) return { ok: false, reason: 'return_to' };
      const signed = new Set(String(p['openid.signed'] || '').split(',').map((s) => s.trim()).filter(Boolean));
      for (const f of ['claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle', 'op_endpoint']) {
        if (!signed.has(f)) return { ok: false, reason: `unsigned:${f}` };
      }
      const nonce = String(p['openid.response_nonce'] || '');
      if (!nonce) return { ok: false, reason: 'no_nonce' };
      pruneNonces();
      if (seen.has(nonce)) return { ok: false, reason: 'nonce_replay' };
      seen.set(nonce, Date.now());
      return { ok: true, reason: '' };
    },

    // Steam recomputes its signature: true only for is_valid:true
    async verify(p) {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(p)) if (k.startsWith('openid.')) body.set(k, v);
      body.set('openid.mode', 'check_authentication');
      try {
        const r = await fetch(OPENID, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT) });
        const text = await r.text();
        if (!r.ok) { log(`steam: verify HTTP ${r.status}`); return false; }
        return text.split('\n').some((l) => l.trim().toLowerCase() === 'is_valid:true');
      } catch (e) {
        log(`steam: verify failed: ${e.message}`);
        return false;
      }
    },

    // the query of the SIGNED return_to (our state rides there; the live query string could have been edited)
    signedReturnQuery(p) {
      try { return new URL(p['openid.return_to']).searchParams; } catch { return new URLSearchParams(); }
    },

    steamIdOf(claimedId) {
      const m = CLAIMED_ID.exec(String(claimedId || ''));
      return m ? m[1] : null;
    },

    // -> { steamId, name, avatar }: the persona, or a stand-in when there is no key or Steam doesn't answer
    async profile(steamId) {
      const fallback = { steamId, name: `Steam player ${steamId.slice(-4)}`, avatar: '' };
      if (!apiKey || !isSteamId(steamId)) return fallback;
      try {
        const r = await fetch(`${SUMMARIES}?key=${encodeURIComponent(apiKey)}&steamids=${steamId}`, { signal: AbortSignal.timeout(TIMEOUT) });
        if (!r.ok) { log(`steam: GetPlayerSummaries HTTP ${r.status}`); return fallback; }
        const p = (await r.json())?.response?.players?.[0];
        if (!p) return fallback;
        // the 184 px one (profiles; small places scale it down), else the 64 px one; Steam's CDN only
        const cdn = (u) => typeof u === 'string' && AVATAR_URL.test(u);
        const avatar = cdn(p.avatarfull) ? p.avatarfull : cdn(p.avatarmedium) ? p.avatarmedium : '';
        return { steamId, name: typeof p.personaname === 'string' && p.personaname.trim() ? p.personaname : fallback.name, avatar };
      } catch (e) {
        log(`steam: GetPlayerSummaries failed: ${e.message}`);
        return fallback;
      }
    },
  };
}
