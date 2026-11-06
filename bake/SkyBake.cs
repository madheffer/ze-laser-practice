// The map's skies and reflection cubemaps, as the game stores them (GPU blocks byte for byte, every mip), for
// web/src/world/sky.js and the env_cubemap specular in world/lighting.js:
//   env_sky (skyname = a sky.vfx material) -> its g_tSkyTexture cube   -> lighting/sky/<hash>.bin + .json
//   maps/<map>/cubemaps/env_cubemap_array  (a cube array, one per array_index) -> lighting/cubemaps.bin
// Layout of a .bin: the mips in order, each mip as the vtex stores it (cube: 6 faces; cube array: depth x 6 faces);
// the .json lists each mip's offset / bytes / size. Names are hashes or fixed, never from the VPK.
using System.Text.Json;
using System.Text.Json.Nodes;
using ValveResourceFormat;
using ValveResourceFormat.ResourceTypes;

namespace Lasers.Bake;

static class SkyBake
{
    const int MaxSide = 4096, MaxDepth = 1024, MaxSkies = 16;
    const long MaxBytes = 128L * 1024 * 1024;

    static string? GpuFormat(VTexFormat f) => f switch
    {
        VTexFormat.BC6H => "bc6h", VTexFormat.BC7 => "bc7", VTexFormat.DXT1 => "dxt1", VTexFormat.DXT5 => "dxt5",
        VTexFormat.RGBA8888 => "rgba8", VTexFormat.RGBA16161616F => "rgba16f", _ => null,
    };

    // every mip's blocks -> file; the description (null if the texture can't go to the browser)
    // maxSide: mips bigger than this are skipped (reflections don't need 256^2 faces x 73 cubes)
    static JsonObject? ExportRaw(Texture tex, string file, Action<string> log, int maxSide = MaxSide)
    {
        var fmt = GpuFormat(tex.Format);
        if (fmt == null) { log($"  sky: {tex.Format} is not a format the browser can upload"); return null; }
        if (tex.Width > MaxSide || tex.Height > MaxSide || tex.Depth > MaxDepth || tex.Width < 1) return null;
        var mips = new JsonArray();
        using var ms = new MemoryStream();
        uint first = 0;
        while (first + 1 < tex.NumMipLevels && Math.Max(tex.Width, tex.Height) >> (int)first > maxSide) first++;
        for (uint m = first; m < Math.Max((byte)1, tex.NumMipLevels); m++)
        {
            var size = tex.CalculateBufferSizeForMipLevel(m);
            if (size <= 0 || ms.Length + size > MaxBytes) break;
            var data = new byte[size];
            tex.ReadTextureMipLevel(data, m);
            mips.Add(new JsonObject { ["offset"] = ms.Length, ["bytes"] = size, ["width"] = Math.Max(1, tex.Width >> (int)m), ["height"] = Math.Max(1, tex.Height >> (int)m) });
            ms.Write(data);
        }
        File.WriteAllBytes(file, ms.ToArray());
        return new JsonObject
        {
            ["file"] = Path.GetFileName(file), ["format"] = fmt, ["width"] = Math.Max(1, tex.Width >> (int)first), ["height"] = Math.Max(1, tex.Height >> (int)first), ["depth"] = tex.Depth,
            ["cube"] = tex.Flags.HasFlag(VTexFlags.CUBE_TEXTURE), ["array"] = tex.Flags.HasFlag(VTexFlags.TEXTURE_ARRAY), ["mips"] = mips,
            ["skippedMips"] = first, ["mipLevels"] = (int)tex.NumMipLevels, // CS2 picks the mip from the full chain
        };
    }

    public static JsonObject Write(Func<string, Resource?> load, string mapName, string mapDir, string outDir, Action<string> log)
    {
        var result = new JsonObject();
        // the reflection cubemaps
        using (var res = load($"maps/{mapName}/cubemaps/env_cubemap_array.vtex_c"))
            if (res?.DataBlock is Texture tex && ExportRaw(tex, SafePath.OutFile(outDir, "cubemaps.bin"), log, 128) is { } d)
            {
                // CUBEMAP_RADIANCE_SH: 27 floats per cubemap, what CS2 normalises the reflection by (the lightmap's brightness
                // over this baked brightness)
                if (tex.RadianceCoefficients is { Length: > 0 } f)
                {
                    var sh = new JsonArray();
                    for (var i = 0; i + 27 <= f.Length && sh.Count < tex.Depth; i += 27)
                        sh.Add(new JsonArray(f.Skip(i).Take(27).Select(v => (JsonNode)JsonValue.Create(float.IsFinite(v) ? v : 0f)!).ToArray()));
                    d["sh"] = sh;
                }
                result["cubemaps"] = d;
                log($"  sky: env_cubemap_array {tex.Format} {tex.Width}x{tex.Height} x{tex.Depth}, {d["mips"]!.AsArray().Count} mips");
            }

        // the skies (env_sky skyname -> sky.vfx material -> g_tSkyTexture)
        var entPath = Path.Combine(mapDir, "entities.json");
        var skies = new JsonObject();
        if (File.Exists(entPath))
        {
            var lumps = JsonNode.Parse(File.ReadAllText(entPath))?["lumps"]?.AsObject();
            var names = (lumps ?? []).SelectMany(l => l.Value?.AsArray() ?? []).Select(e => e?["kv"])
                .Where(kv => kv?["classname"]?.ToString() == "env_sky").Select(kv => kv?["skyname"]?.ToString()).Where(n => !string.IsNullOrEmpty(n)).Distinct().Take(MaxSkies);
            foreach (var skyname in names)
            {
                var key = skyname!.Replace('\\', '/').ToLowerInvariant();
                if (key.EndsWith("_c")) key = key[..^2];
                try
                {
                    using var matRes = load(key + "_c");
                    if (matRes?.DataBlock is not Material mat) { log($"  sky: no material {SafePath.Describe(key)}"); continue; }
                    if (!mat.TextureParams.TryGetValue("g_tSkyTexture", out var texPath) && !mat.TextureParams.TryGetValue("g_tSkyboxTexture", out texPath)) { log($"  sky: {SafePath.Describe(key)} has no sky texture"); continue; }
                    using var texRes = load(texPath.EndsWith("_c") ? texPath : texPath + "_c");
                    if (texRes?.DataBlock is not Texture tex) continue;
                    var hash = Fnv(key);
                    Directory.CreateDirectory(Path.Combine(outDir, "sky"));
                    var d = ExportRaw(tex, SafePath.OutFile(outDir, $"sky/{hash}.bin"), log);
                    if (d == null) continue;
                    d["shader"] = mat.ShaderName;
                    d["ints"] = new JsonObject(mat.IntParams.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)JsonValue.Create(p.Value))));
                    d["floats"] = new JsonObject(mat.FloatParams.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)JsonValue.Create(float.IsFinite(p.Value) ? p.Value : 0))));
                    d["vectors"] = new JsonObject(mat.VectorParams.Select(p => KeyValuePair.Create(p.Key, (JsonNode?)new JsonArray(p.Value.X, p.Value.Y, p.Value.Z, p.Value.W))));
                    skies[key] = new JsonObject { ["file"] = $"sky/{hash}.json" };
                    File.WriteAllText(SafePath.OutFile(outDir, $"sky/{hash}.json"), d.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
                    log($"  sky: {key} {tex.Format} {tex.Width}x{tex.Height}{(d["cube"]!.GetValue<bool>() ? " cube" : "")}");
                }
                catch (Exception e) { log($"  sky: {SafePath.Describe(key)}: {e.Message}"); }
            }
        }
        // csgo_moondome materials: a surface that shows a cube texture along the view direction (ze_dreamin's sky_fix
        // fake-skybox walls show sky56_cube2 through them). Their g_tCubeMap goes in with the skies, keyed by its vtex path
        foreach (var cube in MoondomeCubes(mapDir).Take(MaxSkies))
        {
            if (skies.ContainsKey(cube)) continue;
            try
            {
                using var texRes = load(cube + "_c");
                if (texRes?.DataBlock is not Texture tex || !tex.Flags.HasFlag(VTexFlags.CUBE_TEXTURE)) { log($"  sky: moondome cube {SafePath.Describe(cube)} missing or not a cube"); continue; }
                // as RGBM faces at full size: these cubes are often uncompressed RGBA8888 (ze_dreamin's: 33 MB raw),
                // which the browser can't take as a compressed upload anyway
                var hash = Fnv(cube);
                TierBake.WriteRgbmFaces(tex, Math.Min((int)tex.Width, 1024), outDir, hash, null, null);
                skies[cube] = new JsonObject { ["file"] = $"sky/{hash}.json" };
                log($"  sky: moondome {cube} {tex.Format} {tex.Width}x{tex.Height} -> RGBM faces");
            }
            catch (Exception e) { log($"  sky: {SafePath.Describe(cube)}: {e.Message}"); }
        }
        result["skies"] = skies;
        return result;
    }

    // the g_tCubeMap of every csgo_moondome material in the baked world / entity glbs (VRF keeps the vmat in extras)
    static IEnumerable<string> MoondomeCubes(string mapDir)
    {
        var found = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var sub in new[] { "world", "models" })
        {
            var dir = Path.Combine(mapDir, sub);
            if (!Directory.Exists(dir)) continue;
            foreach (var file in Directory.EnumerateFiles(dir, "*.glb", SearchOption.AllDirectories))
            {
                try
                {
                    using var fs = File.OpenRead(file);
                    using var br = new BinaryReader(fs);
                    if (fs.Length < 20 || br.ReadUInt32() != 0x46546C67) continue; // "glTF"
                    br.ReadUInt32(); br.ReadUInt32();
                    var len = br.ReadUInt32();
                    if (br.ReadUInt32() != 0x4E4F534A || len > fs.Length - 20) continue; // "JSON"
                    var mats = JsonNode.Parse(br.ReadBytes((int)len))?["materials"]?.AsArray();
                    foreach (var m in mats ?? [])
                    {
                        var vmat = m?["extras"]?["vmat"];
                        if (!string.Equals(vmat?["ShaderName"]?.ToString(), "csgo_moondome.vfx", StringComparison.OrdinalIgnoreCase)) continue;
                        var cube = vmat?["TextureParams"]?["g_tCubeMap"]?.ToString();
                        if (string.IsNullOrEmpty(cube)) continue;
                        cube = cube.Replace('\\', '/').ToLowerInvariant();
                        found.Add(cube.EndsWith("_c") ? cube[..^2] : cube);
                    }
                }
                catch (Exception) { /* not a glb we can read: no domes from it */ }
            }
        }
        return found;
    }

    static string Fnv(string s)
    {
        uint h = 2166136261;
        foreach (var c in s) { h ^= c; h *= 16777619; }
        return h.ToString("x8");
    }
}
