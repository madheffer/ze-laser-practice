// The sound event names a baked map plays that its own .vsndevts_c may not define: CS2's stock events (doors,
// breakables, explosions, ambience a map borrows). SoundBake.Map exports the ones the stock packs define next to
// the map's own, so the player finds them in maps/<map>/soundevents.json. Which names an entity plays is the
// player's rule (web/src/world/entities/sound.js, classes/fx.js); this list follows it:
//   - sound keys: ambient_generic / snd_event_point / point_soundevent message|soundname, func_door noise1/noise2/
//     startclosesound/closesound/locked_sound/unlocked_sound, func_movelinear + func_tracktrain startsound/stopsound/
//     movesound/movepingsound, func_button use_sound/locked_sound/unlocked_sound, env_explosion explosion_custom_sound;
//     plus the parameter of any SetSoundEvent / SetSoundName / SetSoundEventName input a connection sends
//   - func_breakable / func_physbox: the material's break (Die) and hit (DamageSound) events, server.dll's tables
//   - env_explosion without spawnflag 64 and no custom sound: its explosion type's m_SoundName from CS2's
//     scripts/explosion_types.vdata (read from the stock packs)
//   - particle systems already baked into fx/systems: C_OP_RenderSound m_pszSoundName
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.Serialization.KeyValues;
using ValveKeyValue;

namespace Lasers.Bake;

static partial class SoundRefs
{
    const int MaxNames = 4000;
    const int MaxFxFiles = 8000;

    static readonly HashSet<string> SoundKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "message", "soundname", "soundeventname", "noise1", "noise2", "startclosesound", "closesound",
        "locked_sound", "unlocked_sound", "startsound", "stopsound", "movesound", "movepingsound", "use_sound",
        "explosion_custom_sound",
    };
    static readonly HashSet<string> SoundClasses = new(StringComparer.OrdinalIgnoreCase)
    {
        "ambient_generic", "snd_event_point", "point_soundevent", "snd_event_alignedbox", "func_door", "func_door_rotating",
        "func_movelinear", "func_tracktrain", "func_tanktrain", "func_button", "env_explosion",
    };
    // server.dll FUN_180d8efa0 (Die) and FUN_180d8baf0 (DamageSound), by m_Material
    static readonly string?[] BreakByMaterial = ["Breakable.Glass", "Breakable.Crate", "Breakable.Metal", "Breakable.Flesh",
        "Breakable.Concrete", "Breakable.Ceiling", "Breakable.Computer", null, "Breakable.Concrete", "Breakable.Flesh"];
    static readonly string?[] ShardByMaterial = ["Breakable.MatGlass", "Breakable.MatWood", "Breakable.MatMetal", null,
        "Breakable.MatConcrete", null, "Breakable.Computer", "Breakable.MatGlass", "Breakable.MatConcrete", null];

    [GeneratedRegex("\"m_pszSoundName\"\\s*:\\s*\"([^\"]{1,200})\"")]
    private static partial Regex RenderSoundRe();

    /// Every sound event name the baked map folder's entities.json and fx/systems name.
    public static SortedSet<string> Collect(string mapDir, GameFileLoader loader)
    {
        var names = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        void Add(string? n) { if (!string.IsNullOrWhiteSpace(n) && n.Length <= 200 && names.Count < MaxNames) names.Add(n.Trim()); }
        var explosionTypes = ExplosionTypes(loader);

        var entsFile = Path.Combine(mapDir, "entities.json");
        if (File.Exists(entsFile))
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(entsFile));
            if (doc.RootElement.TryGetProperty("lumps", out var lumps) && lumps.ValueKind == JsonValueKind.Object)
                foreach (var lump in lumps.EnumerateObject())
                {
                    if (lump.Value.ValueKind != JsonValueKind.Array) continue;
                    foreach (var e in lump.Value.EnumerateArray()) Entity(e, Add, explosionTypes);
                }
        }
        var fx = Path.Combine(mapDir, "fx", "systems");
        if (Directory.Exists(fx))
            foreach (var f in Directory.EnumerateFiles(fx, "*.json", SearchOption.AllDirectories).Take(MaxFxFiles))
                foreach (Match m in RenderSoundRe().Matches(File.ReadAllText(f))) Add(m.Groups[1].Value);
        return names;
    }

    static void Entity(JsonElement e, Action<string?> add, Dictionary<string, string> explosionTypes)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty("kv", out var kv) || kv.ValueKind != JsonValueKind.Object) return;
        string Kv(string k) => kv.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        var cls = Kv("classname");
        if (SoundClasses.Contains(cls))
            foreach (var p in kv.EnumerateObject())
                if (SoundKeys.Contains(p.Name) && p.Value.ValueKind == JsonValueKind.String && !(p.Name == "message" && cls.StartsWith("func_", StringComparison.Ordinal)))
                    add(p.Value.GetString());
        if (cls is "func_breakable" or "func_physbox" or "func_physbox_multiplayer"
            && int.TryParse(Kv("material"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var mat) && mat >= 0 && mat < BreakByMaterial.Length)
        {
            add(BreakByMaterial[mat]);
            add(ShardByMaterial[mat]);
            if (mat == 6) add("Breakable.MatMetal");
        }
        var spawnflags = int.TryParse(Kv("spawnflags"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var sf) ? sf : 0;
        if (cls == "env_explosion" && Kv("explosion_custom_sound").Length == 0 && (spawnflags & 64) == 0)
        {
            var t = Kv("explosion_type");
            if (!explosionTypes.TryGetValue(t.Length > 0 ? t : "default", out var snd)) explosionTypes.TryGetValue("default", out snd);
            add(snd);
        }
        if (e.TryGetProperty("io", out var io) && io.ValueKind == JsonValueKind.Array)
            foreach (var c in io.EnumerateArray())
                if (c.ValueKind == JsonValueKind.Object && c.TryGetProperty("input", out var inp) && inp.GetString() is { } i
                    && i.StartsWith("SetSound", StringComparison.OrdinalIgnoreCase) && !i.Contains("guid", StringComparison.OrdinalIgnoreCase)
                    && c.TryGetProperty("param", out var par) && par.ValueKind == JsonValueKind.String)
                    add(par.GetString());
    }

    // CS2's scripts/explosion_types.vdata: type name -> m_SoundName
    static Dictionary<string, string> ExplosionTypes(GameFileLoader loader)
    {
        var o = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var res = loader.LoadFile("scripts/explosion_types.vdata_c");
            var data = res?.DataBlock switch { BinaryKV3 b => b.Data, KeyValuesOrNTRO k => k.Data, _ => null };
            if (data == null) { Console.WriteLine("sounds: no scripts/explosion_types.vdata_c in the stock packs"); return o; }
            foreach (var (name, v) in data.Children)
                if (name != null && v.IsCollection && v.TryGetValue("m_SoundName", out var s) && s.ValueType == KVValueType.String)
                    o[name] = s.ToString(CultureInfo.InvariantCulture).Replace("soundevent:", "");
        }
        catch (Exception ex) { Console.WriteLine($"sounds: explosion_types.vdata: {ex.Message}"); }
        return o;
    }
}
