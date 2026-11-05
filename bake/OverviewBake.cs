// The map's own CS2 radar, for the in-game minimap (web/src/ui/radar.js):
//   resource/overviews/<map>.txt                  pos_x / pos_y / scale (+ verticalsections: altitude bands)
//   panorama/images/overheadmaps/<map>[_N]_radar  the radar image(s): one per vertical section
// -> <map folder>/overview/overview.json + radar.png / radar_<N>.png
//
//   lasers-bake --overview <workshop.vpk> <web/public/maps/<name>>   (the full bake writes it too)
//
// Entry names come from the VPK (attacker-controlled): only a sanitised section suffix (letters / digits, 16 max)
// reaches an output name, through SafePath. Decoded sizes are capped before anything is allocated.
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.ResourceTypes;

namespace Lasers.Bake;

static class OverviewBake
{
    const string ImageDir = "panorama/images/overheadmaps";
    const string TextDir = "resource/overviews";
    const int MaxSide = 4096;
    const int OutSide = 1024; // CS2 radars are 1024 x 1024

    public static int Run(string vpk, string mapDir)
    {
        if (!File.Exists(Path.Combine(mapDir, "manifest.json"))) { Console.Error.WriteLine($"not a baked map folder: {mapDir}"); return 1; }
        var outer = new Package();
        outer.Read(vpk);
        var paks = new List<Package> { outer };
        // the map's own vpk inside a workshop vpk carries files too
        if (outer.Entries.TryGetValue("vpk", out var vpks))
            foreach (var e in vpks.Where(e => e.DirectoryName == "maps"))
            {
                outer.ReadEntry(e, out var bytes);
                var inner = new Package();
                inner.SetFileName(e.GetFullPath());
                inner.Read(new MemoryStream(bytes));
                paks.Add(inner);
            }
        Write(paks, Path.GetFileName(mapDir.TrimEnd('/', '\\')), mapDir, Console.WriteLine);
        return 0;
    }

    public static void Write(IEnumerable<Package> paks, string mapName, string mapDir, Action<string> log)
    {
        var outDir = Path.Combine(mapDir, "overview");
        var json = new JsonObject();
        var images = new JsonObject();
        foreach (var pak in paks)
        {
            if (pak.Entries.TryGetValue("txt", out var txts))
                foreach (var e in txts.Where(e => string.Equals(e.DirectoryName, TextDir, StringComparison.OrdinalIgnoreCase)
                                                 && string.Equals(e.FileName, mapName, StringComparison.OrdinalIgnoreCase)))
                {
                    pak.ReadEntry(e, out var bytes);
                    if (bytes.Length > 65536) continue;
                    ParseOverview(System.Text.Encoding.UTF8.GetString(bytes), json);
                }
            if (!pak.Entries.TryGetValue("vtex_c", out var texs)) continue;
            var re = new Regex("^" + Regex.Escape(mapName) + "(?:_([a-z0-9]{1,16}))?_radar(?:_(?:psd|tga|png))?$", RegexOptions.IgnoreCase);
            foreach (var e in texs.Where(e => string.Equals(e.DirectoryName, ImageDir, StringComparison.OrdinalIgnoreCase)))
            {
                var m = re.Match(e.FileName);
                if (!m.Success) continue;
                var section = m.Groups[1].Success ? m.Groups[1].Value.ToLowerInvariant() : "";
                if (images.ContainsKey(section)) continue;
                try
                {
                    pak.ReadEntry(e, out var bytes);
                    using var res = new Resource { FileName = e.GetFullPath() };
                    res.Read(new MemoryStream(bytes));
                    if (res.DataBlock is not Texture tex) continue;
                    if (tex.Width > MaxSide || tex.Height > MaxSide || tex.Width < 16 || tex.Height < 16) { log($"  radar {e.FileName}: {tex.Width}x{tex.Height} skipped"); continue; }
                    using var bmp = tex.GenerateBitmap();
                    using var sized = bmp.Width == OutSide ? bmp.Copy() : bmp.Resize(new SkiaSharp.SKImageInfo(OutSide, OutSide, SkiaSharp.SKColorType.Rgba8888, SkiaSharp.SKAlphaType.Unpremul),
                        new SkiaSharp.SKSamplingOptions(SkiaSharp.SKCubicResampler.Mitchell));
                    using var img = SkiaSharp.SKImage.FromBitmap(sized);
                    using var data = img.Encode(SkiaSharp.SKEncodedImageFormat.Png, 100);
                    var name = section == "" ? "radar.png" : $"radar_{section}.png";
                    Directory.CreateDirectory(outDir);
                    File.WriteAllBytes(SafePath.OutFile(mapDir, $"overview/{name}"), data.ToArray());
                    images[section] = name;
                }
                catch (Exception ex) { log($"  radar {e.FileName}: {ex.Message}"); }
            }
        }
        if (images.Count == 0)
        {
            var seen = paks.SelectMany(p => p.Entries.Values.SelectMany(l => l)).Where(e => string.Equals(e.DirectoryName, ImageDir, StringComparison.OrdinalIgnoreCase) || string.Equals(e.DirectoryName, TextDir, StringComparison.OrdinalIgnoreCase)).Select(e => SafePath.Describe(e.GetFullPath())).Take(12);
            log($"overview: no radar image ({string.Join(", ", seen)})");
            return;
        }
        json["images"] = images;
        Directory.CreateDirectory(outDir);
        File.WriteAllText(SafePath.OutFile(mapDir, "overview/overview.json"), json.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        log($"overview: {images.Count} radar image(s), pos {json["pos_x"]} {json["pos_y"]} scale {json["scale"]}");
    }

    // The overview .txt is KeyValues1: "map" { "pos_x" "-1234" "pos_y" "5678" "scale" "7.0" "verticalsections" { "1" {
    // "AltitudeMin" "-100" "AltitudeMax" "200" } } }. A tiny tokenizer: quoted / bare strings and braces, depth-tracked.
    static void ParseOverview(string text, JsonObject into)
    {
        var tokens = Regex.Matches(text, "\"([^\"]*)\"|([{}])|([^\\s{}\"]+)").Select(m => m.Groups[1].Success ? m.Groups[1].Value : m.Value).ToList();
        var stack = new Stack<string>();
        JsonArray? sections = null;
        JsonObject? cur = null;
        for (var i = 0; i < tokens.Count; i++)
        {
            var t = tokens[i];
            if (t == "}") { if (stack.Count > 0) stack.Pop(); cur = null; continue; }
            if (i + 1 < tokens.Count && tokens[i + 1] == "{") { stack.Push(t.ToLowerInvariant()); i++; if (stack.Count == 3 && stack.ElementAt(1) == "verticalsections") { cur = new JsonObject { ["name"] = t }; (sections ??= []).Add(cur); } continue; }
            if (i + 1 >= tokens.Count) break;
            var key = t.ToLowerInvariant();
            var val = tokens[++i];
            if (stack.Count == 1 && key is "pos_x" or "pos_y" or "scale" && double.TryParse(val, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d)) into[key] = d;
            else if (cur != null && key is "altitudemin" or "altitudemax" && double.TryParse(val, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var a)) cur[key == "altitudemin" ? "min" : "max"] = a;
        }
        if (sections != null) into["sections"] = sections;
    }
}
