// lasers-bake <map.bsp> <out maps dir> [--csgo <csgo dir>]: a Source 1 (CS:GO / CS:S) map -> the same map folder a
// CS2 map bakes to (README "The map folder"), so the one game and EntityEngine run it:
//   entities.json  the entity lump, outputs as io, point_template members in lumps of their own (Entities.cs), and
//                  "engine": "source1", which switches the EntityEngine to Source 1's rules where CS2's differ
//   collision.bin  the world's player-solid brushes + displacements; collision_fx(.bin, _layers.bin) the particle set
//   hulls.json     one convex hull per brush of each brush entity's model (BrushGeometry.cs)
//   world/<map>.glb, models/maps/<map>/entities/brush_<n>.glb   faces with their textures and baked light (FaceMesh.cs)
//   static props in the world glb, entity studio models as models/<path>.glb (PropBake.cs)
//   soundevents.json + sounds/   the sounds its entities play (Source1Sounds.cs)
//   fx/            the particle systems its info_particle_systems name, from the .pcf files (Source1Particles.cs)
//   sprites/       its env_sprite textures (SpriteBake.cs)
// Content comes from the map's pakfile, then the game's VPK (CS:GO's csgo/pak01_dir.vpk: stock textures). Not yet:
// the 3D skybox, lighting/.
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Lasers.Bake.Source1;

static class Source1Bake
{
    public static int Run(string bspPath, string outRoot, string? csgo, string[]? only = null)
    {
        var mapName = Path.GetFileNameWithoutExtension(bspPath);
        if (!SafePath.IsMapName(mapName)) { Console.Error.WriteLine($"map name refused (letters, digits, _ and - only): {SafePath.Describe(mapName)}"); return 1; }
        var outDir = SafePath.Under(outRoot, mapName) ?? throw new InvalidDataException($"map folder outside {outRoot}");
        Directory.CreateDirectory(outDir);
        Log($"map {mapName} (Source 1) -> {outDir}");

        var bsp = Bsp.Read(bspPath);
        Log($"VBSP v{bsp.Version}: {bsp.Faces.Length} faces, {bsp.Brushes.Length} brushes, {bsp.Models.Length} models, {bsp.Disps.Length} displacements");
        csgo ??= FindCsgo();
        if (csgo == null) Log("WARNING: no CS:GO install found (--csgo <csgo dir>): stock textures will be missing");
        using var files = new GameFiles(bsp.Lump(Bsp.LumpPakfile).ToArray(), csgo != null ? [Path.Combine(csgo, "pak01_dir.vpk")] : []);
        foreach (var s in files.Sources) Log($"+ {s}");

        if (only != null) return RunOnly(only, files, mapName, outDir);

        // 1. entities.json
        var ents = Entities.Parse(bsp.EntityText);
        var models = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var brushModels = new SortedSet<int>();
        var lumps = Entities.Convert(ents, mapName, models, brushModels);
        File.WriteAllText(Path.Combine(outDir, "entities.json"), new JsonObject { ["engine"] = "source1", ["lumps"] = lumps }.ToJsonString());
        Log($"entities: {ents.Count} ({lumps.Count - 1} template lumps), {brushModels.Count} brush models, {models.Count - brushModels.Count} studio models");

        // 2. collision: the world's player-solid brushes and its displacements
        var tris = new List<float>();
        BrushGeometry.Triangles(bsp, 0, BrushGeometry.PlayerSolid, tris, null);
        FaceMesh.DispTriangles(bsp, tris, null);
        // + the solid static props (their .phy, or their box): PropBake.StaticCollision
        var staticProps = PropBake.StaticProps(bsp, Log);
        var propTris = new List<float>();
        var solidProps = PropBake.StaticCollision(staticProps, files, propTris, Log);
        tris.AddRange(propTris);
        WriteFloats(Path.Combine(outDir, "collision.bin"), tris);
        Log($"collision: {solidProps} solid static props");
        Log($"collision: {tris.Count / 9} triangles");
        var fx = new List<float>();
        var fxLayers = new List<uint>();
        BrushGeometry.Triangles(bsp, 0, ~0, fx, fxLayers);
        FaceMesh.DispTriangles(bsp, fx, fxLayers);
        fx.AddRange(propTris);
        for (var i = 0; i < propTris.Count / 9; i++) fxLayers.Add(1); // a static prop is solid to every trace
        var keep = Enumerable.Range(0, fxLayers.Count).Where(i => (fxLayers[i] & Baker.ParticleLayers) != 0).ToList();
        WriteFloats(Path.Combine(outDir, "collision_fx.bin"), keep.SelectMany(i => fx.GetRange(i * 9, 9)).ToList());
        var lb = new byte[keep.Count * 4];
        Buffer.BlockCopy(keep.Select(i => fxLayers[i]).ToArray(), 0, lb, 0, lb.Length);
        File.WriteAllBytes(Path.Combine(outDir, "collision_fx_layers.bin"), lb);

        // 3. hulls.json: brush entity models in model space. vbsp compiles a brush entity about its origin (the
        //    dmodel's origin is that point), so its brushes are already local; the check below says if one isn't.
        var classOf = new Dictionary<int, string>();
        foreach (var e in ents)
            if (e.Get("model") is { } mp && mp.StartsWith($"maps/{mapName}/entities/brush_") && int.TryParse(mp[(mp.LastIndexOf('_') + 1)..^5], out var n))
                classOf[n] = e.Get("classname") ?? "";
        var hulls = new JsonObject();
        foreach (var n in brushModels)
        {
            if (n >= bsp.Models.Length) continue;
            var cls = classOf.GetValueOrDefault(n, "").ToLowerInvariant();
            var trigger = cls.StartsWith("trigger_") || cls is "func_buyzone" or "func_bomb_target" or "func_hostage_rescue" or "func_ladder";
            var list = BrushGeometry.Hulls(bsp, n, trigger, Vector3.Zero);
            if (list.Count > 0) hulls[Entities.BrushModelPath(mapName, n)] = list;
        }
        // studio models: their .phy's convex pieces (whether one blocks is the entity's: its class and "solid")
        var modelHulls = 0;
        foreach (var m in models.Where(m => m.EndsWith(".mdl", StringComparison.OrdinalIgnoreCase)))
        {
            var list = PropBake.ModelHulls(m, files);
            if (list.Count > 0) { hulls[m] = list; modelHulls++; }
        }
        File.WriteAllText(Path.Combine(outDir, "hulls.json"), hulls.ToJsonString());
        Log($"hulls: {hulls.Count - modelHulls} brush models, {modelHulls} studio models");

        // 4. glbs: the world, then each brush entity model (textures beside each glb)
        var mats = new Materials(files, Log);
        var worldDir = Path.Combine(outDir, "world");
        Directory.CreateDirectory(worldDir);
        var atlas = LightmapAtlas.Build(bsp);
        var lightmapPng = atlas.Png();
        Log($"lightmaps: {atlas.Origin.Count} faces in a {atlas.Size}px atlas ({lightmapPng.Length / 1024} KB)");
        const string LightmapFile = "lightmap.png";
        File.WriteAllBytes(Path.Combine(worldDir, LightmapFile), lightmapPng);
        var world = FaceMesh.Build(bsp, 0, mats, atlas, LightmapFile, Vector3.Zero, out var worldMats);
        foreach (var m in worldMats) mats.WriteImage(m, worldDir);
        // static props join the world (they never move), lit by the leaf ambient cubes (PropBake.cs)
        var ambient = new AmbientLight(bsp);
        var propMats = new List<Materials.Info>();
        var placedProps = PropBake.AddStaticProps(world, staticProps, files, mats, ambient, propMats, Log);
        foreach (var m in propMats) mats.WriteImage(m, worldDir);
        Log($"static props: {placedProps} of {staticProps.Count} placed{(ambient.Has ? "" : " (no ambient light samples: grey)")}");
        world.Write(Path.Combine(worldDir, mapName + ".glb"), mapName);
        Log($"world: {world.Prims.Values.Sum(p => p.Idx.Count) / 3} triangles, {worldMats.Count} materials -> {new FileInfo(Path.Combine(worldDir, mapName + ".glb")).Length / 1024} KB");
        var renderModels = new JsonArray();
        var brushModelPaths = new HashSet<string>(brushModels.Select(n => Entities.BrushModelPath(mapName, n)), StringComparer.OrdinalIgnoreCase);
        foreach (var n in brushModels)
        {
            var g = FaceMesh.Build(bsp, n, mats, atlas, LightmapFile, Vector3.Zero, out var used);
            if (g.Empty) continue;
            var target = SafePath.OutFile(outDir, "models/" + Path.ChangeExtension(Entities.BrushModelPath(mapName, n), ".glb"));
            var lmCopy = Path.Combine(Path.GetDirectoryName(target)!, LightmapFile);
            if (!File.Exists(lmCopy)) File.WriteAllBytes(lmCopy, lightmapPng);
            foreach (var m in used) mats.WriteImage(m, Path.GetDirectoryName(target)!);
            g.Write(target, $"brush_{n}");
            renderModels.Add(Entities.BrushModelPath(mapName, n));
        }
        Log($"models: {renderModels.Count} brush models drawn");
        StampAmbient(lumps, ambient, brushModelPaths);
        File.WriteAllText(Path.Combine(outDir, "entities.json"), new JsonObject { ["engine"] = "source1", ["lumps"] = lumps.DeepClone() }.ToJsonString());
        var animations = new JsonObject();
        var studio = PropBake.EntityModels(models.Where(m => !brushModelPaths.Contains(m)), outDir, files, mats, Log, animations);
        File.WriteAllText(Path.Combine(outDir, "animations.json"), animations.ToJsonString());
        Log($"animations: {animations.Count} models, {animations.Sum(a => a.Value!.AsArray().Count)} sequences");
        foreach (var m in studio) renderModels.Add(m);
        Log($"models: {studio.Count} studio models");
        foreach (var miss in mats.Missing.Take(30)) Log($"  missing {miss}");
        if (mats.Missing.Count > 30) Log($"  ... {mats.Missing.Count - 30} more missing");

        // 5. sky/: worldspawn's skyname, the 2D skybox's six faces (materials/skybox/<name><rt|bk|lf|ft|up|dn>)
        var sky = WriteSky(ents.FirstOrDefault(e => e.Get("classname") == "worldspawn")?.Get("skyname"), files, mats, outDir);

        // 6. sounds (soundevents.json + sounds/) and particle effects (fx/: the .pcf systems as the runtime's documents)
        Source1Sounds.Bake(lumps, files, mapName, outDir, Log);
        Source1Particles.Bake(lumps, files, mapName, outDir, Log);
        SpriteBake.Bake(lumps, files, outDir, Log);

        var manifest = new JsonObject
        {
            ["map"] = mapName,
            ["title"] = mapName,
            ["version"] = DateTime.UtcNow.ToString("yyyyMMddHHmmss"),
            ["source"] = Path.GetFullPath(bspPath),
            ["engine"] = "source1",
            ["exporter"] = $"lasers-bake source1 (VBSP {bsp.Version})",
            ["world"] = $"world/{mapName}.glb",
            ["collision"] = new JsonObject { ["file"] = "collision.bin", ["triangles"] = tris.Count / 9 },
            ["hulls"] = "hulls.json",
            ["models"] = "models/",
            ["renderModels"] = renderModels,
            ["missingMaterials"] = new JsonArray([.. mats.Missing.Select(x => (JsonNode)x!)]),
        };
        if (sky != null) manifest["sky2d"] = sky;
        manifest["sprites"] = "sprites/sprites.json";
        manifest["animations"] = "animations.json";
        File.WriteAllText(Path.Combine(outDir, "manifest.json"), manifest.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Log("done");
        return 0;
    }

    // --only <steps>: sounds and / or fx for a map folder already baked (its entities.json, as stamped), then the
    // manifest's version bumped so clients fetch them again (every other key kept)
    static int RunOnly(string[] only, GameFiles files, string mapName, string outDir)
    {
        var entsFile = Path.Combine(outDir, "entities.json");
        var manifestFile = Path.Combine(outDir, "manifest.json");
        if (!File.Exists(entsFile) || !File.Exists(manifestFile)) { Console.Error.WriteLine($"not a baked map folder: {outDir}"); return 1; }
        var lumps = JsonNode.Parse(File.ReadAllText(entsFile))?["lumps"]?.AsObject() ?? throw new InvalidDataException("entities.json has no lumps");
        var manifest = JsonNode.Parse(File.ReadAllText(manifestFile))!.AsObject();
        foreach (var step in only)
        {
            switch (step.ToLowerInvariant())
            {
                case "sounds": Source1Sounds.Bake(lumps, files, mapName, outDir, Log); break;
                case "fx": Source1Particles.Bake(lumps, files, mapName, outDir, Log); break;
                case "sprites": SpriteBake.Bake(lumps, files, outDir, Log); manifest["sprites"] = "sprites/sprites.json"; break;
                default: Console.Error.WriteLine($"unknown step {step} (sounds, fx, sprites)"); return 2;
            }
        }
        manifest["version"] = DateTime.UtcNow.ToString("yyyyMMddHHmmss");
        File.WriteAllText(manifestFile, manifest.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Log("done");
        return 0;
    }

    // -> { "rt": "sky/rt.png", ... } for the faces found (null without a sky). The face's own material names its
    // texture ($basetexture), as Source's sky drawing loads skybox/<name><face>; the _hdr variant is not used
    static JsonObject? WriteSky(string? name, GameFiles files, Materials mats, string outDir)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        var safe = new string(name.Trim().Where(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-').ToArray());
        if (safe.Length == 0) return null;
        var dir = Path.Combine(outDir, "sky");
        var faces = new JsonObject();
        foreach (var f in new[] { "rt", "bk", "lf", "ft", "up", "dn" })
        {
            var m = mats.Get($"skybox/{safe}{f}");
            if (m.Texture == null) continue;
            Directory.CreateDirectory(dir);
            mats.WriteImage(m, dir);
            var png = Path.Combine(dir, f + ".png");
            File.Move(Path.Combine(dir, m.Texture), png, true);
            faces[f] = $"sky/{f}.png";
        }
        Log($"sky: {safe}, {faces.Count} faces");
        return faces.Count > 0 ? faces : null;
    }

    // each studio-model entity's ambient cube (+X -X +Y -Y +Z -Z, 18 numbers, linear) as "_s1light": the renderer lights
    // its model with it (world/source1-light.js). Where it spawns: its origin, a template member's at its template's
    // place (the point_template's origin + its local origin), 16 units up from the model's base
    static void StampAmbient(JsonObject lumps, AmbientLight ambient, HashSet<string> brushModels)
    {
        static Vector3 Vec(string? s)
        {
            var p = (s ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries);
            var v = new float[3];
            for (var i = 0; i < 3 && i < p.Length; i++) float.TryParse(p[i], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out v[i]);
            return new Vector3(v[0], v[1], v[2]);
        }
        var tplOrigin = new Dictionary<string, Vector3>(StringComparer.OrdinalIgnoreCase);
        foreach (var d in lumps["default_ents"]!.AsArray())
            if (d?["kv"]?["entitylumpname"]?.GetValue<string>() is { } ln) tplOrigin[ln] = Vec(d["kv"]?["origin"]?.GetValue<string>());
        foreach (var (lump, arr) in lumps)
            foreach (var d in arr!.AsArray())
            {
                var kv = d?["kv"]?.AsObject();
                var model = kv?["model"]?.GetValue<string>();
                if (kv == null || model == null || !model.EndsWith(".mdl", StringComparison.OrdinalIgnoreCase) || brushModels.Contains(model)) continue;
                var at = Vec(kv["origin"]?.GetValue<string>()) + (lump == "default_ents" ? Vector3.Zero : tplOrigin.GetValueOrDefault(lump)) + new Vector3(0, 0, 16);
                kv["_s1light"] = string.Join(' ', ambient.LitCube(at).SelectMany(c => new[] { c.X, c.Y, c.Z }).Select(f => MathF.Round(f, 4).ToString(System.Globalization.CultureInfo.InvariantCulture)));
            }
    }

    static void WriteFloats(string path, List<float> v)
    {
        var b = new byte[v.Count * 4];
        Buffer.BlockCopy(v.ToArray(), 0, b, 0, b.Length);
        File.WriteAllBytes(path, b);
    }

    // CS:GO's csgo folder: LASERS_CSGO, else a Steam library's "csgo legacy" (the CS:GO legacy build) or a pre-CS2
    // "Counter-Strike Global Offensive/csgo" that still has its Source 1 pak01_dir.vpk
    static string? FindCsgo()
    {
        var env = Environment.GetEnvironmentVariable("LASERS_CSGO");
        if (!string.IsNullOrEmpty(env)) return File.Exists(Path.Combine(env, "pak01_dir.vpk")) ? Path.GetFullPath(env) : null;
        foreach (var lib in Program.SteamLibraries())
            foreach (var game in new[] { "csgo legacy", "Counter-Strike Global Offensive" })
            {
                var p = Path.Combine(lib, "steamapps", "common", game, "csgo");
                if (File.Exists(Path.Combine(p, "pak01_dir.vpk"))) return p;
            }
        return null;
    }

    static void Log(string s) => Console.WriteLine(s);
}
