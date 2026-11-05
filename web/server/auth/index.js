// Steam sign-in for the servers (vite.config.js via coop-relay.js's plugin, and main.js), from the environment:
//   STEAM_API_KEY       optional: the persona name (auth/steam.js)
//   STEAM_RETURN_HOST   optional: the public origin Steam returns to (auth/routes.js)
//   SESSION_SECRET      the session cookie's key, 32+ characters (auth/session.js); random per start without it
import { steamOpenId } from './steam.js';
import { sessions as makeSessions } from './session.js';

export function serverAuth({ env = process.env, log = () => {} } = {}) {
  return {
    steam: steamOpenId({ apiKey: env.STEAM_API_KEY || '', log }),
    sessions: makeSessions({ secret: env.SESSION_SECRET, log }),
    returnHost: (env.STEAM_RETURN_HOST || '').trim().replace(/\/+$/, ''),
  };
}
