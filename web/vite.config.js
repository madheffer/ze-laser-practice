import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { coopRelayPlugin } from './server/coop-relay.js';
import { stageShotsDevPlugin } from './server/stage-shots-dev.js';
import { CSP, CSP_HEADER, IMMUTABLE_CACHE, isImmutable } from './server/http-policy.js';

// The run store's database (server/db/store.js): DATABASE_URL from the environment, else from web/.env
// (gitignored). Server-side only: it is not a VITE_ variable, so it never reaches the page.
// Steam sign-in's settings the same way (server/auth/index.js): STEAM_API_KEY, STEAM_RETURN_HOST, SESSION_SECRET.
const serverEnv = loadEnv('', fileURLToPath(new URL('.', import.meta.url)), ['DATABASE_', 'STEAM_', 'SESSION_']);
for (const k of ['DATABASE_URL', 'STEAM_API_KEY', 'STEAM_RETURN_HOST', 'SESSION_SECRET']) if (!process.env[k] && serverEnv[k]) process.env[k] = serverEnv[k];

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
  plugins: [longCacheForAssets(), cspInBuild(), cspHeaderInPreview(), coopRelayPlugin(), stageShotsDevPlugin()],
  server: {
    port: 5804, strictPort: true,
    // Generated content (bakes write thousands of files) never reloads a page or restarts anything.
    watch: { ignored: ['**/public/maps/**', '**/public/sounds/**', '**/public/panorama/**', '**/public/weapons/**', '**/public/player/**', '**/dist/**'] },
  },
  // Every package the game imports, bundled up front: Vite never discovers a new one mid-session, which re-optimizes,
  // full-reloads every open page and can leave the server answering "504 Outdated Request" until it restarts.
  optimizeDeps: {
    include: ['three', 'three/addons/loaders/GLTFLoader.js', 'three/addons/libs/meshopt_decoder.module.js',
      'three/addons/environments/RoomEnvironment.js', 'three/addons/utils/SkeletonUtils.js', 'three/addons/geometries/ConvexGeometry.js'],
  },
  // a stable copy for playing while code is being edited: `npm run play` (build + preview, no hot reload)
  // `npm run host` = the same on every network interface, so a friend on your LAN can join a co-op room
  preview: { port: 5805, strictPort: true },
  build: { target: 'es2022' },
});
