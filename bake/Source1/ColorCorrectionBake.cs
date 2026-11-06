// A Source 1 map's color_correction lookups -> correction/<name>.raw + correction/correction.json, which the player
// blends into its post pass (web/src/world/color-correction-source1.js):
//   correction.json   { "<filename as the entity names it, lower case>": { "file": "<name>.raw", "dim": 32 } }
// The .raw is Source's own lookup, copied byte for byte: dim^3 RGB8, red fastest, then green, then blue (the order
// colorcorrectionmgr loads it in), applied to the frame's gamma-space colour. Names are the map's data: files are
// written under cleaned names, and only a file of exactly dim^3 x 3 bytes (dim 2-64) is kept.
using System.Text.Json.Nodes;

namespace Lasers.Bake.Source1;

static class ColorCorrectionBake
{
    const int MaxFiles = 64;

    public static int Bake(JsonObject lumps, GameFiles files, string outDir, Action<string> log)
    {
        var names = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (_, arr) in lumps)
            foreach (var d in arr?.AsArray() ?? [])
                if (d?["kv"] is JsonObject kv && string.Equals(kv["classname"]?.GetValue<string>(), "color_correction", StringComparison.OrdinalIgnoreCase)
                    && kv["filename"]?.GetValue<string>() is { Length: > 0 } f && names.Count < MaxFiles)
                    names.Add(GameFiles.Norm(f));
        var dir = Path.Combine(outDir, "correction");
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        var index = new JsonObject();
        foreach (var name in names)
        {
            if (files.Read(name) is not { } raw) { log($"  correction {name}: missing"); continue; }
            var dim = (int)Math.Round(Math.Cbrt(raw.Length / 3.0));
            if (dim < 2 || dim > 64 || dim * dim * dim * 3 != raw.Length) { log($"  correction {name}: {raw.Length} bytes is no lookup"); continue; }
            var file = new string(Path.GetFileNameWithoutExtension(name).Select(c => char.IsAsciiLetterOrDigit(c) ? c : '_').ToArray()) + ".raw";
            var rel = SafePath.Rel("correction/" + file);
            if (rel == null) continue;
            File.WriteAllBytes(SafePath.OutFile(outDir, rel), raw);
            index[name] = new JsonObject { ["file"] = file, ["dim"] = dim };
        }
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "correction.json"), index.ToJsonString());
        log($"correction: {index.Count} of {names.Count}");
        return index.Count;
    }
}
