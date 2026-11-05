// Put back the cut-out alpha VRF 20.1's glTF exporter drops: a material whose CS2 vmat is alpha-tested
// (F_ALPHA_TEST, e.g. ze_mist_p's tree leaves: csgo_vertexlitgeneric, g_flAlphaTestReference 0.5) or translucent
// comes out with alphaMode MASK / BLEND but an RGB-only base colour PNG, so every leaf card draws solid. The alpha
// is in the vmat's g_tColor texture (CS2 reads opacity from its alpha): this re-reads that vtex and writes its alpha
// into the exported PNG, keeping VRF's RGB as it is (resized to the PNG's size).
//
//   lasers-bake --alpha <workshop.vpk> <web/public/maps/<name>> [--cs2 <game/csgo>]   (the full bake does it too)
//
// Image paths come from the glbs (written by the bake) and stay inside the map folder (SafePath); texture paths come
// from the glb's vmat extras and are only looked up in the loader. Decoded sizes are capped.
using System.Text;
using System.Text.Json.Nodes;
using SkiaSharp;
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;

namespace Lasers.Bake;

static class AlphaBake
{
    const int MaxSide = 8192;

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
        var done = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int fixedCount = 0, glbs = 0;
        foreach (var glb in Directory.EnumerateFiles(mapDir, "*.glb", SearchOption.AllDirectories))
        {
            JsonNode? json;
            try { json = ReadGltfJson(glb); } catch (Exception e) { log($"  alpha: {Path.GetFileName(glb)}: {e.Message}"); continue; }
            if (json == null) continue;
            glbs++;
            var dir = Path.GetDirectoryName(glb)!;
            var images = json["images"]?.AsArray();
            var textures = json["textures"]?.AsArray();
            foreach (var mat in json["materials"]?.AsArray() ?? [])
            {
                var vmat = mat?["extras"]?["vmat"];
                var ints = vmat?["IntParams"];
                var cut = (ints?["F_ALPHA_TEST"]?.GetValue<int>() ?? 0) != 0 || (ints?["F_TRANSLUCENT"]?.GetValue<int>() ?? 0) != 0;
                if (!cut) continue;
                var colorTex = vmat?["TextureParams"]?["g_tColor"]?.GetValue<string>();
                var texIndex = mat?["pbrMetallicRoughness"]?["baseColorTexture"]?["index"]?.GetValue<int>();
                if (colorTex == null || texIndex is not int ti || textures == null || ti < 0 || ti >= textures.Count) continue;
                var src = textures[ti]?["source"]?.GetValue<int>();
                if (src is not int si || images == null || si < 0 || si >= images.Count) continue;
                var uri = images[si]?["uri"]?.GetValue<string>();
                var png = uri == null ? null : SafePath.Under(dir, Uri.UnescapeDataString(uri));
                if (png == null || !png.EndsWith(".png", StringComparison.OrdinalIgnoreCase) || !File.Exists(png) || !done.Add(png)) continue;
                try { if (AddAlpha(loader, png, colorTex)) fixedCount++; }
                catch (Exception e) { log($"  alpha: {Path.GetFileName(png)}: {e.Message}"); }
            }
        }
        log($"alpha: {fixedCount} cut-out textures given their alpha back ({glbs} glbs)");
    }

    // the PNG has no alpha and the CS2 colour texture does: merge
    static bool AddAlpha(GameFileLoader loader, string png, string colorTex)
    {
        using (var codec = SKCodec.Create(png))
        {
            if (codec == null) return false;
            if (codec.Info.AlphaType != SKAlphaType.Opaque && codec.Info.ColorType != SKColorType.Rgb888x) return false; // already has alpha
            if (codec.Info.Width > MaxSide || codec.Info.Height > MaxSide) return false;
        }
        var path = colorTex.EndsWith("_c", StringComparison.OrdinalIgnoreCase) ? colorTex : colorTex + "_c";
        using var res = loader.LoadFile(path);
        if (res?.DataBlock is not Texture tex || tex.Width > MaxSide || tex.Height > MaxSide) return false;
        using var alphaSrc = tex.GenerateBitmap();
        using var rgb = SKBitmap.Decode(png);
        if (rgb == null) return false;
        // the alpha at the PNG's size
        using var alpha = alphaSrc.Width == rgb.Width && alphaSrc.Height == rgb.Height ? alphaSrc.Copy(SKColorType.Rgba8888)
            : alphaSrc.Resize(new SKImageInfo(rgb.Width, rgb.Height, SKColorType.Rgba8888, SKAlphaType.Unpremul), new SKSamplingOptions(SKCubicResampler.Mitchell));
        if (alpha == null) return false;
        var outBmp = new SKBitmap(new SKImageInfo(rgb.Width, rgb.Height, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        var opaque = true;
        for (var y = 0; y < rgb.Height; y++)
            for (var x = 0; x < rgb.Width; x++)
            {
                var c = rgb.GetPixel(x, y);
                var a = alpha.GetPixel(x, y).Alpha;
                if (a < 255) opaque = false;
                outBmp.SetPixel(x, y, c.WithAlpha(a));
            }
        if (opaque) { outBmp.Dispose(); return false; } // nothing to cut
        using (outBmp)
        using (var img = SKImage.FromBitmap(outBmp))
        using (var data = img.Encode(SKEncodedImageFormat.Png, 100))
            File.WriteAllBytes(png, data.ToArray());
        return true;
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
