// A Source 1 map's particle effects -> fx/ in the CS2 bake's shape (ParticleBake.cs), so the player's particle runtime
// draws them:
//   fx/systems/<name>.json   one particle system as a compiled .vpcf would hold it (PcfOps.cs converts its functions)
//   fx/textures/...png       every texture their materials use (VTF decoded, longest side <= 1024)
//   fx/index.json            { systems: { <effect name>: file }, textures: { <key>: { file, width, height, sheet } } }
// Systems come from the .pcf files the map's particle manifest lists (maps/<map>_particles.txt in its pakfile, else
// CS:GO's particles/particles_manifest.txt; a leading '!' only marks a precache), later files replacing earlier
// definitions of the same name, as the map's own files override the stock ones. An effect is named, as Source names
// it, by its system name (info_particle_system effect_name), not a path; its children (DmeParticleChild: child, delay,
// end cap effect) are walked the same way.
// The system's own keys become the definition's: max_particles, initial_particles, radius, color, rotation and
// rotation_speed (degrees), sequence_number (1), maximum draw distance, maximum time step, time to sleep when not
// drawn, Sort particles, bounding box, cull radius / control point, control point to disable rendering if it is the
// camera. Its material (a SpriteCard .vmt) gives every renderer its texture and $additive, $overbrightfactor,
// $addself, $minsize / $maxsize / $startfadesize / $endfadesize and $depthblend ($depthblendscale, default 50); the
// texture's sprite sheet (VTF resource 0x10: CSheet, version 0 one image per frame, 1 four) rides in the index.
// Names and paths come from the map (attacker-controlled): output files are named by a cleaned name, through SafePath.
using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;

namespace Lasers.Bake.Source1;

static class Source1Particles
{
    const int MaxSystems = 4000, MaxSide = 1024;
    const double Deg = Math.PI / 180;

    public static int Bake(JsonObject lumps, GameFiles files, string mapName, string outDir, Action<string> log)
    {
        var wanted = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (_, arr) in lumps)
            foreach (var d in arr?.AsArray() ?? [])
                if (d?["kv"]?["classname"]?.GetValue<string>() == "info_particle_system" && d["kv"]?["effect_name"]?.GetValue<string>() is { Length: > 0 } fx)
                    wanted.Add(fx.Trim());
        if (wanted.Count == 0) { log("fx: no particle systems"); return 0; }

        var defs = Definitions(files, mapName, log);
        var fxDir = Path.Combine(outDir, "fx");
        if (Directory.Exists(fxDir)) Directory.Delete(fxDir, true); // a rebake replaces the folder whole
        var systems = new JsonObject();
        var textures = new JsonObject();
        var materials = new Dictionary<string, PcfOps.Material>(StringComparer.OrdinalIgnoreCase);
        var skipped = new SortedDictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var missing = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        PcfOps.Material Material(string vmt) => materials.TryGetValue(vmt, out var m) ? m : materials[vmt] = LoadMaterial(vmt, files, fxDir, textures, log);

        var queue = new Queue<string>(wanted);
        var done = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (queue.Count > 0 && done.Count < MaxSystems)
        {
            var name = queue.Dequeue();
            if (!done.Add(name)) continue;
            if (!defs.TryGetValue(name, out var def)) { missing.Add(name); continue; }
            var skip = new List<string>();
            var doc = System(def, Material, skip, out var children);
            foreach (var s in skip) skipped[s] = skipped.GetValueOrDefault(s) + 1;
            foreach (var c in children) queue.Enqueue(c);
            var rel = SafePath.Rel($"systems/{Clean(name)}.json");
            if (rel == null) continue;
            File.WriteAllText(SafePath.OutFile(fxDir, rel), doc.ToJsonString());
            systems[name.ToLowerInvariant()] = rel;
        }
        Directory.CreateDirectory(fxDir);
        File.WriteAllText(Path.Combine(fxDir, "index.json"), new JsonObject { ["systems"] = systems, ["textures"] = textures }.ToJsonString());
        log($"fx: {systems.Count} systems ({wanted.Count} named by entities), {textures.Count} textures");
        if (missing.Count > 0) log($"  fx: not in any .pcf: {string.Join(", ", missing.Take(20))}");
        if (skipped.Count > 0) log($"  fx: functions with no CS2 counterpart (skipped): {string.Join(", ", skipped.Select(kv => $"{kv.Key} x{kv.Value}"))}");
        return systems.Count;
    }

    // ---- the .pcf files -------------------------------------------------------------------------------------

    static Dictionary<string, DmxElement> Definitions(GameFiles files, string mapName, Action<string> log)
    {
        var manifest = files.Read($"maps/{mapName}_particles.txt") ?? files.Read("particles/particles_manifest.txt");
        var list = new List<string>();
        if (manifest != null)
            foreach (var root in KvText.Parse(Encoding.Latin1.GetString(manifest)).Children)
                foreach (var f in root.Children)
                    if (f.Value != null && f.Key.Equals("file", StringComparison.OrdinalIgnoreCase)) list.Add(f.Value.TrimStart('!'));
        var defs = new Dictionary<string, DmxElement>(StringComparer.OrdinalIgnoreCase);
        var read = 0;
        foreach (var path in list)
        {
            var bytes = files.Read(path);
            if (bytes == null) continue;
            try
            {
                var (_, els) = Dmx.Read(bytes);
                if (els.Count == 0) continue;
                foreach (var d in els[0].Elements("particleSystemDefinitions")) defs[d.Name] = d;
                read++;
            }
            catch (Exception e) { log($"  fx: {path}: {e.Message}"); }
        }
        log($"fx: {defs.Count} systems in {read} of {list.Count} .pcf files");
        return defs;
    }

    // ---- one system --------------------------------------------------------------------------------------------

    static JsonObject System(DmxElement def, Func<string, PcfOps.Material> material, List<string> skipped, out List<string> children)
    {
        double F(string k, double d) => def[k] switch { float f => f, int i => i, _ => d };
        int I(string k, int d) => def[k] switch { int i => i, float f => (int)f, bool b => b ? 1 : 0, _ => d };
        var mat = def["material"] as string ?? "vgui/white";
        var o = new JsonObject
        {
            ["_class"] = "CParticleSystemDefinition",
            ["m_nMaxParticles"] = I("max_particles", 1000),
            ["m_nInitialParticles"] = I("initial_particles", 0),
            ["m_flConstantRadius"] = F("radius", 5),
            ["m_flConstantRotation"] = Math.Round(F("rotation", 0) * Deg, 6),
            ["m_flConstantRotationSpeed"] = Math.Round(F("rotation_speed", 0) * Deg, 6),
            ["m_nConstantSequenceNumber"] = I("sequence_number", 0),
            ["m_nConstantSequenceNumber1"] = I("sequence_number 1", 0),
            ["m_flMaxDrawDistance"] = F("maximum draw distance", 100000),
            ["m_flMaximumTimeStep"] = F("maximum time step", 0.1),
            ["m_flNoDrawTimeToGoToSleep"] = F("time to sleep when not drawn", 8),
            ["m_bShouldSort"] = I("Sort particles", 1) != 0,
            ["m_nMinimumFrames"] = I("minimum rendered frames", 0),
            ["m_nSkipRenderControlPoint"] = I("control point to disable rendering if it is the camera", -1),
            ["m_nAllowRenderControlPoint"] = I("control point to only enable rendering if it is the camera", -1),
        };
        if (def["color"] is int[] c && c.Length == 4) o["m_ConstantColor"] = new JsonArray(c[0], c[1], c[2], c[3]);
        if (def["bounding_box_min"] is float[] bmin && bmin.Length == 3) o["m_BoundingBoxMin"] = new JsonArray(bmin[0], bmin[1], bmin[2]);
        if (def["bounding_box_max"] is float[] bmax && bmax.Length == 3) o["m_BoundingBoxMax"] = new JsonArray(bmax[0], bmax[1], bmax[2]);
        if (F("cull_radius", 0) > 0) { o["m_flCullRadius"] = F("cull_radius", 0); o["m_nCullControlPoint"] = I("cull_control_point", 0); }

        foreach (var (src, dst) in new[] { ("emitters", "m_Emitters"), ("initializers", "m_Initializers"), ("operators", "m_Operators"),
                     ("forces", "m_ForceGenerators"), ("constraints", "m_Constraints"), ("renderers", "m_Renderers") })
        {
            var arr = new JsonArray();
            foreach (var op in def.Elements(src))
                if (PcfOps.Convert(op, material, mat, skipped) is { } fn) arr.Add(fn);
            if (arr.Count > 0) o[dst] = arr;
        }
        children = [];
        var kids = new JsonArray();
        foreach (var ch in def.Elements("children"))
        {
            if (ch["child"] is not DmxElement target || string.IsNullOrEmpty(target.Name)) continue;
            children.Add(target.Name);
            var k = new JsonObject { ["m_ChildRef"] = target.Name.ToLowerInvariant() };
            if (ch["delay"] is float delay && delay != 0) k["m_flDelay"] = Math.Round(delay, 6);
            if (ch["end cap effect"] is bool ec && ec) k["m_bEndCap"] = true;
            kids.Add(k);
        }
        if (kids.Count > 0) o["m_Children"] = kids;
        return o;
    }

    // ---- materials and textures ----------------------------------------------------------------------------------

    static PcfOps.Material LoadMaterial(string vmtPath, GameFiles files, string fxDir, JsonObject textures, Action<string> log)
    {
        var key = GameFiles.Norm(vmtPath);
        if (key.StartsWith("materials/")) key = key["materials/".Length..];
        if (key.EndsWith(".vmt")) key = key[..^4];
        var vmt = Vmt.Load(files, key);
        // a material or texture the game can't find draws as Source's error material: the texture is named anyway, and
        // the runtime draws its error texture (a magenta / black checker, as Source's) for a key the index lacks
        if (vmt == null) { log($"  fx: material {key} missing"); return new($"materials/{Clean(key)}.vtf", 0, false, 1, 0, null, null, null, null, null); }
        double? Opt(string k) => vmt.Get(k) is { } v && double.TryParse(v.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : null;
        string? texKey = null;
        var height = 0;
        if (vmt.Get("$basetexture")?.Replace('\\', '/').Trim() is { Length: > 0 } tex)
        {
            var t = GameFiles.Norm(tex);
            if (t.EndsWith(".vtf")) t = t[..^4];
            texKey = $"materials/{t}.vtf";
            if (textures[texKey] is JsonObject have) height = have["sourceHeight"]?.GetValue<int>() ?? 0;
            else if (files.Read($"materials/{t}.vtf") is { } raw && Vtf.Decode(raw) is { } img)
            {
                var rel = SafePath.Rel($"textures/materials/{Clean(t)}.png");
                if (rel != null)
                {
                    File.WriteAllBytes(SafePath.OutFile(fxDir, rel), Materials.EncodePng(img, MaxSide));
                    var s = Math.Min(1.0, (double)MaxSide / Math.Max(img.Width, img.Height));
                    var entry = new JsonObject
                    {
                        ["file"] = rel, ["width"] = Math.Max(1, (int)(img.Width * s)), ["height"] = Math.Max(1, (int)(img.Height * s)),
                        ["sourceWidth"] = img.Width, ["sourceHeight"] = img.Height,
                    };
                    if (Sheet(raw) is { } sheet) entry["sheet"] = sheet;
                    textures[texKey] = entry;
                    height = img.Height;
                }
            }
            else log($"  fx: texture materials/{t}.vtf missing");
        }
        return new(texKey, height, vmt.Flag("$additive"), Opt("$overbrightfactor") ?? 1, Opt("$addself") ?? 0,
            Opt("$minsize"), Opt("$maxsize"), Opt("$startfadesize"), Opt("$endfadesize"), vmt.Flag("$depthblend") ? Opt("$depthblendscale") ?? 50 : null);
    }

    // the VTF's sprite sheet resource (tag 0x10 0 0) -> [{ id, clamp, totalTime, frames: [{ time, uv }] }] (first image)
    static JsonArray? Sheet(byte[] d)
    {
        if (d.Length < 80 || BitConverter.ToInt32(d, 8) < 3) return null;
        var n = BitConverter.ToInt32(d, 68);
        for (var i = 0; i < n && i < 32 && 80 + i * 8 + 8 <= d.Length; i++)
        {
            var o = 80 + i * 8;
            if (d[o] != 0x10 || d[o + 1] != 0 || d[o + 2] != 0) continue;
            var at = (int)BitConverter.ToUInt32(d, o + 4);
            if (at < 0 || at + 4 > d.Length) return null;
            var size = BitConverter.ToInt32(d, at);
            var p = at + 4;
            var end = (long)p + size;
            if (size <= 8 || end > d.Length) return null;
            try
            {
                int Int() { var v = BitConverter.ToInt32(d, p); p += 4; return v; }
                float Flt() { var v = BitConverter.ToSingle(d, p); p += 4; return v; }
                var version = Int();
                var images = version != 0 ? 4 : 1;
                var count = Int();
                var arr = new JsonArray();
                for (var s = 0; s < count && s < 256 && p < end; s++)
                {
                    var id = Int();
                    var clamp = Int() != 0;
                    var frames = Int();
                    var total = Flt();
                    if (frames < 0 || frames > 1024 || p + (long)frames * (4 + images * 16) > end) return arr.Count > 0 ? arr : null;
                    var fr = new JsonArray();
                    for (var f = 0; f < frames; f++)
                    {
                        var time = Flt();
                        var uv = new JsonArray(R(Flt()), R(Flt()), R(Flt()), R(Flt()));
                        p += (images - 1) * 16;
                        fr.Add(new JsonObject { ["time"] = R(time), ["uv"] = uv });
                    }
                    arr.Add(new JsonObject { ["id"] = id, ["clamp"] = clamp, ["totalTime"] = R(total), ["frames"] = fr });
                }
                return arr.Count > 0 ? arr : null;
            }
            catch (ArgumentOutOfRangeException) { return null; }
        }
        return null;
    }

    static double R(float v) => float.IsFinite(v) ? Math.Round(v, 6) : 0;
    static string Clean(string s) => new(s.ToLowerInvariant().Select(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '/' ? c : '_').ToArray());
}
