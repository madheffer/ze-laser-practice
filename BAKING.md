# Baking maps

Everything under `web/public/maps|sounds|panorama|weapons|player` is generated from Valve / workshop content and
is gitignored (100+ MB a map). This page is how to make it again on a fresh checkout, and what each tool writes.
The map folder format itself is in [README.md](README.md#the-map-folder-shared-with-laserscybodev).

## From a fresh checkout (you or your agent)

The repo has the code, the hand-written stages and the tools, but none of Valve's or the map makers' content: you
make that from your own CS2 install. You need:

- **CS2 through Steam** (Windows is what this is built and tested on; the tools also look in Linux / macOS Steam folders)
- **Node 20+** and the **.NET 10 SDK** (`dotnet build bake -c Release` builds `lasers-bake`)
- **The maps that have stages, subscribed in the Steam Workshop** (Steam downloads them into
  `<library>/steamapps/workshop/content/730/<id>`; start CS2 once if a download doesn't begin):

| Map | Workshop |
|---|---|
| ze_mist_p | [3318738050](https://steamcommunity.com/sharedfiles/filedetails/?id=3318738050) |
| ze_deadcore | [3351649726](https://steamcommunity.com/sharedfiles/filedetails/?id=3351649726) |
| ze_ffxii_westersand_v8 | [3363745150](https://steamcommunity.com/sharedfiles/filedetails/?id=3363745150) |
| ze_dreamin | [3415958616](https://steamcommunity.com/sharedfiles/filedetails/?id=3415958616) |
| ze_visualizer | [3261434415](https://steamcommunity.com/sharedfiles/filedetails/?id=3261434415) |
| ze_offliner | [3559892707](https://steamcommunity.com/sharedfiles/filedetails/?id=3559892707) |
| ze_neochrome | [3437506779](https://steamcommunity.com/sharedfiles/filedetails/?id=3437506779) |
| ze__hell_p | [3351648056](https://steamcommunity.com/sharedfiles/filedetails/?id=3351648056) |
| ze_alien_shooter | [3425735986](https://steamcommunity.com/sharedfiles/filedetails/?id=3425735986) |
| ze_minecraft_sakura | [3195096311](https://steamcommunity.com/sharedfiles/filedetails/?id=3195096311) |
| ze_the_shifting_pool | [3554883009](https://steamcommunity.com/sharedfiles/filedetails/?id=3554883009) |

(Each `web/public/scenarios/<map>.json` names its workshop id; that list is where `--scenarios` reads them.)

```bash
npm --prefix web install
npm --prefix tools install
node tools/steam.mjs                        # where it found CS2 and the workshop folder (from Steam's library list)
node tools/bake-map.mjs --scenarios         # bake every map that has stages (100-300 MB each, a few minutes each)
./bake/bin/Release/net10.0/lasers-bake --stock-sounds web/public/sounds    # knife / guns / player sounds
./bake/bin/Release/net10.0/lasers-bake --panorama web/public/panorama      # CS2's HUD icons, fonts, chat / kill feed
./bake/bin/Release/net10.0/lasers-bake --gfl <workshop>/3793587501/3793587501.vpk web/public/gfl  # GFL's boss hitmarker
./bake/bin/Release/net10.0/lasers-bake --player web/public/player          # your third-person body
npm --prefix web run dev                    # http://localhost:5804
```

CS2 and the workshop folder are found the way Steam lists its libraries (`<Steam>/steamapps/libraryfolders.vdf`,
Steam itself from the registry or its usual folder). If yours is elsewhere: `LASERS_CS2=<…/game/csgo>`,
`LASERS_WORKSHOP=<…/workshop/content/730>` or `STEAM_DIR=<Steam folder>`, or `--cs2` / `--workshop` on `bake-map.mjs`.
The bake only reads the CS2 install and the workshop files, and writes only under the output folder it is given.

Two things come from vpkstuff's weaponviewer bake, which is not part of this repo: the first-person hands and gun
(`web/public/weapons/fp/`) and the third-person stance poses (`web/public/player/clips/`, README "Playing"). Without
them the game plays the same (the guns' numbers, sounds and buy commands are this repo's); the hands and gun aren't
drawn, and third person has no stance pose.

## One command

```bash
node tools/bake-map.mjs 3318738050                  # a workshop item id (looked up in steamapps/workshop/content/730)
node tools/bake-map.mjs path/to/map.vpk             # or a VPK (split maps: the _dir.vpk)
node tools/bake-map.mjs ze_mist_p                   # or a map already baked (its manifest's "source")
node tools/bake-map.mjs --all                       # every map in web/public/maps
npm --prefix web run bake -- 3318738050             # the same, from npm
```

It builds `bake/` (Release), then runs, per map:

| Step | lasers-bake | Writes (`web/public/maps/<map>/`) |
|---|---|---|
| `map` | `<vpk> web/public/maps` | manifest, entities, collision (+ `collision_fx*.bin`, what particle traces hit), hulls, glbs + textures (cut-out alpha put back; animated props with their sequences + `animations.json`), particles + `fx/`, sounds (the stock events the map's entities name), `shots/`, `overview/`, `water/` (the water shaders' textures, only for a map with CS2 water) |
| `entwatch` | `node tools/entwatch.mjs <map>` | `entwatch.json`: GFL's EntWatch config (the map's items: the heal option, the item HUD); none if GFL has no config for the map |
| `stripper` | `node tools/stripper.mjs <map>` | `stripper.json`: GFL's StripperCS2 edits to the map's entities (below); none if GFL doesn't strip the map |
| `lighting` | `--lighting <vpk> <map dir>` | `lighting/`: lightmaps (raw BC6H/BC7/DXT1/BC4 blocks), probes, tonemap + LUT (`post/`), skies, reflection cubemaps. The **high** tier |
| `tiers` | `--tiers <vpk> <map dir>` | `q/medium/`, `q/low/`: smaller WebP textures and WebP / PNG lightmaps any GPU can take |
| `chunks` | `node tools/chunk-world.mjs <map dir>` | `world/chunk_<n>.glb` + `world/chunks.json`, and `"chunks"` in the manifest: the world streamed in pieces (below) |
| `index` | `node tools/index-maps.mjs` | `web/public/maps/index.json` (the map picker) |

`--steps lighting,tiers` runs only those, `--skip-build` uses the bake already built, `--cs2 <game/csgo>` if CS2
isn't in a usual Steam library. Order matters: `tiers` reads `lighting/` and the textures the `map` step wrote, and
`chunks` must run after `map` (a re-bake rewrites the manifest without `"chunks"`, so the game falls back to the whole
world glb until `chunks` runs again). `chunks` needs the tools' npm packages (`npm --prefix tools install`; the script
runs it the first time).

## GFL's entity edits (stripper)

GFL's servers run [StripperCS2](https://github.com/Source2ZE/StripperCS2), which rewrites some maps' entities as they
load (configs: `stripper/<map>/<lump>.jsonc` in [gflze/CS2-ZE-Configs](https://github.com/gflze/CS2-ZE-Configs)).
`tools/stripper.mjs` fetches a map's configs into `stripper.json`; `web/src/lib/stripper.js` applies them exactly as
the plugin does (all filters, then adds, then modifies; `/regex/` values case-insensitive; an `io` replace moves the
matched outputs to the end; duplicate top-level keys merged). Everything that loads a map's entities goes through it:
the client (`world/assets.js`), the co-op server (`server/map-store.js`, so the anti-cheat's copy is the player's) and
the tools (`tools/map-entities.mjs`: sim, teleports, io-graph, index-maps). A config for another world (a skybox) is
skipped: the bake has the main world only. Re-run the step to pick up GFL's changes.

Applied today: ze_deadcore's B ending (`b_escape_speedup1`: `KeyValue runspeed 2`, then `runspeed 1` 36 s later,
instead of the map's `speed`) and ze_ffxii_westersand_v8 (the `Staff_*_Epicker` item blockers killed 15 s in, a warmup
fix). `runspeed` is CS2Fixes' custom keyvalue (the pawn's `m_flVelocityModifier`, a max-speed multiplier,
`world/movement.js runSpeed`); `speed` stays lagged movement (CS2Fixes scales the movement frametime).

## World streaming (chunks)

A world glb is one 7-200 MB file with hundreds to thousands of meshes (mist: 6,319 draw calls). `chunk-world.mjs`
cuts it into 4096-unit cells and the game (`world/stream.js`) loads only the cells around you, nearest first, so a stage
starts once its own area is in (mist's throne finale: about 6 MB of the world's 59 MB). A stage starts once
it is loaded and drawn (app/readiness.js): its area, models, effects, sounds and shaders. Solo, its clock waits; a
co-op / versus round's server starts everyone's clock once all have loaded (server/coop-round.js).

Rendering only: collision, hulls, entities and logic are whole from the start, so the game plays the same 1:1
whatever has loaded. Per chunk:

- lightmapped meshes sharing a material are joined (they're lit per pixel from the lightmap, so joining can't change
  their shading); a lightmapped mesh wider than 1.5 cells is cut by triangle into the cells it crosses
- repeated props without a lightmap become GPU instances (mist: 5,896 copies of 85 meshes); the renderer splits each
  batch by light probe volume per instance, so every copy is lit by the same volume as before
- geometry is meshopt-compressed (normals / tangents quantised; positions and UVs stay float)
- editor-only tool materials are dropped; blended (transparent) meshes stay apart so their draw order holds
- textures stay the world's own PNGs (quality tiers swap them as before); the renderer keeps one material per vmat
  across chunks, so a texture is uploaded once

Result (draw calls where you stand, mist): 630 -> 64 at the CT spawn, 642 -> 56 in the dragon arena, 51 at the throne.
Settings → Video → **World loading**: Auto (default: the 12,000-unit area first, then, one chunk at a time, whatever
the map's far plane and fog let you see, so distant scenery is there as in CS2), Area only (slow PCs: distant scenery
may be missing), Whole map. `?nochunks` in the URL loads
the whole world glb instead (for comparisons). The world glb stays in the folder: lasers.cybo.dev reads it.

Shared assets, once per checkout (not per map):

```bash
./bake/bin/Release/net10.0/lasers-bake.exe --stock-sounds web/public/sounds   # knife / AK / player sounds
./bake/bin/Release/net10.0/lasers-bake.exe --mixers web/src/lib/sound-mix-cs2.js  # CS2's mix group levels (committed; rerun after a CS2 update)
# per map, sounds only (soundevents.json + sounds/, the stock events its entities name included; manifest version bumped):
# ./bake/bin/Release/net10.0/lasers-bake.exe --sounds <workshop.vpk> web/public/maps/<map>
./bake/bin/Release/net10.0/lasers-bake.exe --panorama web/public/panorama     # HUD icons, fonts, Panorama reference
./bake/bin/Release/net10.0/lasers-bake.exe --gfl <workshop>/3793587501/3793587501.vpk web/public/gfl  # GFL's boss hitmarker (their content pack)
./bake/bin/Release/net10.0/lasers-bake.exe --player web/public/player         # your third-person body
```

`web/public/weapons/fp/` is copied from the weaponviewer bake (see README "Playing").

## Quality tiers

The Video settings' **Quality** picks the tier a map loads at (next map load). Auto is high on a GPU with BC6H/BC7
(`EXT_texture_compression_bptc`, desktop), low without (most phones). A tier a map wasn't baked at falls back to high.

| Tier | Textures | Lightmaps | Reflections | Sky | ze_mist_p |
|---|---|---|---|---|---|
| high | as baked (1024 px) | full size, BC6H/BC7 blocks | cubemaps, all mips | BC6H cube | lighting 50 MB |
| medium | 512 px, WebP q80 | 2048 px: RGBM exact, the rest WebP q90 | cubemaps <= 64 px | 512 px RGBM faces, exact | +18 MB (PNG: +54) |
| low | 256 px, WebP q80 | 1024 px: RGBM exact, the rest WebP q90 | 32 px RGBM faces (any GPU; water always reflects them) | 256 px RGBM faces, exact | +7.3 MB (PNG: +19) |

RGBM: `rgb x a x 16`, linear (the lightmaps and skies sit well under 16). Geometry (`world/`, `models/` glbs) is
the same for every tier; the loader swaps their PNGs for `q/<tier>/tex/` ones (`assets.js` `glbLoader`), as
`.webp` when `q/<tier>/tex.json` says `"format": "webp"` (its `version` is the tier textures' cache key, so a
`--tiers` re-bake alone reaches browsers). Formats: the host compresses `.bin` / `.glb` on the way, never images, so
the images are what shrank. Textures are lossy WebP with exact alpha (cut-out edges keep their shape). RGBM can't
take lossy error (the multiplier scales it up to 16x), so the irradiance and sky faces are exact pixels, in
whichever of PNG / lossless WebP is smaller. The directional and shadow lightmaps were block-compressed in CS2
(DXT1 / BC7) already, so WebP q90 adds about what the source lost. Side by side on westersand, old and new tiers
look the same.
Tiers don't change how the map plays: entities, collision and logic are the one bake.

Other performance switches (Video, apply instantly): render resolution, MSAA, fog, reflections; "CS2 baked lighting"
off skips the whole `lighting/` download for the simple lighting.

## Single steps

For a map that's already baked, each piece can be redone on its own (`lasers-bake <mode> <workshop.vpk> <map dir>`):

| Mode | What |
|---|---|
| `--lighting` | the whole `lighting/` folder (lightmaps, probes, post, skies, cubemaps) |
| `--sky` | only skies + reflection cubemaps + csgo_moondome cubes (fake-skybox walls), merged into the existing `lighting.json`; rerun `--tiers` after |
| `--tiers` | `q/medium` + `q/low` (after `--lighting`) |
| `--alpha` | cut-out alpha back into the glb PNGs (tree leaves, fences). The `map` step already does it |
| `--water` | the water shaders' textures (`water/`: waves, foam, debris, animated normal frames, and `csgo_water_fancy`'s low-end cube as floats in water.json). The `map` step already does it; `bake-map.mjs <map> --steps water` for a map baked before |
| `--fx` | particle effects (`fx/`) |
| `--collision` | `collision_fx.bin` + layers only (the particle trace set); takes `web/public/maps`, not the map dir |
| `--overview` | the CS2 radar (`overview/`) |
| `--shots` | the loading-screen screenshots (`shots/`) |
| `--sounds` | `soundevents.json` + `sounds/` only (the map's events and the stock ones its entities name); bumps the manifest version |

And `--scan <workshop/content/730> scan.json` ranks a local workshop library for laser-heavy maps.

Cache: files are fetched with the manifest's / `lighting.json`'s `version` (a bake timestamp) as a query, so a
re-bake reaches browsers. The tier textures carry their own version (`q/<tier>/tex.json`), so `--tiers` alone is
enough.

## Stage thumbnails

The stage list shows a small picture per stage: `maps/<map>/stages/<id>.webp` (320x180, webp quality 0.6, a few
KB), the stage's own spawn view captured in the game. Generated, gitignored like the rest of `maps/`. To make them,
open the map on a dev server (`npm --prefix web run dev:stable`, no hot reload) and in the page's console:

```js
const cap = await import('/src/dev/capture-stage-shots.js');
await cap.captureStages();        // every top-level stage of the open map; or cap.captureStage(i) for one
```

Each stage is started, waited on until ready (`run.ready`), drawn once without the HUD or viewmodel, pitch levelled
to ±12° (a spawn looking at the sky still shows the place), and POSTed to the dev server's `/__dev/stage-shot`
(`web/server/stage-shots-dev.js`: `vite` serve only, localhost only, a known map and stage id, a real webp under
64 KB, written only to that file). A black frame is reported and not saved. Audio stays silent and no setting is
saved. Then `node tools/index-maps.mjs`: it lists the thumbnails per map (`stageShots`, plus `stageShotsVersion` on
their URLs), so the menu only asks for files that exist.

## Rules the bake keeps

- It never writes outside its output folder: every path built from a VPK goes through `SafePath.cs`.
- It never writes into the CS2 install. Use lasers-bake (VRF 20.1), not the old VRF CLI (it ignores `-o` for fonts).
- Truth from the files: lighting, fog, sky and tonemap numbers are the map's own (`.vpost`, `env_*` entities,
  `sky.vfx` params); the web side reads the same keyvalues CS2 does, so any map with fog / sky / cubemaps gets them.
