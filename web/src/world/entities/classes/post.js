// post_processing_volume, as the map's own entities and I/O drive it (visual only: world/tonemap.js reads
// engine.postState() every frame and blends the .vpost settings). Truth sources:
//   CS2's FGD (game/csgo/postprocessing.fgd): `@SolidClass base(Trigger)`, "Set postprocessing params while a player
//     is inside the volume"; master = "active by default even when not touched by the player"; fadetime = "Time to
//     transition to these postprocessing settings in seconds".
//   server.dll / client.dll (schema): the server keeps the volumes touching each player in
//     CPlayer_CameraServices::m_PostProcessingVolumes (a networked handle list); the client keeps an active and a
//     previous volume (m_hActivePostProcessingVolume / m_hPrevPostProcessingVolume) and fades between them.
// So: a volume applies while it is enabled and touches the player (a trigger: spawnflags 1 = clients, the player's
// hull against its model's hulls; Enable / Disable / Toggle). The volume you are in is the
// one touched last; in none, the first enabled master; none of those either, CS2's defaults. A change of volume
// fades over the NEW volume's fadetime (a master with fadetime 0 snaps back).
// UNSETTLED: with several volumes touched at once the newest touch wins here (the client's pick between them is not
//   decompiled); volumes that start touching on the same tick count in the order they were enabled.
// Where the player first appears (a stage placed after a fast-forward, which runs with no player) the pick is
// instant, as at map start: the fades the map started before you were there are over.
// ze_deadcore's Insane D: d_ex_relay enables cc_red (red, 20 s fade), radiation_ex_startrelay1 then invert (10 s);
//   the "prank D" escape music (1 in 6) disables both and escape_relay_ex enables them again 13 s in.
import { register } from '../registry.js';
import { num, bool } from '../math.js';
import { boxTouchesHull } from '../../collision.js';

const CLS = 'post_processing_volume';

function touches(e, ph) {
  if (!e.enabled || e.state.master || !ph || !(num(e.kv.spawnflags, 1) & 1)) return false;
  const hulls = e.hulls();
  return !!hulls && hulls.some((h) => boxTouchesHull(ph.c, ph.h, h));
}

// The volume the player sees now; a change starts a fade (none at map start: the first pick is instant).
function choose(engine) {
  let best = null, master = null;
  for (const v of engine.byClass.get(CLS) || []) {
    if (!v.alive) continue;
    if (v.state.touched && (!best || later(v, best))) best = v;
    if (v.state.master && v.enabled && (!master || v.id < master.id)) master = v;
  }
  const vol = best || master;
  const p = engine.post;
  if (p && p.vol === vol) return;
  const instant = !p || engine.time <= (engine.postFirstTouchTick ?? -1);
  engine.post = { vol, t0: engine.time, dur: instant ? 0 : Math.max(0, num(vol?.kv.fadetime, 1)) };
}
const later = (a, b) => a.state.touchTick > b.state.touchTick || (a.state.touchTick === b.state.touchTick && a.state.enabledSeq > b.state.enabledSeq);

register(CLS, {
  spawn(e) {
    e.state.master = bool(e.kv.master);
    e.state.touched = false;
    e.state.touchTick = 0;
    e.state.enabledSeq = 0;
  },
  input(e, inp) {
    if (inp === 'toggle') inp = e.enabled ? 'disable' : 'enable';
    if (inp === 'enable') {
      if (!e.enabled) { e.enabled = true; e.state.enabledSeq = e.engine.postSeq = (e.engine.postSeq || 0) + 1; }
      return true;
    }
    if (inp === 'disable') { e.enabled = false; return true; }
    return false;
  },
  think(e) {
    const engine = e.engine;
    if (engine.playerHull && engine.postFirstTouchTick == null) engine.postFirstTouchTick = engine.time;
    const t = touches(e, engine.playerHull);
    if (t && !e.state.touched) e.state.touchTick = engine.time;
    e.state.touched = t;
    choose(engine);
  },
});

// { vol: the volume entity or null (CS2's defaults), t0, dur: the fade to it, time: engine time now }
export function postState(engine) {
  if (!engine.post || (engine.post.vol && !engine.post.vol.alive)) choose(engine);
  return { ...engine.post, time: engine.time };
}
