// env_fade: the map's screen flashes (an ultima's white-out, westersand's Fade_3_Secs). Like env_shake it only emits a
// request (engine 'fade'), which the client draws (app/screen-fade.js), so the engine stays the same on every client
// and on the co-op server.
//
// CS2's CEnvFade keeps Source's keys and input: `duration`, `holdtime`, `rendercolor`, `renderamt` (the alpha) and
// `spawnflags`, input Fade (OnBeginFade). CS:GO's `reversefadeduration` / FadeReverse are not in CS2's datamap (porter
// research 03_ENTITY_COMPAT_USAGE.md, env_fade: MISSING), so a map's value for them does nothing here either.
// spawnflags (Source env_fade.cpp): 1 fade FROM the colour (else to it), 2 modulate, 4 only the activator, 8 stay out.
import { register } from '../registry.js';
import { num, parseVec } from '../math.js';

register('env_fade', {
  input(e, inp, p, act) {
    if (inp !== 'fade') return;
    const sf = num(e.kv.spawnflags) | 0;
    const c = parseVec(e.kv.rendercolor || '255 255 255');
    e.engine.emit('fade', {
      color: [0, 1, 2].map((k) => Math.max(0, Math.min(255, Number.isFinite(c[k]) ? c[k] : 255))),
      alpha: Math.max(0, Math.min(255, num(e.kv.renderamt, 255))),
      duration: Math.max(0, num(e.kv.duration, 2)), hold: Math.max(0, num(e.kv.holdtime, 0)),
      fadeIn: (sf & 1) !== 0, modulate: (sf & 2) !== 0, stayOut: (sf & 8) !== 0,
      // SF_FADE_ONLYONE: the activator's screen only (when it is a player), else everyone's
      only: (sf & 4) !== 0 ? act : null,
    });
    e.fireOutput('OnBeginFade', act);
    return true;
  },
});
