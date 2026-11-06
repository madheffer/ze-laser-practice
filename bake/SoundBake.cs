// lasers-bake sounds (split out of Program.cs): the map's soundevents + the stock CS2 events its entities name.
using System.Globalization;
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Nodes;
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.Serialization.KeyValues;
using ValveKeyValue;
using VEntityLump = ValveResourceFormat.ResourceTypes.EntityLump;

namespace Lasers.Bake;

// ---------------------------------------------------------------------------------------------------------
// Sounds: soundevents (.vsndevts_c, KV3) -> a small soundevents.json the player reads, and every .vsnd_c an
// event names -> a browser-playable file. MP3 stays MP3; WAV is written as PCM16 WAV (Valve's MS-ADPCM
// waves are decoded here, since browsers only decode PCM WAV).
//
//   soundevents.json: { "<event>": { type, files: ["sounds/x.wav"], volume, pitch, pitchRandom?: [min, max],
//                       curve?: [[distance, volume], ...], delay?, local?, children?: [event], duration?,
//                       loop?: true, loopStart?: seconds, loopEnd?: seconds } }
//
// `curve` is the event's distance_volume_mapping_curve (Source units -> gain); `base` inheritance is resolved.
// `local` marks events that play on the listener (position_relative_to_player). Files are relative to the
// folder the json sits in. Voice management (csgo_mega's soundevent_limiter / soundevent_block operators, the player's
// audio/limits.js): instanceLimit, blockDuration, blockDistance, blockMatchEntity, blockMatching, when the event sets them.
//
// A map's table also carries the stock CS2 events its entities name (SoundRefs.cs) that its own files don't define,
// with their sounds under the map folder.
//
//   lasers-bake --sounds <workshop.vpk> <web/public/maps/<name>> [--cs2 <game/csgo>]: only soundevents.json + sounds/
//   for a map already baked (reads its entities.json and fx/); bumps manifest.json's version, every other key kept.
static class SoundBake
{
    static readonly JsonSerializerOptions Json = new() { WriteIndented = false };
    const int MaxSoundBytes = 64 << 20; // one sound file; CS2's longest music tracks are a few MB

    // The player's own sounds. Names are CS2's (pak01 soundevents/game_sounds_*.vsndevts_c).
    static readonly string[] StockFiles =
    [
        "soundevents/game_sounds_weapons.vsndevts_c",
        "soundevents/game_sounds_player.vsndevts_c",
        "soundevents/game_sounds_footsteps.vsndevts_c",
        "soundevents/game_sounds_ui.vsndevts_c",
        "soundevents/game_sounds_physics.vsndevts_c",
    ];
    static readonly string[] StockEvents =
    [
        "Weapon_Knife.Deploy", "Weapon_Knife.Slash", "Weapon_Knife.Stab", "Weapon_Knife.Hit", "Weapon_Knife.HitWall",
        "Weapon_AK47.Draw", "Weapon_AK47.Single", "Weapon_AK47.Clipout", "Weapon_AK47.Clipin", "Weapon_AK47.BoltPull",
        "Default.WalkJump", "CT_Concrete.StepLeft", "Land_Concrete.StepLeft", "CT_Default.StepLeft", "Land_Default.StepLeft",
        "Player.DamageBody.Victim", "Player.DamageFall", "Player.BurnDamage", "Player.Death",
        // the stage countdown's 3, 2, 1: Premier map pick/ban's last-seconds tick (panorama/scripts/popups/popup_premier_pick_ban)
        "UI.Premier.CounterTimer",
        // water (web/src/world/water-move.js): server.dll's jump-in-water swim stroke, enter / exit, the steps in water;
        // client.dll's loop with your eyes under (m_flWaterLevel 1) and the splash a knife or bullet makes on water
        "Player.Swim", "Player.Wade", "Water.PlayerEnter", "Water.PlayerExit", "CT_Water.StepLeft", "Land_WaterVol.StepLeft",
        "Player.AmbientUnderWater", "Physics.WaterSplash",
    ];

    /// The map's events (every vsndevts_c in its packages) + the stock events its entities name (outDir's
    /// entities.json / fx, SoundRefs.cs) from the stock packs. Returns the event count written.
    public static int Map(GameFileLoader loader, IEnumerable<Package> packages, string outDir, IEnumerable<string> stockPaks)
    {
        var raw = new Dictionary<string, KVObject>(StringComparer.OrdinalIgnoreCase);
        foreach (var pkg in packages.Distinct()) ReadAll(pkg, raw);
        var own = raw.Keys.ToList();
        // the stock definitions, under the map's own (a map's event of the same name wins)
        var stock = new Dictionary<string, KVObject>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in stockPaks)
        {
            var pkg = new Package();
            pkg.Read(path);
            ReadAll(pkg, stock);
        }
        var refs = SoundRefs.Collect(outDir, loader);
        // surfaces.json + the bullet-impact / prop-break sounds its surfaces name (SurfaceBake.cs)
        foreach (var n in SurfaceBake.Write(loader, packages, stockPaks, outDir)) refs.Add(n);
        var fromStock = refs.Where(n => !raw.ContainsKey(n) && stock.ContainsKey(n)).ToList();
        var unknown = refs.Where(n => !raw.ContainsKey(n) && !stock.ContainsKey(n)).ToList();
        foreach (var (k, v) in stock) raw.TryAdd(k, v);
        if (own.Count + fromStock.Count == 0) { Console.WriteLine("sounds: map ships no soundevents and names no stock ones"); return 0; }
        var (events, files, failed) = Export(loader, raw, [.. own, .. fromStock], outDir);
        File.WriteAllText(Path.Combine(outDir, "soundevents.json"), events.ToJsonString(Json));
        Console.WriteLine($"sounds: {events.Count} events ({own.Count} the map's, {fromStock.Count} stock it names: {string.Join(", ", fromStock.Take(40))}), {files} files exported, {failed.Count} failed{(failed.Count > 0 ? ": " + string.Join(", ", failed.Take(40)) : "")}");
        // names no table defines play nothing in CS2 either (soundsystem.dll: "Unable to find soundevent")
        if (unknown.Count > 0) Console.WriteLine($"sounds: {unknown.Count} names no table defines (silent in CS2 too): {string.Join(", ", unknown.Take(40))}{(unknown.Count > 40 ? " ..." : "")}");
        return events.Count;
    }

    static void ReadAll(Package pkg, Dictionary<string, KVObject> into)
    {
        if (!pkg.Entries.TryGetValue("vsndevts_c", out var entries)) return;
        foreach (var e in entries)
        {
            pkg.ReadEntry(e, out var bytes);
            ReadEvents(bytes, e.GetFullPath(), into);
        }
    }

    /// lasers-bake --sounds: re-export the sounds of a map folder already baked.
    public static int Run(string vpk, string mapDir, string? cs2)
    {
        var manifestPath = Path.Combine(mapDir, "manifest.json");
        if (!File.Exists(manifestPath) || !File.Exists(Path.Combine(mapDir, "entities.json"))) { Console.Error.WriteLine($"not a baked map folder: {mapDir}"); return 1; }
        if (cs2 == null) { Console.Error.WriteLine("no CS2 install found (--cs2 <game/csgo>)"); return 1; }
        var outer = new Package();
        outer.Read(vpk);
        var map = outer;
        if (outer.Entries.TryGetValue("vpk", out var vpks) && vpks.FirstOrDefault(e => e.DirectoryName == "maps" && !e.FileName.EndsWith("_skybox", StringComparison.OrdinalIgnoreCase)) is { } inner)
        {
            outer.ReadEntry(inner, out var bytes);
            map = new Package();
            map.SetFileName(inner.GetFullPath());
            map.Read(new MemoryStream(bytes));
        }
        using var loader = new GameFileLoader(map, null);
        if (map != outer) loader.AddPackageToSearch(outer);
        var stockPaks = Program.StockPaks(cs2).ToList();
        foreach (var pak in stockPaks) loader.AddPackageToSearch(pak);
        Map(loader, [map, outer], mapDir, stockPaks);
        // the version busts the browser cache of soundevents.json + sounds; every other key stays as it is
        var manifest = JsonNode.Parse(File.ReadAllText(manifestPath))!.AsObject();
        manifest["version"] = DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
        File.WriteAllText(manifestPath, manifest.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        return 0;
    }

    /// The shared stock set (knife, the buyable guns, footsteps, damage) -><outDir>/soundevents.json + sounds.
    public static void Stock(string pak01, string outDir)
    {
        var pkg = new Package();
        pkg.Read(pak01);
        using var loader = new GameFileLoader(pkg, null);
        var raw = new Dictionary<string, KVObject>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in StockFiles)
        {
            var entry = pkg.FindEntry(f);
            if (entry == null) { Console.WriteLine($"stock: {f} not in pak01"); continue; }
            pkg.ReadEntry(entry, out var bytes);
            ReadEvents(bytes, f, raw);
        }
        Directory.CreateDirectory(outDir);
        // plus every buyable gun's shot, draw and reload sounds (WeaponBake.cs)
        var wanted = StockEvents.Concat(WeaponBake.SoundNames(pkg)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var (events, files, failed) = Export(loader, raw, wanted, outDir);
        File.WriteAllText(Path.Combine(outDir, "soundevents.json"), events.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine($"stock sounds: {events.Count} events, {files} files -> {outDir}{(failed.Count > 0 ? "; failed: " + string.Join(", ", failed) : "")}");
    }

    static void ReadEvents(byte[] bytes, string name, Dictionary<string, KVObject> into)
    {
        using var res = new Resource { FileName = name };
        res.Read(new MemoryStream(bytes));
        var data = res.DataBlock switch
        {
            BinaryKV3 b => b.Data,
            KeyValuesOrNTRO k => k.Data,
            _ => null,
        };
        if (data == null) { Console.WriteLine($"sounds: {name}: not KV3"); return; }
        foreach (var (key, value) in data.Children)
        {
            if (key != null && value.IsCollection) into[key] = value;
        }
    }

    // Event fields with its base chain applied (the event's own fields win).
    static Dictionary<string, KVObject> Flatten(Dictionary<string, KVObject> raw, string name, int depth = 0)
    {
        var o = new Dictionary<string, KVObject>(StringComparer.OrdinalIgnoreCase);
        if (depth > 8 || !raw.TryGetValue(name, out var ev)) return o;
        if (ev.TryGetValue("base", out var b) && b.ValueType == KVValueType.String)
        {
            foreach (var (k, v) in Flatten(raw, b.ToString(CultureInfo.InvariantCulture), depth + 1)) o[k] = v;
        }
        foreach (var (k, v) in ev.Children) if (k != null && k != "base") o[k] = v;
        return o;
    }

    static double Num(KVObject v) => v.ValueType switch
    {
        KVValueType.Boolean => v.ToBoolean(CultureInfo.InvariantCulture) ? 1 : 0,
        KVValueType.String => double.TryParse(v.ToString(CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : 0,
        _ => v.ToDouble(CultureInfo.InvariantCulture),
    };

    static bool Flag(Dictionary<string, KVObject> f, string key, bool dflt) => f.TryGetValue(key, out var v) ? Num(v) != 0 : dflt;

    // a curve field ([[x, y, ...], ...]) as [[x, y], ...]; null when absent or empty
    static JsonArray? Curve(Dictionary<string, KVObject> f, string key)
    {
        if (!f.TryGetValue(key, out var curve) || !curve.IsArray) return null;
        var pts = new JsonArray();
        foreach (var (_, p) in curve.Children)
            if (p.IsArray && p.Count >= 2) pts.Add(new JsonArray(Math.Round(Num(p[0]), 4), Math.Round(Num(p[1]), 4)));
        return pts.Count > 0 ? pts : null;
    }

    static IEnumerable<string> Strings(KVObject v)
    {
        if (v.ValueType == KVValueType.String) { var s = v.ToString(CultureInfo.InvariantCulture); if (s.Length > 0) yield return s; }
        else if (v.IsArray) foreach (var (_, c) in v.Children) foreach (var s in Strings(c)) yield return s;
    }

    static (JsonObject events, int files, List<string> failed) Export(GameFileLoader loader, Dictionary<string, KVObject> raw, IEnumerable<string> wanted, string outDir)
    {
        var events = new JsonObject();
        var exported = new Dictionary<string, (string? rel, Sound? snd)>(StringComparer.OrdinalIgnoreCase);
        var failed = new List<string>();
        var queue = new Queue<string>(wanted);
        while (queue.Count > 0)
        {
            var name = queue.Dequeue();
            if (events.ContainsKey(name)) continue;
            if (!raw.ContainsKey(name)) { failed.Add($"{name} (no such event)"); continue; }
            var f = Flatten(raw, name);
            var vsnds = f.Where(kv => kv.Key.StartsWith("vsnd_files", StringComparison.OrdinalIgnoreCase)).SelectMany(kv => Strings(kv.Value)).ToList();
            var children = f.Where(kv => kv.Key.StartsWith("soundevent_", StringComparison.OrdinalIgnoreCase)).SelectMany(kv => Strings(kv.Value)).ToList();
            if (vsnds.Count == 0 && children.Count == 0) continue; // a template (base.*), nothing to play

            var ev = new JsonObject { ["type"] = f.TryGetValue("type", out var t) ? t.ToString(CultureInfo.InvariantCulture) : "csgo_mega" };
            var files = new JsonArray();
            Sound? first = null;
            foreach (var v in vsnds)
            {
                if (!exported.TryGetValue(v, out var done)) exported[v] = done = ExportFile(loader, v, outDir, failed);
                if (done.rel != null) { files.Add(done.rel); first ??= done.snd; }
            }
            ev["files"] = files;
            ev["volume"] = f.TryGetValue("volume", out var vol) ? Math.Round(Num(vol), 4) : 1;
            ev["pitch"] = f.TryGetValue("pitch", out var pit) ? Math.Round(Num(pit), 4) : 1;
            if (f.TryGetValue("pitch_random_min", out var pmin) && f.TryGetValue("pitch_random_max", out var pmax) && (Num(pmin) != 0 || Num(pmax) != 0))
                ev["pitchRandom"] = new JsonArray(Math.Round(Num(pmin), 4), Math.Round(Num(pmax), 4));
            if (f.TryGetValue("delay", out var del) && Num(del) > 0) ev["delay"] = Math.Round(Num(del), 4);
            if (f.TryGetValue("distance_volume_mapping_curve", out var curve) && curve.IsArray)
            {
                var pts = new JsonArray();
                foreach (var (_, p) in curve.Children)
                {
                    if (!p.IsArray || p.Count < 2) continue;
                    pts.Add(new JsonArray(Math.Round(Num(p[0]), 2), Math.Round(Num(p[1]), 4)));
                }
                var useCurve = !f.TryGetValue("use_distance_volume_mapping_curve", out var use) || Num(use) != 0;
                if (pts.Count > 0 && useCurve) ev["curve"] = pts;
            }
            if (f.TryGetValue("position_relative_to_player", out var rel) && Num(rel) != 0) ev["local"] = true;
            // the mixer and the stack's volume / distance inputs (audio/mix.js, audio.js): only what the event sets
            if (f.TryGetValue("mixgroup", out var mg) && mg.ValueType == KVValueType.String && mg.ToString(CultureInfo.InvariantCulture).Length > 0)
                ev["mixgroup"] = mg.ToString(CultureInfo.InvariantCulture);
            if (f.TryGetValue("distance_multiplier", out var dm) && Num(dm) != 1) ev["distanceMultiplier"] = Math.Round(Num(dm), 4);
            var vrMin = f.TryGetValue("volume_random_min", out var vmn) ? Num(vmn) : 0;
            var vrMax = f.TryGetValue("volume_random_max", out var vmx) ? Num(vmx) : 0;
            if (vrMin != 0 || vrMax != 0) ev["volumeRandom"] = new JsonArray(Math.Round(vrMin, 4), Math.Round(vrMax, 4));
            // the volume over playback (use_time_volume_mapping_curve, csgo_mega default off) and over the time since a
            // stop (use_fadetime_volume_mapping_curve, default on; an empty curve = stop at once)
            if (Flag(f, "use_time_volume_mapping_curve", false) && Curve(f, "time_volume_mapping_curve") is { } tc) ev["timeCurve"] = tc;
            if (Flag(f, "use_fadetime_volume_mapping_curve", true) && Curve(f, "fadetime_volume_mapping_curve") is { } fc) ev["fadeCurve"] = fc;
            // a room reverb this event switches the listener's RoomDSP to (a soundscape's), its own reverb send
            if (Flag(f, "override_dsp_preset", false) && f.TryGetValue("dsp_preset", out var dp) && dp.ToString(CultureInfo.InvariantCulture).Length > 0)
                ev["dspPreset"] = dp.ToString(CultureInfo.InvariantCulture).ToLowerInvariant();
            if (f.TryGetValue("reverb_wet", out var rw) && Num(rw) != 0) ev["reverbWet"] = Math.Round(Num(rw), 4);
            // csgo_mega's retrigger (plays again every [min, max] s until stopped) and random position (a point min..max
            // units from where it plays, the upper half only with randomize_position_hemisphere): soundscape one-shots
            if (Flag(f, "enable_retrigger", false))
                ev["retrigger"] = new JsonArray(Math.Round(Num(f.GetValueOrDefault("retrigger_interval_min") ?? 1), 3), Math.Round(Num(f.GetValueOrDefault("retrigger_interval_max") ?? 1), 3));
            var rpMax = f.TryGetValue("randomize_position_max_radius", out var rpx) ? Num(rpx) : 0;
            if (rpMax > 0)
                ev["randomPos"] = new JsonArray(Math.Round(f.TryGetValue("randomize_position_min_radius", out var rpn) ? Num(rpn) : 0, 2), Math.Round(rpMax, 2), Flag(f, "randomize_position_hemisphere", false));
            // csgo_music: starting it stops every other "Music." event (soundevent_limiter max 0, substring match)
            if (Flag(f, "stop_music", false)) ev["stopMusic"] = true;
            if (f.TryGetValue("vsnd_duration", out var dur)) ev["duration"] = Math.Round(Num(dur), 3);
            // voice management (audio/limits.js): only what the event sets; the stack's defaults live in the player
            if (f.TryGetValue("instance_limit", out var il) && Num(il) > 0) ev["instanceLimit"] = Math.Round(Num(il));
            if (f.TryGetValue("block_duration", out var bd)) ev["blockDuration"] = Math.Round(Num(bd), 4);
            if (f.TryGetValue("block_distance", out var bdi)) ev["blockDistance"] = Math.Round(Num(bdi), 2);
            if (f.TryGetValue("block_match_entity", out var bme)) ev["blockMatchEntity"] = Num(bme) != 0;
            if (f.TryGetValue("block_matching_events", out var bm)) ev["blockMatching"] = Num(bm) != 0;
            if (first != null && first.LoopStart >= 0 && first.SampleRate > 0)
            {
                // the wave carries a loop point (Source loops those until stopped); loopEnd 0 = to the end
                ev["loop"] = true;
                ev["loopStart"] = Math.Round((double)first.LoopStart / first.SampleRate, 4);
                if (first.LoopEnd > first.LoopStart) ev["loopEnd"] = Math.Round((double)first.LoopEnd / first.SampleRate, 4);
            }
            if (children.Count > 0)
            {
                ev["children"] = new JsonArray([.. children.Select(c => (JsonNode)c!)]);
                foreach (var c in children) if (raw.ContainsKey(c)) queue.Enqueue(c);
            }
            events[name] = ev;
        }
        return (events, exported.Values.Count(x => x.rel != null), failed);
    }

    static (string?, Sound?) ExportFile(GameFileLoader loader, string vsnd, string outDir, List<string> failed)
    {
        var path = vsnd.Replace('\\', '/');
        if (path.EndsWith("_c", StringComparison.Ordinal)) path = path[..^2];
        try
        {
            var res = loader.LoadFile(path + "_c");
            // an event may name the source file (ze_offliner: "sounds/ambient/waterrun.wav", "sounds/contest/torpedo.mp3");
            // the resource compiler writes it as <name>.vsnd_c, which is what the game loads
            if (res?.DataBlock is not Sound && !path.EndsWith(".vsnd", StringComparison.OrdinalIgnoreCase))
            {
                var compiled = Path.ChangeExtension(path, ".vsnd");
                var alt = loader.LoadFile(compiled + "_c");
                if (alt?.DataBlock is Sound) { res = alt; path = compiled; }
            }
            if (res?.DataBlock is not Sound snd) { failed.Add($"{path} (missing)"); return (null, null); }
            var bytes = snd.GetSound();
            if (bytes.Length > MaxSoundBytes) { failed.Add($"{path} (over {MaxSoundBytes / 1048576} MB)"); return (null, null); }
            string ext;
            switch (snd.SoundType)
            {
                case Sound.AudioFileType.MP3: ext = ".mp3"; break;
                case Sound.AudioFileType.AAC: ext = ".aac"; break;
                default: ext = ".wav"; bytes = WavToPcm16(bytes); break;
            }
            // the sound's VPK path names the file on disk and its URL in soundevents.json
            var rel = SafePath.Rel(Path.ChangeExtension(path, ext));
            if (rel == null) { failed.Add($"{SafePath.Describe(path)} (path refused)"); return (null, null); }
            File.WriteAllBytes(SafePath.OutFile(outDir, rel), bytes);
            return (rel, snd);
        }
        catch (Exception e)
        {
            failed.Add($"{path} ({e.Message})");
            return (null, null);
        }
    }

    // A RIFF wave in MS-ADPCM (format 2) -> PCM16; anything else is returned as it is.
    static byte[] WavToPcm16(byte[] wav)
    {
        if (wav.Length < 12 || BitConverter.ToUInt32(wav, 0) != 0x46464952) return wav; // "RIFF"
        int pos = 12, fmtAt = -1, fmtLen = 0, dataAt = -1, dataLen = 0;
        while (pos + 8 <= wav.Length)
        {
            var id = BitConverter.ToUInt32(wav, pos);
            var len = BitConverter.ToInt32(wav, pos + 4);
            if (id == 0x20746d66) { fmtAt = pos + 8; fmtLen = len; } // "fmt "
            else if (id == 0x61746164) { dataAt = pos + 8; dataLen = Math.Min(len, wav.Length - pos - 8); } // "data"
            if (len < 0) break;
            pos += 8 + len + (len & 1);
        }
        if (fmtAt < 0 || dataAt < 0) return wav;
        if (BitConverter.ToUInt16(wav, fmtAt) != 2) return wav;
        int ch = BitConverter.ToUInt16(wav, fmtAt + 2);
        var rate = BitConverter.ToInt32(wav, fmtAt + 4);
        int blockAlign = BitConverter.ToUInt16(wav, fmtAt + 12);
        // a block is a 7-byte header per channel plus data: anything smaller would never advance the decoder
        if (ch < 1 || ch > 8 || blockAlign < 7 * ch || rate <= 0) return wav;
        int samplesPerBlock = fmtLen >= 20 ? BitConverter.ToUInt16(wav, fmtAt + 18) : 0;
        short[] c1 = [256, 512, 0, 192, 240, 460, 392], c2 = [0, -256, 0, 64, 0, -208, -232];
        if (fmtLen >= 22)
        {
            int n = BitConverter.ToUInt16(wav, fmtAt + 20);
            if (n > 0 && fmtLen >= 22 + n * 4)
            {
                c1 = new short[n]; c2 = new short[n];
                for (var i = 0; i < n; i++) { c1[i] = BitConverter.ToInt16(wav, fmtAt + 22 + i * 4); c2[i] = BitConverter.ToInt16(wav, fmtAt + 24 + i * 4); }
            }
        }
        if (samplesPerBlock == 0) samplesPerBlock = (blockAlign - 7 * ch) * 2 / ch + 2;
        int[] adapt = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
        var outS = new List<short>(dataLen * 2);
        var co1 = new int[ch]; var co2 = new int[ch]; var delta = new int[ch]; var s1 = new int[ch]; var s2 = new int[ch];
        for (var blk = dataAt; blk + 7 * ch <= dataAt + dataLen; blk += blockAlign)
        {
            var end = Math.Min(blk + blockAlign, dataAt + dataLen);
            var p = blk;
            for (var c = 0; c < ch; c++) { var pi = Math.Min((int)wav[p++], c1.Length - 1); co1[c] = c1[pi]; co2[c] = c2[pi]; }
            for (var c = 0; c < ch; c++) { delta[c] = BitConverter.ToInt16(wav, p); p += 2; }
            for (var c = 0; c < ch; c++) { s1[c] = BitConverter.ToInt16(wav, p); p += 2; }
            for (var c = 0; c < ch; c++) { s2[c] = BitConverter.ToInt16(wav, p); p += 2; }
            for (var c = 0; c < ch; c++) outS.Add((short)s2[c]);
            for (var c = 0; c < ch; c++) outS.Add((short)s1[c]);
            var produced = 2;
            var c0 = 0;
            for (; p < end && produced < samplesPerBlock; p++)
            {
                for (var half = 0; half < 2; half++)
                {
                    var nib = half == 0 ? wav[p] >> 4 : wav[p] & 15;
                    var signed = nib >= 8 ? nib - 16 : nib;
                    var pred = (s1[c0] * co1[c0] + s2[c0] * co2[c0]) / 256 + signed * delta[c0];
                    pred = Math.Clamp(pred, short.MinValue, short.MaxValue);
                    s2[c0] = s1[c0]; s1[c0] = pred;
                    delta[c0] = Math.Max(16, adapt[nib] * delta[c0] / 256);
                    outS.Add((short)pred);
                    if (++c0 == ch) { c0 = 0; produced++; }
                }
            }
        }
        var pcm = new byte[outS.Count * 2];
        Buffer.BlockCopy(outS.ToArray(), 0, pcm, 0, pcm.Length);
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        w.Write(0x46464952); w.Write(36 + pcm.Length); w.Write(0x45564157); // RIFF....WAVE
        w.Write(0x20746d66); w.Write(16); w.Write((short)1); w.Write((short)ch); w.Write(rate);
        w.Write(rate * ch * 2); w.Write((short)(ch * 2)); w.Write((short)16);
        w.Write(0x61746164); w.Write(pcm.Length); w.Write(pcm);
        w.Flush();
        return ms.ToArray();
    }
}
