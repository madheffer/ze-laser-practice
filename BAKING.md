# Baking maps

Everything under `web/public/maps|sounds|panorama|weapons|player` is generated from Valve / workshop content and
is gitignored (100+ MB a map). This page is how to make it again on a fresh checkout, and what each tool writes.
The map folder format itself is in [README.md](README.md#the-map-folder-shared-with-laserscybodev).

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
| `map` | `<vpk> web/public/maps` | manifest, entities, collision (+ `collision_fx*.bin`, what particle traces hit), hulls, glbs + textures (cut-out alpha put back; animated props with their sequences + `animations.json`), particles + `fx/`, sounds (the stock events the map's entities name), `shots/`, `overview/` |
| `entwatch` | `node tools/entwatch.mjs <map>` | `entwatch.json`: GFL's EntWatch config (the map's items: the heal option, the item HUD); none if GFL has no config for the map |
| `lighting` | `--lighting <vpk> <map dir>` | `lighting/`: lightmaps (raw BC6H/BC7/DXT1/BC4 blocks), probes, tonemap + LUT (`post/`), skies, reflection cubemaps. The **high** tier |
| `tiers` | `--tiers <vpk> <map dir>` | `q/medium/`, `q/low/`: smaller textures and PNG lightmaps any GPU can take |
| `chunks` | `node tools/chunk-world.mjs <map dir>` | `world/chunk_<n>.glb` + `world/chunks.json`, and `"chunks"` in the manifest: the world streamed in pieces (below) |
| `index` | `node tools/index-maps.mjs` | `web/public/maps/index.json` (the map picker) |

`--steps lighting,tiers` runs only those, `--skip-build` uses the bake already built, `--cs2 <game/csgo>` if CS2
isn't in a usual Steam library. Order matters: `tiers` reads `lighting/` and the textures the `map` step wrote, and
`chunks` must run after `map` (a re-bake rewrites the manifest without `"chunks"`, so the game falls back to the whole
world glb until `chunks` runs again). `chunks` needs the tools' npm packages (`npm --prefix tools install`; the script
runs it the first time).

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
# per map, sounds only (soundevents.json + sounds/, the stock events its entities name included; manifest version bumped):
# ./bake/bin/Release/net10.0/lasers-bake.exe --sounds <workshop.vpk> web/public/maps/<map>
./bake/bin/Release/net10.0/lasers-bake.exe --panorama web/public/panorama     # HUD icons, fonts, Panorama reference
./bake/bin/Release/net10.0/lasers-bake.exe --player web/public/player         # your third-person body
```

`web/public/weapons/fp/` is copied from the weaponviewer bake (see README "Playing").

## Quality tiers

The Video settings' **Quality** picks the tier a map loads at (next map load). Auto is high on a GPU with BC6H/BC7
(`EXT_texture_compression_bptc`, desktop), low without (most phones). A tier a map wasn't baked at falls back to high.

| Tier | Textures | Lightmaps | Reflections | Sky | ze_mist_p |
|---|---|---|---|---|---|
| high | as baked (1024 px) | full size, BC6H/BC7 blocks | cubemaps, all mips | BC6H cube | lighting 50 MB |
| medium | 512 px | 2048 px, RGBM PNG | cubemaps <= 64 px | 512 px RGBM PNG faces | +54 MB |
| low | 256 px | 1024 px, RGBM PNG | none | 256 px RGBM PNG faces | +19 MB |

RGBM: `rgb x a x 16`, linear (the lightmaps and skies sit well under 16). Geometry (`world/`, `models/` glbs) is
the same for every tier; the loader swaps their PNGs for `q/<tier>/tex/` ones (`assets.js` `glbLoader`).
Tiers don't change how the map plays: entities, collision and logic are the one bake.

Other performance switches (Video, apply instantly): render resolution, MSAA, fog, reflections; "CS2 baked lighting"
off skips the whole `lighting/` download for the simple lighting.

## Single steps

For a map that's already baked, each piece can be redone on its own (`lasers-bake <mode> <workshop.vpk> <map dir>`):

| Mode | What |
|---|---|
| `--lighting` | the whole `lighting/` folder (lightmaps, probes, post, skies, cubemaps) |
| `--sky` | only skies + reflection cubemaps, merged into the existing `lighting.json` |
| `--tiers` | `q/medium` + `q/low` (after `--lighting`) |
| `--alpha` | cut-out alpha back into the glb PNGs (tree leaves, fences). The `map` step already does it |
| `--fx` | particle effects (`fx/`) |
| `--collision` | `collision_fx.bin` + layers only (the particle trace set); takes `web/public/maps`, not the map dir |
| `--overview` | the CS2 radar (`overview/`) |
| `--shots` | the loading-screen screenshots (`shots/`) |

And `--scan <workshop/content/730> scan.json` ranks a local workshop library for laser-heavy maps.

Cache: files are fetched with the manifest's / `lighting.json`'s `version` (a bake timestamp) as a query, so a
re-bake reaches browsers. Re-running `--tiers` alone keeps the old manifest version for the tier textures: hard
reload, or run the `map` step too.

## Rules the bake keeps

- It never writes outside its output folder: every path built from a VPK goes through `SafePath.cs`.
- It never writes into the CS2 install. Use lasers-bake (VRF 20.1), not the old VRF CLI (it ignores `-o` for fonts).
- Truth from the files: lighting, fog, sky and tonemap numbers are the map's own (`.vpost`, `env_*` entities,
  `sky.vfx` params); the web side reads the same keyvalues CS2 does, so any map with fog / sky / cubemaps gets them.
