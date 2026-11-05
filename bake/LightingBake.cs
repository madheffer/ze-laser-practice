// The map's baked CS2 lighting, for the browser to light the world the way CS2 does (web/src/world/lighting.js):
//   maps/<map>/world.vwrld_c                    m_worldLightingInfo: lightmap versions + m_vLightmapUvScale
//   maps/<map>/lightmaps/irradiance.vtex_c      BC6H: the baked light (sky, bounce, the map's baked lights)
//   maps/<map>/lightmaps/directional_irradiance DXT1: its dominant direction, for normal-mapped surfaces
//   maps/<map>/lightmaps/direct_light_shadows   BC7 / BC4: the sun's (and stationary lights') baked shadow masks
// -> <map folder>/lighting/lighting.json + <name>.bin (the texture's top mip, its GPU blocks byte for byte: the
//    browser uploads them compressed, exactly as the game does)
//
//   lasers-bake --lighting <workshop.vpk> <web/public/maps/<name>>
//
// Output names are fixed (never from the VPK). Sizes and formats are checked before anything is read.
using System.Text.Json;
using System.Text.Json.Nodes;
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.Serialization.KeyValues;
using ValveKeyValue;

namespace Lasers.Bake;

static class LightingBake
{
    // (output name, the map's lightmaps/<file>); the light probes are ProbeBake.cs (too big to ship as stored)
    static readonly (string Out, string File)[] Lightmaps = [
        ("irradiance", "irradiance"), ("directional_irradiance", "directional_irradiance"), ("direct_light_shadows", "direct_light_shadows"),
    ];
    const int MaxDepth = 4096;
    const int MaxSide = 8192;
    const long MaxBytes = 256L * 1024 * 1024;

    // VTexFormat -> what the browser uploads (WebGL extension format names)
    static string? GpuFormat(VTexFormat f) => f switch
    {
        VTexFormat.BC6H => "bc6h",   // EXT_texture_compression_bptc RGB_BPTC_UNSIGNED_FLOAT
        VTexFormat.BC7 => "bc7",     // EXT_texture_compression_bptc RGBA_BPTC_UNORM
        VTexFormat.DXT1 => "dxt1",   // WEBGL_compressed_texture_s3tc RGB(A)_S3TC_DXT1
        VTexFormat.DXT5 => "dxt5",
        VTexFormat.ATI1N => "bc4",   // EXT_texture_compression_rgtc RED_RGTC1 (one channel: a shadow mask)
        _ => null,
    };

    // skyOnly: just the skies + reflection cubemaps (SkyBake.cs), merged into an existing lighting.json; postOnly: just
    // the post-processing volumes (WritePost), the same way
    public static int Run(string vpk, string mapDir, bool skyOnly = false, bool postOnly = false)
    {
        if (!File.Exists(Path.Combine(mapDir, "manifest.json"))) { Console.Error.WriteLine($"not a baked map folder: {mapDir}"); return 1; }
        var outer = new Package();
        outer.Read(vpk);
        var paks = new List<Package> { outer };
        if (outer.Entries.TryGetValue("vpk", out var vpks))
            foreach (var e in vpks.Where(e => e.DirectoryName == "maps"))
            {
                outer.ReadEntry(e, out var bytes);
                var inner = new Package();
                inner.SetFileName(e.GetFullPath());
                inner.Read(new MemoryStream(bytes));
                paks.Add(inner);
            }
        var mapName = Path.GetFileName(mapDir.TrimEnd('/', '\\'));
        if (!SafePath.IsMapName(mapName)) { Console.Error.WriteLine($"bad map folder name: {mapName}"); return 1; }
        if (skyOnly || postOnly)
        {
            var outDir = Path.Combine(mapDir, "lighting");
            var path = Path.Combine(outDir, "lighting.json");
            if (JsonNode.Parse(File.Exists(path) ? File.ReadAllText(path) : "null") is not JsonObject json) { Console.Error.WriteLine("run --lighting first"); return 1; }
            if (postOnly)
            {
                json["post"] = WritePost(paks, outDir, Console.WriteLine);
                json["version"] = DateTime.UtcNow.ToString("yyyyMMddHHmmss");
                File.WriteAllText(SafePath.OutFile(outDir, "lighting.json"), json.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
                return 0;
            }
            var sky = SkyBake.Write(p => Load(paks, p), mapName, mapDir, outDir, Console.WriteLine);
            json.Remove("cubemaps");
            if (sky["cubemaps"] is { } cubes) json["cubemaps"] = cubes.DeepClone();
            json["skies"] = sky["skies"]!.DeepClone();
            json["version"] = DateTime.UtcNow.ToString("yyyyMMddHHmmss");
            File.WriteAllText(SafePath.OutFile(outDir, "lighting.json"), json.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            return 0;
        }
        return Write(paks, mapName, mapDir, Console.WriteLine) ? 0 : 1;
    }

    static Resource? Load(IEnumerable<Package> paks, string path)
    {
        foreach (var pak in paks)
        {
            var entry = pak.FindEntry(path);
            if (entry == null) continue;
            pak.ReadEntry(entry, out var bytes);
            var res = new Resource { FileName = path };
            res.Read(new MemoryStream(bytes));
            return res;
        }
        return null;
    }

    public static bool Write(IEnumerable<Package> paks, string mapName, string mapDir, Action<string> log)
    {
        var outDir = Path.Combine(mapDir, "lighting");
        // version: the browser fetches lighting.json fresh and the .bin files as <file>?v=<version> (long-cached)
        var json = new JsonObject { ["map"] = mapName, ["version"] = DateTime.UtcNow.ToString("yyyyMMddHHmmss") };

        // the world's lighting info: which lightmap layout, and the UV scale the lightmap UVs are multiplied by
        using (var world = Load(paks, $"maps/{mapName}/world.vwrld_c"))
        {
            if (world?.DataBlock is not KeyValuesOrNTRO kv) { log("  lighting: no world.vwrld_c"); return false; }
            var info = kv.Data.GetSubCollection("m_worldLightingInfo");
            if (info == null || !info.GetBooleanProperty("m_bHasLightmaps")) { log("  lighting: the map has no lightmaps"); return false; }
            var scale = info.GetArray<double>("m_vLightmapUvScale") ?? [1, 1];
            json["lightmapVersion"] = info.GetInt32Property("m_nLightmapVersionNumber");
            json["lightmapGameVersion"] = info.GetInt32Property("m_nLightmapGameVersionNumber");
            json["uvScale"] = new JsonArray(scale.Select(v => (JsonNode)JsonValue.Create(v)!).ToArray());
        }

        var textures = new JsonObject();
        long total = 0;
        foreach (var (name, file) in Lightmaps)
        {
            using var res = Load(paks, $"maps/{mapName}/lightmaps/{file}.vtex_c");
            if (res?.DataBlock is not Texture tex) { log($"  lighting: no {name}"); continue; }
            var fmt = GpuFormat(tex.Format);
            if (fmt == null) { log($"  lighting: {name} is {tex.Format}, not a format the browser can upload"); continue; }
            if (tex.Width > MaxSide || tex.Height > MaxSide || tex.Width < 4 || tex.Height < 4 || tex.Depth < 1 || tex.Depth > MaxDepth) { log($"  lighting: {name} {tex.Width}x{tex.Height} skipped"); continue; }
            var size = tex.CalculateBufferSizeForMipLevel(0);
            if (size <= 0 || (total += size) > MaxBytes) { log($"  lighting: {name} too large"); return false; }
            var data = new byte[size];
            tex.ReadTextureMipLevel(data, 0); // the top mip's GPU blocks, as stored
            Directory.CreateDirectory(outDir);
            File.WriteAllBytes(SafePath.OutFile(outDir, $"{name}.bin"), data);
            textures[name] = new JsonObject
            {
                ["file"] = $"{name}.bin", ["format"] = fmt, ["width"] = tex.Width, ["height"] = tex.Height, ["depth"] = tex.Depth, ["bytes"] = size,
                ["hdr"] = tex.IsHighDynamicRange,
            };
            log($"  lighting: {name} {tex.Format} {tex.Width}x{tex.Height}x{tex.Depth} ({size / 1024 / 1024.0:0.0} MB)");
        }
        if (!textures.ContainsKey("irradiance")) return false;
        json["textures"] = textures;
        json["post"] = WritePost(paks, outDir, log);
        if (ProbeBake.Write(p => Load(paks, p), mapName, mapDir, outDir, log) is { } probes) json["probes"] = probes;
        var sky = SkyBake.Write(p => Load(paks, p), mapName, mapDir, outDir, log);
        if (sky["cubemaps"] is { } cubes) json["cubemaps"] = cubes.DeepClone();
        json["skies"] = sky["skies"]!.DeepClone();
        Directory.CreateDirectory(outDir);
        File.WriteAllText(SafePath.OutFile(outDir, "lighting.json"), json.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        return true;
    }

    // Every .vpost in the map (a post_processing_volume names one): its tonemap curve, bloom and colour-correction
    // lookup. -> post/<hash>.json (+ <hash>.lut: dim^3 RGBA8). The index maps the vpost's path (lower case, no _c)
    // to its hash; the file name never comes from the VPK.
    const int MaxPosts = 64, MaxLutDim = 64;
    static JsonObject WritePost(IEnumerable<Package> paks, string outDir, Action<string> log)
    {
        var index = new JsonObject();
        foreach (var pak in paks)
        {
            if (!pak.Entries.TryGetValue("vpost_c", out var posts)) continue;
            foreach (var e in posts)
            {
                if (index.Count >= MaxPosts) break;
                var path = e.GetFullPath().ToLowerInvariant().Replace('\\', '/');
                var key = path.EndsWith("_c") ? path[..^2] : path;
                if (index.ContainsKey(key)) continue;
                try
                {
                    pak.ReadEntry(e, out var bytes);
                    using var res = new Resource { FileName = path };
                    res.Read(new MemoryStream(bytes));
                    if (res.DataBlock is not KeyValuesOrNTRO kv) continue;
                    var d = kv.Data;
                    var hash = Fnv(key);
                    var o = new JsonObject { ["path"] = key };
                    if (d.GetBooleanProperty("m_bHasTonemapParams") && d.GetSubCollection("m_toneMapParams") is { } t)
                    {
                        var tm = new JsonObject();
                        foreach (var k in new[] { "m_flExposureBias", "m_flShoulderStrength", "m_flLinearStrength", "m_flLinearAngle", "m_flToeStrength", "m_flToeNum", "m_flToeDenom", "m_flWhitePoint" })
                            tm[k] = t.GetFloatProperty(k);
                        o["tonemap"] = tm;
                    }
                    if (d.GetBooleanProperty("m_bHasBloomParams") && d.GetSubCollection("m_bloomParams") is { } b) o["bloom"] = BloomJson(b);
                    var dim = d.ContainsKey("m_nColorCorrectionVolumeDim") ? d.GetInt32Property("m_nColorCorrectionVolumeDim") : 0;
                    byte[]? lut = null;
                    foreach (var (k, v) in d.Children) if (k == "m_colorCorrectionVolumeData" && v.ValueType == KVValueType.BinaryBlob) lut = v.AsBlob().ToArray();
                    if (dim >= 2 && dim <= MaxLutDim && lut != null && lut.Length == dim * dim * dim * 4)
                    {
                        Directory.CreateDirectory(Path.Combine(outDir, "post"));
                        File.WriteAllBytes(SafePath.OutFile(outDir, $"post/{hash}.lut"), lut);
                        o["lutDim"] = dim;
                    }
                    Directory.CreateDirectory(Path.Combine(outDir, "post"));
                    File.WriteAllText(SafePath.OutFile(outDir, $"post/{hash}.json"), o.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
                    index[key] = hash;
                    log($"  lighting: post {key}{(o.ContainsKey("tonemap") ? " tonemap" : "")}{(o.ContainsKey("lutDim") ? $" lut {dim}" : "")}");
                }
                catch (Exception ex) { log($"  lighting: post {SafePath.Describe(key)}: {ex.Message}"); }
            }
        }
        return index;
    }

    // m_bloomParams (world/bloom.js reads every field): blend mode, the three strengths, threshold, start value, the
    // per-level blur weights and tints (5 levels in every vpost seen)
    static JsonObject BloomJson(KVObject b)
    {
        var o = new JsonObject
        {
            ["blendMode"] = b.ContainsKey("m_blendMode") ? b.GetStringProperty("m_blendMode") : "BLOOM_BLEND_ADD",
            ["strength"] = b.GetFloatProperty("m_flBloomStrength"), ["screenStrength"] = b.GetFloatProperty("m_flScreenBloomStrength"),
            ["blurStrength"] = b.GetFloatProperty("m_flBlurBloomStrength"), ["threshold"] = b.GetFloatProperty("m_flBloomThreshold"),
            ["thresholdWidth"] = b.GetFloatProperty("m_flBloomThresholdWidth"), ["skyboxStrength"] = b.GetFloatProperty("m_flSkyboxBloomStrength"),
            ["startValue"] = b.GetFloatProperty("m_flBloomStartValue"),
        };
        // the compute bloom fields (client.dll FUN_1811e88a0 reads these for r_csgo_use_compute_bloom), only when present
        foreach (var (k, name) in new[] { ("computeStrength", "m_flComputeBloomStrength"), ("computeThreshold", "m_flComputeBloomThreshold"),
            ("computeRadius", "m_flComputeBloomRadius"), ("computeEffectsScale", "m_flComputeBloomEffectsScale") })
            if (b.ContainsKey(name)) o[k] = b.GetFloatProperty(name);
        var weights = b.GetArray<double>("m_flBlurWeight");
        if (weights != null) o["weights"] = new JsonArray(weights.Take(8).Select(v => (JsonNode)JsonValue.Create(v)!).ToArray());
        var tints = b.GetArray("m_vBlurTint");
        if (tints != null) o["tints"] = new JsonArray(tints.Take(8).Select(t => (JsonNode)new JsonArray(t.ToVector3() is var v ? new JsonNode[] { v.X, v.Y, v.Z } : [])).ToArray());
        return o;
    }

    static string Fnv(string s)
    {
        uint h = 2166136261;
        foreach (var c in s) { h ^= c; h *= 16777619; }
        return h.ToString("x8");
    }
}
