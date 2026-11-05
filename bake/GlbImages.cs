using System.Text;
using System.Text.Json.Nodes;

namespace Lasers.Bake;

// VRF's GltfModelExporter keeps one texture cache across Export calls: an image two exports share (a packed ORM map
// like default_ao_tga_*_orm_*.png) can be written beside only one of the glbs, while every glb names it by a URI
// relative to itself. ze__hell_p's world glb named its ORM map and the file landed in models/ only, so the world's
// loaders (the browser, tools/chunk-world.mjs) failed on it. After the exports, put each missing image beside the glb
// that names it, copied from wherever the bake wrote a file of that name.
static class GlbImages
{
    public static void FillMissing(string outDir, Action<string> log)
    {
        var byName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var png in Directory.EnumerateFiles(outDir, "*.png", SearchOption.AllDirectories))
            byName.TryAdd(Path.GetFileName(png), png);
        var copied = 0;
        foreach (var glb in Directory.EnumerateFiles(outDir, "*.glb", SearchOption.AllDirectories))
        {
            var dir = Path.GetDirectoryName(glb)!;
            foreach (var uri in ImageUris(glb))
            {
                // a URI is a bare file name beside the glb (SatelliteImages); anything else isn't ours to place
                if (uri.Length == 0 || uri != Path.GetFileName(uri) || uri.Contains("..")) continue;
                var want = SafePath.OutFile(dir, uri);
                if (File.Exists(want) || !byName.TryGetValue(uri, out var from)) continue;
                File.Copy(from, want);
                copied++;
            }
        }
        if (copied > 0) log($"textures: {copied} shared image(s) copied beside the glbs that name them");
    }

    static IEnumerable<string> ImageUris(string glb)
    {
        JsonNode? json;
        try
        {
            using var f = File.OpenRead(glb);
            var head = new byte[20];
            if (f.Read(head, 0, 20) != 20 || BitConverter.ToUInt32(head, 0) != 0x46546C67) yield break; // "glTF"
            var len = (int)BitConverter.ToUInt32(head, 12);
            if (len <= 0 || len > 64 << 20) yield break;
            var buf = new byte[len];
            f.ReadExactly(buf, 0, len);
            json = JsonNode.Parse(Encoding.UTF8.GetString(buf));
        }
        catch { yield break; }
        if (json?["images"] is not JsonArray images) yield break;
        foreach (var img in images)
            if (img?["uri"]?.GetValue<string>() is { } uri) yield return Uri.UnescapeDataString(uri);
    }
}
