// Scan a local workshop library for laser maps, without baking them: per item, read only the map's entity lumps and
// count the shapes laser stages are built from.
//
//   lasers-bake --scan <steamapps/workshop/content/730> <out.json>
//
// Per map: laserTemplates = template lumps holding a trigger_hurt AND a mover (func_door / func_movelinear /
// func_tracktrain / func_rotating): every laser wave we've traced (mist, westersand, deadcore) is one of these;
// laserNamed = entities whose name contains "laser"; hurts = trigger_hurts in templates; bosses = breakables /
// physboxes / math_counters named like a boss. A score ranks them; tools/library.mjs turns the JSON into a table.
// Read-only: nothing is written except <out.json>.
using System.Text.Json;
using System.Text.Json.Nodes;
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.Serialization.KeyValues;
using ValveKeyValue;
using VEntityLump = ValveResourceFormat.ResourceTypes.EntityLump;

namespace Lasers.Bake;

static class LibraryScan
{
    static readonly string[] Movers = ["func_door", "func_movelinear", "func_tracktrain", "func_rotating", "func_door_rotating"];

    public static int Run(string root, string outFile)
    {
        var results = new JsonArray();
        foreach (var item in Directory.EnumerateDirectories(root).OrderBy(d => d))
        {
            var vpk = Directory.EnumerateFiles(item, "*.vpk").FirstOrDefault(f => f.EndsWith("_dir.vpk", StringComparison.OrdinalIgnoreCase))
                   ?? Directory.EnumerateFiles(item, "*.vpk").FirstOrDefault(f => !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(f), @"_\d{3}\.vpk$"));
            if (vpk == null) continue;
            try { var r = ScanOne(vpk); if (r != null) { r["item"] = Path.GetFileName(item); results.Add(r); Console.WriteLine($"{r["map"]}: score {r["score"]}"); } }
            catch (Exception ex) { Console.WriteLine($"{Path.GetFileName(item)}: {ex.Message}"); }
        }
        File.WriteAllText(outFile, results.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine($"{results.Count} maps -> {outFile}");
        return 0;
    }

    static JsonObject? ScanOne(string vpkPath)
    {
        var outer = new Package();
        outer.Read(vpkPath);
        var paks = new List<Package> { outer };
        string? mapName = null;
        if (outer.Entries.TryGetValue("vpk", out var vpks))
            foreach (var e in vpks.Where(e => e.DirectoryName == "maps" && !e.FileName.EndsWith("_skybox", StringComparison.OrdinalIgnoreCase)))
            {
                outer.ReadEntry(e, out var bytes);
                var inner = new Package();
                inner.SetFileName(e.GetFullPath());
                inner.Read(new MemoryStream(bytes));
                paks.Add(inner);
                mapName ??= e.FileName;
            }
        var lumps = new Dictionary<string, List<Dictionary<string, string>>>(StringComparer.OrdinalIgnoreCase);
        foreach (var pak in paks)
        {
            if (!pak.Entries.TryGetValue("vents_c", out var ents)) continue;
            foreach (var e in ents)
            {
                pak.ReadEntry(e, out var bytes);
                using var res = new Resource { FileName = e.GetFullPath() };
                res.Read(new MemoryStream(bytes));
                if (res.DataBlock is not VEntityLump lump) continue;
                var key = string.IsNullOrEmpty(lump.Name) ? Path.GetFileNameWithoutExtension(e.FileName) : lump.Name;
                var list = new List<Dictionary<string, string>>();
                foreach (var ent in lump.GetEntities())
                {
                    var kv = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var p in new[] { "classname", "targetname", "entitylumpname", "damage" })
                        if (ent.GetStringProperty(p) is { Length: > 0 } v) kv[p] = v;
                    list.Add(kv);
                }
                lumps[key] = list;
                if (mapName == null && e.DirectoryName?.StartsWith("maps/") == true) mapName = e.DirectoryName.Split('/')[1];
            }
        }
        if (lumps.Count == 0) return null;
        var templateLumps = new HashSet<string>(lumps.Values.SelectMany(l => l)
            .Where(k => k.GetValueOrDefault("classname") == "point_template" && k.ContainsKey("entitylumpname"))
            .Select(k => k["entitylumpname"]), StringComparer.OrdinalIgnoreCase);
        int laserTemplates = 0, hurts = 0, laserNamed = 0, bosses = 0, heals = 0;
        foreach (var (name, list) in lumps)
        {
            var cls = list.Select(k => k.GetValueOrDefault("classname") ?? "").ToList();
            if (templateLumps.Contains(name))
            {
                var h = cls.Count(c => c == "trigger_hurt");
                hurts += h;
                if (h > 0 && cls.Any(c => Movers.Contains(c))) laserTemplates++;
            }
            foreach (var k in list)
            {
                var tn = k.GetValueOrDefault("targetname") ?? "";
                var c = k.GetValueOrDefault("classname") ?? "";
                if (tn.Contains("laser", StringComparison.OrdinalIgnoreCase)) laserNamed++;
                if ((c is "func_breakable" or "func_physbox" or "math_counter") && tn.Contains("boss", StringComparison.OrdinalIgnoreCase)) bosses++;
                if (c == "trigger_hurt" && double.TryParse(k.GetValueOrDefault("damage"), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d) && d < 0) heals++;
            }
        }
        return new JsonObject
        {
            ["map"] = mapName ?? Path.GetFileNameWithoutExtension(vpkPath),
            ["score"] = laserTemplates * 3 + Math.Min(laserNamed, 60) + Math.Min(bosses, 20),
            ["laserTemplates"] = laserTemplates, ["laserNamed"] = laserNamed, ["templateHurts"] = hurts,
            ["bosses"] = bosses, ["healHurts"] = heals, ["lumps"] = lumps.Count,
        };
    }
}
