// The shared test server: the same as vite.config.js (co-op relay, headers, the deps bundled up front) on port 5807,
// but nothing reloads by itself. Hot reload is off, so an open page is never cut short when someone else edits a file;
// files are still watched, so reloading the page (or a new navigation) always gets the current code. Editing a config
// file doesn't restart it either (restart it by hand for that). One server for every agent and session: don't start
// copies on other ports, don't stop it while others may be testing.
// `npm run dev:stable --prefix web` (.claude/launch.json "web-stable").
import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config.js';

export default mergeConfig(base, defineConfig({
  server: {
    port: 5807, strictPort: true, hmr: false,
    watch: { ignored: ['**/vite.config.js', '**/vite.stable.config.js', '**/package.json', '**/package-lock.json'] },
  },
}));
