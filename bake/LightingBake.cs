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

namespace Lasers.Bake;

static class LightingBake
{
    static readonly string[] Lightmaps = ["irradiance", "directional_irradiance", "direct_light_shadows"];
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

    public static int Run(string vpk, string mapDir)
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
        foreach (var name in Lightmaps)
        {
            using var res = Load(paks, $"maps/{mapName}/lightmaps/{name}.vtex_c");
            if (res?.DataBlock is not Texture tex) { log($"  lighting: no {name}"); continue; }
            var fmt = GpuFormat(tex.Format);
            if (fmt == null) { log($"  lighting: {name} is {tex.Format}, not a format the browser can upload"); continue; }
            if (tex.Width > MaxSide || tex.Height > MaxSide || tex.Width < 4 || tex.Height < 4) { log($"  lighting: {name} {tex.Width}x{tex.Height} skipped"); continue; }
            var size = tex.CalculateBufferSizeForMipLevel(0);
            if (size <= 0 || (total += size) > MaxBytes) { log($"  lighting: {name} too large"); return false; }
            var data = new byte[size];
            tex.ReadTextureMipLevel(data, 0); // the top mip's GPU blocks, as stored
            Directory.CreateDirectory(outDir);
            File.WriteAllBytes(SafePath.OutFile(outDir, $"{name}.bin"), data);
            textures[name] = new JsonObject
            {
                ["file"] = $"{name}.bin", ["format"] = fmt, ["width"] = tex.Width, ["height"] = tex.Height, ["bytes"] = size,
                ["hdr"] = tex.IsHighDynamicRange,
            };
            log($"  lighting: {name} {tex.Format} {tex.Width}x{tex.Height} ({size / 1024 / 1024.0:0.0} MB)");
        }
        if (!textures.ContainsKey("irradiance")) return false;
        json["textures"] = textures;
        Directory.CreateDirectory(outDir);
        File.WriteAllText(SafePath.OutFile(outDir, "lighting.json"), json.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        return true;
    }
}
