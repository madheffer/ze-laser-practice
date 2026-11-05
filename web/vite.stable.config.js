// A dev server that never reloads itself: the same as vite.config.js (co-op relay, headers) on port 5807, with hot
// reload off and no file watching, so a browser test isn't cut short when someone else edits a file.
// `npm run dev:stable --prefix web` (.claude/launch.json "web-stable"); restart it to pick up changes.
import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config.js';

export default mergeConfig(base, defineConfig({
  server: { port: 5807, strictPort: true, hmr: false, watch: { ignored: ['**/*'] } },
}));
