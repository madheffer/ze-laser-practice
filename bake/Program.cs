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
        if (args.Length >= 3 && args[0] == "--shots")
        {
            // lasers-bake --shots <workshop.vpk> <web/public/maps/<name>>: only the map's screenshots (ShotsBake.cs)
            return ShotsBake.Run(Path.GetFullPath(args[1]), Path.GetFullPath(args[2]));
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

    static string? FindCs2()
    {
        foreach (var lib in new[] { @"D:\Steam", @"C:\Program Files (x86)\Steam", @"D:\SteamLibrary", @"E:\SteamLibrary" })
        {
            var p = Path.Combine(lib, @"steamapps\common\Counter-Strike Global Offensive\game\csgo");
            if (File.Exists(Path.Combine(p, "pak01_dir.vpk"))) return p;
        }
        return null;
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
        if (cs2 != null)
        {
            // Stock CS2 content (dev textures, base props, tool materials) the map references but does not ship.
            foreach (var p in new[] { "pak01_dir.vpk" })
            {
                var path = Path.Combine(cs2, p);
                if (File.Exists(path)) { loader.AddPackageToSearch(path); Log($"+ {path}"); }
            }
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
        foreach (var m in models)
        {
            var res = loader.LoadFileCompiled(m);
            if (res == null || res.DataBlock is not Model model) continue;
            if (!model.GetEmbeddedMeshesAndLoD().Any() && !model.GetReferenceMeshNamesAndLoD().Any()) continue;
            try
            {
                var target = SafePath.OutFile(outDir, "models/" + Path.ChangeExtension(m, ".glb"));
                exporter.Export(res, target);
                renderModels.Add(m);
            }
            catch (Exception e)
            {
                Log($"  model {m}: {e.Message}");
            }
        }
        Log($"models: {renderModels.Count} exported");

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

        // 5. sounds: soundevents.json (every event the map's .vsndevts_c files define) + the sounds they play.
        var soundEvents = SoundBake.Map(loader, [map, outer], outDir);

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
            // a model path becomes models/<path>.glb on disk and a URL in the player: only safe relative paths
            if (!string.IsNullOrEmpty(model))
            {
                if (SafePath.Rel(model) is { } safeModel) models.Add(safeModel);
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

    static void AppendTriangles(PhysAggregateData phys, Matrix4x4 xf, List<float> outTris, bool playerSolidOnly)
    {
        var bind = phys.BindPose;
        for (var p = 0; p < phys.Parts.Length; p++)
        {
            var shape = phys.Parts[p].Shape;
            var pose = (bind.Length == 0 ? Matrix4x4.Identity : bind[p]) * xf;
            foreach (var h in shape.Hulls)
            {
                if (playerSolidOnly && !IsPlayerSolid(phys, h.CollisionAttributeIndex)) continue;
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
            }
            foreach (var m in shape.Meshes)
            {
                if (playerSolidOnly && !IsPlayerSolid(phys, m.CollisionAttributeIndex)) continue;
                var verts = m.Shape.GetVertices();
                foreach (var t in m.Shape.GetTriangles())
                {
                    Tri(outTris, Vector3.Transform(verts[t.X], pose), Vector3.Transform(verts[t.Y], pose), Vector3.Transform(verts[t.Z], pose));
                }
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

    // Same shape as cybo's hulls.json, plus "solid" (does it block players) and a "tris" entry for mesh shapes.
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
                list.Add(new JsonObject { ["verts"] = verts, ["planes"] = planes, ["solid"] = IsPlayerSolid(phys, h.CollisionAttributeIndex) });
            }
            foreach (var m in shape.Meshes)
            {
                var tris = new List<float>();
                var verts = m.Shape.GetVertices();
                foreach (var t in m.Shape.GetTriangles())
                {
                    Tri(tris, Vector3.Transform(verts[t.X], pose), Vector3.Transform(verts[t.Y], pose), Vector3.Transform(verts[t.Z], pose));
                }
                list.Add(new JsonObject { ["tris"] = new JsonArray([.. tris.Select(f => (JsonNode)R(f)!)]), ["solid"] = IsPlayerSolid(phys, m.CollisionAttributeIndex) });
            }
        }
        return list;
    }

    static void Log(string s) => Console.WriteLine(s);
}

// ---------------------------------------------------------------------------------------------------------
// Sounds: soundevents (.vsndevts_c, KV3) -> a small soundevents.json the player reads, and every .vsnd_c an
// event names -> a browser-playable file. MP3 stays MP3; WAV is written as PCM16 WAV (Valve's MS-ADPCM
// waves are decoded here, since browsers only decode PCM WAV).
//
//   soundevents.json: { "<event>": { type, files: ["sounds/x.wav"], volume, pitch, pitchRandom?: [min, max],
//                       curve?: [[distance, volume], ...], delay?, local?, children?: [event], duration?,
//                       loop?: true, loopStart?: seconds, loopEnd?: seconds } }
//
// `curve` is the event's distance_volume_mapping_curve (Source units -> gain); `base` inheritance is resolved.
// `local` marks events that play on the listener (position_relative_to_player). Files are relative to the
// folder the json sits in.
static class SoundBake
{
    static readonly JsonSerializerOptions Json = new() { WriteIndented = false };
    const int MaxSoundBytes = 64 << 20; // one sound file; CS2's longest music tracks are a few MB

    // The player's own sounds. Names are CS2's (pak01 soundevents/game_sounds_*.vsndevts_c).
    static readonly string[] StockFiles =
    [
        "soundevents/game_sounds_weapons.vsndevts_c",
        "soundevents/game_sounds_player.vsndevts_c",
        "soundevents/game_sounds_footsteps.vsndevts_c",
    ];
    static readonly string[] StockEvents =
    [
        "Weapon_Knife.Deploy", "Weapon_Knife.Slash", "Weapon_Knife.Stab", "Weapon_Knife.Hit", "Weapon_Knife.HitWall",
        "Weapon_AK47.Draw", "Weapon_AK47.Single", "Weapon_AK47.Clipout", "Weapon_AK47.Clipin", "Weapon_AK47.BoltPull",
        "Default.WalkJump", "CT_Concrete.StepLeft", "Land_Concrete.StepLeft", "CT_Default.StepLeft", "Land_Default.StepLeft",
        "Player.DamageBody.Victim", "Player.DamageFall", "Player.BurnDamage", "Player.Death",
    ];

    /// The map's events (every vsndevts_c in its packages). Returns the event count written.
    public static int Map(GameFileLoader loader, IEnumerable<Package> packages, string outDir)
    {
        var raw = new Dictionary<string, KVObject>(StringComparer.OrdinalIgnoreCase);
        foreach (var pkg in packages.Distinct())
        {
            if (!pkg.Entries.TryGetValue("vsndevts_c", out var entries)) continue;
            foreach (var e in entries)
            {
                pkg.ReadEntry(e, out var bytes);
                ReadEvents(bytes, e.GetFullPath(), raw);
            }
        }
        if (raw.Count == 0) { Console.WriteLine("sounds: map ships no soundevents"); return 0; }
        var (events, files, failed) = Export(loader, raw, raw.Keys.ToList(), outDir);
        File.WriteAllText(Path.Combine(outDir, "soundevents.json"), events.ToJsonString(Json));
        Console.WriteLine($"sounds: {events.Count} events, {files} files exported, {failed.Count} failed{(failed.Count > 0 ? ": " + string.Join(", ", failed) : "")}");
        return events.Count;
    }

    /// The shared stock set (knife, AK-47, footsteps, damage) -> <outDir>/soundevents.json + sounds.
    public static void Stock(string pak01, string outDir)
    {
        var pkg = new Package();
        pkg.Read(pak01);
        using var loader = new GameFileLoader(pkg, null);
        var raw = new Dictionary<string, KVObject>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in StockFiles)
        {
            var entry = pkg.FindEntry(f);
            if (entry == null) { Console.WriteLine($"stock: {f} not in pak01"); continue; }
            pkg.ReadEntry(entry, out var bytes);
            ReadEvents(bytes, f, raw);
        }
        Directory.CreateDirectory(outDir);
        var (events, files, failed) = Export(loader, raw, StockEvents, outDir);
        File.WriteAllText(Path.Combine(outDir, "soundevents.json"), events.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine($"stock sounds: {events.Count} events, {files} files -> {outDir}{(failed.Count > 0 ? "; failed: " + string.Join(", ", failed) : "")}");
    }

    static void ReadEvents(byte[] bytes, string name, Dictionary<string, KVObject> into)
    {
        using var res = new Resource { FileName = name };
        res.Read(new MemoryStream(bytes));
        var data = res.DataBlock switch
        {
            BinaryKV3 b => b.Data,
            KeyValuesOrNTRO k => k.Data,
            _ => null,
        };
        if (data == null) { Console.WriteLine($"sounds: {name}: not KV3"); return; }
        foreach (var (key, value) in data.Children)
        {
            if (key != null && value.IsCollection) into[key] = value;
        }
    }

    // Event fields with its base chain applied (the event's own fields win).
    static Dictionary<string, KVObject> Flatten(Dictionary<string, KVObject> raw, string name, int depth = 0)
    {
        var o = new Dictionary<string, KVObject>(StringComparer.OrdinalIgnoreCase);
        if (depth > 8 || !raw.TryGetValue(name, out var ev)) return o;
        if (ev.TryGetValue("base", out var b) && b.ValueType == KVValueType.String)
        {
            foreach (var (k, v) in Flatten(raw, b.ToString(CultureInfo.InvariantCulture), depth + 1)) o[k] = v;
        }
        foreach (var (k, v) in ev.Children) if (k != null && k != "base") o[k] = v;
        return o;
    }

    static double Num(KVObject v) => v.ValueType switch
    {
        KVValueType.Boolean => v.ToBoolean(CultureInfo.InvariantCulture) ? 1 : 0,
        KVValueType.String => double.TryParse(v.ToString(CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : 0,
        _ => v.ToDouble(CultureInfo.InvariantCulture),
    };

    static IEnumerable<string> Strings(KVObject v)
    {
        if (v.ValueType == KVValueType.String) { var s = v.ToString(CultureInfo.InvariantCulture); if (s.Length > 0) yield return s; }
        else if (v.IsArray) foreach (var (_, c) in v.Children) foreach (var s in Strings(c)) yield return s;
    }

    static (JsonObject events, int files, List<string> failed) Export(GameFileLoader loader, Dictionary<string, KVObject> raw, IEnumerable<string> wanted, string outDir)
    {
        var events = new JsonObject();
        var exported = new Dictionary<string, (string? rel, Sound? snd)>(StringComparer.OrdinalIgnoreCase);
        var failed = new List<string>();
        var queue = new Queue<string>(wanted);
        while (queue.Count > 0)
        {
            var name = queue.Dequeue();
            if (events.ContainsKey(name)) continue;
            if (!raw.ContainsKey(name)) { failed.Add($"{name} (no such event)"); continue; }
            var f = Flatten(raw, name);
            var vsnds = f.Where(kv => kv.Key.StartsWith("vsnd_files", StringComparison.OrdinalIgnoreCase)).SelectMany(kv => Strings(kv.Value)).ToList();
            var children = f.Where(kv => kv.Key.StartsWith("soundevent_", StringComparison.OrdinalIgnoreCase)).SelectMany(kv => Strings(kv.Value)).ToList();
            if (vsnds.Count == 0 && children.Count == 0) continue; // a template (base.*), nothing to play

            var ev = new JsonObject { ["type"] = f.TryGetValue("type", out var t) ? t.ToString(CultureInfo.InvariantCulture) : "csgo_mega" };
            var files = new JsonArray();
            Sound? first = null;
            foreach (var v in vsnds)
            {
                if (!exported.TryGetValue(v, out var done)) exported[v] = done = ExportFile(loader, v, outDir, failed);
                if (done.rel != null) { files.Add(done.rel); first ??= done.snd; }
            }
            ev["files"] = files;
            ev["volume"] = f.TryGetValue("volume", out var vol) ? Math.Round(Num(vol), 4) : 1;
            ev["pitch"] = f.TryGetValue("pitch", out var pit) ? Math.Round(Num(pit), 4) : 1;
            if (f.TryGetValue("pitch_random_min", out var pmin) && f.TryGetValue("pitch_random_max", out var pmax) && (Num(pmin) != 0 || Num(pmax) != 0))
                ev["pitchRandom"] = new JsonArray(Math.Round(Num(pmin), 4), Math.Round(Num(pmax), 4));
            if (f.TryGetValue("delay", out var del) && Num(del) > 0) ev["delay"] = Math.Round(Num(del), 4);
            if (f.TryGetValue("distance_volume_mapping_curve", out var curve) && curve.IsArray)
            {
                var pts = new JsonArray();
                foreach (var (_, p) in curve.Children)
                {
                    if (!p.IsArray || p.Count < 2) continue;
                    pts.Add(new JsonArray(Math.Round(Num(p[0]), 2), Math.Round(Num(p[1]), 4)));
                }
                var useCurve = !f.TryGetValue("use_distance_volume_mapping_curve", out var use) || Num(use) != 0;
                if (pts.Count > 0 && useCurve) ev["curve"] = pts;
            }
            if (f.TryGetValue("position_relative_to_player", out var rel) && Num(rel) != 0) ev["local"] = true;
            if (f.TryGetValue("vsnd_duration", out var dur)) ev["duration"] = Math.Round(Num(dur), 3);
            if (first != null && first.LoopStart >= 0 && first.SampleRate > 0)
            {
                // the wave carries a loop point (Source loops those until stopped); loopEnd 0 = to the end
                ev["loop"] = true;
                ev["loopStart"] = Math.Round((double)first.LoopStart / first.SampleRate, 4);
                if (first.LoopEnd > first.LoopStart) ev["loopEnd"] = Math.Round((double)first.LoopEnd / first.SampleRate, 4);
            }
            if (children.Count > 0)
            {
                ev["children"] = new JsonArray([.. children.Select(c => (JsonNode)c!)]);
                foreach (var c in children) if (raw.ContainsKey(c)) queue.Enqueue(c);
            }
            events[name] = ev;
        }
        return (events, exported.Values.Count(x => x.rel != null), failed);
    }

    static (string?, Sound?) ExportFile(GameFileLoader loader, string vsnd, string outDir, List<string> failed)
    {
        var path = vsnd.Replace('\\', '/');
        if (path.EndsWith("_c", StringComparison.Ordinal)) path = path[..^2];
        try
        {
            var res = loader.LoadFile(path + "_c");
            if (res?.DataBlock is not Sound snd) { failed.Add($"{path} (missing)"); return (null, null); }
            var bytes = snd.GetSound();
            if (bytes.Length > MaxSoundBytes) { failed.Add($"{path} (over {MaxSoundBytes / 1048576} MB)"); return (null, null); }
            string ext;
            switch (snd.SoundType)
            {
                case Sound.AudioFileType.MP3: ext = ".mp3"; break;
                case Sound.AudioFileType.AAC: ext = ".aac"; break;
                default: ext = ".wav"; bytes = WavToPcm16(bytes); break;
            }
            // the sound's VPK path names the file on disk and its URL in soundevents.json
            var rel = SafePath.Rel(Path.ChangeExtension(path, ext));
            if (rel == null) { failed.Add($"{SafePath.Describe(path)} (path refused)"); return (null, null); }
            File.WriteAllBytes(SafePath.OutFile(outDir, rel), bytes);
            return (rel, snd);
        }
        catch (Exception e)
        {
            failed.Add($"{path} ({e.Message})");
            return (null, null);
        }
    }

    // A RIFF wave in MS-ADPCM (format 2) -> PCM16; anything else is returned as it is.
    static byte[] WavToPcm16(byte[] wav)
    {
        if (wav.Length < 12 || BitConverter.ToUInt32(wav, 0) != 0x46464952) return wav; // "RIFF"
        int pos = 12, fmtAt = -1, fmtLen = 0, dataAt = -1, dataLen = 0;
        while (pos + 8 <= wav.Length)
        {
            var id = BitConverter.ToUInt32(wav, pos);
            var len = BitConverter.ToInt32(wav, pos + 4);
            if (id == 0x20746d66) { fmtAt = pos + 8; fmtLen = len; } // "fmt "
            else if (id == 0x61746164) { dataAt = pos + 8; dataLen = Math.Min(len, wav.Length - pos - 8); } // "data"
            if (len < 0) break;
            pos += 8 + len + (len & 1);
        }
        if (fmtAt < 0 || dataAt < 0) return wav;
        if (BitConverter.ToUInt16(wav, fmtAt) != 2) return wav;
        int ch = BitConverter.ToUInt16(wav, fmtAt + 2);
        var rate = BitConverter.ToInt32(wav, fmtAt + 4);
        int blockAlign = BitConverter.ToUInt16(wav, fmtAt + 12);
        // a block is a 7-byte header per channel plus data: anything smaller would never advance the decoder
        if (ch < 1 || ch > 8 || blockAlign < 7 * ch || rate <= 0) return wav;
        int samplesPerBlock = fmtLen >= 20 ? BitConverter.ToUInt16(wav, fmtAt + 18) : 0;
        short[] c1 = [256, 512, 0, 192, 240, 460, 392], c2 = [0, -256, 0, 64, 0, -208, -232];
        if (fmtLen >= 22)
        {
            int n = BitConverter.ToUInt16(wav, fmtAt + 20);
            if (n > 0 && fmtLen >= 22 + n * 4)
            {
                c1 = new short[n]; c2 = new short[n];
                for (var i = 0; i < n; i++) { c1[i] = BitConverter.ToInt16(wav, fmtAt + 22 + i * 4); c2[i] = BitConverter.ToInt16(wav, fmtAt + 24 + i * 4); }
            }
        }
        if (samplesPerBlock == 0) samplesPerBlock = (blockAlign - 7 * ch) * 2 / ch + 2;
        int[] adapt = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
        var outS = new List<short>(dataLen * 2);
        var co1 = new int[ch]; var co2 = new int[ch]; var delta = new int[ch]; var s1 = new int[ch]; var s2 = new int[ch];
        for (var blk = dataAt; blk + 7 * ch <= dataAt + dataLen; blk += blockAlign)
        {
            var end = Math.Min(blk + blockAlign, dataAt + dataLen);
            var p = blk;
            for (var c = 0; c < ch; c++) { var pi = Math.Min((int)wav[p++], c1.Length - 1); co1[c] = c1[pi]; co2[c] = c2[pi]; }
            for (var c = 0; c < ch; c++) { delta[c] = BitConverter.ToInt16(wav, p); p += 2; }
            for (var c = 0; c < ch; c++) { s1[c] = BitConverter.ToInt16(wav, p); p += 2; }
            for (var c = 0; c < ch; c++) { s2[c] = BitConverter.ToInt16(wav, p); p += 2; }
            for (var c = 0; c < ch; c++) outS.Add((short)s2[c]);
            for (var c = 0; c < ch; c++) outS.Add((short)s1[c]);
            var produced = 2;
            var c0 = 0;
            for (; p < end && produced < samplesPerBlock; p++)
            {
                for (var half = 0; half < 2; half++)
                {
                    var nib = half == 0 ? wav[p] >> 4 : wav[p] & 15;
                    var signed = nib >= 8 ? nib - 16 : nib;
                    var pred = (s1[c0] * co1[c0] + s2[c0] * co2[c0]) / 256 + signed * delta[c0];
                    pred = Math.Clamp(pred, short.MinValue, short.MaxValue);
                    s2[c0] = s1[c0]; s1[c0] = pred;
                    delta[c0] = Math.Max(16, adapt[nib] * delta[c0] / 256);
                    outS.Add((short)pred);
                    if (++c0 == ch) { c0 = 0; produced++; }
                }
            }
        }
        var pcm = new byte[outS.Count * 2];
        Buffer.BlockCopy(outS.ToArray(), 0, pcm, 0, pcm.Length);
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        w.Write(0x46464952); w.Write(36 + pcm.Length); w.Write(0x45564157); // RIFF....WAVE
        w.Write(0x20746d66); w.Write(16); w.Write((short)1); w.Write((short)ch); w.Write(rate);
        w.Write(rate * ch * 2); w.Write((short)(ch * 2)); w.Write((short)16);
        w.Write(0x61746164); w.Write(pcm.Length); w.Write(pcm);
        w.Flush();
        return ms.ToArray();
    }
}
