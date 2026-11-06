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

Ported: `KeepUpright` (180e8de00 and 180e69700 checked against the disassembly: "Transform code" below).

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
  below 4). The record's flag byte (+0x3f) is m_nCollisionFunctionMask, 7 from the constructor ("Brush entities"). The phys_thruster force is
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

## The server frame

- **CSource2Server::GameFrame** (`180dd4970`): the pre-think event (game system slot 0xf8), the think pass
  (CSimThinkManager vtable `181805a48` vfn 0, `1805af790`: each entity's PhysicsSimulate / think), the entity I/O queue
  (`FUN_18138c120` on the entity system: "target entity not found", 10000 events at most), then the post-think event
  (slot 0x100) whose CPhysicsGameSystem handler (`180583f00`) runs OnSimulate (`18059ef60`): PullKinematicTransforms
  (`1805a5ca0`), SimulateFrame (`1805ba760`), PushDynamicTransforms (`1805a7260`). Physics runs after the thinks and
  the I/O. The slot 0xe0 handler (`1805c1840`) is not dispatched by server.dll. Ported: `entities/engine.js` tick
  (the engine keeps its I/O-before-thinks order).
- **PushDynamicTransforms** (`1805c29c0`): a node whose m_nHierarchyType (+0xec, schema) is not 0 is skipped, so a
  parented entity never follows its body; else, with one dynamic body, the node takes the body's transform.

## Physbox motion and the hierarchy

- Spawn is two passes (`181383560`): every entity's keyvalues (`FUN_181373f70`), then Spawn grouped by hierarchy depth
  (`180c24000`, CGameEntitySystem slot 0x98 -> `18138cff0`: vfn 0x48 with the keyvalues). parentname is the scene
  node's keyvalue (`180c24190`, "unrecognized parent"), so the parent exists before CreateVPhysics.
- **Move type recompute** (CBaseEntity vfn 0x2b0, `1803de760`): m_nActualMoveType (+0x2f5) = m_MoveType (+0x2f3),
  except with a parent: MOVETYPE_NONE unless PUSH with m_flMoveDoneTime > 0 or OBSERVER; on a change, entity vfn 0x5e0
  and the physics motion FUN_1801a4a40(vfn 0x2b8 (`180d13510`: move type == 5) ? 1 : 3). SetMoveType (`1803e4ba0`)
  and the parent change (`180c2caa0`) run it.
- **The motion type** (`FUN_180cb1900`, node +0x120 +0x282) re-applies only when it changes (`FUN_180cb69b0`): when the
  node's parent has a skeleton instance (parent node vfn 0x68), one body is keyframed (3) unless the parent's
  aggregate is dynamic (motion 1) and m_nHierarchyType is 3; otherwise the stored type (3 keyframed, 2 static, else 1);
  the children are re-applied. The aggregate's creation (`180cb3350`) and SetParent (`180be2670` -> node vfn 0xa8,
  `180caf840`) apply it; ClearParent does not (only the recompute's change). VPhysicsInitNormal sets 1 after its
  SetMoveType. EnableMotion / DisableMotion (`FUN_1803df550`) set 1 / 3 with no parent test (DisableMotion zeroes the
  velocities). So a physbox under a model entity (train, door, prop, physbox) is keyframed and follows it; one under a
  point entity keeps its own motion. Ported: `physics-rubikon.js` applyMotion (a parent with a model is taken as one
  with a skeleton instance).

## Brush entities

Each class's CreateVPhysics (slot 0x238) calls VPhysicsInitNormal (`180d087f0`) with motion type 3 (move type 6), its
group (FUN_180d07730: debris / touchall re-derived) and an interacts-with that replaces the record's (cleared, then
set). CFuncBrush `180e1af60` 0; CBaseDoor `180d399f0` 0x80c3001; CRotDoor `180d39a50`, CFuncMoveLinear `180d8b6e0`,
CFuncTrackTrain `180fbefd0`, CFuncRotating `180d8b7f0`, CBreakable `180d8b670`, CDynamicProp `180b9a3d0`, CFuncWall
`180ce6660` (group 4) 0xc3001; CBaseButton / CMomentaryRotButton `180ce61b0` 0xc3001 and interacts-as bit 23;
CFuncVPhysicsClip `180ce6490` group 3, 0x200000 (physics_prop), its solid bit cleared; CFuncMover / CFuncRotator group 3
with extras (not used here). CBaseEntity / CBaseModelEntity / CBaseToggle / CFuncTrain `1803c9f60`: none.
CCollisionProperty's constructor (`180cd6e90`): interacts-as 0x20000 (touchall), with / exclude 0, group 4, function
mask 7 (+0x3c = 0x07000000). The record builder (`180d11800`) adds physics_prop only for m_MoveType 5. Schema:
VPhysicsCollisionAttribute_t at property +0x10 (as +0x8, with +0x10, exclude +0x18, entity +0x20, owner +0x24,
hierarchy +0x28, group +0x2e, m_nCollisionFunctionMask +0x2f, the shape's +0x77 flags). Ported: `BrushPhysics.cs`.

## Triggers

- CBaseTrigger's flag test (`1803df180`, slot 0x878): 64 anything; 1 FL_CLIENT (flags bit 7); 2 NPCs; 8 move type
  VPHYSICS; 0x400 groups 5 / 6; 0x2000 interacts-as bit 38; then 32 / 512 vehicle conditions for players; then the
  filter (m_hFilter +0x9b0). Ported: `entities/math.js` touchesPlayers.

## phys_thruster inputs and forcetime

- start (`180e73b40`) keeps SetupForces' result twice: running +0x4d4 / +0x4e0 and base +0x4ec / +0x4f8; forcetime
  (+0x4bc) != 0 schedules the stop at now + forcetime (SetNextThink `1803e4db0`: tick (int)(t x 64 + 0.5)).
- Scale (`180e3fc80`): starts it when not running, running = scale x base (`180e8e520`), then the controller's vfn
  0x60 (`1800579c0`: every attached body's Wake). Deactivate (`180e3fa80`) and the think call the stop (`180e73a40`:
  controller destroyed, body woken, think cleared). SetupForces reads m_angRotation (node +0xb8, the local angles).
- OnActivate with 8 (`180e84c70`): body vfn 0x1b0 (`180011fb0`), inverted (`181473ba0`), concatenated with the
  thruster's transform (`1814738d0`); the offset is its position, its rotation's angles (`181473400` -> `181470cb0`)
  go back onto the thruster (`1803e4440`). Ported lane for lane in `Transforms.cs`.

## Transform code (lane order)

`Transforms.cs`: the rotate every one of these uses ((q x t) + (v + w t), t = 2 (q x v)); 181473ba0 (scale 1: the
unnormalized conjugate turns the position; else normalized, times -1/s, zero lengths FLT_EPSILON); 1814738d0 (qa qb as
masked swizzles 181e857e0 / 181e857f0 / 181e85800); 181473400 (the matrix from q2 = q + q); 181470cb0 (MatrixAngles,
0.001 threshold). 1802c5230's wake test turns target x conj(body) (masks 180449190..1c0). 180e8de00 and 180e69700
(KeepUpright) checked; 180e69700's out-of-range normalize is `181471150` (double). Native = WebAssembly
(`--thruster`, `--keyframe` hashes).

## The default layer mask

- vphysics2's static constructor (`1800065c0`) zeroes it; RnCollision_RegisterDefaultRules (`180296fa0`, from
  VPhysics2_InitCollisionGroups `18006e1d0`) writes mask +0x220 = 1, solid bits +0x228 = 1, +0x230 = 0, the default
  preset index +0x218 = -1, registers the presets (`180298b30`) and then makes CONTENTS_SOLID the default
  (`180297ddb`: +0x218 = its index, +0x220 = its mask, 0x4c1: solid, blocklos, blocklight, blocksound). CS2 overrides
  none of it (gameinfo's Physics block has only BuildMeshWings; server.dll registers no layers).
- The shape merge (`180256c80` base, `180256d00` record): a base equal to the default mask (and not group 3) leaves no
  base layers; with a base group below 4 or base layers holding a solid bit, interacts-as = base | (record & ~1), else
  record | (base & ~1) (`18045b2a8` = 1, `18045b2b0` = 0); a group-4 record with no layers and function flag 1 takes
  the default. For the models these maps use (empty InteractAs, group "default": trains, brushes, movers, physboxes,
  clips) that is the record's layers, as `GameWorld.Layered` gives.
- The entity records then take the model's layers at creation ("The model's layers in the entity record"), so a
  physbox meets the world, players, func_clip_vphysics, brushes, movers and other physboxes.

## Brush solidity and contact refilter

- CFuncBrush TurnOff (vfn 0x878, `180e3d060`): unless solidity 2, FUN_180ce76c0 clears the function mask's bits 0-2;
  EF_NODRAW; m_iDisabled 1. TurnOn (`180e3d120`): unless solidity 1, FUN_180cea920 sets them. The record reaches the
  physics through entity vfn 0x5e0 (`1803c81a0`) -> `180ca18e0` -> aggregate vfn 0xf0 -> body `1801ba7e0` -> shape
  `180256d00` with refilter: `FUN_180255860` destroys each contact whose bodies the world ignores (`FUN_1801faf20`,
  world +0x790), whose pair flags changed or that ShouldCollide refuses, then marks the shape for the query. Destroying
  a contact (`1801f7450`) wakes nothing. Ported: `WorldApi.SetBrushSolid`, `GameWorld.SetEntityAttributes`.
- sv_phys_sleep_enable (`180076a40`) defaults to 1.

## Mesh shapes in the mass update

CRnMeshShape vfn 0x88 (`1802420e0`): the mesh box times the shape's per-axis scale (+0xb8), 1/16 out; vfn 0x90
(`180242f90`): the mesh's orthographic areas (+0xa8), unscaled. Ported: `RnMassUpdate` Bounds / Areas.

## Trigger touches

- Touches are vphysics2's: a pair whose contact flags keep bit 2 (the pair filter: both function masks with 4, different
  entity ids) counts touching shape pairs per body pair (world +0xa4..+0xc8); the end side is `1801feca0`, events are
  collected for the game by world vfn 0x3d0 (`180059170`). OnSimulate (`18059ef60`) dispatches them right after the
  step (`18057ad70`): StartTouch / EndTouch on both entities.
- CBaseTrigger spawn (`1803e5d60`): exclude bit 30; 0x810 adds spawnflag 2, 32 and 512 add 1; the subclass sets
  function mask 0x20 (`180ceae90`). InitTrigger (`1803d7230`): interacts-as the trigger layer (bit 2, touchall
  removed); interacts-with 0x400 debris, 64 touchall, 8 physics_prop, 1 player, 2 npc, 0x2000 bit 38; mask without 0x48
  (spawnflag 0x10000000: `180ceacb0`, unused here); a radius makes a sphere, else the model; disabled clears bits 0-2.
  Triggers create no physics through slot 0x238. Their model shapes are group "default" with empty layers.
- CBaseTrigger::StartTouch then runs the flag test (`1803df180`) and the filter (m_hFilter). Ported:
  `TriggerPhysics.cs` (record, pair test through `CollisionFilter`), `physics-touch.js` (overlap of hulls, the flag
  test, outputs, after the step). Not ported: the shape-exact overlap (hulls here), hurt / push / teleport effects
  on physboxes.

## The model's layers in the entity record

When VPhysicsInitNormal creates the physics (`FUN_180d0a6e0`), an entity of solid type 1 or 6 (VPhysicsInitNormal
sets 6) takes the model's layers into its record: interacts-as |= the aggregate's (CPhysAggregateInstance vfn 0xe8,
vphysics2 `180046280`: the first palette entry, or the first later one of group 4 or above when the first is below 4;
an empty group-4 interacts-as reads as the default mask) without blocksound (bit 10) unless that entry is group 3
(`FUN_180ceaa80`); interacts-exclude |= its exclude (`FUN_180ceab10`). So a default-layer brush or physbox record holds
solid, blocklos and blocklight, and physboxes meet brushes, movers and each other. Ported: `GameWorld.ModelLayers` /
`MergeModelLayers`, called by `PhysBox.Spawn` and `WorldApi.SpawnKeyframed`. Checked: a physbox dropped on a
keyframed physbox rides it (`--keyframe`, native = WebAssembly).

## Not yet read

- SetTransform (body vfn 0x1b8, `1801bd3b0` -> `1801bcf70`, `1801bca60`): a teleport; a func_physbox start asleep
  (spawnflag 0x100000); buoyancy and fluid drag; the contact refilter after a
  mid-simulation collision change (shape `180256d00` with refilter: `FUN_180255860`, `FUN_1802d6c90`).
