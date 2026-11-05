// Steam identities as this site checks them, on the server and in the page alike: a SteamID64 (17 digits) and a
// Steam avatar URL (its CDN, a 40-hex hash, a jpg). The page's CSP img-src allows these two hosts and no others
// (server/http-policy.js).
export const STEAM_ID = /^\d{17}$/;
export const AVATAR_URL = /^https:\/\/avatars\.(?:akamai\.)?steamstatic\.com\/[0-9a-f]{40}(?:_medium|_full)?\.jpg$/;

export const isSteamId = (v) => typeof v === 'string' && STEAM_ID.test(v);
export const isAvatarUrl = (v) => typeof v === 'string' && AVATAR_URL.test(v);
