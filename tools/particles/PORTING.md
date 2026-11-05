# Porting a particle function class from particles.dll

The particle runtime (`web/src/fx/particles`) simulates each `.vpcf` function class (emitters, initializers,
operators, constraints) the way CS2 does. A class is ported from CS2's own `particles.dll`, never fitted to a
screenshot or copied from a viewer's approximation. Every rule cites the address it was read from.

## Tools

| step | tool |
|---|---|
| class defaults (every field's default value) | `python tools/particles/schemadump.py`, `kv3all.py`, then `node tools/particles/defaults.mjs <dir>` (writes `defaults.js`) |
| vtables from RTTI | `python tools/particles/rtti.py particles.dll vtables.json` (then `name<TAB>0xaddr` lines for the Ghidra script) |
| decompile each class's own virtual functions | Ghidra headless + `tools/particles/ghidra/DumpParticleClasses.java <outDir> "^C_.*" <vtables.tsv>` |
| readable decompile | `node tools/particles/annotate.mjs schema_raw.json <Class>.c` -> `<Class>.named.c` |
| constants a decompile names (`DAT_180534a20`) | `python tools/particles/consts.py particles.dll 180534a20 ...` (float32 x4, double, hex) |

`CS2_GAME_DIR` points at `<CS2>/game`; the scripts load the DLLs from `game/bin/win64` and never write there.

## Reading a decompile

- Slot 3 returns the class name; the class-init slot (often slot 6) precomputes fields (degrees -> radians, ...).
- `Operate` is the slot called as `(this, collection, strength)`; `InitNewParticles` as `(this, collection, start, count, ...)`.
  The third argument of Operate is the operator strength (m_flOpStrength x the fade-in/out factor, research section
  "Operator strength and time").
- Collection members (second parameter), from the research notes:

```
+0x40..0x4c current time x4      +0x50 current time       +0x5c endcap start     +0x60 operator time origin
+0x64 dt                          +0x68 previous non-zero dt
+0x74 active particle count       +0x170 control points (0xE0 each: +0 position, +0x0c prev position,
                                         +0x18 forward, +0x24 up, +0x30 left, +0x90 flags, +0x94 last change time)
+0x2d8 + 8*i attribute i stream   +0x460 + i its stride byte (>> 2 = 16-byte blocks of 4 particles)
+0x4c8 + 8*i attribute i initial values, +0x650 + i stride
+0x8bc flags (8 = emission stopped, 0x10 = endcap)   +0x910 random counter, +0x914 seed offset, +0x918 operator seed
```

- Attributes (ParticleAttributeIndex_t): 0 position, 1 life duration, 2 previous position, 3 radius, 4 roll,
  5 roll speed, 6 colour, 7 alpha, 8 creation time, 9 sequence, 10 trail length, 11 particle id, 12 yaw, 16 alpha 2,
  17 scratch vector, 18 scratch float, 20 pitch, 21 normal. Roll / roll speed / yaw / pitch are radians in the stream.
- SIMD code works on 4 particles at a time (`pfVar[0..3]`, `auVar._0_4_ .. _12_4_`): port it as a per-particle loop.
  `rcpps` / `rsqrtps` are approximate reciprocals; use exact maths unless the result visibly depends on the error.
- A virtual call on `this` (e.g. `(*param_1)[0x130/8]`) picks the attribute to write: the class's own vtable slot
  returns it (C_OP_Spin -> roll, C_OP_SpinYaw -> yaw).

## Writing the port

- Runtime conventions: `web/src/fx/particles/functions/*.js` and `common.js` (`A` attribute indices, `getV` / `setV`,
  `age`, `nage`, `kill`, `evalFloat` / `evalVec` for inputs, `attrIndex`, `mul` / `add` / `sub`, `getInitF`).
- An entry: `{ evidence: 'RE', op(fn, c, strength, state) }` for operators, `init(fn, c, start, count, state)` for
  initializers (see existing entries for the exact signatures). `fn` is the class with defaults applied.
- Cite in a comment above each entry: the particles.dll md5 and the Operate / Init address, plus any constant read.
- Anything the decompile can't settle: implement the evident behaviour, mark it `UNSETTLED: <what>` in the comment.
- Check: `node` a system that uses the class through `ParticleSystem` (see tools/particles in the repo for examples)
  and confirm the class no longer reports "is not implemented".
