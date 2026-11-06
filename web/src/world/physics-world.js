// CS2's physics (vphysics2 / Rubikon and the server's physics entities) as the WebAssembly build of rubikon/
// (rubikon/README.md, rubikon/CS2_RUNTIME.md): one world per map run, the same bits in every browser and on the co-op
// server, so a round's server copy and a replay's check move physboxes exactly as the players saw them.
//
//   await loadPhysics(frameworkDotnetJsUrl)    once per page / process; null when the runtime can't load
//   const w = createPhysicsWorld(physicsBinArrayBuffer)   null without the runtime or the bake's physics.bin
//   w.spawnPhysBox(...), w.spawnKeyframed(...), w.drive(...), w.tick(), w.pose(body) ...
//
// The browser serves the runtime from /rubikon/_framework (tools/build-rubikon.mjs copies `dotnet publish`'s output
// there); Node loads the same files by path.
let api = null;
let loading = null;

/** Loads the runtime from its dotnet.js (a URL string). Resolves to true when it is ready. */
export function loadPhysics(dotnetJs) {
  if (api) return Promise.resolve(true);
  loading ||= (async () => {
    try {
      const { dotnet } = await import(/* @vite-ignore */ dotnetJs);
      const runtime = await dotnet.create();
      const exports = await runtime.getAssemblyExports('Rubikon.Wasm.dll');
      api = exports.Source2.Compiler.Wasm.WorldApi;
      return true;
    } catch (err) {
      console.warn(`physics runtime unavailable (${err?.message || err}): physboxes use the fallback motion`);
      loading = null;
      return false;
    }
  })();
  return loading;
}

export const physicsLoaded = () => !!api;

const v3 = (v) => [Number(v.x ?? v[0]) || 0, Number(v.y ?? v[1]) || 0, Number(v.z ?? v[2]) || 0];
const q4 = (q) => [q.x, q.y, q.z, q.w];

/** A world for one run, or null (no runtime loaded, no physics.bin for the map). */
export function createPhysicsWorld(bin, svGravity = 800) {
  if (!api || !bin || !bin.byteLength) return null;
  return new PhysicsWorld(new Uint8Array(bin), svGravity);
}

class PhysicsWorld {
  constructor(bytes, svGravity) {
    this.id = api.Create(bytes, svGravity);
    this.poses = null; // Float64Array-like: 8 numbers a body (x y z, qx qy qz qw, awake), after each tick
  }

  hasModel(key) { return api.HasModel(this.id, key); }

  // func_physbox (rubikon/src/Game/PhysBox.cs): -1 when the model has no physics
  spawnPhysBox(key, pos, quat, k) {
    return api.SpawnPhysBox(this.id, key, v3(pos), q4(quat), k.spawnflags | 0, k.massScale || 0, k.gameMass || 0,
      v3(k.massCenterOffset || [0, 0, 0]), k.damageToEnableMotion | 0, k.forceToEnableMotion || 0,
      [k.collisionGroup || '', k.interactsAs || '', k.interactsWith || '', k.interactsExclude || '']);
  }

  // a brush or prop entity's keyframed body with its class's collision record (rubikon/src/Game/BrushPhysics.cs);
  // -1 when the model has no physics or the class makes none
  spawnKeyframed(key, pos, quat, cls) { return api.SpawnKeyframed(this.id, key, v3(pos), q4(quat), String(cls || '')); }

  // the server's per-tick keyframe; false when it would be a teleport (not ported)
  drive(body, pos, quat, teleport = false) { return api.Drive(this.id, body, v3(pos), q4(quat), !!teleport); }

  setMotion(body, on) { api.SetMotion(this.id, body, !!on); }
  // would a trigger with these spawnflags get touch events from the body (rubikon/src/Game/TriggerPhysics.cs)
  triggerTouches(body, spawnflags, enabled) { return api.TriggerTouches(this.id, body, spawnflags | 0, !!enabled); }
  setMotionType(body, motion) { api.SetMotionType(this.id, body, motion | 0); } // a parent change: 1 or 3, velocities kept
  setAwake(body, on) { api.SetAwake(this.id, body, !!on); }
  remove(body) { api.Remove(this.id, body); }
  setBrushSolid(body, on) { api.SetBrushSolid(this.id, body, !!on); }

  addThruster(body, spawnflags, force, angles, pos, quat) {
    return api.AddThruster(this.id, body, spawnflags | 0, force || 0, v3(angles), v3(pos), q4(quat));
  }
  thrusterAngles(handle) { return Array.from(api.ThrusterAngles(this.id, handle)); }
  thrusterStart(handle, force, angles) { return api.ThrusterStart(this.id, handle, force || 0, v3(angles)); }
  thrusterStop(handle) { api.ThrusterStop(this.id, handle); }
  thrusterScale(handle, scale) { api.ThrusterScale(this.id, handle, scale || 0); }

  addKeepUpright(body, goalAxis, limit, active, dampAll) {
    return api.AddKeepUpright(this.id, body, v3(goalAxis), limit || 0, !!active, !!dampAll);
  }
  keepUprightOn(handle, on) { api.KeepUprightOn(this.id, handle, !!on); }
  setAngularLimit(handle, limit) { api.SetAngularLimit(this.id, handle, limit || 0); }

  tick() {
    api.Tick(this.id);
    this.poses = api.Poses(this.id);
  }

  // [x, y, z, qx, qy, qz, qw, awake] of a body after the last tick, or null
  pose(body) {
    const p = this.poses;
    if (!p || body < 0 || body * 8 + 7 >= p.length) return null;
    return p.slice(body * 8, body * 8 + 8);
  }

  velocity(body) { return api.Velocity(this.id, body); }

  destroy() { if (this.id) api.Destroy(this.id); this.id = 0; }
}
