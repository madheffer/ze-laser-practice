// The map's particle effects as the game has them, for the player's particle runtime (web/src/fx/particles):
//   fx/systems/<effect path>.json   a .vpcf's DATA block as JSON (Kv3Json), for every effect an info_particle_system
//                                   plays and every child system they name (m_Children[].m_ChildRef)
//   fx/textures/<vtex path>.png     every texture those systems reference, decoded (longest side <= 1024)
//   fx/index.json                   { systems: { path: file }, textures: { path: { file, width, height, sheet } } }
// A sprite sheet (sequences of frames as normalised UV rectangles) rides in index.json with its texture.
//
// Paths come from the VPK (attacker-controlled): every output path goes through SafePath; sizes are capped.
using System.Text.Json;
using System.Text.Json.Nodes;
using ValveKeyValue;
using ValveResourceFormat;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;

namespace Lasers.Bake;

static class ParticleBake
{
    const int MaxSystems = 4000, MaxTextures = 2000, MaxSide = 1024, MaxDecodePixels = 8192 * 8192;

    // lasers-bake --fx <workshop.vpk> <map folder>: only fx/, for a map already baked (its entities.json names the effects)
    public static int Run(string vpk, string mapDir, string? cs2)
    {
        var entsFile = Path.Combine(mapDir, "entities.json");
        if (!File.Exists(entsFile)) { Console.Error.WriteLine($"not a baked map folder: {mapDir}"); return 1; }
        var effects = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        using (var doc = JsonDocument.Parse(File.ReadAllBytes(entsFile)))
            foreach (var lump in doc.RootElement.GetProperty("lumps").EnumerateObject())
                foreach (var e in lump.Value.EnumerateArray())
                    if (e.TryGetProperty("kv", out var kv) && kv.TryGetProperty("effect_name", out var fx) && fx.GetString() is { Length: > 0 } name)
                        effects.Add(name.Replace('\\', '/'));
        var outer = new SteamDatabase.ValvePak.Package();
        outer.Read(vpk);
        var map = outer;
        if (outer.Entries.TryGetValue("vpk", out var vpks) && vpks.FirstOrDefault(e => e.DirectoryName == "maps" && !e.FileName.EndsWith("_skybox", StringComparison.OrdinalIgnoreCase)) is { } inner)
        {
            outer.ReadEntry(inner, out var bytes);
            map = new SteamDatabase.ValvePak.Package();
            map.SetFileName(inner.GetFullPath());
            map.Read(new MemoryStream(bytes));
        }
        using var loader = new GameFileLoader(map, null);
        if (map != outer) loader.AddPackageToSearch(outer);
        if (cs2 != null) foreach (var pak in Program.StockPaks(cs2)) loader.AddPackageToSearch(pak);
        var missing = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        Write(loader, effects, mapDir, Console.WriteLine, missing);
        if (missing.Count > 0) Console.WriteLine($"missing: {string.Join(", ", missing.Take(20))}{(missing.Count > 20 ? " ..." : "")}");
        return 0;
    }

    public static void Write(GameFileLoader loader, IEnumerable<string> effects, string outDir, Action<string> log, ISet<string> missing)
    {
        var systems = new JsonObject();
        var textures = new JsonObject();
        var texRefs = new SortedSet<string>(StringComparer.Ordinal);
        var queue = new Queue<string>(effects.Select(Normalize).OfType<string>());
        var seen = new HashSet<string>(StringComparer.Ordinal);
        while (queue.Count > 0 && seen.Count < MaxSystems)
        {
            var fx = queue.Dequeue();
            if (!seen.Add(fx)) continue;
            var rel = SafePath.Rel(fx);
            if (rel == null) { log($"  particle path refused: {SafePath.Describe(fx)}"); continue; }
            var res = loader.LoadFileCompiled(fx);
            if (res?.DataBlock is not ParticleSystem ps) { missing.Add(fx + "_c"); continue; }
            try
            {
                var json = Kv3Json.ToUtf8(ps.Data);
                var file = $"fx/systems/{rel}.json";
                File.WriteAllBytes(SafePath.OutFile(outDir, file), json);
                systems[fx] = file["fx/".Length..];
                foreach (var s in Strings(ps.Data))
                {
                    var n = Normalize(s);
                    if (n == null) continue;
                    if (n.EndsWith(".vpcf", StringComparison.Ordinal)) queue.Enqueue(n);
                    else if (n.EndsWith(".vtex", StringComparison.Ordinal)) texRefs.Add(n);
                }
            }
            catch (Exception ex) { log($"  particle {fx}: {ex.Message}"); }
        }
        foreach (var tex in texRefs.Take(MaxTextures))
        {
            var rel = SafePath.Rel(tex);
            if (rel == null) continue;
            try
            {
                var res = loader.LoadFileCompiled(tex);
                if (res?.DataBlock is not Texture t) { missing.Add(tex + "_c"); continue; }
                if ((long)t.Width * t.Height > MaxDecodePixels) continue;
                using var bmp = t.GenerateBitmap();
                var longest = Math.Max(bmp.Width, bmp.Height);
                var scale = longest > MaxSide ? (double)MaxSide / longest : 1;
                var w = Math.Max(1, (int)Math.Round(bmp.Width * scale));
                var h = Math.Max(1, (int)Math.Round(bmp.Height * scale));
                using var sized = scale < 1 ? bmp.Resize(new SkiaSharp.SKImageInfo(w, h), new SkiaSharp.SKSamplingOptions(SkiaSharp.SKFilterMode.Linear, SkiaSharp.SKMipmapMode.None)) : bmp.Copy();
                using var img = SkiaSharp.SKImage.FromBitmap(sized);
                using var data = img.Encode(SkiaSharp.SKEncodedImageFormat.Png, 100);
                var file = $"fx/textures/{rel}.png";
                File.WriteAllBytes(SafePath.OutFile(outDir, file), data.ToArray());
                var entry = new JsonObject { ["file"] = file["fx/".Length..], ["width"] = w, ["height"] = h, ["sourceWidth"] = t.Width, ["sourceHeight"] = t.Height };
                if (Sheet(t) is { } sheet) entry["sheet"] = sheet;
                textures[tex] = entry;
            }
            catch (Exception ex) { log($"  particle texture {tex}: {ex.Message}"); }
        }
        var index = new JsonObject { ["systems"] = systems, ["textures"] = textures };
        File.WriteAllText(SafePath.OutFile(outDir, "fx/index.json"), index.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
        log($"fx: {systems.Count} particle systems, {textures.Count} textures");
    }

    // every string value in a KV3 tree (resource references: child systems, textures)
    static IEnumerable<string> Strings(KVObject o, int depth = 0)
    {
        if (depth > 64) yield break;
        switch (o.ValueType)
        {
            case KVValueType.Collection: foreach (var (_, v) in o.Children) foreach (var s in Strings(v, depth + 1)) yield return s; break;
            case KVValueType.Array: foreach (var v in o.Values) foreach (var s in Strings(v, depth + 1)) yield return s; break;
            case KVValueType.String: yield return o.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? ""; break;
        }
    }

    // a reference as the index keys it: lower case, forward slashes, no "resource:" prefix / quotes / "_c"
    public static string? Normalize(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var p = raw.Trim().Trim('"').Replace('\\', '/').ToLowerInvariant();
        if (p.StartsWith("resource_name:", StringComparison.Ordinal)) p = p["resource_name:".Length..].Trim('"');
        if (p.StartsWith("resource:", StringComparison.Ordinal)) p = p["resource:".Length..].Trim('"');
        if (p.EndsWith("_c", StringComparison.Ordinal)) p = p[..^2];
        if (p.Length == 0 || p.Length > 260 || p.StartsWith('/') || p.Contains(':')) return null;
        return p;
    }

    // a sprite sheet: [{ id, clamp, totalTime, frames: [{ time, uv: [u0, v0, u1, v1] }] }]
    static JsonArray? Sheet(Texture tex)
    {
        var sheet = tex.GetSpriteSheetData();
        if (sheet is null || sheet.Sequences.Length == 0) return null;
        var arr = new JsonArray();
        foreach (var seq in sheet.Sequences.Take(256))
        {
            var frames = new JsonArray();
            foreach (var f in seq.Frames.Take(1024))
            {
                var uv = new JsonArray();
                if (f.Images.Length > 0)
                {
                    var im = f.Images[0];
                    foreach (var v in new[] { im.CroppedMin.X, im.CroppedMin.Y, im.CroppedMax.X, im.CroppedMax.Y }) uv.Add(Finite(v));
                }
                frames.Add(new JsonObject { ["time"] = Finite(f.DisplayTime), ["uv"] = uv });
            }
            arr.Add(new JsonObject { ["id"] = seq.Id, ["clamp"] = seq.Clamp, ["totalTime"] = Finite(seq.TotalTime), ["frames"] = frames });
        }
        return arr;
    }

    static double Finite(float v) => float.IsFinite(v) ? Math.Round(v, 6) : 0;
}
