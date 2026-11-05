// Entity models with their skeleton and animation sequences, for prop_dynamic animation (web/src/world/anim.js and
// web/src/world/entities/classes/props.js).
//
// A model with at least one real sequence (more than one frame) is exported with VRF's glTF animations: one glTF
// animation per sequence, named as the vmdl names it (westersand's dragon: maas_niisama, holjuk, lendamine, ...).
// animations.json beside manifest.json lists each such model's sequences in the vmdl's own order (CS2 falls back to
// sequence 0 when SetAnimation names an unknown one), with what the server needs to time OnAnimationDone without
// three.js: { "<model.vmdl>": [{ name, duration, loop, fadeIn, fadeOut }] }. A model without one stays as it was
// (no skeleton, a plain mesh). Everything else in the map folder is untouched.
//
//   lasers-bake --models <workshop.vpk> <web/public/maps/<name>> [--cs2 <game/csgo>]   (the full bake does it too)
//
// Model paths come from manifest.json (the bake wrote them, SafePath-checked) and go through SafePath again; the
// re-export goes to a scratch folder inside the map folder first, then only the glb is moved over the old one, so
// the PNGs the full bake resized and AlphaBake fixed stay as they are (new ones are resized like the bake's).
using System.Text.Json;
using System.Text.Json.Nodes;
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.ResourceTypes.ModelAnimation;

namespace Lasers.Bake;

static class ModelBake
{
    public const string IndexFile = "animations.json";
    const int MaxSequences = 512; // a model's sequence list is data: far above any real prop

    public static int Run(string vpk, string mapDir, string? cs2)
    {
        var manifestPath = Path.Combine(mapDir, "manifest.json");
        if (!File.Exists(manifestPath)) { Console.Error.WriteLine($"not a baked map folder: {mapDir}"); return 1; }
        var manifest = JsonNode.Parse(File.ReadAllText(manifestPath))!.AsObject();
        var models = (manifest["renderModels"]?.AsArray() ?? []).Select(n => n?.GetValue<string>()).OfType<string>().ToList();

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
        if (cs2 != null && File.Exists(Path.Combine(cs2, "pak01_dir.vpk"))) loader.AddPackageToSearch(Path.Combine(cs2, "pak01_dir.vpk"));

        var scratch = SafePath.Under(mapDir, ".models_tmp") ?? throw new InvalidDataException("scratch folder");
        var index = new JsonObject();
        try
        {
            var exporter = Exporter(loader, textures: true);
            foreach (var m in models)
            {
                var res = loader.LoadFileCompiled(m);
                if (res?.DataBlock is not Model model) continue;
                var seqs = Sequences(loader, model, out var animated);
                if (seqs == null) continue;
                index[m] = seqs; // a static model's sequences too: CS2 still finds them (OnAnimationBegun, sequence 0)
                if (!animated) continue;
                try
                {
                    if (Directory.Exists(scratch)) Directory.Delete(scratch, true);
                    var tmp = SafePath.OutFile(scratch, "models/" + Path.ChangeExtension(m, ".glb"));
                    Export(exporter, res, tmp, seqs);
                    var target = SafePath.OutFile(mapDir, "models/" + Path.ChangeExtension(m, ".glb"));
                    File.Copy(tmp, target, true);
                    // textures the old export did not have: moved over and capped like the full bake's
                    foreach (var png in Directory.EnumerateFiles(Path.GetDirectoryName(tmp)!, "*.png"))
                    {
                        var dest = Path.Combine(Path.GetDirectoryName(target)!, Path.GetFileName(png));
                        if (File.Exists(dest)) continue;
                        File.Copy(png, dest);
                        Baker.ResizePng(dest, Baker.MaxTexture);
                    }
                    Console.WriteLine($"  {m}: {seqs.Count} sequences, {new FileInfo(target).Length / 1024} KB");
                }
                catch (Exception e) { Console.WriteLine($"  model {m}: {e.Message}"); }
            }
        }
        finally { if (Directory.Exists(scratch)) Directory.Delete(scratch, true); }

        File.WriteAllText(Path.Combine(mapDir, IndexFile), index.ToJsonString());
        manifest["animations"] = IndexFile;
        // the glbs changed: a new version so browsers do not keep the old ones (everything is fetched as ?v=<version>)
        manifest["version"] = DateTime.UtcNow.ToString("yyyyMMddHHmmss");
        File.WriteAllText(manifestPath, manifest.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine($"models: {index.Count} models with sequences -> {IndexFile}");
        return 0;
    }

    /// The exporter for animated entity models: the full bake's settings plus the skeleton and every sequence.
    public static GltfModelExporter Exporter(IFileLoader loader, bool textures) => new(loader)
    {
        ProgressReporter = new Progress<string>(_ => { }),
        ExportMaterials = textures,
        ExportAnimations = true,
        AdaptTextures = true,
        SatelliteImages = true,
        ExportExtras = true,
    };

    /// Export one animated model: only the sequences Sequences() listed (the filter is the exporter's, set per model).
    public static void Export(GltfModelExporter exporter, Resource res, string target, JsonArray seqs)
    {
        exporter.AnimationFilter.Clear();
        foreach (var s in seqs) if (s?["name"]?.GetValue<string>() is { } n) exporter.AnimationFilter.Add(n);
        exporter.Export(res, target);
    }

    /// The model's sequences in its own order (null without any); animated = one of them moves (only then is the glb
    /// exported with its skeleton and clips; a static prop stays a plain mesh, as before). duration = one playback cycle in seconds (VRF CycleDuration, the period a looping
    /// sequence wraps at); loop = the sequence's own looping flag (CS2 ANIM_LOOP_MODE_USE_SEQUENCE_SETTINGS reads
    /// it); fadeIn / fadeOut = the sequence's blend times.
    public static JsonArray? Sequences(IFileLoader loader, Model model, out bool animated)
    {
        animated = false;
        List<Animation> anims;
        try { anims = [.. model.GetAllAnimations(loader).Take(MaxSequences)]; }
        catch { return null; }
        if (anims.Count == 0) return null;
        animated = anims.Any(a => a.FrameCount > 1);
        // ModelDoc models list each sequence again as "@name" / "@name_<i>" (the clips under them): the map names the
        // sequences (westersand: maas_niisama, not @maas_niisama), so the clips are dropped when real sequences exist.
        // UNSETTLED: CS2's own sequence index order (the fallback is sequence 0) assumed to be the sequences' order here
        if (anims.Any(a => !a.Name.StartsWith('@'))) anims = [.. anims.Where(a => !a.Name.StartsWith('@'))];
        var arr = new JsonArray();
        foreach (var a in anims)
        {
            var seq = a as SequenceAnimation;
            var o = new JsonObject
            {
                ["name"] = a.Name,
                ["duration"] = Math.Round(a.CycleDuration, 5),
                ["loop"] = seq?.IsLooping ?? false,
            };
            if (seq?.SequenceParams is { } sp)
            {
                o["fadeIn"] = Math.Round(sp.FadeInTime, 4);
                o["fadeOut"] = Math.Round(sp.FadeOutTime, 4);
            }
            arr.Add(o);
        }
        return arr;
    }
}
