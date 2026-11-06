# What CS2 does around Rubikon (decompiled)

The game-side pieces source2-compiler's port leaves out (it simulates a settle; the game runtime is this repo's), read
from CS2's binaries in the Ghidra project `D:\tools\ghidra_projects\cs2` (served headless by source2-compiler's
`tools/re/reva_serve.py`, called with its `tools/re/reva_call.py`). Programs: `cs2_server_20260923.dll` (server) and
`vphysics2_20260924.dll` (vphysics2; its body functions are at the same addresses in `cs2_vphysics2_20260923.dll`).
Each item says where it is ported (`src/Game/`). Decompiler traps apply (source2-compiler `docs/REVERSING.md`): float
association is checked against the disassembly before a port is called exact.

## The tick

- **Step count and dt** (server `FUN_18059ef60` CPhysicsGameSystem::OnSimulate, also `FUN_180585840` GameInit):
  substeps = `FUN_180589b50` = clamp(floor(1.5), 1, 3) = **1**; step dt = **0.015625 / substeps** (1/64), times
  `phys_timescale` (`DAT_181ff2038`, default 1) in `FUN_1805ba760` CPhysicsGameSystem::SimulateFrame, which calls
  `IVPhysics2::SimulateWorlds` (interface slot 0x80) with them.
- **SimulateWorlds** (vphysics2 `180075b60`): per world, `substeps` x world slot 0 (`180059f30` CPhysicsWorld_Simulate,
  first = the first substep), then world slot 8 (`180059fe0`: collects the bodies that woke / fell asleep).
- **CPhysicsWorld_Simulate**: `CRnWorld_Step(dt, first)` when dt > 1e-5, then every motion controller's vfn 0x20 (dt)
  in list order; world +0x148 = 1 once any returns 0.
- **Motion controllers run after the step.** A synchronous controller (its event's vfn 0x28 false, as CPhysThruster's)
  runs from CPhysicsWorld_Simulate's vfn 0x20 right after each step, with the step's dt (`FUN_1800575b0`). An
  asynchronous one only gathers the time there; vphysics2 `180064ca0` CVPhys2World::BeginAsyncPostTickJobs (world slot
  0x58) then runs every controller's vfn 0x28 (in list order, as a job past a list size) when +0x148 is set, and clears
  it. Either way the velocity change lands after this tick's step: the next tick integrates it.
- **Gravity** (server GameInit `FUN_180585840`): world slot 0x90 (`180063f10`, CRnWorld +0x190) = (0, 0, -`sv_gravity`)
  (`DAT_181ff1fe8`, registered by `FUN_180078b30`, default 800). Rubikon's own default is -360.

Ported: `GameWorld.Tick`.

## CPhysicsMotionController (vphysics2 vtable `1803f9340`, created by world slot 0x3e8 `18005bb90`)

- created with its event (the server's IMotionEvent); +0x30 active = event vfn 0x28 (); +0x34 accumulated time; the
  attached bodies at +0x20 (count +0x18), newest first (AttachObject `1800576a0` inserts at the front, once).
- vfn 0x20 (`180057560`): asynchronous (+0x30): +0x34 += dt, returns 0; else runs now (`FUN_1800575b0`, the loop below
  with this dt), returns 1. The server's thruster event is synchronous (vfn 0x28 `1803e58a0` returns 0; vfns 0, 8,
  0x18 empty).
- vfn 0x28 (`180057590`): dt = +0x34, +0x34 = 0; when active: event vfn 0 (); each attached body from the last index
  down (a removed one drops out): event vfn 0x10 (controller, body, dt) when the body is dynamic (+0x54 == 2) and awake
  (+0x249 bit 2 clear), else event vfn 0x18 (same args); then event vfn 8 (dt).

Ported: `MotionController`.

## CPhysThruster (server vtable `1819bab40`, IMotionEvent vtable `1819ba360`)

- **spawn** (`180e7bd70`): OnActivate (slot 0x778, `180e84c70`), then start when spawnflag 1.
- **OnActivate**: with spawnflag 8 (orient locally) the thruster's transform relative to the attached body, once: its
  position is the offset (+0x508), its rotation the thruster's local angles; with 32 (ignore position) the offset is
  zeroed; without 8 the offset stays 0. The Activate input (`180e3f260` -> `180e73b40`) never redoes it.
- **start** (`180e73b40`, only when not running): SetupForces (slot 0x770, `180e8f680`) once, kept as +0x4d4 linear,
  +0x4e0 angular; the controller (world slot 0x3e8) with the body attached; forcetime != 0 schedules the stop
  (`180e73a40`).
- **SetupForces**: F = forward(the thruster's angles) x force (+0x4b8) x 1000. Without 8: the offset turned by the
  body's transform (pos + scale x q.offset) is the point, F world; body vfn 0x270 gives (linear, angular). With 8: point
  = body vfn 0x1e8 (offset), F = vfn 0x1d8 (F); vfn 0x270; linear = vfn 0x1d0 (linear) (world to body), angular = vfn
  0x1d0 of the angular result, then `FUN_18017d280`. Spawnflag 2 clear zeroes linear, 4 clear zeroes angular. Spawnflag
  16 (ignore mass) is not read on this path.
- **Simulate** (IMotionEvent vfn 0x10, `180e90eb0`): linear x dt (with 8: body vfn 0x1d8 to world first) -> body vfn
  0x208; angular x dt -> body vfn 0x240.

## CKeepUpright (server vtable `1819bbbd0`, IMotionEvent at +0x4a8, vtable `1819bc348`)

- **spawn** (`180e914c0`): local test axis (+0x4bc) = (0, 0, 1); world goal axis (+0x4b0) = the entity's up vector
  (`FUN_1803d3050`); active (+0x4e0) = spawnflag 1 clear. angularlimit +0x4dc, dampallrotation +0x4e1.
- synchronous event (vfn 0x28 false). **Simulate** (`180e91090`): when active: w = body vfn 0x248 (the angular velocity
  in the body's frame, degrees); the goal axis turned by the conjugate of body vfn 0x1b0's rotation (`180e8de00`);
  `180e69700` (test, goal, w, gain 1 or 0 with dampallrotation, 1/dt, limit): n = normalize(test x goal), angle =
  atan2(|test x goal|, test . goal) in degrees, r = n x invDt x angle - n x gain x (w . n), normalized and held to the
  limit; with dampallrotation r - w; then body vfn 0x240.
- body vfn 0x1b0 (`180011fb0`), its rotation: the orientation to a matrix and back (MatrixQuaternion), normalized by
  dpps; vfn 0x248 (`180014550`): the world-to-body rotate of +0x114, x 57.295776.

Ported: `KeepUpright` (180e8de00 and 180e69700 in the decompile's operation order; not yet checked in disassembly).

## vphysics2 CPhysicsBody (vtable `1803f44e0`), the calls above

- 0x1d0 (`180013230`): world to body vector (the inverse quaternion rotate).
- 0x1d8 (`180013390` -> `180010b10`): body to world vector (quaternion rotate, q at +0x120).
- 0x1e8 (`180013400` -> `180009d10`): body to world point: q.p + origin, origin = mass centre (+0xfc) - q.(scale +0x88
  x local mass centre +0xc8).
- 0x208 (`180012620`): linear velocity (+0x108) += v, unless the sum is not finite or the body is not in the world
  (+0x54 == 0); a change with |v|^2 over 0.16 wakes it (`FUN_1801c0ff0`, timer kept).
- 0x240 (`1800147d0`): angular velocity (+0x114) += q.w (body-frame degrees to world radians, x 0.017453292), same
  finiteness and wake rule with 0.0048738797.
- 0x270 (`180014a20`): force at a point to velocity changes: linear = F x invMass (+0xd4); angular = world inverse
  inertia (+0xd8) x ((point - mass centre) x F) x 57.295776 (degrees).

## func_physbox (server CPhysBox) motion

- **EnableMotion / DisableMotion** (inputs `180ea5630` / `180ea56c0`) -> `FUN_1803df550(entity, on)`: the physics
  component's motion type (+0x282, `FUN_180cb1900`) = 1 on, 3 off; off also zeroes every part body's velocity and
  angular velocity (body vfns 0x200 / 0x220). Applied by `FUN_180cb69b0` -> the aggregate's SetMotionType (vphysics2
  CPhysAggregateInstance vfn 0x30, `1800488d0`): **1** each part body SetType by its part flags (bit 0 static 0, bit 1
  keyframed 1, else dynamic 2); **2** all static (0); **3** all keyframed (1). EnableMotion also fires its output.
- **Wake** (`180ea5350`): every part body's vfn 0x400.
- **SetType** (vphysics2 `1801bd3e0`): to static zeroes the velocities; the frame origin is kept; the mass update
  (`FUN_1801c0880`, flags 7, or 3 from a non-static type); then every contact of the body's shapes is re-filtered
  (`FUN_1801bdea0`) and kept or destroyed (`FUN_1801f7450`) for the new type; a kept one is a group 0 contact only
  between two dynamic bodies (`FUN_1801d6470`), and going dynamic drops its warm start (`FUN_1801d5930(c, 0)`, joints
  vfn 0x18 too). Ported in `src/Game/SetType.cs`. The island leave (`1802ccbb0`) takes the active joints, the body
  +0x240 edges (`FUN_1802cd8b0`) and every in-island contact of its shapes (`FUN_1802cc020`) out before the node;
  the return (`1802ce270`) puts the node back and re-evaluates joints (`1802cc370`), +0x240 edges (`1802cc520`)
  and contacts (`1802cc140`: alive, solid, touching). Checked: `--settype` native = WebAssembly.

## func_physbox (server CPhysBox, vtable `181837f98`) spawn

Ported in `src/Game/PhysBox.cs`; checked by `--thruster ... <spawnflags> <massscale>` (native = WebAssembly).

- **Spawn** (slot 0x48, `180ed7520`): CBreakable::Spawn (`180dc0d50`) first, then spawnflag 0x40000 reads
  preferredcarryangles, and spawnflag 0x4000 (debris) without a collisionGroup keyvalue sets group 5 (`FUN_180d07730`).
- **CBreakable::Spawn**: CreateVPhysics (slot 0x238), then on the body: gamemass > 0 -> SetMass (body vfn 0x100);
  massScale > 0 and != 1 -> SetMass(GetMass (vfn 0x128) x massScale); a non-zero masscenteroffset -> SetMassCenter
  (vfn 0x108) of the local centre (vfn 0x150) plus it; buoyancyscale / fluiddragscale -> vfns 0x330 / 0x320 + 0x328
  (water, not ported).
- **CreateVPhysics** (`180ebce10`): VPhysicsInitNormal (`180d087f0`) with the collision property's group (4 when there
  is none) and interacts-with 0xc3001 (solid, window, passbullets, player, npc) added; solid type 6; move type 5.
  The collisionGroup / interactsAs / interactsWith / interactsExclude keyvalues (+0x958..+0x970) by name. Spawnflag
  0x100000 clear -> Wake (vfn 0x400). Spawnflag 0x8000, damagetoenablemotion > 0 or forcetoenablemotion > 0 ->
  DisableMotion.
- **vphysics2 SetMass** (`1801bbb60`): +0x4a bit 8, the mass held to 1e6 and 500 when not positive, the mass update
  with flags 0x13 when it changed (else 0, nothing). **SetMassCenter** (`1801bb9a0`): bit 10, flags 0x14 when changed.
- **The mass update** (`FUN_1801c0880`) gates each block on its flags: 0x10 (or its fourth argument) sums the shapes
  unless all three are set by hand, raising 0x13 / 0x14 / 2 (`FUN_1801bb2b0` returns 2 when the inertia changed); 9 the
  inverse mass; 0xc the world mass centre; 0xa the world inverse inertia; 0x1c the previous frame and radii; 0x1a the
  drag (`FUN_1801b9ca0`, or +0x24a bit 0 out of the world).
- **The collision record** (`FUN_180d11800`, the collision property's VPhysicsCollisionAttribute_t): group 5 has layer
  debris and not touchall, any group but 2 and 14 touchall and not debris (`FUN_180d07730`); physics_prop while the
  move type is 5; the entity and owner handles; the hierarchy id. It reaches each shape through the entity's vfn 0x5e0
  -> aggregate vfn 0xf0 (`180046220`) -> body `1801ba7e0` -> shape `180256d00`: source2-compiler's capture-checked
  `Layered` (the record's fields, the base's layers added unless they are the default mask, the base's group when
  below 4). The record's flag byte (+0x3f) is not read yet (7, as resourcecompiler's). The phys_thruster force is
  +0x4b8 straight from the "force" keyvalue (datamap `180e5af80`), so F = force x 1000 and the thrust is F x invMass.

## Keyframed movers

Ported in `src/Game/Keyframe.cs`; checked by `--keyframe` (native = WebAssembly).

- **The body wrapper's SetType** (vphysics2 `180011210`): CRnBody::SetType, then a keyframed body (or a dynamic one
  with +0x4a bit 5, `FUN_1801c0fe0`) gets a shadow controller (`1803f7ae8`) over CRnBody +0x80 (`1801b3ce0`: the
  current frame origin and orientation, `1802c4b60` / `1802c50b0` / `1802c4f70`); any other type loses it
  (`1801b3e90`). Bodies created with a target get one too (`180045630`).
- **The server's keyframe** (`FUN_1805836c0`): for an entity whose physics is keyframed, dt = phys_timescale x 1/64 x
  host_timescale (`DAT_181ff2038`, `DAT_181ff2048`) when not given, then the aggregate's vfn 0x78 (`180045bf0`): each
  part body of type 1 gets the entity transform concatenated with its bind pose, through its shadow controller's
  vfn 0x20 (`18003f010` -> `1802c5230`: orientation, position, time = max(0, dt); a sleeping body wakes when the
  target is more than 1/32 unit away or turned more than 0.0349 rad), or the transform set outright (body vfn 0x1b8,
  `1801bd3b0`, not ported) on a teleport or with no controller.

## Not yet read

- SetTransform (body vfn 0x1b8, `1801bd3b0` -> `1801bcf70`, `1801bca60`): a teleport; a func_physbox start asleep
  (spawnflag 0x100000); buoyancy and fluid drag; the collision record's flag byte; the contact refilter after a
  mid-simulation collision change (shape `180256d00` with refilter: `FUN_180255860`, `FUN_1802d6c90`).
