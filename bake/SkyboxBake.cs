// The 3D skybox: a CS2 map's skybox_reference (targetmapname maps/<x>.vmap) loads a second world into the same entity
// system (its own spawn group), drawn behind everything through its sky_camera: a skybox point P is seen from
// skyOrigin + eye / scale, so it lands on the main world at scale * (P - skyOrigin) (sky_camera's `scale`, 16),
// whatever the eye. The main map's I/O reaches its entities by name (ze_rush_b's relays Enable / Skin its tube).
//
//   skybox.json   { "worlds": [{ "map": "<x>", "reference": <skybox_reference kv>, "camera": { "origin": [x,y,z], "scale": 16 },
//                                "lumps": { "<lump>": [{ kv, io }] } }] }
//
// The skybox world's own vpk sits beside the map's in a workshop item (maps/<x>.vpk); its models are exported with
// the map's entity models (models/<path>.glb, manifest renderModels). Its world geometry isn't exported yet.
using System.Globalization;
using System.Text.Json.Nodes;
using SteamDatabase.ValvePak;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;

namespace Lasers.Bake;

static class SkyboxBake
{
    public const string IndexFile = "skybox.json";

    // lumps: the main map's lumps (entities.json). walk(loader, lumpName, into, models, visited) is the Baker's WalkLump.
    // Adds the skybox worlds' packages to the loader and their entity models to `models`. Returns the worlds written.
    public static int Write(Package outer, GameFileLoader loader, JsonObject lumps, ISet<string> models, string outDir,
        Action<GameFileLoader, string, JsonObject, ISet<string>, HashSet<string>> walk, Action<string> log)
    {
        var worlds = new JsonArray();
        var vpks = outer.Entries.TryGetValue("vpk", out var v) ? v : [];
        foreach (var refKv in References(lumps))
        {
            var target = refKv["targetmapname"]?.GetValue<string>() ?? "";
            var name = Path.GetFileNameWithoutExtension(target.Replace('\\', '/'));
            if (!SafePath.IsMapName(name)) { log($"  skybox: target refused: {SafePath.Describe(target)}"); continue; }
            var entry = vpks.FirstOrDefault(e => e.DirectoryName == "maps" && e.FileName.Equals(name, StringComparison.OrdinalIgnoreCase));
            if (entry != null)
            {
                outer.ReadEntry(entry, out var bytes);
                var pak = new Package();
                pak.SetFileName(entry.GetFullPath());
                pak.Read(new MemoryStream(bytes));
                loader.AddPackageToSearch(pak);
            }
            var worldRes = loader.LoadFile($"maps/{name}/world.vwrld_c");
            if (worldRes?.DataBlock is not World world) { log($"  skybox: no world for {name}"); continue; }
            var skyLumps = new JsonObject();
            var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var lumpName in world.GetEntityLumpNames())
                if (lumpName != null) walk(loader, lumpName, skyLumps, models, visited);
            var camera = Camera(skyLumps);
            worlds.Add(new JsonObject
            {
                ["map"] = name,
                ["reference"] = refKv.DeepClone(),
                ["camera"] = camera,
                ["lumps"] = skyLumps,
            });
            log($"skybox: {name}, {skyLumps.Count} lumps{(camera == null ? ", no sky_camera" : "")}");
        }
        var file = Path.Combine(outDir, IndexFile);
        if (worlds.Count > 0) File.WriteAllText(file, new JsonObject { ["worlds"] = worlds }.ToJsonString());
        else if (File.Exists(file)) File.Delete(file);
        return worlds.Count;
    }

    static IEnumerable<JsonObject> References(JsonObject lumps)
    {
        foreach (var (_, arr) in lumps)
            foreach (var d in arr?.AsArray() ?? [])
                if (d?["kv"] is JsonObject kv && string.Equals(kv["classname"]?.GetValue<string>(), "skybox_reference", StringComparison.OrdinalIgnoreCase))
                    yield return kv;
    }

    // the skybox world's sky_camera: its origin and scale
    static JsonObject? Camera(JsonObject lumps)
    {
        foreach (var (_, arr) in lumps)
            foreach (var d in arr?.AsArray() ?? [])
            {
                if (d?["kv"] is not JsonObject kv || !string.Equals(kv["classname"]?.GetValue<string>(), "sky_camera", StringComparison.OrdinalIgnoreCase)) continue;
                var o = (kv["origin"]?.GetValue<string>() ?? "0 0 0").Split(' ', StringSplitOptions.RemoveEmptyEntries)
                    .Select(s => double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var f) ? f : 0).ToArray();
                var scale = double.TryParse(kv["scale"]?.GetValue<string>(), NumberStyles.Float, CultureInfo.InvariantCulture, out var sc) && sc > 0 ? sc : 16;
                return new JsonObject { ["origin"] = new JsonArray(o.Length > 0 ? o[0] : 0, o.Length > 1 ? o[1] : 0, o.Length > 2 ? o[2] : 0), ["scale"] = scale };
            }
        return null;
    }
}
