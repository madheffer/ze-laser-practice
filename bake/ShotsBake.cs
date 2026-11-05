// The map's own loading-screen screenshots (panorama/images/map_icons/screenshots/1080p/*.vtex_c, which every
// workshop map ships for CS2's map picker) -> <map folder>/shots/1.jpg, 2.jpg, ... for the site's home page hero.
//
//   lasers-bake --shots <workshop.vpk> <web/public/maps/<name>>   (the full bake writes them too)
//
// Entry names come from the VPK (attacker-controlled), so they are never used in an output path: files are
// numbered in name order. Decoded sizes are capped before anything is allocated.
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.ResourceTypes;

namespace Lasers.Bake;

static class ShotsBake
{
    const string Dir = "panorama/images/map_icons/screenshots/1080p";
    const int MaxShots = 8;
    const int Width = 1280; // the hero shows them at most ~half a 4K screen wide, dimmed
    const int MaxSide = 8192;

    public static int Run(string vpk, string mapDir)
    {
        if (!File.Exists(Path.Combine(mapDir, "manifest.json"))) { Console.Error.WriteLine($"not a baked map folder: {mapDir}"); return 1; }
        var pak = new Package();
        pak.Read(vpk);
        Write(pak, mapDir, Console.WriteLine);
        return 0;
    }

    public static int Write(Package pak, string mapDir, Action<string> log)
    {
        var entries = pak.Entries.TryGetValue("vtex_c", out var list)
            ? list.Where(e => string.Equals(e.DirectoryName, Dir, StringComparison.OrdinalIgnoreCase))
                  .OrderBy(e => e.FileName, StringComparer.OrdinalIgnoreCase).Take(MaxShots * 2).ToList()
            : [];
        var outDir = Path.Combine(mapDir, "shots");
        if (Directory.Exists(outDir)) foreach (var old in Directory.EnumerateFiles(outDir, "*.jpg")) File.Delete(old);
        var n = 0;
        var seen = new HashSet<string>(); // some maps ship the same screenshot twice
        foreach (var e in entries)
        {
            if (n >= MaxShots) break;
            try
            {
                pak.ReadEntry(e, out var bytes);
                if (!seen.Add(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)))) continue;
                using var res = new Resource { FileName = e.GetFullPath() };
                res.Read(new MemoryStream(bytes));
                if (res.DataBlock is not Texture tex) continue;
                if (tex.Width > MaxSide || tex.Height > MaxSide || tex.Width < 16 || tex.Height < 16) { log($"  shot {e.FileName}: {tex.Width}x{tex.Height} skipped"); continue; }
                using var bmp = tex.GenerateBitmap();
                var w = Math.Min(Width, bmp.Width);
                var h = Math.Max(1, (int)Math.Round(bmp.Height * (double)w / bmp.Width));
                using var small = bmp.Resize(new SkiaSharp.SKImageInfo(w, h, SkiaSharp.SKColorType.Rgba8888, SkiaSharp.SKAlphaType.Opaque),
                    new SkiaSharp.SKSamplingOptions(SkiaSharp.SKCubicResampler.Mitchell));
                using var img = SkiaSharp.SKImage.FromBitmap(small);
                using var data = img.Encode(SkiaSharp.SKEncodedImageFormat.Jpeg, 82);
                Directory.CreateDirectory(outDir);
                File.WriteAllBytes(SafePath.OutFile(mapDir, $"shots/{++n}.jpg"), data.ToArray());
            }
            catch (Exception ex) { log($"  shot {e.FileName}: {ex.Message}"); }
        }
        log($"shots: {n} screenshots -> {outDir}");
        return n;
    }
}
