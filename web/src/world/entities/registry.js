// The class-behaviour table. Each classes/*.js module registers its handlers here; the engine looks a
// class up by its lowercased classname.
//
// Each handler: { spawn?(e), input?(e, input, param, activator, caller) -> true if handled, think?(e, dt),
// solid?(e) -> true if it blocks the player, trigger?: true }
// No prototype: a map's classname is data, and "constructor" / "__proto__" must find nothing.
export const C = Object.create(null);

export function register(name, handler) {
  C[name] = handler;
  return handler;
}
