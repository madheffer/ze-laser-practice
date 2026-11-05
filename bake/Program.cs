// lasers-bake: a CS2 workshop map VPK -> the folder the laser trainer loads.
//
// The output layout is the same one lasers.cybo.dev reads (maps/<name>/manifest.json, entities.json,
// collision.bin, hulls.json, world/<name>.glb), so a map baked here can be dropped into either site.
//
//   lasers-bake <workshop .vpk | map .vpk> <out maps dir> [--cs2 <game/csgo dir>] [--no-textures]
//
// Coordinates in every JSON/bin file are Source units (inches, Z up). Only the glbs are in glTF space
// (VRF's export: metres, Y up); the player undoes that one transform when it loads them.
using System.Globalization;
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Nodes;
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.Serialization.KeyValues;
using ValveKeyValue;
using VEntityLump = ValveResourceFormat.ResourceTypes.EntityLump;

namespace Lasers.Bake;

public static class Program
{
    public static int Main(string[] args)
    {
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        if (args.Length >= 2 && args[0] == "--stock-sounds")
        {
            // lasers-bake --stock-sounds <web/public/sounds> [--cs2 <game/csgo>]: the player's own CS2 sounds
            // (knife, AK-47, footsteps, damage), written once and shared by every map.
            string? stockCs2 = null;
            for (var i = 2; i < args.Length; i++) if (args[i] == "--cs2" && i + 1 < args.Length) stockCs2 = args[++i];
            stockCs2 ??= FindCs2();
            if (stockCs2 == null) { Console.Error.WriteLine("no CS2 install found (--cs2 <game/csgo>)"); return 1; }
            SoundBake.Stock(Path.Combine(stockCs2, "pak01_dir.vpk"), Path.GetFullPath(args[1]));
            return 0;
        }
        if (args.Length >= 2 && args[0] == "--weapons")
        {
            // lasers-bake --weapons <web/src/lib/weapons-cs2.js> [--cs2 <game/csgo>]: the buyable guns' CS2 numbers (WeaponBake.cs)
            string? wCs2 = null;
            for (var i = 2; i < args.Length; i++) if (args[i] == "--cs2" && i + 1 < args.Length) wCs2 = args[++i];
            wCs2 ??= FindCs2();
            if (wCs2 == null) { Console.Error.WriteLine("no CS2 install found (--cs2 <game/csgo>)"); return 1; }
            return WeaponBake.Run(Path.Combine(wCs2, "pak01_dir.vpk"), Path.GetFullPath(args[1]));
        }
        if (args.Length >= 3 && args[0] == "--sounds")
        {
            // lasers-bake --sounds <workshop.vpk> <web/public/maps/<name>> [--cs2 <game/csgo>]: only soundevents.json + sounds/
            // (the map's events + the stock ones its entities name), for a map already baked (SoundBake.cs)
            var si = Array.IndexOf(args, "--cs2");
            return SoundBake.Run(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]), si > 0 && si + 1 < args.Length ? args[si + 1] : FindCs2());
        }
        if (args.Length >= 2 && args[0] == "--panorama")
        {
            // lasers-bake --panorama <web/public/panorama> [--cs2 <game/csgo>]: the CS2 HUD's own icons (SVG) and
            // its Stratum2 font, so the HUD can be the game's, not a lookalike.
            string? pCs2 = null;
            for (var i = 2; i < args.Length; i++) if (args[i] == "--cs2" && i + 1 < args.Length) pCs2 = args[++i];
            pCs2 ??= FindCs2();
            if (pCs2 == null) { Console.Error.WriteLine("no CS2 install found (--cs2 <game/csgo>)"); return 1; }
            PanoramaBake.Run(pCs2, Path.GetFullPath(args[1]));
            return 0;
        }
        if (args.Length >= 3 && args[0] == "--collision")
        {
            // lasers-bake --collision <workshop.vpk> <web/public/maps>: only collision_fx.bin + collision_fx_layers.bin
            // (the particle collision set, Baker.WriteParticleCollision); the rest of the map folder is untouched
            new Baker(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]), null, false) { CollisionOnly = true }.Run();
            return 0;
        }
        if (args.Length >= 3 && args[0] == "--shots")
        {
            // lasers-bake --shots <workshop.vpk> <web/public/maps/<name>>: only the map's screenshots (ShotsBake.cs)
            return ShotsBake.Run(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]));
        }
        if (args.Length >= 3 && args[0] == "--fx")
        {
            // lasers-bake --fx <workshop.vpk> <web/public/maps/<name>> [--cs2 <game/csgo>]: only the particle effects (ParticleBake.cs)
            string? fxCs2 = null;
            for (var i = 3; i < args.Length; i++) if (args[i] == "--cs2" && i + 1 < args.Length) fxCs2 = args[++i];
            return ParticleBake.Run(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]), fxCs2 ?? FindCs2());
        }
        if (args.Length >= 3 && args[0] == "--scan")
        {
            // lasers-bake --scan <workshop/content/730> <out.json>: rank a local library for laser maps (LibraryScan.cs)
            return LibraryScan.Run(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]));
        }
        if (args.Length >= 3 && args[0] == "--overview")
        {
            // lasers-bake --overview <workshop.vpk> <web/public/maps/<name>>: only the map's radar (OverviewBake.cs)
            return OverviewBake.Run(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]));
        }
        if (args.Length >= 3 && args[0] == "--alpha")
        {
            // lasers-bake --alpha <workshop.vpk> <web/public/maps/<name>> [--cs2 <game/csgo>]: put back cut-out alpha (AlphaBake.cs)
            var ai = Array.IndexOf(args, "--cs2");
            return AlphaBake.Run(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]), ai > 0 && ai + 1 < args.Length ? args[ai + 1] : FindCs2());
        }
        if (args.Length >= 3 && args[0] == "--water")
        {
            // lasers-bake --water <workshop.vpk> <web/public/maps/<name>> [--cs2 <game/csgo>]: the water shader's textures (WaterBake.cs)
            var wi = Array.IndexOf(args, "--cs2");
            return WaterBake.Run(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]), wi > 0 && wi + 1 < args.Length ? args[wi + 1] : FindCs2());
        }
        if (args.Length >= 3 && args[0] == "--tiers")
        {
            // lasers-bake --tiers <workshop.vpk> <web/public/maps/<name>>: medium / low quality copies (TierBake.cs)
            return TierBake.Run(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]));
        }
        if (args.Length >= 3 && args[0] == "--sky")
        {
            // lasers-bake --sky <workshop.vpk> <web/public/maps/<name>>: only the skies + reflection cubemaps (SkyBake.cs)
            return LightingBake.Run(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]), skyOnly: true);
        }
        if (args.Length >= 3 && args[0] == "--post")
        {
            // lasers-bake --post <workshop.vpk> <web/public/maps/<name>>: only the post-processing volumes (LightingBake.cs)
            return LightingBake.Run(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]), postOnly: true);
        }
        if (args.Length >= 3 && args[0] == "--lighting")
        {
            // lasers-bake --lighting <workshop.vpk> <web/public/maps/<name>>: the map's baked CS2 lighting (LightingBake.cs)
            return LightingBake.Run(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]));
        }
        if (args.Length >= 3 && args[0] == "--models")
        {
            // lasers-bake --models <workshop.vpk> <web/public/maps/<name>> [--cs2 <game/csgo>]: re-export the animated
            // entity models with their sequences + animations.json (ModelBake.cs)
            var mi = Array.IndexOf(args, "--cs2");
            return ModelBake.Run(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]), mi > 0 && mi + 1 < args.Length ? args[mi + 1] : FindCs2());
        }
        if (args.Length >= 2 && args[0] == "--player")
        {
            // lasers-bake --player <web/public/player> [--cs2 <game/csgo>]: your own third-person body (CT agent + knife).
            string? plCs2 = null;
            for (var i = 2; i < args.Length; i++) if (args[i] == "--cs2" && i + 1 < args.Length) plCs2 = args[++i];
            plCs2 ??= FindCs2();
            if (plCs2 == null) { Console.Error.WriteLine("no CS2 install found (--cs2 <game/csgo>)"); return 1; }
            return PlayerBake.Run(plCs2, Path.GetFullPath(args[1]));
        }
        if (args.Length < 2)
        {
            Console.Error.WriteLine("usage: lasers-bake <workshop.vpk|map.vpk> <out maps dir> [--cs2 <game/csgo>] [--no-textures]");
            return 2;
        }
        var input = Path.GetFullPath(args[0]);
        var outRoot = Path.GetFullPath(args[1]);
        string? cs2 = null;
        var textures = true;
        for (var i = 2; i < args.Length; i++)
        {
            if (args[i] == "--cs2" && i + 1 < args.Length) cs2 = args[++i];
            else if (args[i] == "--no-textures") textures = false;
        }
        cs2 ??= FindCs2();

        new Baker(input, outRoot, cs2, textures).Run();
        return 0;
    }

    // CS2's game/csgo: LASERS_CS2 if set, else the first Steam library that has CS2. Libraries come from Steam's own
    // list, <Steam>/steamapps/libraryfolders.vdf ("path" entries), with Steam found through STEAM_DIR, the registry
    // (HKCU\Software\Valve\Steam SteamPath) or its usual folders. tools/steam.mjs does the same for the node tools.
    internal static string? FindCs2()
    {
        var env = Environment.GetEnvironmentVariable("LASERS_CS2");
        if (!string.IsNullOrEmpty(env)) return File.Exists(Path.Combine(env, "pak01_dir.vpk")) ? Path.GetFullPath(env) : null;
        foreach (var lib in SteamLibraries())
        {
            var p = Path.Combine(lib, "steamapps", "common", "Counter-Strike Global Offensive", "game", "csgo");
            if (File.Exists(Path.Combine(p, "pak01_dir.vpk"))) return p;
        }
        return null;
    }

    static IEnumerable<string> SteamLibraries()
    {
        var roots = new List<string>();
        var envSteam = Environment.GetEnvironmentVariable("STEAM_DIR");
        if (!string.IsNullOrEmpty(envSteam)) roots.Add(envSteam);
        if (OperatingSystem.IsWindows())
        {
            try
            {
                using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam");
                if (key?.GetValue("SteamPath") is string sp) roots.Add(sp);
            }
            catch { /* no Steam in the registry */ }
            roots.Add(@"C:\Program Files (x86)\Steam");
        }
        else
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            roots.Add(Path.Combine(home, ".steam", "steam"));
            roots.Add(Path.Combine(home, ".local", "share", "Steam"));
            roots.Add(Path.Combine(home, "Library", "Application Support", "Steam"));
        }
        var seen = new HashSet<string>(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        foreach (var root in roots)
        {
            if (!Directory.Exists(root)) continue;
            if (seen.Add(Path.GetFullPath(root))) yield return Path.GetFullPath(root);
            var vdf = Path.Combine(root, "steamapps", "libraryfolders.vdf");
            if (!File.Exists(vdf)) continue;
            foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(File.ReadAllText(vdf), @"""path""\s+""([^""]+)"""))
            {
                var lib = m.Groups[1].Value.Replace(@"\\", @"\");
                if (Directory.Exists(lib) && seen.Add(Path.GetFullPath(lib))) yield return Path.GetFullPath(lib);
            }
        }
    }

    // CS2's stock content packs beside <game/csgo>: csgo's own and the engine's core pack (game/core), which carries
    // shared particle textures (materials/particle/fire_particle_4 and others effects name). Existing files only.
    internal static IEnumerable<string> StockPaks(string cs2)
    {
        foreach (var p in new[] { Path.Combine(cs2, "pak01_dir.vpk"), Path.Combine(cs2, "..", "core", "pak01_dir.vpk") })
            if (File.Exists(p)) yield return Path.GetFullPath(p);
    }
}

sealed class Baker(string input, string outRoot, string? cs2, bool textures)
{
    static readonly JsonSerializerOptions Json = new() { WriteIndented = false };
    static readonly JsonSerializerOptions JsonPretty = new() { WriteIndented = true };

    readonly List<Package> packages = [];
    readonly HashSet<string> missing = new(StringComparer.OrdinalIgnoreCase);
    readonly SortedSet<string> effects = new(StringComparer.OrdinalIgnoreCase);
    string mapName = "";
    string outDir = "";

    public void Run()
    {
        var outer = OpenPackage(input);
        Package map;
        var inner = outer.Entries.TryGetValue("vpk", out var vpks)
            ? vpks.FirstOrDefault(e => e.DirectoryName == "maps" && !e.FileName.EndsWith("_skybox", StringComparison.OrdinalIgnoreCase))
            : null;
        if (inner != null)
        {
            // A workshop item: the map is a vpk inside the vpk, the rest (materials, models, sounds) sits beside it.
            outer.ReadEntry(inner, out var bytes);
            map = new Package();
            map.SetFileName(inner.GetFullPath());
            map.Read(new MemoryStream(bytes));
            mapName = inner.FileName;
        }
        else
        {
            map = outer;
            mapName = outer.Entries["vwrld_c"].First().DirectoryName.Split('/').Last();
        }
        // the map's name comes from the VPK: it names the output folder, so it must be a plain folder name
        if (!SafePath.IsMapName(mapName)) throw new InvalidDataException($"map name refused (letters, digits, _ and - only): {SafePath.Describe(mapName)}");
        outDir = SafePath.Under(outRoot, mapName) ?? throw new InvalidDataException($"map folder outside {outRoot}");
        Directory.CreateDirectory(outDir);
        Log($"map {mapName} -> {outDir}");

        using var loader = new GameFileLoader(map, null);
        if (inner != null) loader.AddPackageToSearch(outer);
        if (CollisionOnly) { WriteParticleCollision(loader); return; }
        if (cs2 != null)
        {
            // Stock CS2 content (dev textures, base props, tool materials) the map references but does not ship.
            foreach (var path in Program.StockPaks(cs2)) { loader.AddPackageToSearch(path); Log($"+ {path}"); }
        }
        else Log("WARNING: no CS2 install found; stock textures will be missing (--cs2 <game/csgo>)");

        var worldRes = loader.LoadFile($"maps/{mapName}/world.vwrld_c") ?? throw new InvalidOperationException("no world.vwrld_c");
        var world = (World)worldRes.DataBlock!;

        // 1. entities.json: every lump, child template lumps included, keyed by lump name.
        var lumps = new JsonObject();
        var models = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var lumpName in world.GetEntityLumpNames())
        {
            if (lumpName != null) WalkLump(loader, lumpName, lumps, models, visited);
        }
        File.WriteAllText(Path.Combine(outDir, "entities.json"), new JsonObject { ["lumps"] = lumps }.ToJsonString(Json));
        Log($"entities: {lumps.Count} lumps, {models.Count} entity models");

        // 2. collision.bin: the static world's player-solid triangles, 9 floats each.
        var tris = new List<float>();
        var physRes = loader.LoadFile($"maps/{mapName}/world_physics.vmdl_c");
        if (physRes?.DataBlock is Model physModel)
        {
            var phys = PhysOf(loader, physModel);
            if (phys != null) AppendTriangles(phys, Matrix4x4.Identity, tris, playerSolidOnly: true);
        }
        var bin = new byte[tris.Count * 4];
        Buffer.BlockCopy(tris.ToArray(), 0, bin, 0, bin.Length);
        File.WriteAllBytes(Path.Combine(outDir, "collision.bin"), bin);
        Log($"collision: {tris.Count / 9} triangles");

        WriteParticleCollision(loader);

        // 3. hulls.json: each entity model's physics as convex hulls (verts + planes) and mesh triangles, model space.
        //    Brush entities (doors, movelinears, breakables, triggers) collide/overlap with these at runtime.
        var hulls = new JsonObject();
        var collisionInfo = new JsonObject();
        foreach (var m in models)
        {
            var res = loader.LoadFileCompiled(m);
            if (res?.DataBlock is not Model model) { missing.Add(m + "_c"); continue; }
            var phys = PhysOf(loader, model);
            if (phys == null) continue;
            var list = HullsOf(phys);
            if (list.Count > 0) hulls[m] = list;
        }
        File.WriteAllText(Path.Combine(outDir, "hulls.json"), hulls.ToJsonString(Json));
        Log($"hulls: {hulls.Count} models");

        // 3b. particles.json: a small summary of every effect an info_particle_system plays (and their
        //     children): colour, emit box, radius, rate. Laser visuals in ZE maps are particles, so the
        //     player draws these as glowing sprite strips until a full particle port lands.
        var particles = new JsonObject();
        var queue = new Queue<string>(effects);
        var seenFx = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (queue.Count > 0)
        {
            var fx = queue.Dequeue();
            if (!seenFx.Add(fx)) continue;
            var res = loader.LoadFileCompiled(fx);
            if (res?.DataBlock is not ParticleSystem ps) { missing.Add(fx + "_c"); continue; }
            var (summary, children) = SummariseParticle(ps.Data);
            particles[fx] = summary;
            foreach (var c in children) queue.Enqueue(c);
        }
        File.WriteAllText(Path.Combine(outDir, "particles.json"), particles.ToJsonString(Json));
        Log($"particles: {particles.Count} effects");
        // 3c. fx/: the effects themselves (every system + texture) for the particle runtime (ParticleBake.cs)
        // + the models their C_OP_RenderModels draw (ze_offliner's lasers are models/offliner/laser.vmdl), exported below
        //   with the entity models so the player finds them the same way (manifest renderModels, models/<path>.glb)
        ParticleBake.Write(loader, effects, outDir, Log, missing, models);

        // 4. glbs: the static world, then each entity model on its own (the player places and moves them).
        var exporter = new GltfModelExporter(loader)
        {
            ProgressReporter = new Progress<string>(_ => { }),
            ExportMaterials = textures,
            ExportAnimations = false,
            AdaptTextures = true,
            SatelliteImages = true,
            ExportExtras = true,
        };
        Directory.CreateDirectory(Path.Combine(outDir, "world"));
        var worldGlb = Path.Combine(outDir, "world", mapName + ".glb");
        foreach (var node in world.GetWorldNodeNames())
        {
            if (node == null) continue;
            var nodeRes = loader.LoadFile(node + ".vwnod_c");
            if (nodeRes == null) continue;
            exporter.Export(nodeRes, worldGlb);
            Log($"world: {node} -> {new FileInfo(worldGlb).Length / 1024} KB");
            break; // CS2 maps compile to a single node
        }
        var renderModels = new JsonArray();
        // models with real sequences get their skeleton + animations, and a line in animations.json (ModelBake.cs)
        var animExporter = ModelBake.Exporter(loader, textures);
        var animations = new JsonObject();
        foreach (var m in models)
        {
            var res = loader.LoadFileCompiled(m);
            if (res == null || res.DataBlock is not Model model) continue;
            if (!model.GetEmbeddedMeshesAndLoD().Any() && !model.GetReferenceMeshNamesAndLoD().Any()) continue;
            try
            {
                var target = SafePath.OutFile(outDir, "models/" + Path.ChangeExtension(m, ".glb"));
                var seqs = ModelBake.Sequences(loader, model, out var animated);
                if (animated) ModelBake.Export(animExporter, res, target, seqs!); else exporter.Export(res, target);
                if (seqs != null) animations[m] = seqs;
                renderModels.Add(m);
            }
            catch (Exception e)
            {
                Log($"  model {m}: {e.Message}");
            }
        }
        Log($"models: {renderModels.Count} exported");
        GlbImages.FillMissing(outDir, Log); // a texture shared by two exports lands beside one glb only (GlbImages.cs)

        // Textures come out as full-size PNGs beside each glb. Cap them so a map loads in a browser:
        // 1024 px keeps the look; the glb references the file by name, so a resize in place is all it takes.
        var resized = 0;
        long before = 0, after = 0;
        foreach (var png in Directory.EnumerateFiles(outDir, "*.png", SearchOption.AllDirectories))
        {
            before += new FileInfo(png).Length;
            try { if (ResizePng(png, MaxTexture)) resized++; }
            catch (Exception e) { Log($"  texture {Path.GetFileName(png)}: {e.Message}"); }
            after += new FileInfo(png).Length;
        }
        Log($"textures: {resized} resized to <= {MaxTexture}px, {before / 1048576} MB -> {after / 1048576} MB");
        // the cut-out alpha VRF's exporter drops (alpha-tested leaves, fences): AlphaBake.cs
        AlphaBake.Write(loader, outDir, Log);

        // the water shader's own textures (waves, foam, debris), which the glTF exporter drops: WaterBake.cs
        WaterBake.Write(loader, outDir, Log);
        // 5. sounds: soundevents.json (every event the map's .vsndevts_c files define, + the stock ones its entities
        //    name: SoundRefs.cs) + the sounds they play (SoundBake.cs).
        var soundEvents = SoundBake.Map(loader, [map, outer], outDir, cs2 != null ? Program.StockPaks(cs2) : []);

        // 6. shots/: the map's loading-screen screenshots, for the home page (ShotsBake.cs)
        ShotsBake.Write(outer, outDir, Log);

        // 7. overview/: the map's CS2 radar for the minimap (OverviewBake.cs)
        OverviewBake.Write([map, outer], mapName, outDir, Log);

        var manifest = new JsonObject
        {
            ["map"] = mapName,
            ["title"] = mapName,
            ["version"] = DateTime.UtcNow.ToString("yyyyMMddHHmmss"),
            ["source"] = input,
            ["exporter"] = "lasers-bake (ValveResourceFormat 20.1)",
            ["world"] = $"world/{mapName}.glb",
            ["collision"] = new JsonObject { ["file"] = "collision.bin", ["triangles"] = tris.Count / 9 },
            ["hulls"] = "hulls.json",
            ["models"] = "models/",
            ["renderModels"] = renderModels,
            ["missingMaterials"] = new JsonArray([.. missing.Select(x => (JsonNode)x!)]),
        };
        if (soundEvents > 0) manifest["soundEvents"] = "soundevents.json";
        File.WriteAllText(Path.Combine(outDir, ModelBake.IndexFile), animations.ToJsonString(Json));
        manifest["animations"] = ModelBake.IndexFile;
        File.WriteAllText(Path.Combine(outDir, "manifest.json"), manifest.ToJsonString(JsonPretty));
        Log("done");
    }

    Package OpenPackage(string path)
    {
        var p = new Package();
        p.Read(path);
        packages.Add(p);
        return p;
    }

    void WalkLump(GameFileLoader loader, string lumpName, JsonObject lumps, ISet<string> models, HashSet<string> visited)
    {
        if (!visited.Add(lumpName)) return;
        var res = loader.LoadFileCompiled(lumpName);
        if (res?.DataBlock is not VEntityLump lump) { missing.Add(lumpName + "_c"); return; }

        var key = string.IsNullOrEmpty(lump.Name) ? Path.GetFileNameWithoutExtension(lumpName) : lump.Name;
        var arr = new JsonArray();
        foreach (var e in lump.GetEntities())
        {
            var kv = new JsonObject();
            foreach (var prop in e.Children)
            {
                // strings verbatim (StringifyValue would escape backslashes); vectors etc. in its text form
                kv[prop.Key] = Unquote(VEntityLump.StringifyValue(prop.Value));
            }
            var io = new JsonArray();
            foreach (var c in e.Connections ?? [])
            {
                io.Add(new JsonObject
                {
                    ["output"] = c.OutputName,
                    ["delay"] = c.Delay,
                    ["times"] = c.TimesToFire,
                    ["input"] = c.InputName,
                    ["target"] = c.TargetName,
                    ["param"] = c.OverrideParam ?? "",
                });
            }
            var model = e.GetStringProperty("model");
            // a model path becomes models/<path>.glb on disk and a URL in the player: only safe relative paths.
            // Lower case: a VPK's entries are (resourcecompiler writes them so), CS2's file system is case-insensitive,
            // and VRF's lookup isn't: ze_offliner's "Laser_Hurt2_988.vmdl" is "laser_hurt2_988.vmdl_c" in the package
            if (!string.IsNullOrEmpty(model))
            {
                if (SafePath.Rel(model.ToLowerInvariant()) is { } safeModel) models.Add(safeModel);
                else Log($"  model path refused: {SafePath.Describe(model)}");
            }
            var effect = e.GetStringProperty("effect_name");
            if (!string.IsNullOrEmpty(effect)) effects.Add(effect.Replace('\\', '/'));
            arr.Add(new JsonObject { ["kv"] = kv, ["io"] = io });
        }
        lumps[key] = arr;

        foreach (var child in lump.GetChildEntityNames())
        {
            WalkLump(loader, child, lumps, models, visited);
        }
    }

    // The handful of operator values that decide what a sprite effect looks like.
    static (JsonObject, List<string>) SummariseParticle(KVObject data)
    {
        var o = new JsonObject();
        var children = new List<string>();
        static JsonArray Vec(KVObject kv, string key)
        {
            var arr = kv.ContainsKey(key) ? kv.GetArray<object>(key) : null;
            return arr == null ? [] : new JsonArray([.. arr.Select(v => (JsonNode)Convert.ToDouble(v, CultureInfo.InvariantCulture)!)]);
        }
        void Ops(string key, Action<string, KVObject> fn)
        {
            if (!data.ContainsKey(key)) return;
            foreach (var op in data.GetArray(key)) fn(op.GetStringProperty("_class") ?? "", op);
        }
        o["radius"] = data.ContainsKey("m_flConstantRadius") ? data.GetFloatProperty("m_flConstantRadius") : 5;
        o["max"] = data.ContainsKey("m_nMaxParticles") ? data.GetInt32Property("m_nMaxParticles") : 1000;
        o["color"] = Vec(data, "m_ConstantColor");
        Ops("m_Emitters", (cls, op) =>
        {
            if (cls == "C_OP_ContinuousEmitter" && op.ContainsKey("m_flEmitRate"))
            {
                // a plain float, or (newer files) a parameter object with m_flLiteralValue
                try { o["rate"] = op.GetFloatProperty("m_flEmitRate"); }
                catch { try { o["rate"] = op.GetSubCollection("m_flEmitRate").GetFloatProperty("m_flLiteralValue"); } catch { } }
            }
            if (cls == "C_OP_InstantaneousEmitter") o["burst"] = true;
        });
        Ops("m_Initializers", (cls, op) =>
        {
            switch (cls)
            {
                case "C_INIT_RandomColor":
                    o["colorMin"] = Vec(op, "m_ColorMin"); o["colorMax"] = Vec(op, "m_ColorMax"); break;
                case "C_INIT_PositionOffset":
                    o["offsetMin"] = Vec(op, "m_OffsetMin"); o["offsetMax"] = Vec(op, "m_OffsetMax"); break;
                case "C_INIT_CreateWithinBox":
                    if (op.ContainsKey("m_vecMin")) { o["boxMin"] = Vec(op, "m_vecMin"); o["boxMax"] = Vec(op, "m_vecMax"); }
                    break;
                case "C_INIT_RandomRadius":
                    o["radiusMin"] = op.GetFloatProperty("m_flRadiusMin"); o["radiusMax"] = op.GetFloatProperty("m_flRadiusMax"); break;
                case "C_INIT_RandomLifeTime":
                    o["lifeMin"] = op.GetFloatProperty("m_fLifetimeMin"); o["lifeMax"] = op.GetFloatProperty("m_fLifetimeMax"); break;
                case "C_INIT_InitFloat":
                    // output field 3 = radius (default when unset), 1 = lifetime, 7 = alpha
                    var field = op.ContainsKey("m_nOutputField") ? op.GetInt32Property("m_nOutputField") : 3;
                    KVObject? iv = null;
                    try { if (op.ContainsKey("m_InputValue")) iv = op.GetSubCollection("m_InputValue"); } catch { }
                    if (iv != null && iv.ContainsKey("m_flRandomMin"))
                    {
                        var (lo, hi) = (iv.GetFloatProperty("m_flRandomMin"), iv.GetFloatProperty("m_flRandomMax"));
                        if (field == 3) { o["radiusMin"] = lo; o["radiusMax"] = hi; }
                        else if (field == 1) { o["lifeMin"] = lo; o["lifeMax"] = hi; }
                        else if (field == 7) { o["alphaMin"] = lo; o["alphaMax"] = hi; }
                    }
                    break;
            }
        });
        Ops("m_Renderers", (cls, op) =>
        {
            o["renderer"] = cls;
            if (op.ContainsKey("m_vecTexturesInput"))
            {
                var tex = op.GetArray("m_vecTexturesInput").FirstOrDefault();
                if (tex != null && tex.ContainsKey("m_hTexture")) o["texture"] = tex.GetStringProperty("m_hTexture");
            }
            if (op.ContainsKey("m_hTexture")) o["texture"] = op.GetStringProperty("m_hTexture");
        });
        if (data.ContainsKey("m_Children"))
        {
            var kids = new JsonArray();
            foreach (var c in data.GetArray("m_Children"))
            {
                var r = c.GetStringProperty("m_ChildRef");
                if (string.IsNullOrEmpty(r)) continue;
                r = r.Replace('\\', '/');
                if (!r.EndsWith("_c", StringComparison.Ordinal)) { } // paths are source names; loader adds _c
                kids.Add(r);
                children.Add(r);
            }
            o["children"] = kids;
        }
        return (o, children);
    }

    // StringifyValue writes KV3 text: a string comes back quoted with \\ and \" escapes.
    static string Unquote(string s)
    {
        // resource-typed keys (a brush entity's model in newer maps) stringify as resource_name:"<path>": write
        // the plain path, as older maps and lasers.cybo.dev's format have it
        const string Res = "resource_name:";
        if (s.StartsWith(Res, StringComparison.Ordinal)) s = s[Res.Length..];
        if (s.Length >= 2 && s[0] == '"' && s[^1] == '"')
        {
            try { return JsonSerializer.Deserialize<string>(s) ?? ""; }
            catch (JsonException) { return s[1..^1]; }
        }
        return s;
    }

    static PhysAggregateData? PhysOf(GameFileLoader loader, Model model)
    {
        var phys = model.GetEmbeddedPhys();
        if (phys != null) return phys;
        foreach (var name in model.GetReferencedPhysNames())
        {
            if (loader.LoadFileCompiled(name)?.DataBlock is PhysAggregateData p) return p;
        }
        return null;
    }

    // lasers-bake --collision: only these two files (the rest of the map folder untouched)
    public bool CollisionOnly { get; init; }

    void WriteParticleCollision(GameFileLoader loader)
    {
        // collision_fx.bin + collision_fx_layers.bin: the static world as particle traces see it. A particle trace
        //    interacts with layers 0x1db001 at most (particles.dll 63babcbf: 0x1c3001, 0x1db001 with m_bIncludeWater),
        //    so player clips (layer 4) and sky (3) are left out; each triangle keeps its layer bits (uint32) so the
        //    runtime can apply the exact mask of each trace. Ours only: cybo's format is unchanged.
        var fxTris = new List<float>();
        var fxLayers = new List<uint>();
        var fxSurfaces = new List<uint>(); // each triangle's surface property hash (collision_fx_surfaces.bin: bullet impacts)
        if (loader.LoadFile($"maps/{mapName}/world_physics.vmdl_c")?.DataBlock is Model physModel2 && PhysOf(loader, physModel2) is { } phys2)
        {
            AppendTriangles(phys2, Matrix4x4.Identity, fxTris, playerSolidOnly: false, fxLayers, ParticleLayers, fxSurfaces);
        }
        var fxBin = new byte[fxTris.Count * 4];
        Buffer.BlockCopy(fxTris.ToArray(), 0, fxBin, 0, fxBin.Length);
        File.WriteAllBytes(Path.Combine(outDir, "collision_fx.bin"), fxBin);
        var layerBin = new byte[fxLayers.Count * 4];
        Buffer.BlockCopy(fxLayers.ToArray(), 0, layerBin, 0, layerBin.Length);
        File.WriteAllBytes(Path.Combine(outDir, "collision_fx_layers.bin"), layerBin);
        var surfBin = new byte[fxSurfaces.Count * 4];
        Buffer.BlockCopy(fxSurfaces.ToArray(), 0, surfBin, 0, surfBin.Length);
        File.WriteAllBytes(Path.Combine(outDir, "collision_fx_surfaces.bin"), surfBin);
        Log($"collision_fx: {fxLayers.Count} triangles");
    }

    // Collision groups a CS2 player stands on / is blocked by. Triggers, debris and "never collides" are skipped.
    static bool IsPlayerSolid(PhysAggregateData phys, int attrIndex)
    {
        var attrs = phys.CollisionAttributes;
        if (attrIndex < 0 || attrIndex >= attrs.Count) return true;
        var a = attrs[attrIndex];
        var group = a.GetStringProperty("m_CollisionGroupString")?.ToLowerInvariant() ?? "";
        if (group is "trigger" or "debris" or "interactive" or "never" or "weapon") return false;
        var interact = a.GetArray<string>("m_InteractAsStrings") ?? [];
        var exclude = a.GetArray<string>("m_InteractExcludeStrings") ?? [];
        if (exclude.Any(s => s.Equals("player", StringComparison.OrdinalIgnoreCase))) return false;
        if (interact.Any(s => s.Equals("trigger", StringComparison.OrdinalIgnoreCase))) return false;
        return true;
    }

    // CS2's interaction layers by bit (CS2Fixes sdk/public/const.h BuiltInInteractionLayer_t + StandardInteractionLayers_t;
    // names as vphysics2's intersection dictionary spells them, compared case-insensitively).
    static readonly string[] LayerNames =
    [
        "solid", "hitboxes", "trigger", "sky", "playerclip", "npcclip", "blocklos", "blocklight", "ladder", "pickup",
        "blocksound", "nodraw", "window", "passbullets", "worldgeometry", "water", "slime", "touchall", "player", "npc",
        "debris", "physics_prop", "navignore", "navlocalignore", "postprocessingvolume", "unused_layer3", "carriedobject",
        "pushaway", "serverentityonclient", "carriedweapon", "staticlevel",
    ];
    // every layer a particle trace (0x1db001 at most: solid, window, passbullets, water, slime, player, npc, debris) or a
    // bullet trace (0x1c300b, server.dll 0x180a71821: adds hitboxes and sky) can hit; each trace applies its own mask per
    // triangle, so sky triangles are kept for bullets and skipped by particles
    internal const uint ParticleLayers = 0x1db001 | 0x1c300b;

    // A collision attribute's interaction layers (m_InteractAsStrings) as bits; 0 for the trigger / never groups,
    // which no trace collides with. Any other group but conditionallysolid is solid to everything (CS2Fixes const.h
    // BuiltInCollisionGroup_t; world brushes are "Default" with no layer strings), so it carries the solid bit too;
    // a conditionallysolid shape (player clip, sky, window) is only what its strings say. Out of range: plain solid.
    internal static uint LayersOf(PhysAggregateData phys, int attrIndex)
    {
        var attrs = phys.CollisionAttributes;
        if (attrIndex < 0 || attrIndex >= attrs.Count) return 1;
        var a = attrs[attrIndex];
        var group = a.GetStringProperty("m_CollisionGroupString")?.ToLowerInvariant() ?? "";
        if (group is "trigger" or "never") return 0;
        uint bits = group == "conditionallysolid" ? 0u : 1u;
        foreach (var s in a.GetArray<string>("m_InteractAsStrings") ?? [])
        {
            var i = Array.FindIndex(LayerNames, n => n.Equals(s, StringComparison.OrdinalIgnoreCase));
            if (i >= 0) bits |= 1u << i;
        }
        return bits;
    }

    // outLayers / layerMask: keep only shapes whose layers meet layerMask and record each triangle's layer bits.
    // outSurfaces: each triangle's surface property hash (the shape's, or a mesh triangle's own material).
    static void AppendTriangles(PhysAggregateData phys, Matrix4x4 xf, List<float> outTris, bool playerSolidOnly,
        List<uint>? outLayers = null, uint layerMask = 0, List<uint>? outSurfaces = null)
    {
        var hashes = phys.SurfacePropertyHashes ?? [];
        uint Surf(int i) => i >= 0 && i < hashes.Length ? hashes[i] : 0;
        var bind = phys.BindPose;
        for (var p = 0; p < phys.Parts.Length; p++)
        {
            var shape = phys.Parts[p].Shape;
            var pose = (bind.Length == 0 ? Matrix4x4.Identity : bind[p]) * xf;
            foreach (var h in shape.Hulls)
            {
                if (playerSolidOnly && !IsPlayerSolid(phys, h.CollisionAttributeIndex)) continue;
                var layers = outLayers == null ? 0 : LayersOf(phys, h.CollisionAttributeIndex);
                if (outLayers != null && (layers & layerMask) == 0) continue;
                var before = outTris.Count;
                var verts = h.Shape.GetVertexPositions();
                var edges = h.Shape.GetEdges();
                foreach (var face in h.Shape.GetFaces())
                {
                    var start = face.Edge;
                    for (var e = edges[start].Next; e != start;)
                    {
                        var next = edges[e].Next;
                        if (next == start) break;
                        Tri(outTris, Vector3.Transform(verts[edges[start].Origin], pose),
                            Vector3.Transform(verts[edges[e].Origin], pose),
                            Vector3.Transform(verts[edges[next].Origin], pose));
                        e = next;
                    }
                }
                for (var k = before; k < outTris.Count; k += 9) { outLayers?.Add(layers); outSurfaces?.Add(Surf(h.SurfacePropertyIndex)); }
            }
            foreach (var m in shape.Meshes)
            {
                if (playerSolidOnly && !IsPlayerSolid(phys, m.CollisionAttributeIndex)) continue;
                var layers = outLayers == null ? 0 : LayersOf(phys, m.CollisionAttributeIndex);
                if (outLayers != null && (layers & layerMask) == 0) continue;
                var before = outTris.Count;
                var verts = m.Shape.GetVertices();
                var mats = m.Shape.Materials ?? [];
                var ti = 0;
                foreach (var t in m.Shape.GetTriangles())
                {
                    Tri(outTris, Vector3.Transform(verts[t.X], pose), Vector3.Transform(verts[t.Y], pose), Vector3.Transform(verts[t.Z], pose));
                    // a mesh triangle's material indexes the aggregate's surface list (UNSETTLED: read from VRF's types only)
                    outSurfaces?.Add(Surf(ti < mats.Length ? mats[ti] : m.SurfacePropertyIndex));
                    ti++;
                }
                for (var k = before; k < outTris.Count; k += 9) outLayers?.Add(layers);
            }
        }
    }

    static void Tri(List<float> o, Vector3 a, Vector3 b, Vector3 c)
    {
        o.Add(a.X); o.Add(a.Y); o.Add(a.Z);
        o.Add(b.X); o.Add(b.Y); o.Add(b.Z);
        o.Add(c.X); o.Add(c.Y); o.Add(c.Z);
    }

    internal const int MaxTexture = 1024;

    // Largest texture side the bake will decode at all (a PNG header can claim any size: don't allocate it).
    const int MaxDecodeSide = 16384;

    internal static bool ResizePng(string path, int max)
    {
        using (var codec = SkiaSharp.SKCodec.Create(path))
        {
            if (codec == null) return false;
            var (w, h) = (codec.Info.Width, codec.Info.Height);
            if (w <= max && h <= max) return false;
            if (w > MaxDecodeSide || h > MaxDecodeSide) throw new InvalidDataException($"{w}x{h} is over {MaxDecodeSide} px, not decoded");
        }
        using var src = SkiaSharp.SKBitmap.Decode(path);
        if (src == null || (src.Width <= max && src.Height <= max)) return false;
        var scale = (float)max / Math.Max(src.Width, src.Height);
        var info = new SkiaSharp.SKImageInfo(Math.Max(1, (int)(src.Width * scale)), Math.Max(1, (int)(src.Height * scale)), src.ColorType, src.AlphaType);
        using var dst = src.Resize(info, new SkiaSharp.SKSamplingOptions(SkiaSharp.SKCubicResampler.Mitchell));
        using var img = SkiaSharp.SKImage.FromBitmap(dst);
        using var data = img.Encode(SkiaSharp.SKEncodedImageFormat.Png, 100);
        File.WriteAllBytes(path, data.ToArray());
        return true;
    }

    static float R(float v) => MathF.Round(v, 5);

    // Same shape as cybo's hulls.json, plus "solid" (does it block players), "layers" (its interaction-layer bits, LayersOf) and a "tris" entry for mesh shapes.
    static JsonArray HullsOf(PhysAggregateData phys)
    {
        var list = new JsonArray();
        var bind = phys.BindPose;
        for (var p = 0; p < phys.Parts.Length; p++)
        {
            var shape = phys.Parts[p].Shape;
            var pose = bind.Length == 0 ? Matrix4x4.Identity : bind[p];
            foreach (var h in shape.Hulls)
            {
                var verts = new JsonArray();
                foreach (var v in h.Shape.GetVertexPositions())
                {
                    var w = Vector3.Transform(v, pose);
                    verts.Add(R(w.X)); verts.Add(R(w.Y)); verts.Add(R(w.Z));
                }
                var planes = new JsonArray();
                foreach (var pl in h.Shape.GetPlanes())
                {
                    var n = Vector3.Normalize(Vector3.TransformNormal(pl.Normal, pose));
                    var point = Vector3.Transform(pl.Normal * pl.Offset, pose);
                    planes.Add(R(n.X)); planes.Add(R(n.Y)); planes.Add(R(n.Z)); planes.Add(R(Vector3.Dot(n, point)));
                }
                list.Add(new JsonObject { ["verts"] = verts, ["planes"] = planes, ["solid"] = IsPlayerSolid(phys, h.CollisionAttributeIndex), ["layers"] = LayersOf(phys, h.CollisionAttributeIndex) });
            }
            foreach (var m in shape.Meshes)
            {
                var tris = new List<float>();
                var verts = m.Shape.GetVertices();
                foreach (var t in m.Shape.GetTriangles())
                {
                    Tri(tris, Vector3.Transform(verts[t.X], pose), Vector3.Transform(verts[t.Y], pose), Vector3.Transform(verts[t.Z], pose));
                }
                list.Add(new JsonObject { ["tris"] = new JsonArray([.. tris.Select(f => (JsonNode)R(f)!)]), ["solid"] = IsPlayerSolid(phys, m.CollisionAttributeIndex), ["layers"] = LayersOf(phys, m.CollisionAttributeIndex) });
            }
        }
        return list;
    }

    static void Log(string s) => Console.WriteLine(s);
}
