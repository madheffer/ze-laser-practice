// A model's skins (its material groups): CS2's Skin input / `skin` keyvalue swaps every material of the default group
// for the same slot of another group. VRF's glTF exporter writes the default group only, so this writes the rest:
//
//   skins.json   { "<model path>": { "groups": [[vmat, ...], ...],                 // group 0 = what the glb has
//                                    "materials": { "<vmat>": { "vmat": {...},     // Name / ShaderName / params, the glb's extras shape
//                                                               "textures": { "g_tColor": "skins/<file>.webp", ... } } } } }
//
// Textures as WebP q80 (the quality tiers' setting: a skin is fetched only when the map switches to it, and a flipbook
// fetches every frame). Only models with more than one group, only the materials the glb doesn't already carry (groups 1..n), only the
// texture slots the web's materials read (colour, self-illum mask, normal). ze_rush_b's 3D-skybox tube
// (models/s2_models/sky_matrix.vmdl) is a 27-frame flipbook of skins the map steps through every 0.04 s.
// Paths written are SafePath'd under the map folder; texture paths from a vmat are only looked up in the loader.
using System.Text.Json.Nodes;
using SkiaSharp;
using ValveResourceFormat;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;

namespace Lasers.Bake;

static class SkinBake
{
    public const string IndexFile = "skins.json";
    const int MaxSide = 1024;
    static readonly string[] Slots = ["g_tColor", "g_tSelfIllumMask", "g_tNormal"];

    // models: the exported entity models (model path -> its Model). Returns the number of skinned models written.
    public static int Write(GameFileLoader loader, IEnumerable<(string Path, Model Model)> models, string outDir, Action<string> log)
    {
        var index = new JsonObject();
        // written fresh each bake: a skin texture the map no longer names isn't left behind
        var skinsDir = SafePath.OutFile(outDir, "models/skins");
        if (Directory.Exists(skinsDir)) Directory.Delete(skinsDir, recursive: true);
        var pngs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); // vtex -> written file (shared)
        foreach (var (path, model) in models)
        {
            var groups = model.GetMaterialGroups().ToList();
            if (groups.Count < 2) continue;
            var gArr = new JsonArray();
            foreach (var g in groups) gArr.Add(new JsonArray([.. g.Materials.Select(m => (JsonNode)Norm(m)!)]));
            var first = new HashSet<string>(groups[0].Materials.Select(Norm), StringComparer.OrdinalIgnoreCase);
            var mats = new JsonObject();
            foreach (var vmat in groups.Skip(1).SelectMany(g => g.Materials).Select(Norm).Distinct(StringComparer.OrdinalIgnoreCase))
            {
                if (first.Contains(vmat) || mats.ContainsKey(vmat)) continue;
                using var res = loader.LoadFileCompiled(vmat);
                if (res?.DataBlock is not Material mat) { log($"  skins: {SafePath.Describe(vmat)} not found"); continue; }
                var tex = new JsonObject();
                foreach (var slot in Slots)
                {
                    if (!mat.TextureParams.TryGetValue(slot, out var vtex) || string.IsNullOrEmpty(vtex)) continue;
                    var file = Png(loader, vtex, outDir, pngs, log);
                    if (file != null) tex[slot] = file;
                }
                mats[vmat] = new JsonObject
                {
                    ["vmat"] = new JsonObject
                    {
                        ["Name"] = mat.Name,
                        ["ShaderName"] = mat.ShaderName,
                        ["IntParams"] = Obj(mat.IntParams.Select(p => (p.Key, (JsonNode?)p.Value))),
                        ["FloatParams"] = Obj(mat.FloatParams.Select(p => (p.Key, (JsonNode?)p.Value))),
                        ["VectorParams"] = Obj(mat.VectorParams.Select(p => (p.Key, (JsonNode?)new JsonArray(p.Value.X, p.Value.Y, p.Value.Z, p.Value.W)))),
                    },
                    ["textures"] = tex,
                };
            }
            index[path] = new JsonObject { ["groups"] = gArr, ["materials"] = mats };
        }
        File.WriteAllText(Path.Combine(outDir, IndexFile), index.ToJsonString());
        if (index.Count > 0) log($"skins: {index.Count} models with skins, {pngs.Count} textures");
        return index.Count;
    }

    static string Norm(string vmat) => vmat.Replace('\\', '/').ToLowerInvariant().TrimEnd('_', 'c') is var s && s.EndsWith(".vmat") ? s : vmat.Replace('\\', '/').ToLowerInvariant();

    static JsonObject Obj(IEnumerable<(string Key, JsonNode? Value)> kv)
    {
        var o = new JsonObject();
        foreach (var (k, v) in kv) o[k] = v;
        return o;
    }

    // a vtex as skins/<name>.webp (<= MaxSide), once per texture; null if it can't be read
    static string? Png(GameFileLoader loader, string vtex, string outDir, Dictionary<string, string> done, Action<string> log)
    {
        if (done.TryGetValue(vtex, out var have)) return have;
        var name = Path.GetFileNameWithoutExtension(vtex.Replace('\\', '/')).ToLowerInvariant();
        if (SafePath.Rel($"models/skins/{name}.webp") is not { } rel) return null;
        try
        {
            using var res = loader.LoadFileCompiled(vtex);
            if (res?.DataBlock is not Texture tex || tex.Width > 8192 || tex.Height > 8192) return null;
            using var bmp = tex.GenerateBitmap();
            var scale = Math.Min(1f, MaxSide / (float)Math.Max(bmp.Width, bmp.Height));
            using var sized = scale < 1 ? bmp.Resize(new SKImageInfo((int)(bmp.Width * scale), (int)(bmp.Height * scale)), new SKSamplingOptions(SKCubicResampler.Mitchell)) : null;
            using var img = SKImage.FromBitmap(sized ?? bmp);
            using var data = img.Encode(SKEncodedImageFormat.Webp, 80);
            var target = SafePath.OutFile(outDir, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.WriteAllBytes(target, data.ToArray());
            var url = rel["models/".Length..];
            done[vtex] = url;
            return url;
        }
        catch (Exception e) { log($"  skins: {SafePath.Describe(vtex)}: {e.Message}"); return null; }
    }
}
