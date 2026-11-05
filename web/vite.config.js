import { defineConfig } from 'vite';
import { coopRelayPlugin } from './server/coop-relay.js';

// Baked maps and sounds never change under a given URL: the loader adds ?v=<version> to every one of them
// (lib/paths.js versioned()). So the browser may keep them for a year and a reload reads them from disk
// instead of re-downloading ~100+ MB. /weapons/ and /panorama/ are fetched without a version (the vendored
// fp/ engine, CSS url()s), so they keep normal revalidation.
const IMMUTABLE = /^\/(maps|sounds)\//;
function longCacheForAssets() {
  const handler = (req, res, next) => {
    const path = (req.url || '').split('?')[0];
    const versioned = /[?&]v=/.test(req.url || '');
    if (IMMUTABLE.test(path) && versioned) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    next();
  };
  return {
    name: 'long-cache-versioned-assets',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

// Content-Security-Policy for built pages. Not in dev: Vite's dev server injects <style> tags and a websocket.
//   'wasm-unsafe-eval'           three's meshopt decoder
//   style-src-attr 'unsafe-inline'  the style="--src:url(...)" attributes the HUD builds for its icons
// frame-ancestors is header-only; hosts should also send it (and the same policy) as a response header.
export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self' blob: data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');
function cspInBuild() {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  };
}
// `vite preview` (npm run play) sends it as a real header too, with frame-ancestors.
function cspHeaderInPreview() {
  return {
    name: 'csp-header-preview',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => { res.setHeader('Content-Security-Policy', `${CSP}; frame-ancestors 'none'`); next(); });
    },
  };
}

export default defineConfig({
  plugins: [longCacheForAssets(), cspInBuild(), cspHeaderInPreview(), coopRelayPlugin()],
  server: { port: 5804, strictPort: true },
  // a stable copy for playing while code is being edited: `npm run play` (build + preview, no hot reload)
  // `npm run host` = the same on every network interface, so a friend on your LAN can join a co-op room
  preview: { port: 5805, strictPort: true },
  build: { target: 'es2022' },
});
