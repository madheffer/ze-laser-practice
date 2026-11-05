// HTTP rules shared by the Vite config (dev / preview / build) and the standalone server's static files
// (server/static.js), so a hosted copy sends the same headers as `npm run play`.

// Content-Security-Policy for built pages. Not in dev: Vite's dev server injects <style> tags and a websocket.
//   'wasm-unsafe-eval'           three's meshopt decoder
//   style-src-attr 'unsafe-inline'  the style="--src:url(...)" attributes the HUD builds for its icons
// Builds carry it as a <meta>; servers also send it as a header, with frame-ancestors (header-only).
export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' blob: data: https://avatars.steamstatic.com https://avatars.akamai.steamstatic.com", // Steam avatars (auth/steam.js)
  "font-src 'self'",
  "connect-src 'self' blob: data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');
export const CSP_HEADER = `${CSP}; frame-ancestors 'none'`;

// Baked maps and sounds never change under a given URL: the loader adds ?v=<version> to every one of them
// (lib/paths.js versioned()). So the browser may keep them for a year and a reload reads them from disk
// instead of re-downloading ~100+ MB. /weapons/ and /panorama/ are fetched without a version (the vendored
// fp/ engine, CSS url()s), so they keep normal revalidation.
const IMMUTABLE = /^\/(maps|sounds)\//;
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export function isImmutable(url) {
  const path = (url || '').split('?')[0];
  return IMMUTABLE.test(path) && /[?&]v=/.test(url || '');
}
