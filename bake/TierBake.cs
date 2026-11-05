// Medium / low quality copies of a baked map, for slower or older PCs and faster loading (the browser's Quality
// setting; Auto picks low on a GPU without BC6H/BC7, e.g. phones). High is the map folder as baked.
//   tier     textures  lightmaps (decoded, RGBM PNG)  reflections            sky (RGBM PNG faces)
//   medium   512 px    2048 px                       cubemaps <= 64 px      512 px
//   low      256 px    1024 px                       none                   256 px
// -> <map>/q/<tier>/tex/<world|models/...>.png (the glbs' textures, same names; the loader redirects them)
//    <map>/q/<tier>/lighting/ (lighting.json + PNGs; post / probes copied; medium: the cubemaps' small mips)
// Lightmaps and skies are decoded from the workshop VPK (VRF) and box-filtered; RGBM: rgb x a x range, linear.
//
//   lasers-bake --tiers <workshop.vpk> <web/public/maps/<name>>   (after --lighting and --sky)
using System.Text.Json;
using System.Text.Json.Nodes;
using SkiaSharp;
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.ResourceTypes;

namespace Lasers.Bake;

static class TierBake
{
    record Tier(string Name, int Texture, int Lightmap, int Cube, int Sky);
    static readonly Tier[] Tiers = [new("medium", 512, 2048, 64, 512), new("low", 256, 1024, 0, 256)];
    const float RgbmRange = 16f; // irradiance / sky values above this clip (CS2 lightmaps sit well under it)

    public static int Run(string vpk, string mapDir)
    {
        var high = Path.Combine(mapDir, "lighting", "lighting.json");
        if (!File.Exists(high)) { Console.Error.WriteLine("run --lighting (and --sky) first"); return 1; }
        var mapName = Path.GetFileName(mapDir.TrimEnd('/', '\\'));
        if (!SafePath.IsMapName(mapName)) return 1;
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
        Resource? Load(string path)
        {
            foreach (var pak in paks)
                if (pak.FindEntry(path) is { } entry) { pak.ReadEntry(entry, out var b); var r = new Resource { FileName = path }; r.Read(new MemoryStream(b)); return r; }
            return null;
        }
        var hiJson = JsonNode.Parse(File.ReadAllText(high))!.AsObject();
        foreach (var tier in Tiers)
        {
            var root = Path.Combine(mapDir, "q", tier.Name);
            Console.WriteLine($"tier {tier.Name}");
            Textures(mapDir, Path.Combine(root, "tex"), tier.Texture);
            Lighting(Load, mapName, mapDir, hiJson, Path.Combine(root, "lighting"), tier);
        }
        return 0;
    }

    // every PNG beside the glbs (world/, models/), shrunk to the tier's size (alpha kept)
    static void Textures(string mapDir, string outRoot, int max)
    {
        int n = 0;
        foreach (var sub in new[] { "world", "models" })
        {
            var dir = Path.Combine(mapDir, sub);
            if (!Directory.Exists(dir)) continue;
            foreach (var png in Directory.EnumerateFiles(dir, "*.png", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(mapDir, png);
                var dst = SafePath.OutFile(outRoot, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(dst)!);
                using var src = SKBitmap.Decode(png);
                if (src == null) continue;
                if (src.Width <= max && src.Height <= max) { File.Copy(png, dst, true); n++; continue; }
                var s = (float)max / Math.Max(src.Width, src.Height);
                using var small = src.Resize(new SKImageInfo(Math.Max(1, (int)(src.Width * s)), Math.Max(1, (int)(src.Height * s)), src.ColorType, src.AlphaType), new SKSamplingOptions(SKCubicResampler.Mitchell));
                Save(small, dst);
                n++;
            }
        }
        Console.WriteLine($"  textures: {n} at <= {max} px");
    }

    static void Lighting(Func<string, Resource?> load, string mapName, string mapDir, JsonObject hi, string outDir, Tier tier)
    {
        Directory.CreateDirectory(outDir);
        var json = new JsonObject
        {
            ["map"] = mapName, ["version"] = DateTime.UtcNow.ToString("yyyyMMddHHmmss"), ["tier"] = tier.Name,
            ["lightmapVersion"] = hi["lightmapVersion"]?.DeepClone(), ["lightmapGameVersion"] = hi["lightmapGameVersion"]?.DeepClone(), ["uvScale"] = hi["uvScale"]?.DeepClone(),
        };
        var textures = new JsonObject();
        foreach (var name in new[] { "irradiance", "directional_irradiance", "direct_light_shadows" })
        {
            using var res = load($"maps/{mapName}/lightmaps/{name}.vtex_c");
            if (res?.DataBlock is not Texture tex) continue;
            using var bmp = tex.GenerateBitmap();
            var hdr = name == "irradiance";
            using var small = Downsample(bmp, tier.Lightmap, hdr);
            Save(small, Path.Combine(outDir, $"{name}.png"));
            textures[name] = new JsonObject { ["file"] = $"{name}.png", ["format"] = hdr ? "rgbm" : "png", ["range"] = hdr ? RgbmRange : null, ["width"] = small.Width, ["height"] = small.Height };
        }
        json["textures"] = textures;
        Console.WriteLine($"  lightmaps: {textures.Count} at <= {tier.Lightmap} px");

        // small, so copied as they are: the post-processing and the probes
        foreach (var sub in new[] { "post", "probes" })
        {
            var src = Path.Combine(mapDir, "lighting", sub);
            if (!Directory.Exists(src)) continue;
            Directory.CreateDirectory(Path.Combine(outDir, sub));
            foreach (var f in Directory.EnumerateFiles(src)) File.Copy(f, Path.Combine(outDir, sub, Path.GetFileName(f)), true);
        }
        if (hi["post"] is { } post) json["post"] = post.DeepClone();
        if (hi["probes"] is { } probes) json["probes"] = probes.DeepClone();

        // reflections: the high bake's cubemap mips at or under the tier's size (the bytes as they are)
        if (tier.Cube > 0 && hi["cubemaps"] is JsonObject cm && cm["mips"] is JsonArray mips)
        {
            var bin = File.ReadAllBytes(Path.Combine(mapDir, "lighting", "cubemaps.bin"));
            var keep = mips.Select(m => m!.AsObject()).Where(m => m["width"]!.GetValue<int>() <= tier.Cube).ToList();
            if (keep.Count > 0)
            {
                using var ms = new MemoryStream();
                var outMips = new JsonArray();
                foreach (var m in keep)
                {
                    var off = m["offset"]!.GetValue<long>(); var len = m["bytes"]!.GetValue<int>();
                    outMips.Add(new JsonObject { ["offset"] = ms.Length, ["bytes"] = len, ["width"] = m["width"]!.DeepClone(), ["height"] = m["height"]!.DeepClone() });
                    ms.Write(bin, (int)off, len);
                }
                File.WriteAllBytes(Path.Combine(outDir, "cubemaps.bin"), ms.ToArray());
                var c = cm.DeepClone().AsObject();
                c["mips"] = outMips;
                c["width"] = keep[0]["width"]!.DeepClone(); c["height"] = keep[0]["height"]!.DeepClone();
                c["skippedMips"] = (c["skippedMips"]?.GetValue<int>() ?? 0) + (mips.Count - keep.Count);
                json["cubemaps"] = c;
            }
        }

        // skies: each face decoded, linear, box-filtered, RGBM PNG (works on any GPU)
        var skies = new JsonObject();
        if (hi["skies"] is JsonObject hiSkies)
            foreach (var (key, v) in hiSkies)
            {
                var hiSky = JsonNode.Parse(File.ReadAllText(Path.Combine(mapDir, "lighting", v!["file"]!.GetValue<string>())))!.AsObject();
                using var matRes = load(key + "_c");
                if (matRes?.DataBlock is not Material mat || !mat.TextureParams.TryGetValue("g_tSkyTexture", out var texPath)) continue;
                using var texRes = load(texPath.EndsWith("_c") ? texPath : texPath + "_c");
                if (texRes?.DataBlock is not Texture tex || !tex.Flags.HasFlag(VTexFlags.CUBE_TEXTURE)) continue;
                var hash = Path.GetFileNameWithoutExtension(v["file"]!.GetValue<string>());
                Directory.CreateDirectory(Path.Combine(outDir, "sky"));
                var faces = new JsonArray();
                for (var f = 0; f < 6; f++)
                {
                    using var face = tex.GenerateBitmap(depth: 0, face: (Texture.CubemapFace)f, mipLevel: 0);
                    using var small = Downsample(face, tier.Sky, true, srgb: !tex.IsHighDynamicRange);
                    var file = $"sky/{hash}_{f}.png";
                    Save(small, Path.Combine(outDir, file));
                    faces.Add(file);
                }
                var d = new JsonObject { ["format"] = "rgbm-faces", ["range"] = RgbmRange, ["faces"] = faces, ["size"] = Math.Min(tier.Sky, tex.Width), ["cube"] = true,
                    ["ints"] = hiSky["ints"]?.DeepClone(), ["floats"] = hiSky["floats"]?.DeepClone() };
                File.WriteAllText(Path.Combine(outDir, $"sky/{hash}.json"), d.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
                skies[key] = new JsonObject { ["file"] = $"sky/{hash}.json" };
            }
        json["skies"] = skies;
        File.WriteAllText(Path.Combine(outDir, "lighting.json"), json.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }

    // box-filter a decoded bitmap to <= max on its longer side; hdr: float -> RGBM (linear); srgb: decode first
    static SKBitmap Downsample(SKBitmap src, int max, bool rgbm, bool srgb = false)
    {
        var step = Math.Max(1, (int)Math.Ceiling(Math.Max(src.Width, src.Height) / (double)max));
        int w = Math.Max(1, src.Width / step), h = Math.Max(1, src.Height / step);
        var dst = new SKBitmap(new SKImageInfo(w, h, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        var f32 = src.ColorType == SKColorType.RgbaF32;
        var px = src.GetPixelSpan();
        var floats = f32 ? System.Runtime.InteropServices.MemoryMarshal.Cast<byte, float>(px) : default;
        var bgra = src.ColorType == SKColorType.Bgra8888;
        Span<double> acc = stackalloc double[4];
        for (var y = 0; y < h; y++)
            for (var x = 0; x < w; x++)
            {
                acc.Clear();
                for (var j = 0; j < step; j++)
                    for (var i = 0; i < step; i++)
                    {
                        var idx = ((y * step + j) * src.Width + x * step + i) * 4;
                        for (var c = 0; c < 4; c++)
                        {
                            double v = f32 ? floats[idx + c] : px[bgra && c < 3 ? idx + 2 - c : idx + c] / 255.0;
                            if (srgb && c < 3) v = v <= 0.04045 ? v / 12.92 : Math.Pow((v + 0.055) / 1.055, 2.4);
                            acc[c] += double.IsFinite(v) ? v : 0;
                        }
                    }
                var n = step * step;
                byte r, g, b, a;
                if (rgbm)
                {
                    double R = acc[0] / n, G = acc[1] / n, B = acc[2] / n;
                    var m = Math.Clamp(Math.Max(R, Math.Max(G, B)) / RgbmRange, 1 / 255.0, 1);
                    m = Math.Ceiling(m * 255) / 255;
                    var k = 1 / (m * RgbmRange);
                    r = (byte)Math.Clamp(Math.Round(R * k * 255), 0, 255); g = (byte)Math.Clamp(Math.Round(G * k * 255), 0, 255); b = (byte)Math.Clamp(Math.Round(B * k * 255), 0, 255); a = (byte)Math.Round(m * 255);
                }
                else { r = (byte)Math.Round(acc[0] / n * 255); g = (byte)Math.Round(acc[1] / n * 255); b = (byte)Math.Round(acc[2] / n * 255); a = (byte)Math.Round(acc[3] / n * 255); }
                dst.SetPixel(x, y, new SKColor(r, g, b, a));
            }
        return dst;
    }

    static void Save(SKBitmap bmp, string path)
    {
        using var img = SKImage.FromBitmap(bmp);
        using var data = img.Encode(SKEncodedImageFormat.Png, 100);
        File.WriteAllBytes(path, data.ToArray());
    }
}
