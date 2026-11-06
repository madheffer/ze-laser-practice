// A Source 1 map's sounds -> soundevents.json + sounds/ in the CS2 bake's shape (SoundBake.cs), so audio.js plays them.
// What an entity plays is a name: a sound file under sound/ ("malgo/explode_2.mp3", with Source's leading
// control characters such as '#', '*', ')' or '~') or a soundscript entry ("Doors.FullOpen14", "DoSpark"). Both
// become an event named exactly as the entity names it:
//   - a file: its sound (the map's pakfile first, then CS:GO's pak01), played as EmitSound plays a raw wave: volume 1,
//     pitch 100, SNDLVL_NORM (75 dB). An ambient_generic sends its own volume, pitch and falloff with each sound
//     (web soundents.js: its radius), so these defaults are only for doors / movers naming files.
//   - a soundscript entry: the map's maps/<map>_level_sounds.txt (it overrides), else CS:GO's scripts named by
//     scripts/game_sounds_manifest.txt; its wave / rndwave files, volume, pitch and soundlevel.
// Each event carries its `soundlevel`; the player turns it into Source's falloff (web/src/audio/source1-falloff.js:
// CS:GO's calc_falloff), the one place that formula lives. A wave's loop is Source's: the first cue point is the loop start, an ltxt length ends it
// (CAudioSourceWave::ParseCueChunk). MS-ADPCM waves are decoded to PCM16 (browsers decode only PCM); a wave holding MP3
// (format 0x55) is written as the MP3 it is.
// Which names entities play follows the player's rules (web/src/world/entities/sound.js, classes/soundents.js) with
// Source 1's names: func_button's sounds / locked_sound / unlocked_sound index N -> "Buttons.sndN" (CBaseButton
// MakeButtonSound), env_spark -> "DoSpark", env_explosion -> "BaseExplosionEffect.Sound" (unless spawnflag 64),
// breakables -> their material's Breakable.* names (SoundRefs.cs tables, the same names in Source 1).
// Files whose path has a music/ folder are typed "source1_music": the player's music volume (a trainer choice; CS:GO's
// own mixer groups are not read, UNSETTLED). Output paths are the sound's path lower-cased with anything but
// [a-z0-9._/-] replaced, under sounds/ (SafePath): names are a map's data.
using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Lasers.Bake.Source1;

static partial class Source1Sounds
{
    const int MaxNames = 4000;
    const int MaxSoundBytes = 64 << 20;
    const int DefaultLevel = 75; // SNDLVL_NORM

    static readonly HashSet<string> SoundKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "noise1", "noise2", "startclosesound", "closesound", "startsound", "stopsound", "movesound", "movepingsound", "m_soundname",
    };
    static readonly string?[] BreakByMaterial = ["Breakable.Glass", "Breakable.Crate", "Breakable.Metal", "Breakable.Flesh",
        "Breakable.Concrete", "Breakable.Ceiling", "Breakable.Computer", null, "Breakable.Concrete", "Breakable.Flesh"];
    static readonly string?[] ShardByMaterial = ["Breakable.MatGlass", "Breakable.MatWood", "Breakable.MatMetal", null,
        "Breakable.MatConcrete", null, "Breakable.Computer", "Breakable.MatGlass", "Breakable.MatConcrete", null];

    [GeneratedRegex("^SNDLVL_(\\d+)dB$", RegexOptions.IgnoreCase)]
    private static partial Regex LevelDbRe();

    sealed record Wave(string Rel, double Duration, double LoopStart, double LoopEnd);

    /// Writes outDir/soundevents.json and outDir/sounds/; returns the number of events written.
    public static int Bake(JsonObject lumps, GameFiles files, string mapName, string outDir, Action<string> log)
    {
        var names = Collect(lumps);
        var scripts = Scripts(files, mapName, log);
        var events = new JsonObject();
        var waves = new Dictionary<string, Wave?>(StringComparer.OrdinalIgnoreCase);
        var failed = new List<string>();
        foreach (var name in names)
        {
            var ev = scripts.TryGetValue(name, out var entry) ? FromScript(entry, files, outDir, waves, failed)
                : IsFile(name) ? FromFile(name, files, outDir, waves, failed) : null;
            if (ev != null) events[name] = ev;
            else if (!IsFile(name) && entry == null) failed.Add($"{name} (no soundscript entry)");
        }
        File.WriteAllText(Path.Combine(outDir, "soundevents.json"), events.ToJsonString());
        log($"sounds: {events.Count} of {names.Count} names, {waves.Values.Count(w => w != null)} files");
        foreach (var f in failed.Take(30)) log($"  sound: {f}");
        if (failed.Count > 30) log($"  ... {failed.Count - 30} more");
        return events.Count;
    }

    // ---- which names the entities play -----------------------------------------------------------------------

    static SortedSet<string> Collect(JsonObject lumps)
    {
        var names = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        void Add(string? n) { if (!string.IsNullOrWhiteSpace(n) && n.Trim() != "0" && n.Length <= 200 && names.Count < MaxNames) names.Add(n.Trim()); }
        foreach (var (_, arr) in lumps)
            foreach (var d in arr?.AsArray() ?? [])
            {
                if (d?["kv"] is not JsonObject kv) continue;
                string K(string k) => kv[k]?.GetValue<string>() ?? "";
                int I(string k) => int.TryParse(K(k), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : 0;
                var cls = K("classname").ToLowerInvariant();
                switch (cls)
                {
                    case "ambient_generic": Add(K("message")); break;
                    case "func_button": case "momentary_rot_button": case "func_rot_button":
                        foreach (var k in new[] { "sounds", "locked_sound", "unlocked_sound" }) if (I(k) > 0) Add($"Buttons.snd{I(k)}");
                        break;
                    case "env_spark": Add("DoSpark"); break;
                    case "env_explosion": if ((I("spawnflags") & 64) == 0) Add("BaseExplosionEffect.Sound"); break;
                    case "func_breakable": case "func_physbox": case "func_physbox_multiplayer":
                        var mat = I("material");
                        if (mat >= 0 && mat < BreakByMaterial.Length) { Add(BreakByMaterial[mat]); Add(ShardByMaterial[mat]); if (mat == 6) Add("Breakable.MatMetal"); }
                        break;
                }
                // doors' and movers' keys hold names; a func_button's locked_sound is an index (above)
                if (cls.StartsWith("func_door", StringComparison.Ordinal) && K("locked_sound").Length > 0 && I("locked_sound") == 0) Add(K("locked_sound"));
                if (cls.StartsWith("func_door", StringComparison.Ordinal) && K("unlocked_sound").Length > 0 && I("unlocked_sound") == 0) Add(K("unlocked_sound"));
                foreach (var (k, v) in kv)
                    if (SoundKeys.Contains(k) && v is JsonValue jv && jv.TryGetValue<string>(out var s)) Add(s);
            }
        return names;
    }

    // Source's leading sound characters (CHAR_STREAM '*', CHAR_DRYMIX '#', CHAR_OMNI '@', CHAR_SPATIALSTEREO ')', ...)
    static string Strip(string n) => n.TrimStart('*', '#', '@', '>', '<', '^', ')', '(', '}', '$', '!', '?', '&', '~', '`', '+', '%').Replace('\\', '/');
    static bool IsFile(string n) => !n.StartsWith('!') && (Strip(n).EndsWith(".wav", StringComparison.OrdinalIgnoreCase) || Strip(n).EndsWith(".mp3", StringComparison.OrdinalIgnoreCase));

    // ---- soundscripts ----------------------------------------------------------------------------------------

    static Dictionary<string, KvNode> Scripts(GameFiles files, string mapName, Action<string> log)
    {
        var o = new Dictionary<string, KvNode>(StringComparer.OrdinalIgnoreCase);
        void Load(string path, bool overrides)
        {
            var bytes = files.Read(path);
            if (bytes == null) return;
            foreach (var e in KvText.Parse(Encoding.Latin1.GetString(bytes)).Children)
                if (e.Value == null && (overrides || !o.ContainsKey(e.Key))) o[e.Key] = e;
        }
        var manifest = files.Read("scripts/game_sounds_manifest.txt");
        var count = 0;
        if (manifest != null)
            foreach (var root in KvText.Parse(Encoding.Latin1.GetString(manifest)).Children)
                foreach (var f in root.Children)
                    if (f.Value != null && f.Value.EndsWith(".txt", StringComparison.OrdinalIgnoreCase)) { Load(f.Value, false); count++; }
        Load($"maps/{mapName}_level_sounds.txt", true);
        log($"sounds: {o.Count} soundscript entries ({count} stock scripts{(files.InPak($"maps/{mapName}_level_sounds.txt") ? " + the map's" : "")})");
        return o;
    }

    static JsonObject? FromScript(KvNode e, GameFiles files, string outDir, Dictionary<string, Wave?> waves, List<string> failed)
    {
        var list = new List<string>();
        if (e.Get("wave") is { } w) list.Add(w);
        if (e.Block("rndwave") is { } rnd) list.AddRange(rnd.Children.Where(c => c.Value != null && c.Key.Equals("wave", StringComparison.OrdinalIgnoreCase)).Select(c => c.Value!));
        var (vMin, vMax) = Range(e.Get("volume"), 1, Volume);
        var (pMin, pMax) = Range(e.Get("pitch"), 100, Pitch);
        var level = e.Get("soundlevel") is { } sl ? Level(sl) : e.Get("attenuation") is { } at ? AttnLevel(at) : DefaultLevel;
        return Event(list, files, outDir, waves, failed, vMin, vMax, pMin, pMax, level);
    }

    static JsonObject? FromFile(string name, GameFiles files, string outDir, Dictionary<string, Wave?> waves, List<string> failed)
        => Event([name], files, outDir, waves, failed, 1, 1, 100, 100, DefaultLevel);

    static JsonObject? Event(List<string> list, GameFiles files, string outDir, Dictionary<string, Wave?> waves, List<string> failed,
        double vMin, double vMax, double pMin, double pMax, int level)
    {
        var arr = new JsonArray();
        Wave? first = null;
        var music = false;
        foreach (var raw in list.Take(32))
        {
            if (raw.StartsWith('!')) continue; // a sentence
            var path = Strip(raw).ToLowerInvariant();
            if (!waves.TryGetValue(path, out var wv)) waves[path] = wv = Export(path, files, outDir, failed);
            if (wv == null) continue;
            arr.Add(wv.Rel);
            first ??= wv;
            music |= path.StartsWith("music/", StringComparison.Ordinal) || path.Contains("/music/", StringComparison.Ordinal);
        }
        if (arr.Count == 0) return null;
        var ev = new JsonObject
        {
            ["type"] = music ? "source1_music" : "source1",
            ["files"] = arr,
            ["volume"] = Math.Round(vMin, 4),
            ["pitch"] = Math.Round(pMin / 100, 4),
            ["soundlevel"] = level,
        };
        if (vMax > vMin) ev["volumeRandom"] = new JsonArray(0, Math.Round(vMax - vMin, 4));
        if (pMax > pMin) ev["pitchRandom"] = new JsonArray(0, Math.Round((pMax - pMin) / 100, 4));
        if (first!.Duration > 0) ev["duration"] = Math.Round(first.Duration, 3);
        if (first.LoopStart >= 0)
        {
            ev["loop"] = true;
            ev["loopStart"] = Math.Round(first.LoopStart, 4);
            if (first.LoopEnd > first.LoopStart) ev["loopEnd"] = Math.Round(first.LoopEnd, 4);
        }
        return ev;
    }

    static (double, double) Range(string? s, double dflt, Func<string, double> one)
    {
        if (string.IsNullOrWhiteSpace(s)) return (dflt, dflt);
        var p = s.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        var a = one(p[0]);
        var b = p.Length > 1 ? one(p[1]) : a;
        return (Math.Min(a, b), Math.Max(a, b));
    }
    static double Num(string s, double d) => double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : d;
    static double Volume(string s) => s.Equals("VOL_NORM", StringComparison.OrdinalIgnoreCase) ? 1 : Math.Clamp(Num(s, 1), 0, 1);
    static double Pitch(string s) => s.ToUpperInvariant() switch { "PITCH_NORM" => 100, "PITCH_LOW" => 95, "PITCH_HIGH" => 120, _ => Math.Clamp(Num(s, 100), 1, 255) };
    static int Level(string s)
    {
        var u = s.Trim().ToUpperInvariant();
        if (LevelDbRe().Match(u) is { Success: true } m) return int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        return u switch
        {
            "SNDLVL_NONE" => 0, "SNDLVL_NORM" => 75, "SNDLVL_IDLE" => 60, "SNDLVL_TALKING" => 80, "SNDLVL_STATIC" => 66,
            "SNDLVL_GUNFIRE" => 140, "SNDLVL_STATIC_CLOSE" => 66, _ => (int)Math.Clamp(Num(u, DefaultLevel), 0, 255),
        };
    }
    // ATTN_TO_SNDLVL: attn ? 50 + 20 / attn : 0
    static int AttnLevel(string s)
    {
        var a = s.Trim().ToUpperInvariant() switch { "ATTN_NONE" => 0, "ATTN_NORM" => 0.8, "ATTN_IDLE" => 2.0, "ATTN_STATIC" => 1.25, "ATTN_RICOCHET" => 1.5, "ATTN_GUNFIRE" => 0.27, var x => Num(x, 0.8) };
        return a > 0 ? (int)(50 + 20 / a) : 0;
    }

    // ---- files -----------------------------------------------------------------------------------------------

    static Wave? Export(string path, GameFiles files, string outDir, List<string> failed)
    {
        try
        {
            var bytes = files.Read("sound/" + path);
            if (bytes == null) { failed.Add($"sound/{path} (missing)"); return null; }
            if (bytes.Length > MaxSoundBytes) { failed.Add($"sound/{path} (over {MaxSoundBytes >> 20} MB)"); return null; }
            double dur = 0, loopStart = -1, loopEnd = -1;
            string ext;
            if (path.EndsWith(".mp3", StringComparison.Ordinal)) { ext = ".mp3"; dur = Mp3Duration(bytes); }
            else
            {
                var info = RiffInfo(bytes);
                if (info.Format == 0x55 && info.DataAt >= 0) { bytes = bytes[info.DataAt..(info.DataAt + info.DataLen)]; ext = ".mp3"; dur = Mp3Duration(bytes); }
                else
                {
                    ext = ".wav";
                    bytes = SoundBake.WavToPcm16(bytes);
                    var pcm = RiffInfo(bytes);
                    var frame = pcm.Channels * Math.Max(1, pcm.Bits / 8);
                    if (pcm.Rate > 0 && frame > 0) dur = (double)pcm.DataLen / frame / pcm.Rate;
                    if (info.Rate > 0 && info.CueSample >= 0)
                    {
                        loopStart = (double)info.CueSample / info.Rate;
                        if (info.LoopLength > 0) loopEnd = (double)(info.CueSample + info.LoopLength) / info.Rate;
                    }
                }
            }
            var clean = new string(path.Select(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '/' or '-' ? c : '_').ToArray());
            var rel = SafePath.Rel("sounds/" + Path.ChangeExtension(clean, ext));
            if (rel == null) { failed.Add($"{SafePath.Describe(path)} (path refused)"); return null; }
            File.WriteAllBytes(SafePath.OutFile(outDir, rel), bytes);
            return new Wave(rel, dur, loopStart, loopEnd);
        }
        catch (Exception e)
        {
            failed.Add($"sound/{path} ({e.Message})");
            return null;
        }
    }

    record struct Riff(int Format, int Channels, int Rate, int Bits, int DataAt, int DataLen, long CueSample, long LoopLength);

    static Riff RiffInfo(byte[] w)
    {
        var r = new Riff(0, 0, 0, 0, -1, 0, -1, 0);
        if (w.Length < 12 || BitConverter.ToUInt32(w, 0) != 0x46464952) return r; // "RIFF"
        void Walk(int pos, int end)
        {
            while (pos + 8 <= end)
            {
                var id = BitConverter.ToUInt32(w, pos);
                var len = BitConverter.ToInt32(w, pos + 4);
                if (len < 0) return;
                var body = pos + 8;
                var bodyEnd = (int)Math.Min((long)body + len, end);
                if (id == 0x20746d66 && bodyEnd - body >= 16) // "fmt "
                    r = r with { Format = BitConverter.ToUInt16(w, body), Channels = BitConverter.ToUInt16(w, body + 2), Rate = BitConverter.ToInt32(w, body + 4), Bits = BitConverter.ToUInt16(w, body + 14) };
                else if (id == 0x61746164) r = r with { DataAt = body, DataLen = bodyEnd - body }; // "data"
                else if (id == 0x20657563 && bodyEnd - body >= 28 && BitConverter.ToInt32(w, body) > 0) // "cue ": the first point's dwSampleOffset
                    r = r with { CueSample = BitConverter.ToUInt32(w, body + 4 + 20) };
                else if (id == 0x5453494c && bodyEnd - body >= 4 && BitConverter.ToUInt32(w, body) == 0x6c746461) Walk(body + 4, bodyEnd); // LIST adtl
                else if (id == 0x7478746c && bodyEnd - body >= 8) r = r with { LoopLength = BitConverter.ToUInt32(w, body + 4) }; // "ltxt" dwSampleLength
                pos = body + len + (len & 1);
            }
        }
        Walk(12, w.Length);
        return r;
    }

    // seconds of MPEG audio: every frame's samples / its rate (an ID3v2 tag skipped)
    static double Mp3Duration(byte[] b)
    {
        int[] br1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], br2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
        int[] sr1 = [44100, 48000, 32000];
        var p = 0;
        if (b.Length > 10 && b[0] == 'I' && b[1] == 'D' && b[2] == '3') p = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
        double secs = 0;
        var frames = 0;
        while (p + 4 <= b.Length && frames < 1_000_000)
        {
            if (b[p] != 0xff || (b[p + 1] & 0xe0) != 0xe0) { p++; continue; }
            var ver = (b[p + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
            var layer = (b[p + 1] >> 1) & 3; // 1 = layer III
            var bri = b[p + 2] >> 4;
            var sri = (b[p + 2] >> 2) & 3;
            var pad = (b[p + 2] >> 1) & 1;
            if (ver == 1 || layer != 1 || bri == 0 || bri == 15 || sri == 3) { p++; continue; }
            var rate = sr1[sri] >> (ver == 3 ? 0 : ver == 2 ? 1 : 2);
            var kbps = (ver == 3 ? br1 : br2)[bri];
            var samples = ver == 3 ? 1152 : 576;
            var len = samples / 8 * kbps * 1000 / rate + pad;
            if (len < 4) { p++; continue; }
            secs += (double)samples / rate;
            frames++;
            p += len;
        }
        return secs;
    }
}
