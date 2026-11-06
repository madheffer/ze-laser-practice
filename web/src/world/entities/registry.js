// The class-behaviour table. Each classes/*.js module registers its handlers here; the engine looks a
// class up by its lowercased classname.
//
// Each handler: { spawn?(e), input?(e, input, param, activator, caller) -> true if handled, think?(e, dt),
// solid?(e) -> true if it blocks the player, physSolid?(e) -> true if it blocks only physics objects (physboxes),
// trigger?: true }
// No prototype: a map's classname is data, and "constructor" / "__proto__" must find nothing.
export const C = Object.create(null);

// The most simulated humans a run stands in for (engine.humans): per-human HP adds repeat at most this many times.
// A map is untrusted; real servers peak at 64.
export const MAX_HUMANS = 256;

export function register(name, handler) {
  C[name] = handler;
  return handler;
}
