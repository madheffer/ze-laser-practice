// surfaces.json: CS2's surface properties (surfaceproperties/*.vsurf_c: the stock packs', then the map's own) as the
// player needs them for sound, and which surface each breakable prop model is made of.
//
//   { "surfaces": { "<m_nameHash>": { "name", "bulletImpact"?, "break"?, "impactHard"?, "impactSoft"? } },
//     "models": { "<model path, lower case>": "<m_nameHash>" } }
//
// A surface's audiosounds inherit along m_baseNameHash where it leaves one out. Hashes are the ones the physics data
// carries (PhysAggregateData.SurfacePropertyHashes, collision_fx_surfaces.bin per world triangle). A model's surface:
// its m_modelInfo.m_sSurfaceProperty when set, else its physics' first surface (UNSETTLED: which of several surfaces
// CS2's prop break sound reads). Returns the sound names the map can play this way (SoundBake adds them to the table).
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.Serialization.KeyValues;
using ValveKeyValue;

namespace Lasers.Bake;

static class SurfaceBake
{
    const int MaxModels = 4000;
    static readonly (string kv, string json)[] Sounds = [("bulletimpact", "bulletImpact"), ("break", "break"), ("impacthard", "impactHard"), ("impactsoft", "impactSoft")];

    // Physics: the entry's "physics" block (density, friction, elasticity, thickness, ...), for RubikonBake
    internal sealed record Surf(string Name, uint Hash, uint Base, Dictionary<string, string> Audio, KVObject? Physics);

    // Every surface property by m_nameHash: the stock packs', then the map's own (which win)
    internal static Dictionary<uint, Surf> Load(IEnumerable<Package> mapPackages, IEnumerable<string> stockPaks)
    {
        var byHash = new Dictionary<uint, Surf>();
        foreach (var path in stockPaks) { var p = new Package(); p.Read(path); Read(p, byHash); }
        foreach (var p in mapPackages.Distinct()) Read(p, byHash);
        return byHash;
    }

    public static SortedSet<string> Write(GameFileLoader loader, IEnumerable<Package> mapPackages, IEnumerable<string> stockPaks, string outDir)
    {
        var names = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var byHash = Load(mapPackages, stockPaks);
        if (byHash.Count == 0) { Console.WriteLine("surfaces: no surfaceproperties found"); return names; }
        var byName = byHash.Values.GroupBy(s => s.Name, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First().Hash, StringComparer.OrdinalIgnoreCase);

        string? Resolve(uint hash, string key)
        {
            for (var guard = 0; guard < 16 && byHash.TryGetValue(hash, out var s); guard++)
            {
                if (s.Audio.TryGetValue(key, out var v)) return v;
                if (s.Base == 0 || s.Base == hash) break;
                hash = s.Base;
            }
            return null;
        }
        var surfaces = new JsonObject();
        foreach (var s in byHash.Values.OrderBy(s => s.Name, StringComparer.Ordinal))
        {
            var o = new JsonObject { ["name"] = s.Name };
            foreach (var (kv, json) in Sounds) if (Resolve(s.Hash, kv) is { Length: > 0 } v) o[json] = v;
            surfaces[s.Hash.ToString(CultureInfo.InvariantCulture)] = o;
        }

        // world triangles: their surfaces' bullet impacts
        var used = new HashSet<uint>();
        var triFile = Path.Combine(outDir, "collision_fx_surfaces.bin");
        if (File.Exists(triFile))
        {
            var b = File.ReadAllBytes(triFile);
            for (var i = 0; i + 4 <= b.Length; i += 4) used.Add(BitConverter.ToUInt32(b, i));
        }
        foreach (var h in used) if (Resolve(h, "bulletimpact") is { Length: > 0 } n) names.Add(n);

        // breakable props' models: their surface's break sound
        var models = new JsonObject();
        foreach (var m in PropModels(outDir).Take(MaxModels))
        {
            try
            {
                if (loader.LoadFileCompiled(m)?.DataBlock is not Model model) continue;
                uint hash = 0;
                var sp = model.Data.GetSubCollection("m_modelInfo")?.GetStringProperty("m_sSurfaceProperty");
                if (!string.IsNullOrEmpty(sp) && byName.TryGetValue(sp, out var hn)) hash = hn;
                else if (model.GetEmbeddedPhys() is { } phys && phys.SurfacePropertyHashes is { Length: > 0 } hs) hash = hs[0];
                if (hash == 0) continue;
                models[m.ToLowerInvariant()] = hash.ToString(CultureInfo.InvariantCulture);
                if (Resolve(hash, "break") is { Length: > 0 } br) names.Add(br);
            }
            catch (Exception e) { Console.WriteLine($"surfaces: {SafePath.Describe(m)}: {e.Message}"); }
        }
        File.WriteAllText(Path.Combine(outDir, "surfaces.json"), new JsonObject { ["surfaces"] = surfaces, ["models"] = models }.ToJsonString());
        Console.WriteLine($"surfaces: {byHash.Count} surface properties, {used.Count} on the world's triangles, {models.Count} prop models; sounds: {string.Join(", ", names.Take(30))}");
        return names;
    }

    static void Read(Package pkg, Dictionary<uint, Surf> into)
    {
        if (!pkg.Entries.TryGetValue("vsurf_c", out var entries)) return;
        foreach (var e in entries)
        {
            try
            {
                pkg.ReadEntry(e, out var bytes);
                using var res = new Resource { FileName = e.GetFullPath() };
                res.Read(new MemoryStream(bytes));
                var data = res.DataBlock switch { BinaryKV3 b => b.Data, KeyValuesOrNTRO k => k.Data, _ => null };
                if (data == null || !data.TryGetValue("SurfacePropertiesList", out var list) || !list.IsArray) continue;
                foreach (var (_, s) in list.Children)
                {
                    if (!s.IsCollection || !s.TryGetValue("surfacePropertyName", out var n) || !s.TryGetValue("m_nameHash", out var h)) continue;
                    var audio = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    if (s.TryGetValue("audiosounds", out var a) && a.IsCollection)
                        foreach (var (k, v) in a.Children)
                            if (k != null && v.ValueType == KVValueType.String) audio[k] = v.ToString(CultureInfo.InvariantCulture);
                    var hash = Convert.ToUInt32(h.ToInt64(CultureInfo.InvariantCulture) & 0xffffffff);
                    var bse = s.TryGetValue("m_baseNameHash", out var bh) ? Convert.ToUInt32(bh.ToInt64(CultureInfo.InvariantCulture) & 0xffffffff) : 0u;
                    var physics = s.TryGetValue("physics", out var ph) && ph.IsCollection ? ph : null;
                    into[hash] = new Surf(n.ToString(CultureInfo.InvariantCulture), hash, bse, audio, physics);
                }
            }
            catch (Exception ex) { Console.WriteLine($"surfaces: {e.GetFullPath()}: {ex.Message}"); }
        }
    }

    // models of the props a map can break (prop_dynamic / prop_physics and their overrides), from entities.json
    static IEnumerable<string> PropModels(string outDir)
    {
        var set = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var f = Path.Combine(outDir, "entities.json");
        if (!File.Exists(f)) return set;
        using var doc = JsonDocument.Parse(File.ReadAllBytes(f));
        if (!doc.RootElement.TryGetProperty("lumps", out var lumps) || lumps.ValueKind != JsonValueKind.Object) return set;
        foreach (var lump in lumps.EnumerateObject())
        {
            if (lump.Value.ValueKind != JsonValueKind.Array) continue;
            foreach (var e in lump.Value.EnumerateArray())
            {
                if (!e.TryGetProperty("kv", out var kv) || kv.ValueKind != JsonValueKind.Object) continue;
                var cls = kv.TryGetProperty("classname", out var c) ? c.GetString() ?? "" : "";
                if (!cls.StartsWith("prop_dynamic", StringComparison.Ordinal) && !cls.StartsWith("prop_physics", StringComparison.Ordinal)) continue;
                if (kv.TryGetProperty("model", out var m) && m.GetString() is { Length: > 0 and < 260 } model && SafePath.Rel(model) != null) set.Add(model);
            }
        }
        return set;
    }
}
