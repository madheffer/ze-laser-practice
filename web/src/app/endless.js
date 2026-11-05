// Endless mode: the stage keeps going until you die, for the longest survival time.
//
// A scenario opts in with an `endless` block, which says how to keep the map's own logic running instead of
// letting the stage end:
//   endless: {
//     repeat: 30,                       // re-fire the stage's `start` inputs every N s (attack drills)
//     cancel: [{ target, input }],      // swallow these inputs (e.g. the timer Disable and the nuke that end it)
//     noBossDamage: true,               // the boss can't die (the team stops shooting), so its attacks continue
//   }
// Everything else (lasers, balls, damage) is the map's, unchanged.
import { inputMatcher } from '../lib/names.js';

export function endlessSpec(scenario) {
  return scenario?.endless || null;
}

// Wire endless behaviour into a freshly started run. Returns a per-tick function.
export function installEndless(engine, scenario, fireStart) {
  const spec = endlessSpec(scenario) || {};
  const cancelled = inputMatcher(spec.cancel);
  if (cancelled.size) engine.hookInput((e, input) => cancelled(e.key, input));
  let next = spec.repeat ? spec.repeat : Infinity;
  let elapsed = 0;
  return (dt) => {
    elapsed += dt;
    if (elapsed >= next) { next += spec.repeat; fireStart(); }
  };
}
