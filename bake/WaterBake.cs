// CS2 water: the textures its shaders read that VRF 20.1's glTF exporter drops or flattens. The exporter keeps the
// vmat's parameters on the material (extras.vmat) but turns only a few slots into images: csgo_water_fancy.vfx's look
// comes from g_tWavesNormalHeight (RG = wave normal, B = height), g_tFoam, g_tDebris and g_tDebrisNormal, and
// csgo_water.vfx's from g_tNormal, an animated texture array (one frame per slice, played at
// g_flNormalMapAnimationTimePerFrame) of which the glTF keeps one slice. This decodes each of them, as the GPU sees it
// (raw channels, no colour conversion), to water/<name>.png (an array as its slices stacked top to bottom) and writes
// water/water.json: { "textures": { "<vtex path as the vmat names it>": "<file>.png" }, "frames": { "<vtex>": n } }
// (frames only for arrays). A slot CS2 reads as .wy (csgo_water g_tNormal) is written as (R, G) = (A, G), A = 1.
// web/src/world/water.js looks every water material's TextureParams up in it.
//
//   lasers-bake --water <workshop.vpk> <web/public/maps/<name>> [--cs2 <game/csgo>]   (the full bake does it too)
//
// vtex paths come from the glbs' vmat extras and are only looked up in the loader; output names are built from the
// file name alone ([a-z0-9_] only) and written under <map>/water/ (SafePath). Decoded sizes are capped.
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using SkiaSharp;
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;

namespace Lasers.Bake;

static partial class WaterBake
{
    const int MaxSide = 8192, OutSide = 1024, FrameSide = 512, MaxFrames = 64;
    // shader -> the texture slots it reads that the glb doesn't carry as they are
    static readonly Dictionary<string, string[]> Slots = new(StringComparer.OrdinalIgnoreCase)
    {
        ["csgo_water_fancy.vfx"] = ["g_tWavesNormalHeight", "g_tFoam", "g_tDebris", "g_tDebrisNormal"],
        ["csgo_water.vfx"] = ["g_tNormal"],
    };
    // slots CS2 reads as .wy (a two-channel normal in alpha + green): written as (R, G) = (A, G), A = 1, so the
    // browser never premultiplies the data away
    static readonly HashSet<string> Wy = new(StringComparer.Ordinal) { "g_tNormal" };

    [GeneratedRegex("[^a-z0-9_]")]
    private static partial Regex Unsafe();

    public static int Run(string vpk, string mapDir, string? cs2)
    {
        if (!File.Exists(Path.Combine(mapDir, "manifest.json"))) { Console.Error.WriteLine($"not a baked map folder: {mapDir}"); return 1; }
        var outer = new Package();
        outer.Read(vpk);
        Package map = outer;
        if (outer.Entries.TryGetValue("vpk", out var vpks) && vpks.FirstOrDefault(e => e.DirectoryName == "maps" && !e.FileName.EndsWith("_skybox", StringComparison.OrdinalIgnoreCase)) is { } inner)
        {
            outer.ReadEntry(inner, out var bytes);
            map = new Package();
            map.SetFileName(inner.GetFullPath());
            map.Read(new MemoryStream(bytes));
        }
        using var loader = new GameFileLoader(map, null);
        if (map != outer) loader.AddPackageToSearch(outer);
        if (cs2 != null) foreach (var pak in Program.StockPaks(cs2)) loader.AddPackageToSearch(pak);
        Write(loader, mapDir, Console.WriteLine);
        return 0;
    }

    public static void Write(GameFileLoader loader, string mapDir, Action<string> log)
    {
        // every water material's texture slots, across the world (and its chunks) and the entity models
        var wanted = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var wy = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var glb in Directory.EnumerateFiles(mapDir, "*.glb", SearchOption.AllDirectories))
        {
            JsonNode? json;
            try { json = ReadGltfJson(glb); } catch { continue; }
            foreach (var mat in json?["materials"]?.AsArray() ?? [])
            {
                var vmat = mat?["extras"]?["vmat"];
                if (vmat?["ShaderName"]?.GetValue<string>() is not { } shader || !Slots.TryGetValue(shader, out var slots)) continue;
                foreach (var slot in slots)
                    if (vmat?["TextureParams"]?[slot]?.GetValue<string>() is { Length: > 0 } t) { wanted.Add(t); if (Wy.Contains(slot)) wy.Add(t); }
            }
        }
        var waterDir = Path.Combine(mapDir, "water");
        if (wanted.Count == 0)
        {
            if (Directory.Exists(waterDir)) Directory.Delete(waterDir, true); // a rebake whose water went away
            log("water: no water materials");
            return;
        }
        Directory.CreateDirectory(waterDir);
        var map = new JsonObject();
        var frames = new JsonObject();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var vtex in wanted)
        {
            try
            {
                var path = vtex.EndsWith("_c", StringComparison.OrdinalIgnoreCase) ? vtex : vtex + "_c";
                using var res = loader.LoadFile(path);
                if (res?.DataBlock is not Texture tex || tex.Width > MaxSide || tex.Height > MaxSide) { log($"  water: {SafePath.Describe(vtex)} missing"); continue; }
                var stem = Unsafe().Replace(Path.GetFileNameWithoutExtension(vtex).ToLowerInvariant(), "_");
                if (stem.Length == 0 || stem.Length > 100) stem = "tex";
                var name = stem + ".png";
                for (var i = 2; !names.Add(name); i++) name = $"{stem}_{i}.png";
                var depth = Math.Clamp((int)tex.Depth, 1, MaxFrames);
                var swizzle = wy.Contains(vtex);
                using var outBmp = depth > 1 ? Strip(tex, depth, swizzle) : Decode(tex, 0, OutSide, swizzle);
                using var img = SKImage.FromBitmap(outBmp);
                using var data = img.Encode(SKEncodedImageFormat.Png, 100);
                File.WriteAllBytes(SafePath.OutFile(waterDir, name), data.ToArray());
                map[vtex] = name;
                if (depth > 1) frames[vtex] = depth;
                log($"  water: {vtex} ({tex.Format} {tex.Width}x{tex.Height}{(depth > 1 ? $" x{depth} frames" : "")}) -> water/{name}");
            }
            catch (Exception e) { log($"  water: {SafePath.Describe(vtex)}: {e.Message}"); }
        }
        File.WriteAllText(Path.Combine(waterDir, "water.json"), new JsonObject { ["textures"] = map, ["frames"] = frames }.ToJsonString());
        log($"water: {map.Count} textures");
    }

    // a texture array's slices, each at most FrameSide px, stacked top to bottom (slice 0 on top)
    static SKBitmap Strip(Texture tex, int depth, bool wy)
    {
        SKBitmap? strip = null;
        for (var z = 0; z < depth; z++)
        {
            using var frame = Decode(tex, z, FrameSide, wy);
            strip ??= new SKBitmap(new SKImageInfo(frame.Width, frame.Height * depth, SKColorType.Rgba8888, SKAlphaType.Unpremul));
            for (var y = 0; y < frame.Height; y++)
                for (var x = 0; x < frame.Width; x++)
                    strip.SetPixel(x, z * frame.Height + y, frame.GetPixel(x, y));
        }
        return strip!;
    }

    // One slice's four channels as data, at most `side` px. Each channel is a value, not a colour with coverage
    // (the waves texture's alpha is 0 while its RGB is the normal + height), so colour and alpha are resized apart:
    // a premultiplied resize or encode would wipe RGB wherever alpha is 0.
    static SKBitmap Decode(Texture tex, int slice, int side, bool wy)
    {
        using var bmp = tex.GenerateBitmap(depth: (uint)slice);
        int w = bmp.Width, h = bmp.Height;
        using var rgb = new SKBitmap(new SKImageInfo(w, h, SKColorType.Rgba8888, SKAlphaType.Opaque));
        using var alpha = new SKBitmap(new SKImageInfo(w, h, SKColorType.Rgba8888, SKAlphaType.Opaque));
        for (var y = 0; y < h; y++)
            for (var x = 0; x < w; x++)
            {
                var c = bmp.GetPixel(x, y);
                rgb.SetPixel(x, y, c.WithAlpha(255));
                alpha.SetPixel(x, y, new SKColor(c.Alpha, c.Alpha, c.Alpha, 255));
            }
        var scale = Math.Min(1f, (float)side / Math.Max(w, h));
        int ow = Math.Max(1, (int)(w * scale)), oh = Math.Max(1, (int)(h * scale));
        var sampling = new SKSamplingOptions(SKCubicResampler.Mitchell);
        using var rgbOut = scale < 1 ? rgb.Resize(new SKImageInfo(ow, oh, SKColorType.Rgba8888, SKAlphaType.Opaque), sampling) : rgb.Copy();
        using var alphaOut = scale < 1 ? alpha.Resize(new SKImageInfo(ow, oh, SKColorType.Rgba8888, SKAlphaType.Opaque), sampling) : alpha.Copy();
        var dst = new SKBitmap(new SKImageInfo(ow, oh, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        for (var y = 0; y < oh; y++)
            for (var x = 0; x < ow; x++)
            {
                var c = rgbOut.GetPixel(x, y);
                var a = alphaOut.GetPixel(x, y).Red;
                dst.SetPixel(x, y, wy ? new SKColor(a, c.Green, c.Blue, 255) : c.WithAlpha(a));
            }
        return dst;
    }

    // a .glb's JSON chunk
    static JsonNode? ReadGltfJson(string path)
    {
        using var fs = File.OpenRead(path);
        using var br = new BinaryReader(fs);
        if (br.ReadUInt32() != 0x46546C67) return null; // "glTF"
        br.ReadUInt32(); br.ReadUInt32();
        var len = br.ReadUInt32();
        if (br.ReadUInt32() != 0x4E4F534A || len > 64 * 1024 * 1024) return null; // "JSON"
        return JsonNode.Parse(Encoding.UTF8.GetString(br.ReadBytes((int)len)));
    }
}
