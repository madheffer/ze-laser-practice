import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { coopRelayPlugin } from './server/coop-relay.js';
import { CSP, CSP_HEADER, IMMUTABLE_CACHE, isImmutable } from './server/http-policy.js';

// The run store's database (server/db/store.js): DATABASE_URL from the environment, else from web/.env
// (gitignored). Server-side only: it is not a VITE_ variable, so it never reaches the page.
process.env.DATABASE_URL ??= loadEnv('', fileURLToPath(new URL('.', import.meta.url)), 'DATABASE_').DATABASE_URL;

// versioned maps + sounds are cached for a year (server/http-policy.js)
function longCacheForAssets() {
  const handler = (req, res, next) => {
    if (isImmutable(req.url)) res.setHeader('Cache-Control', IMMUTABLE_CACHE);
    next();
  };
  return {
    name: 'long-cache-versioned-assets',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

// Content-Security-Policy (server/http-policy.js): a <meta> in built pages (not in dev: Vite's dev server injects
// <style> tags and a websocket)
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
      server.middlewares.use((req, res, next) => { res.setHeader('Content-Security-Policy', CSP_HEADER); next(); });
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
