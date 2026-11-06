# Rubikon (CS2's vphysics2) for the game

CS2 simulates physics objects (func_physbox, the thruster bosses, debris) with Rubikon, vphysics2.dll. This folder is
that simulation for the game: **source2-compiler's port**, decompiled from vphysics2 and checked against Valve's own
functions there (oracles and captures, `source2-compiler/docs/PHYSICS.md`), built for the browser and the co-op server
as WebAssembly. It is copied here, not referenced: source2-compiler is never modified from this repo.

## Where each file comes from

Copied from `source2-compiler/src/Source2.Compiler` at **a12333d**:

| Here | There | Changed |
|---|---|---|
| `src/Simulation/*.cs` | `Simulation/*.cs` | `BoxCast.cs`, `MeshSweep.cs`: the `using System.Runtime.Intrinsics.X86;` line removed (their `Sse` / `Sse41` calls resolve to `SseShim.cs`). `CpuEstimate.cs`: always the Zen 4 tables (below). `RnMassUpdate.cs`: a `Run` overload taking the update flags (vphysics2 `FUN_1801c0880`; the old `Run` is flags 0x1f). `RnMassUpdate.cs`'s flags overload gates each block as `FUN_1801c0880` does and ends in the drag; `SetInertia` returns 2 when it changed. `IslandManagerOps.cs`: `Leave` / `Return` take the body's contacts out of and back into islands (`1802ccbb0` / `1802ce270`) instead of refusing them |
| `src/Simulation/SseShim.cs` | (new) | the SSE operations those two files use, on portable `Vector128` |
| `src/Physics/RnShapes.cs` | `Physics/RnHullBuilder.cs`, `RnMeshBuilder.cs`, `RegionSvm.cs` | only the data classes (`RnHull`, `RnMesh`, `RegionSvm`); the builders are left out (the game reads Valve's cooked shapes) |
| `src/Physics/RnHullBuilder.cs` | `Physics/RnHullBuilder.cs` | only `CentroidRadius` and `Areas`, the hull load's post pass |
| `src/Physics/CollisionRules.cs` | `Maps/SettleWorld.cs` (`SettleWorld.CollisionRules`) | without `Convert` (it reads VRF's KV3; the bake does that) |
| `src/Io/Tier0Strings.cs` | `Io/Tier0Strings.cs` | none |
| `src/Resources/estimate_zen4_*.bin` | `Resources/estimate_zen4_*.bin` | none |

Ours:

| File | What |
|---|---|
| `src/Physics/PhysFile.cs` | `physics.bin`'s format; compiled into the bake too (`bake/RubikonBake.cs` writes it) |
| `src/Game/GameWorld.cs` | the world built from `physics.bin` as `SettleWorld.CreateWorld` builds one |
| `src/Game/BodyOps.cs`, `MotionController.cs`, `Thruster.cs`, `KeepUpright.cs`, `SetType.cs`, `PhysBox.cs`, `Keyframe.cs` | CS2's body calls (SetMass, SetMassCenter), motion controllers, phys_thruster, phys_keepupright, CRnBody::SetType, func_physbox's spawn and keyframed movers, ported from the binaries (`CS2_RUNTIME.md`) |
| `src/Game/Probe.cs` | a fixed scenario, to compare the WebAssembly build with the native one |
| `wasm/` | the browser-wasm project and its JS interop |

To take a newer source2-compiler: copy its `Simulation/` again, then redo the edits in the table (two `using`
lines, `CpuEstimate`'s `UseTable`, the `RnMassUpdate` overload, `Leave` / `Return`) and rerun the checks below. New x86 intrinsics in their code need a shim too.

## Why the shim and the tables

WebAssembly has no SSE. `BoxCast` and `MeshSweep` are written with SSE lane for lane as vphysics2 is; `SseShim.cs` gives
each operation the bits the x86 instruction gives (minps / maxps NaN and zero rules, ordered compares, movmskps, shufps,
unpck, blendvps). `rcpps` / `rsqrtps` estimates differ between CPU vendors, so every client and the server must use the
same ones: source2-compiler's Zen 4 tables, one real CPU's results (`CpuEstimate`).

## Build

```bash
dotnet build rubikon -c Release                    # the library (native), for tests
dotnet publish rubikon/wasm -c Release             # the WebAssembly module: rubikon/wasm/bin/Release/net10.0/publish/wwwroot/_framework
```

Needs the .NET 10 SDK and `dotnet workload install wasm-tools`. AOT compiled; about 2 MB brotli in all.

## Checks

```bash
dotnet run -c Release --project rubikon/tests/ShimCheck                     # SseShim vs real SSE, 2M random inputs x 16 ops
dotnet run -c Release --project rubikon/tests/Probe -- <physics.bin> <model> x y z [steps]   # native
node rubikon/tests/probe-wasm.mjs <physics.bin> <model> x y z [steps]        # the same in WebAssembly
# also, with the same arguments in both: --thruster ... [keepupright [spawnflags massscale]], --settype ..., --keyframe ...
```

The two probes print the same numbers and the same state hash (ze_tyranny2: the troll's mover, a barrel, a tornado and a
poison ball, 640 steps each, identical).

## Not done yet

- CS2's server side is ported in `src/Game` (motion controllers, phys_thruster, phys_keepupright, SetType with
  contacts, func_physbox's spawn and collision record, keyframed movers, gravity, the tick); what is left is listed at
  the end of `CS2_RUNTIME.md`. The plain drop probe still uses resourcecompiler's settle rule for its collision.
- The game does not load the module yet (entities still use `web/src/world/entities/classes/physics.js`).
