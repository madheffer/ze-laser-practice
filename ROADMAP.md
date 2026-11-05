# Roadmap

What's shipped and what's next for ZE Laser Practice. Tick a box when it lands; add anything you defer.

## Shipped
A browser laser trainer in the spirit of cybo's lasers.cybo.dev (which is paused while he's away), writing his
exact map-folder format so he can lift our maps straight into his site. See [README.md](README.md).
- [x] **Phase 1 (local)** — `lasers-bake` (VRF 20.1: world glb, entity models, entities.json, collision.bin, hulls.json, particles.json); the browser player with CS2 movement, box-trace collision, an entity I/O engine (templates/makers, doors, movelinears, rotators, relays/cases/branches/timers/counters, triggers), particle-strip laser visuals; ze_mist_p "Dragon – laser waves" plays from the map's own logic
- [x] **ze_mist_p full ending** — stage picker (full run, dragon fight, 6 attack drills, escape dragon, throne falling-balls finale); boss HP scaling (humans alive × the map's own per-human HP adds, boss HP %, simulated team fire with line of sight, Mouse 1 shooting); player keyvalues from the map (gravity 0.1 in the escape, 180 HP, damage filters, contexts); func_tracktrain/path_track, logic_measure_movement, momentary_rot_button, breakable/physbox health, trigger_push base velocity, riding movers, fast-forward stage starts
- [x] **Sounds + music** — map soundevents + music, stock CS2 knife/AK/player sounds (`audio.js`)
- [x] **Game feel pass (2026-11-05)** — pause menu with Resume, nothing runs before a pick, nested stage picker (throne finale first), throne starts 5 s before the balls, raw-input `sensitivity × m_yaw`, CS2 stamina + weapon speeds, fullscreen + Keyboard Lock (Ctrl+W), BossHUD-style HUD, CS2 crosshair/hitmarker, AK-47 + knife viewmodel on CS2's AnimGraph2 (vpkstuff previewer)
- [x] **1:1 pass (2026-11-05)** — throne finale at normal gravity (the escape's 0.1 ends at the unfiltered `KeyValue gravity 1` trigger every human crosses into the throne room) and 180 HP; trigger_hurt exactly as CS2's binary (porter research 07 §5.1: damage×0.5 on touch then every 0.5 s, model-1 doubling, thinkalways, half damage on an un-hurt EndTouch, negative = heal) → a mist ball is 150, two kill; Esc is a tap (keyboard lock aware); CS2 Panorama HUD from the game's own SVGs + Stratum2 (`lasers-bake --panorama`): health/armor/team circle/ammo bar, weapon select; spawn with the knife + assault suit (CS2Fixes ZR loadout), Q = lastinv, AK magazine 30 + infinite reserve (`cs2f_infinite_reserve_ammo`) + R reload; death / cleared / endless end cards (game paused behind); endless mode (balls never stop, drills repeat, dragon can't die); local personal bests; simulated ping 0–500 ms (entities + their sounds drawn late, movement predicted); code split into app/ ui/ world/ audio/ weapons/

- [x] **Accuracy fixes (2026-11-05, later)** — dragon segment HP = 900 × humans (max health is the SPAWN health, as GFL's BossHUD offset -10000 shows; it was 10000 + 900 × humans), GFL boss names (Dragon / Revived Dragon); a real simulated squad (rifles/SMGs/knives, ~50% hits, dodging during attacks → dragon ~3 min, escape ~70 s; "Perfect team" option keeps the fast kill); base CS2 HUD for CT (money + buy icon, team-coloured health/armor + bar, CT circle, ammo + clip bar, persistent weapon list; colours from csgostyles); Esc tap exits fullscreen + pauses; audio silent until a stage starts, fades on pause/resume, music joins mid-track after a fast-forward, `volume` / `snd_musicvolume` as CS2 cvars (perceptual gain); a mist ball = 150 but volleys are 4 balls (600 standing centre), so a hit is effectively a one-shot

- [x] **Own repo + polish (2026-11-05)** — split out of homelab-control-plane with CLAUDE.md / ROADMAP.md / .claude; a stage click drops straight into play (lock + fullscreen requested inside the click); menu as tabs (Play / Settings) with a stage list and settings cards, fluid from phone to ultrawide; mobile touch controls (floating joystick, drag-to-look, Jump / Crouch / Fire / swap / reload / pause); CS2Fixes `!tp` third person (custom_player_camera follow-eyes, offset (dist, 15 right), wall clip, 15–150, default 65) with the stock CT body in CS2's knife stance + crouch blend; Music + SFX sliders only; FOV fixed at CS2's 90; Sensitivity only (m_yaw 0.022 internal); duck spam allowed (CS2Fixes `cs2f_allow_duck_spam`, duck speed 8); shared helpers in `web/src/lib/`; security pass (bake output paths sandboxed by SafePath, prototype-safe tables, settings sanitised, map names validated, entity/IO/timer/parent-cycle limits, CSP in builds); versioned long-cache for maps + sounds; `npm run play` (stable build on :5805, no hot reload)

## Next
- [ ] **Online leaderboards** — longest endless survival / fastest clear per map + stage + mode; needs a tiny server (a Helm bundle with Postgres, or vpkstuff's DB) + Steam sign-in so names are real; records.js already stores the right shape
- [ ] **Leaderboard filters** — by humans/boss-HP settings and ping, so a 200 ms run isn't ranked against 0 ms
- [ ] **Endless difficulty ramp** — balls/lasers speed up or overlap more the longer you last (a scenario `endless.ramp`), instead of a flat repeat
- [ ] **Escape-dragon endless** — the chase ends by geography; a loop (teleport back + respawn the boss) would make it endless
- [ ] **Verify armor vs map damage live** — CS2Fixes gives `item_assaultsuit`; we assume armor doesn't absorb `DMG_ENERGYBEAM` (CS:GO's `bDamageTypeApplyToArmor` = bullet/blast/club/slash). Check on our server: one ball with and without `!kev`
- [ ] **Laser sound check on westersand** — its lasers carry sounds (snd_event_point in the templates); confirm they follow the laser and use CS2's distance curves
- [ ] **Ping jitter** — ± variation on the simulated ping (cybo has it), and delayed HUD damage feedback (one-way)
- [ ] **ze_ffxii_westersand_v8** — bake (item 3363745150), find its laser stages, scenarios (the next map)
- [ ] **Remaining mist attacks as drills** — pentagram/target/charge/wind/zdef (they already run inside the full fight)
- [ ] **Third-person body animation** — the CT stands in the knife idle (crouch blended by duck amount); CS2's walk/run/jump clips, aim pitch and the AK hold aren't played (the lab bake has them: `extract-tp-clips.py`)
- [ ] **Animated bosses** — `SetAnimation*` on the dragon model is ignored (it floats in its bind pose)
- [ ] **More guns** — P90 / Negev / M4 from the weaponviewer bake (only the AK-47 and CT knife are copied in)
- [ ] **Item pickups** — mist's items (heal, frost, flame, force, toxic, electro) as usable, since the map's `AddContext` filters are already honoured
- [ ] **Looks closer to in-game** — baked lightmaps, CS2 materials via vpkstuff's CS2Mat, the real particle system via vpkstuff's particles port
- [ ] **Smaller downloads** — gltfpack/meshopt the world glb (60 MB), KTX2 textures, LOW/MED/HIGH tiers like cybo's
- [ ] **Radar / minimap** — CS2's top-left radar from the map's overview image
- [ ] **Replay / ghost** — record your best run's inputs and race its ghost
- [ ] **ZR human models** — humans on a ZR server wear the playerclass models (MasterChief, IsaacClarke… from `s2ze` workshop packs), not the stock CT; bake them for third person when available
- [ ] **CSP as a response header** — builds carry it as a <meta>; the eventual host (Helm bundle / Caddy) should send it as a header with `frame-ancestors 'none'`
- [ ] **Event queue as a heap** — engine.tick scans the queue per event (fine today; firestorm peaks ~600 entities)
- [ ] **Real-device mobile test** — touch controls were verified with simulated touches; check pointer:coarse detection, fullscreen + landscape lock on iOS Safari / Android Chrome
- [ ] **Hosting** — a static Helm bundle (preview first), after the local playtest; then offer cybo the baked folders
