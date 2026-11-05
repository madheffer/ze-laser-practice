# ZE Laser Practice (this repo)

Practice ZE laser stages in the browser: you spawn where the lasers are, and the **map's own entity logic** runs
the wave, the same chain of relays, cases, templates and movers that runs on a server. It follows
[lasers.cybo.dev](https://lasers.cybo.dev) (cybo's trainer, paused while he's away). Maps baked here use
**his folder format**, so he can drop them into his site as they are.

```
bake/    lasers-bake: a CS2 workshop VPK -> a map folder (C#, ValveResourceFormat 20.1)
web/     the player (Vite + three.js, plain ES modules)
tools/   io-graph.mjs (scenario authoring), index-maps.mjs (rebuild maps/index.json)
```

## Run it locally

```bash
dotnet build ./bake -c Release
./bake/bin/Release/net10.0/lasers-bake.exe D:/Steam/steamapps/workshop/content/730/3318738050/3318738050.vpk ./web/public/maps
node ./tools/index-maps.mjs
npm --prefix ./web install
npm --prefix ./web run dev      # http://localhost:5804
```

The bake finds CS2's `pak01_dir.vpk` for stock textures; pass `--cs2 <game/csgo>` if it's elsewhere.
Baked maps are gitignored (100+ MB each). Scenarios in `web/public/scenarios/` are committed.

| Map | Workshop item |
|---|---|
| ze_mist_p | 3318738050 |
| ze_ffxii_westersand_v8 | 3363745150 (not baked yet) |

## The map folder (shared with lasers.cybo.dev)

All coordinates are Source units (inches, Z up), except the glbs, which are VRF's glTF space (metres, Y up:
`gltf = (y, z, x) * 0.0254`). The player undoes that one transform when it loads them.

| File | What |
|---|---|
| `manifest.json` | map, version, world glb path, collision triangle count, `renderModels` |
| `entities.json` | `{ lumps: { <lump name>: [{ kv: {...}, io: [{output, target, input, param, delay, times}] }] } }`, every lump, template lumps included |
| `collision.bin` | the static world's player-solid triangles: raw float32, 9 per triangle, no header |
| `hulls.json` | `{ <model path>: [{ verts, planes, solid }] }` convex hulls in model space, for brush entities (movers, breakables, triggers). Mesh-only shapes come as `{ tris }` |
| `particles.json` | *(ours)* a summary per effect an `info_particle_system` plays: colour, emit box, radius, rate, children |
| `world/<map>.glb` | the world node, textures beside it as PNGs capped at 1024 px |
| `models/<path>.glb` | each entity model, placed and moved at runtime |

## Scenarios

`web/public/scenarios/<map>.json`, the same shape cybo uses:

```json
{ "id": "dragon_lasers", "name": "...", "description": "...",
  "spawn": { "origin": [2560, -3072, -2944], "yaw": 180 },
  "start": [{ "target": "[PR#]relay_atk_laser", "input": "Trigger" }],
  "winAfter": 26 }
```

`start` inputs fire 1 s after spawn. You win either after `winAfter` seconds, or when `win: {target, input}`
is received. Fields we added (cybo's site ignores them):

| Field | What |
|---|---|
| `group`, `full` | groups the menu (the stage picker); `full` marks the whole-sequence run |
| `lose` | `{target, input}` (or a list) that fails the stage, e.g. `relay_fail.Trigger`. A disabled relay doesn't count |
| `fastForward` | seconds of the map's own sequence to replay silently before placing you. This is how later stages start mid-ending |
| `fastForwardBosses` | `[{target, after}]` bosses the simulated team shoots down during that replay (from `after` s in) |
| `spawn.at` | spawn on a named entity (an `info_teleport_destination`) instead of a fixed origin |
| `player` | `{health, gravity}` at spawn. ze_mist_p's boss door sets 180 HP; the escape trigger sets gravity 0.1 |
| `bosses` | `[{target, name, counter, counterMode}]` breakables/physboxes the team shoots, with a HUD bar |

### Bosses

ZE boss HP grows per human: ze_mist_p's dragon gets `10000 + 900 × humans` per segment (16 segments), and the
escape dragon `10 + 190 × humans` hits. Both come from `AddHealth`/`Add` outputs on a trigger every human
touches. **Humans alive** (menu) repeats those outputs once per simulated human, and the simulated team
shoots the boss at 5 landed hits/s per human × 30 damage, only while it is in line of sight. **Boss HP %**
adds hits instead of changing the map's numbers, so a boss that counts bullets (`OnHealthChanged ->
Subtract 1`) scales the same way as one that counts health. The defaults (20 humans, 100%) give about a
server's fight length: dragon ~2.5 min, escape ~40 s. Mouse 1 shoots too.

### What the map does to you

`!activator` inputs are applied to the player: `KeyValue gravity/speed/max_health/absvelocity`,
`SetHealth`, `SetDamageFilter` (a negated DMG_FALL filter turns off fall damage), `AddContext` (read by
`filter_activator_context`). Fall damage (CS's 580–1024 u/s curve) is a menu option, off by default
because ZE servers run `sv_falldamage_scale 0`. Damage is CS2's trigger_hurt exactly as its server binary does it (`cs2map/porter/research/docs/07_RUNTIME_SEMANTICS.md` §5.1): model 0 = `damage × 0.5` on touch then every 0.5 s (a mist ball, 300, is 150: two kill a 180 HP human); model 1 = full damage doubling to `damagecap`, reset after `forgivedelay`; `thinkalways` = every tick; leaving un-hurt this cycle costs 0.5 × damage; negative damage heals. Armor (the ZR loadout's assault suit, 100) is shown but not applied to map damage (CS armor absorbs bullet/blast/club/slash; mist hurts are `DMG_ENERGYBEAM`) — to verify live, see FEATURES.md. To find a laser stage, follow the I/O graph:

```bash
node ./tools/io-graph.mjs ./web/public/maps/ze_mist_p "laser" --kv origin
```

**ze_mist_p stages** (all from the map's own logic):

| Stage | Starts with | Notes |
|---|---|---|
| Full run | `relay_dragon.Trigger`, ff 20 s | dragon → its death teleports you to the escape → throne → win at `hurt_nuke.Enable` (~5 min) |
| Dragon fight | same | win on `relay_escape.Trigger` (its death); random attack every 30 s; floor breaks mid-fight |
| Attack drills | `relay_atk_{laser,triangle,curveball,firestorm,spin,beam}` | one attack each, no dragon HP |
| Escape dragon | `relay_escape.Trigger`, ff 0.1 s, spawn `td_throneroom` | landing in `tr_addeschp` sets gravity 0.1 + boss HP; lasers 300, fireballs 60, bullets 30; win `temp_final.ForceSpawn`, lose `relay_fail` |
| Throne finale | same, ff 106 s + hold 4 s, spawn on `ml_throne` | on the landed throne 5 s before the balls (300 dmg, 107–130 s); **gravity 1**: the escape's 0.1 ends at the unfiltered `KeyValue gravity 1` trigger (x 6144–6272) every human crosses into the throne room |

**ze_mist_p, dragon laser waves:** `relay_atk_laser` fires `case_laser.PickRandom` 7 times. Each case
sets `laser_{l,m,r}_branch`, and their `OnFalse` sends `ForceSpawn` to `env_entity_maker`s ringed around (2048, -3072).
Each template is a `func_door` (moves out 1248+ units) carrying a `trigger_hurt` plus particle strips.
`vlaser`/`slaser*` sit 0–32 above the floor (jump them). `claser` sits 56–88 (crouch under it).

## Playing

The menu is the pause screen: nothing runs until a stage is picked, and Esc (a tap) pauses (Resume / Restart); death / clear / endless end cards pause behind.
**Fullscreen while playing** (default on) also takes Chrome's Keyboard Lock, so Ctrl+W (crouch + forward)
can't close the tab; outside fullscreen a "Leave site?" prompt catches it. Mouse look uses raw input
(`requestPointerLock({ unadjustedMovement })`) and CS2's formula, degrees per count = `sensitivity × m_yaw`,
so your CS2 sensitivity carries over 1:1. Movement adds CS2 stamina (`sv_stamina*` defaults) and weapon
speed (knife 250, AK-47 215). Boss HP shows in CS2Fixes BossHUD's layout (homelab-control-plane: apps/cs2/patches/bosshud.patch):
name, coloured HP and %, a 14-block bar; a segmented boss counts `(segments - 1) × segment HP + current`.

Weapons: `weapons/viewmodel.js` + `weapons/fp/` is vpkstuff's previewer engine (CS2's own AnimGraph2) with the AK-47 and
CT knife; assets in `web/public/weapons/fp/` are copied from the weaponviewer bake (`Z:\weaponviewer\fp`,
gitignored). Sound: `lasers-bake` writes `maps/<map>/soundevents.json` + `sounds/`, and
`lasers-bake --stock-sounds web/public/sounds` writes the stock knife/AK/player set (gitignored);
`audio/audio.js` plays them (CS2 distance curves, music through the music volume). Test pages:
`audio-test.html`, `vm-test.html`.

Third person (CS2Fixes `!tp`, menu "Video & camera"): `world/body.js` draws your CT, the stock
`agents/models/ctm_sas/ctm_sas.vmdl` (a ZR human class in CS2Fixes' playerclass example) holding the default CT knife.
It is posed the way vpkstuff's previewer (`frontend/previewer/tp.js`) does it: CS2's knife-class aim pose `idle_knife`
rebuilt on the clip's own stock skeleton and copied onto the model, the agent's twist constraints, the knife on the
stock `wpn` bone; ducking blends to `idle_crouch_knife` (also an absolute pose) by the duck amount. No locomotion.
Assets in `web/public/player/` (gitignored, ~19 MB): `lasers-bake --player web/public/player` writes the two glbs;
the stance files are vpkstuff's clip decode (lab `tools/previewer/extract-tp-clips.py`: Source2Viewer-CLI `-d` to DMX,
`pose_extract.py` to JSON) then `node tools/tp-pose.mjs <decoded.json> web/public/player/clips/pose_<clip>.json`
(rotates the DMX's Y-up root bones into Z-up; `--check` it against `Z:\weaponviewer\tp\clips\pose_idle_knife.json`);
`ctm_sas/ctm_sas.constraints.json` is copied from `Z:\weaponviewer\fp\agents\`.

## Co-op and versus

Play any stage (normal or endless) with other people, on rooms our server hosts. The **Multiplayer** card on the
Play tab has three ways in:

- **Create room**: a name, **Private** (code / invite link only) or **Public** (listed under Browse rooms), the mode,
  max players (2–8) and the rules: humans alive, boss HP %, team fire, perfect team, fall damage, and the
  **cheats** (god mode, laser hitboxes, auto bunnyhop). Cheats start **off**. Only the room owner can turn them on,
  and the room view and the public list flag them for everyone. Your own Settings toggles (G / H / T too) do nothing
  in a round: the round plays by the room's rules (`app/rules.js`), which are never saved into your settings.
- **Browse rooms**: the public rooms (name, mode, map, players, in the lobby or playing what, cheats on), refreshed
  every 4 s, with a Join button. With no rooms open, it offers to create a public one.
- **Join by code** (or an invite link, `?room=CODE`).

In a room: the code and **Copy invite link**, the badges, the players (★ owner; the owner can remove someone),
the rules as chips, **Room settings** (owner; applies from the next round) and **Leave**. The owner picks the map
and the stage, and the round starts for everyone (a 3 s countdown so the others can click in). Guests' stage cards
are dimmed. If the owner leaves, the next oldest member owns the room.

- **Co-op**: survive together. When someone dies, the kill feed (top right, CS2-style) says what got them, and you
  can still clear the stage alone as the last one alive. Everyone dead = team wiped (endless: whoever lasted
  longest). Dead players spectate a teammate (Mouse 1 = next).
- **Versus**: the same stage side by side, last one alive wins. If both clear it, fewer hits wins.

**The server runs the rooms and the rounds** (`web/server/`), not a player:
- `coop-relay.js`: sockets, rooms, owner rights (settings, start, kick: all checked by the server), the public list.
  `coop-round.js`: one round. The server picks the seed and hands out the room's rules, keeps the round clock,
  stamps deaths itself (a claimed time has to be plausible), and decides the end and the winners. Stage clears and
  fails come from the map's logic on the clients: the server takes one when every connected player's map says so, or
  most of them within 3 s. `scenarios.js` reads the stage files so only real stages start.
- **Boss damage** goes through the server. Each player's hits are capped at a gun's rate (12/s × the boss-HP
  scale), and the simulated team's fire comes from one client, the round's leader, capped per human. The server
  sums them and sends them to everyone, so every client applies the same hits.
- **Nobody sees anyone's IP**: players only ever talk to the server, never to each other. The server sends names
  only and never logs addresses.
- **How it stays 1:1**: no entity is synced. Every client runs the map's own logic with the server's seed on the
  wall clock, pulled onto the server's round clock. Two tabs spawn the same entities with the same ids on the same
  ticks. Players send their position at 20 Hz.
- **Limits**: 8 KB frames, 80 messages per second, 6 sockets per address, 300 rooms, and sockets from another site's
  Origin are refused. Names and settings are cleaned on both sides by the same code (`lib/room-rules.js`).
- **Running it**: it's built into `npm run dev` / `npm run play` at `/coop`. `npm --prefix web run host` serves on
  your LAN (:5805). For hosting, `npm --prefix web run coop-server` (`server/main.js`, :5810, `/healthz`) runs it
  alone behind the static site, with `/coop` proxied on the same origin.
- **Not yet**: the server trusts each client about its own player (a modified client could skip its own death).
  Leaderboards need the server to re-check runs (see ROADMAP). Triggers only a teammate touches don't fire on your
  client. Someone who joins mid-round waits for the next one. Records are only kept solo.

## Endless, records, ping

- **Endless** (∞ in the picker, or from the Stage cleared card): a scenario's `endless` block keeps the map's own
  logic going: `cancel` swallows the inputs that end it (the throne's `timer_finalbullet.Disable` + nuke),
  `repeat` re-fires a drill every N s, `noBossDamage` keeps a boss (and its attacks) alive. You play until you die.
- **Records** (`app/records.js`): personal bests per map/stage/mode in this browser (fastest clear + fewest hits;
  longest endless). Online leaderboards are on the roadmap.
- **Simulated ping** (0–500 ms, slider + exact number): your movement stays predicted, the map's entities (and their
  sounds) are drawn from a history that many ms behind the simulation, so you react as late as on a server at that ping.

## Code layout

```
web/src/
  main.js            boot + wiring only (G.play = start a stage: lock + fullscreen first, inside the click)
  lib/               shared helpers, import these instead of re-writing them:
                     dom ($, esc, replayClass), names ([PR#] names, matching), paths (map names, safe relative
                     paths, asset keys, versioned URLs), format, math (clamp, approach, bounds), storage, fetch
  app/               state, settings (sanitised, CS2 cvars), session (one attempt), loop (frames + 64-tick step),
                     input (keys, raw mouse, touch, fullscreen, keyboard lock), camera (first / third person),
                     bosses (squad fire, shots, BossHUD numbers), endless, records
  ui/                menu (tabs: Play / Settings), hud (CS2 Panorama HUD + BossHUD panel), overlay (end cards),
                     touch (joystick, look, jump / crouch / fire buttons) + their css
  world/             collision (box traces, BVH, ray-vs-hull), movement (CS2), render (three.js, ping history),
                     assets, body (third-person CT), entities/ (engine, entity, keyvalues, math, registry,
                     classes/{logic,spawners,movers,brushes,triggers,fx})
  audio/             audio.js (map + stock CS2 sound, pause fade), spatial.js (CS2 distance curves, pan)
  weapons/           viewmodel.js (fire gate, magazine, Q/lastinv) + fp/ (vpkstuff's previewer engine, kept verbatim)
bake/                Program.cs (map bake), PanoramaBake.cs, SoundBake (stock + map), SafePath.cs (every output
                     path built from VPK data goes through it)
```

- **collision**: Quake-style box traces (a Minkowski clip of the swept hull against each solid, stopping
  `DIST_EPSILON` short). The static world is triangles in a BVH; moving brush entities are convex hulls.
- **movement**: CS movement at 64 tick. Ground/air acceleration (5.5 / 12, air wish speed 30), friction 5.2,
  jump 301.99, gravity 800 × the player's own gravity keyvalue, step 18, stamina (always on), a duck that lifts the legs in the air; ducking has no spam slowdown (CS2Fixes `cs2f_allow_duck_spam` pins duck speed at 8).
- **entities**: the I/O engine. Unknown inputs are logged once (shown in the menu), never fatal. Team and context
  filters are honoured; name filters pass (you are the human the lasers are aimed at).
- **render**: the world, entity models riding their entities, particle effects as additive sprite strips. H shows
  hurt volumes.

Panorama assets: `lasers-bake --panorama web/public/panorama` exports the HUD's SVG icons, its vxml/vcss (reference)
and the Stratum2 fonts (from `stratum2.uifont`) — Valve content, gitignored.

`window.__lasers` is a debug handle. `__lasers.advance(seconds)` steps the simulation synchronously, and
`window.__lasersInput = (t) => input` drives the player, for automated checks. A hidden tab gets no
animation frames, so the frame loop alone won't move.
