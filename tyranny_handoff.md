# ze_tyranny2 and CS2 physics: handoff

State on 2026-11-06. What was added, what was confirmed against the binaries, what is still a guess, and how to bring the
other physbox maps onto it.

## What exists now

### ze_tyranny2 (the map)
- `web/public/scenarios/ze_tyranny2.json`: 9 stages, each starting with `leveltrigger_case.InValue(N)`.
  - s1_spider (GFL calls it "Snake"), s2_troll, s3_dragon, s3_rakiora (boss `s3_snake_hitbox`, Boss_Health_snake),
    s4_gargantua, s4_diablo (lasers), s5_diablo, s5_angra, s5_diablo_lasers.
  - Bosses use counter `bosshp1`, backup `bosshp2`, iterator `bosshp3`, counterMode hits (GFL bosshud). Boss fights win
    on `<boss>_hpbar.Kill`; the laser endings win on `stage_wins.InValue`.
  - Spawns are placed next to each fight; `arrive` fires the teleport triggers that would have brought you there.
- Engine fixes it needed:
  - `game_zone_player` fires its per-player outputs `engine.humans` times (the map's boss HP adds run through it).
  - Triggers with spawnflag 64 ("Everything") touch players (`math.js touchesPlayers`); the Troll's steering triggers use it.
  - `func_clip_vphysics` blocks physics objects only (`registry.js physSolid`, `engine.solids({ physics: true })`).
- Checked in Chrome: stage 1 (spider) and stage 2 (Troll chase on CS2 physics). **Not yet checked in the browser**:
  stages 3 to 5, Rakiora, and both laser endings (the headless audit passed).
- Known gameplay notes: the spider stage is a damage race (the arena poison `s1_spider_hurt_all` starts 30 s in).
  Rakiora needs about 9 hits per human per second inside its ~4.5 s charge; the simulated team does about 4.2.
- The blue square over bosses is `hpbar.vpcf` drawn by the line-for-line spritecard port. It is the real sprite.

### rubikon/ (CS2's physics, run as WebAssembly)
- Copied from source2-compiler at a12333d (source2-compiler itself is never modified). `rubikon/README.md` lists every
  file's origin and every edit to the copied files.
- `rubikon/CS2_RUNTIME.md` holds every decompiled fact with its address (cs2_server_20260923.dll, vphysics2_20260924.dll).
- Builds: `dotnet build -c Release` (native), `rubikon/wasm` (`dotnet publish -c Release`, .NET 10 + wasm-tools).
  `node tools/build-rubikon.mjs` builds the WASM and copies the runtime (8.3 MB) into `web/public/rubikon/_framework`
  (gitignored).
- Determinism: an SSE shim on portable Vector128 (checked against real SSE on 2M inputs) and Zen 4 rcp/rsqrt tables, so
  every client and the server compute the same bits.

Ported from the binaries (all in `rubikon/src/Game/`):
- The tick: 1 substep, dt = 1/64 x phys_timescale, sv_gravity 800 as world gravity (`GameWorld.cs`).
- Motion controllers, sync and async (`MotionController.cs`).
- phys_thruster: OnActivate, SetupForces (F = forward x force x 1000; the "force" keyvalue goes straight to +0x4b8),
  Simulate (`Thruster.cs`). The thrust is F x invMass: the ~2460 u/s² for the Troll mover is CS2's own. The map only
  pulses it for 0.1 to 0.2 s at a time, which keeps the boss at a normal speed.
- phys_keepupright (`KeepUpright.cs`).
- Body calls: AddVelocity, AddLocalAngularVelocity, VelocityOffset, LocalToWorld*, SetMass, SetMassCenter, GetMass
  (`BodyOps.cs`).
- The mass update gates each block on its flags as `FUN_1801c0880` does (`RnMassUpdate.cs` flags overload).
- CRnBody::SetType including bodies with contacts: island leave / return take the contacts out and back (`SetType.cs`,
  `IslandManagerOps.cs`).
- func_physbox spawn (`PhysBox.cs`): gamemass, massscale, masscenteroffset; spawnflag 0x8000 (start motion disabled)
  or damage / force to enable motion -> DisableMotion; spawnflag 0x4000 -> debris group 5; the collision record
  (interacts-with 0xc3001, touchall / debris / physics_prop layers) layered onto the model's own attributes as vphysics2
  180256d00 does.
- Keyframed movers (`Keyframe.cs`): the wrapper's SetType keeps a move-to-target object on keyframed bodies; the server's
  per-tick keyframe sets the target over dt.

Probes, each run natively and in WASM with identical output and state hash:
`rubikon/tests/Probe` and `node rubikon/tests/probe-wasm.mjs` with a plain drop, `--thruster ... [keepupright
[spawnflags massscale]]`, `--settype`, `--keyframe`.

### Game wiring
- `web/src/world/physics-world.js`: loads the runtime once (browser: `/rubikon/_framework/dotnet.js`; Node: by path)
  and wraps `rubikon/wasm/WorldApi.cs`.
- `createRunEngine({ physics })` (`run-engine.js`) is shared by the browser session, the co-op checker
  (`server/coop-check.js`) and the replay verifier (`server/replay-verify.js`), so all three run the same physics.
  The server reads `physics.bin` in `server/map-store.js`. Worlds are destroyed with their run (`session.js` attach,
  `PlayerCheck.dispose`).
- `entities/classes/physics-rubikon.js`: each tick before the thinks it keyframes solid brushes and parented physboxes,
  creates and starts the thruster / keep-upright controllers, steps the world; physboxes then follow their bodies.
- Without the runtime or `physics.bin`, the old approximation in `physics.js` still runs.
- Cost: about 0.1 ms per tick on tyranny2.

## Guesses that still need fixing (UNSETTLED)

Each of these is marked UNSETTLED in the code. Every one must be decompiled and replaced with what CS2 does.

1. **Physics step order** (`physics-rubikon.js`, `engine.js`): the step runs after the tick's I/O events and before
   the entities think. Find where CPhysicsGameSystem's simulate sits in the server frame against entity thinks.
2. **A parented physbox becomes keyframed** (`physics-rubikon.js`): CPhysBox passes motion type 1 to
   VPhysicsInitNormal (180d087f0); only motion type 2 with a parent turns into 3. Find what SetParent does to a physics
   object (CBaseEntity::SetParent and its physics callbacks) and whether the hierarchy keyframes it.
3. **The thruster's Scale input** (`WorldApi.ThrusterOn`): treated as a multiplier on force. Decompile the input.
4. **Moving brushes' collision record** (`WorldApi.SpawnKeyframed`, `BrushRecord`): interacts-as solid, interacts-with
   0xc3001, group 4. Decompile CFuncBrush / CBaseToggle / CFuncMoveLinear / door / train physics creation.
5. **The collision record's flag byte** (+0x3f, `PhysBox.cs`): 7, taken from resourcecompiler's entity record.
   Read CCollisionProperty's init.
6. **Trigger "Everything" includes players** (`math.js touchesPlayers`): from the FGD wording, not traced in server.dll.
7. **func_clip_vphysics collision groups** (`physics.js`): not decompiled; it blocks only physics objects here.
8. **The keyframe wake test's turn angle** (`Keyframe.SetTarget`): operation order not matched to the disassembly
   (it only decides a wake at the 2 degree threshold).
9. **Thruster OnActivate** (`Thruster.cs`): a semantic port of the server's SSE transform code, not bit-matched.
10. **KeepUpright ConjugateRotate / Correction** (`KeepUpright.cs`): operation order from the decompile, not checked
    against the disassembly.

Not ported at all (listed at the end of `rubikon/CS2_RUNTIME.md`):
- SetTransform / teleport (body vfn 0x1b8, 1801bd3b0).
- func_physbox start asleep (spawnflag 0x100000).
- buoyancyscale / fluiddragscale (water).
- The contact refilter after a collision change mid-simulation.
- Body removal: a killed physbox turns static and stops colliding instead.
- The player as a physics obstacle: physboxes don't feel players. Players still collide with physboxes as solids.

## Getting the other physbox maps working (deadcore excluded)

These maps already have a `physics.bin`, so their physboxes now run on CS2 physics as soon as the runtime loads:
ze__hell_p, ze_alien_shooter, ze_dreamin, ze_ffxii_westersand_v8, ze_gris_p, ze_minecraft_sakura, ze_mist_p,
ze_neochrome, ze_offliner, ze_the_shifting_pool, ze_visualizer.

Physboxes that will now move on their own (unparented, motion enabled):
- ze_alien_shooter: `boss_physbox` (headless check: it rests where it spawns).
- ze_dreamin: `box_1` to `box_4`, `CY01Physic`, `explo_unit&0000`; also `DONT_shoot_from_here` (debris).
- ze_ffxii_westersand_v8: `Bonus_Attack_Physbox&0000`.
- ze_visualizer: `Stage_Switcher_Phybox_Lv1` to `Lv6`.
- ze__hell_p, ze_gris_p, ze_minecraft_sakura, ze_mist_p, ze_neochrome, ze_offliner, ze_the_shifting_pool: none
  unparented and motion enabled; their physboxes are motion disabled or parented (keyframed, guess 2 above).

For each map:
1. Make sure the runtime is built: `node tools/build-rubikon.mjs`.
2. Re-bake `physics.bin` if the map was baked before the current RubikonBake (it reads part damping, mass centre
   override, surfaces with thickness): `node tools/bake-map.mjs <map> --steps physics`. Then rerun the chunks step if
   anything else was re-baked (memory: map assets pipeline).
3. Headless check of each stage with a physbox:
   `node <scratch>/phys-run.mjs <map> <stageId> <seconds> <entity names...>` (a copy of the script is easy to rebuild:
   map-store load, `createRunEngine({ physics })`, tick, print `e.pos` and `e.state.body`). Set `PULSE=<thruster>` to
   pulse a thruster's Activate / Deactivate when no player is there to trip the map's triggers.
   Look for: bodies that fall through the world (missing collision), bosses that drift when they should hold still,
   anything that sleeps when the map expects it to move.
4. Browser check on :5807 in Chrome: `__lasers.startScenario(i)`, `__lasers.advance(s)`, read
   `__lasers.engine.find(name)[0].pos`. Keep the game paused and audio muted; never save test values in
   `localStorage['lasers.settings']`.
5. What to fix when a map misbehaves, using the new findings:
   - **A boss / hitbox physbox that should hold still**: check spawnflag 0x8000 and damagetoenablemotion /
     forcetoenablemotion (all three disable motion in CS2). If the map relies on something else, decompile it; don't
     freeze it by hand.
   - **Mass-dependent behaviour** (thrusters, pushes): massscale and gamemass now apply exactly; thrust is
     force x 1000 / mass. Don't retune numbers in JS.
   - **A physbox that should pass through players**: spawnflag 0x4000 puts it in collision group 5 (debris) with the
     debris layer. The JS player collision still uses `physbox.solid` (`!(sf & 16384)`), which agrees.
   - **A physbox riding a mover / lift** (westersand, dreamin): movers are keyframed bodies now. If it slides off or
     falls through, it is guess 4 (the brush's collision record).
   - **Parented physboxes**: guess 2. Fix it once from the binary and every map benefits.
   - **Template-spawned physboxes and thrusters**: handled lazily (the controller is made once its body exists).
     Thrusters that are re-aimed with KeyValues(angles) take the new angles on their next Activate, and KeyValues force
     takes effect on the next Activate (SetupForces runs once per start, as in CS2).
6. Record every new fact with its address in `rubikon/CS2_RUNTIME.md`, and update the README's "changed" column if a
   copied file is edited.

## Deploy note
The image build needs the .NET 10 SDK with the wasm-tools workload to run `tools/build-rubikon.mjs`, or a prebuilt
`web/public/rubikon/_framework` copied in. Without it, the game and the server silently fall back to the old motion.
Clients and the server must have the same runtime, or rounds and replays on physbox maps will disagree.

## Also outstanding
- README / ROADMAP / BAKING.md entries for ze_tyranny2 (workshop id 3415955166).
- Browser runs of tyranny2 stages 3 to 5 and both laser endings.
- The ReVa headless server (source2-compiler `tools/re/reva_serve.py`) was left running for this session's decompiles.
