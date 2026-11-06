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

## The ten guesses: settled from the binaries (2026-11-07)

Every one is now read from cs2_server_20260923.dll / vphysics2_20260924.dll; addresses in `rubikon/CS2_RUNTIME.md`.

1. **Step order**: GameFrame runs thinks, then I/O, then physics (post-think event -> OnSimulate). The step now runs
   after the thinks; PushDynamicTransforms moves physboxes right after it. (The engine still runs I/O before thinks.)
2. **Parented physbox**: keyframed when its parent has a skeleton instance (a model entity), by the node's motion
   apply (`FUN_180cb69b0`), on spawn and SetParent; EnableMotion does not free it; ClearParent frees only one that was
   parented after spawn. A parented entity never follows its body. (Rakiora's hitbox rides its train.)
3. **Thruster Scale**: running push = scale x the start's push, starting it if off. Also found: **forcetime** (never
   implemented before): the stop think at the tick SetNextThink rounds to. The Troll/Diablo steering thrusters pulse
   for 2 or 6 ticks per Activate now.
4. **Brush records**: per class (`BrushPhysics.cs`); func_train makes no physics in CS2.
5. **Flag byte**: m_nCollisionFunctionMask, 7 from CCollisionProperty's constructor (unchanged value).
6. **Trigger "Everything"**: includes players (CBaseTrigger 1803df180); flag 32 turns players away.
7. **func_clip_vphysics**: group 3, interacts-with physics_prop only.
8. **Keyframe wake test**, 9. **Thruster OnActivate**, 10. **KeepUpright**: ported lane for lane (`Transforms.cs`);
   OnActivate also writes the relative angles back onto the thruster, which later KeyValues(angles) re-aim.

The default layer mask (`18045b2a0`) is CONTENTS_SOLID (0x4c1), from vphysics2's own default rules; CS2 overrides
nothing. So physboxes meet the world, players and func_clip_vphysics, not ordinary brushes, movers or other physboxes
(CS2_RUNTIME.md "The default layer mask"). When a map's physbox misbehaves, check this before suspecting a lift.

Not ported at all (listed at the end of `rubikon/CS2_RUNTIME.md`):
- SetTransform / teleport (body vfn 0x1b8, 1801bd3b0).
- func_physbox start asleep (spawnflag 0x100000).
- buoyancyscale / fluiddragscale (water).
- The contact refilter after a collision change mid-simulation.
- Body removal: a killed physbox turns static and stops colliding instead.
- The player as a physics obstacle: physboxes don't feel players. Players still collide with physboxes as solids.

## The other physbox maps (2026-11-07)

Every physics.bin is current (the same bake run and version as tyranny2). A headless sweep ran every scenario of the 11
maps for 45 s on the WebAssembly runtime (scratch `sweep.mjs`: map-store, createRunEngine, each physbox's motion):

- Fixed: **ze__hell_p**'s boss room failed to spawn (`drag over a shape of type 3`): mesh shapes' drag bounds / areas
  ported (CRnMeshShape vfns 0x88 `1802420e0`, 0x90 `180242f90`).
- Fixed: a func_brush turned off keeps its record and loses function mask bits 0-2 (TurnOff `180e3d060`, TurnOn
  `180e3d120`), and an attribute change now refilters the shapes' contacts (`FUN_180255860`).
- As CS2 does it, by the binaries: ze_dreamin's `box_1` falls through its start-disabled `brush_1`; the other boxes rest
  on their brushes (conditionallysolid with npcclip / passbullets, which a physbox's interacts-with meets). A box that
  has gone to sleep stays up when its brush is disabled later: nothing on the TurnOff path wakes it and
  sv_phys_sleep_enable defaults to 1 (GFL's configs don't change it).
- westersand's Belias tiles go dynamic (the map's EnableMotion) and fall about 1000 units: the attack. tyranny2's
  tornado / barrel physboxes settle; parented hitboxes (mist's dragon, westersand's Judge, dreamin's boss target) ride
  their parents keyframed. alien_shooter, sakura, neochrome, offliner, shifting_pool, visualizer: nothing moves on its
  own in these stages.

**The model's layers in the entity record** (fixed): when its physics is created an entity ORs its model's
interaction layers into its record (server `FUN_180d0a6e0`, vphysics2 aggregate vfn 0xe8 `180046280`), so default
brushes and physboxes carry solid / blocklos / blocklight and physboxes meet brushes, movers and each other. Before
this, physboxes met only the world and clips. ze_visualizer's stage switcher now works: with Stage_Switcher_Brush_Main
off, only the box over the disabled level brush falls into its trigger and fires that level's relay.

**Triggers touched by physboxes** (on): rubikon `TriggerPhysics.cs` (the record from InitTrigger, the pair test
through the real filter) and `web/src/world/entities/classes/physics-touch.js` (hull overlap, CBaseTrigger's flag test
and filter, outputs, after the step). A box that has gone to sleep stays put when the brush under it turns off (no wake
on that path, sleeping on by default). Visualizer's selector works without one if, as in CS:S, func_brush survives a round
restart while the boxes respawn awake (UNVERIFIED: CS2's round-restart preserve list is not read).
dreamin's trigger_1..4 start disabled and nothing enables them. Not ported: hurt / push / teleport effects on physboxes.

## Deploy note
The image build needs the .NET 10 SDK with the wasm-tools workload to run `tools/build-rubikon.mjs`, or a prebuilt
`web/public/rubikon/_framework` copied in. Without it, the game and the server silently fall back to the old motion.
Clients and the server must have the same runtime, or rounds and replays on physbox maps will disagree.

## Also outstanding
- README / ROADMAP / BAKING.md entries for ze_tyranny2 (workshop id 3415955166).
- Browser runs of tyranny2 stages 3 to 5 and both laser endings.
- The ReVa headless server (source2-compiler `tools/re/reva_serve.py`) was left running for this session's decompiles.
