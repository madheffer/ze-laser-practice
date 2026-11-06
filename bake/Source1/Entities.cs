// A Source 1 entity lump (KeyValues text) -> entities.json in the CS2 bake's shape, so the one EntityEngine runs both.
// Two things differ from a CS2 map and are translated here, nothing else is changed:
//  - outputs are key values ("OnTrigger" "target<ESC>input<ESC>param<ESC>delay<ESC>times", or commas in older maps):
//    they become io entries.
//  - a point_template names its entities (Template01..16) instead of holding a lump: they move into a lump of their
//    own ("tpl_<n>", the template's entitylumpname), placed relative to the template's origin and angles as Source 1's
//    CPointTemplate::CreateInstance places them. Without "Preserve entity names" (spawnflags 2) their names are fixed
//    up per spawn: they carry CS2's "&0000" marker, which the engine replaces with a counter per spawn as it does for
//    a CS2 template. Without "Don't remove template entities" (spawnflags 1) they leave the world.
// Keys are lower-cased (Source's are case-insensitive; a CS2 bake's are lower case, which is how the engine reads them).
// Brush models ("*12") are renamed to a path per model (BrushModelPath) and prop models lower-cased: the keys of
// hulls.json and models/.
using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;

namespace Lasers.Bake.Source1;

static class Entities
{
    public sealed class Ent
    {
        public readonly List<(string K, string V)> Kv = [];
        public readonly List<JsonObject> Io = [];
        public string? Get(string k) => Kv.LastOrDefault(p => p.K.Equals(k, StringComparison.OrdinalIgnoreCase)).V;
        public void Set(string k, string v)
        {
            var i = Kv.FindLastIndex(p => p.K.Equals(k, StringComparison.OrdinalIgnoreCase));
            if (i >= 0) Kv[i] = (Kv[i].K, v); else Kv.Add((k, v));
        }
    }

    public static string BrushModelPath(string map, int n) => $"maps/{map}/entities/brush_{n}.vmdl";

    public static List<Ent> Parse(string text)
    {
        var list = new List<Ent>();
        var i = 0;
        string? Tok()
        {
            while (i < text.Length && char.IsWhiteSpace(text[i])) i++;
            if (i >= text.Length) return null;
            if (text[i] is '{' or '}') return text[i++].ToString();
            if (text[i] == '"')
            {
                var end = text.IndexOf('"', i + 1);
                if (end < 0) end = text.Length;
                var s = text[(i + 1)..end];
                i = end + 1;
                return "\"" + s;
            }
            var st = i;
            while (i < text.Length && !char.IsWhiteSpace(text[i])) i++;
            return "\"" + text[st..i];
        }
        Ent? cur = null;
        string? key = null;
        for (var t = Tok(); t != null; t = Tok())
        {
            if (t == "{") { cur = new Ent(); key = null; continue; }
            if (t == "}") { if (cur != null) list.Add(cur); cur = null; continue; }
            if (cur == null) continue;
            var s = t[1..];
            if (key == null) { key = s; continue; }
            if (ParseIo(key, s) is { } io) cur.Io.Add(io); else cur.Kv.Add((key, s));
            key = null;
        }
        return list;
    }

    static JsonObject? ParseIo(string output, string v)
    {
        var esc = v.Contains('\u001b');
        if (!esc && !(output.StartsWith("On", StringComparison.OrdinalIgnoreCase) || output.StartsWith("Out", StringComparison.OrdinalIgnoreCase)
            || output.Contains("Pressed", StringComparison.OrdinalIgnoreCase))) return null;
        var p = v.Split(esc ? '\u001b' : ',');
        if (p.Length != 5) return null;
        if (!float.TryParse(p[3], NumberStyles.Float, CultureInfo.InvariantCulture, out var delay)) return null;
        if (!int.TryParse(p[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out var times)) return null;
        return new JsonObject { ["output"] = output, ["delay"] = delay, ["times"] = times, ["input"] = p[1], ["target"] = p[0], ["param"] = p[2] };
    }

    // -> { lumps } (default_ents + one tpl_<n> per point_template that names entities), and the models the entities use
    public static JsonObject Convert(List<Ent> ents, string map, ISet<string> models, ISet<int> brushModels)
    {
        foreach (var e in ents)
        {
            var m = e.Get("model");
            if (!string.IsNullOrEmpty(m))
            {
                if (m.StartsWith('*') && int.TryParse(m[1..], out var n) && n > 0) { e.Set("model", BrushModelPath(map, n)); brushModels.Add(n); models.Add(BrushModelPath(map, n)); }
                else if (SafePath.Rel(GameFiles.Norm(m)) is { } safe) { e.Set("model", safe); models.Add(safe); }
                else { Console.WriteLine($"  model path refused: {SafePath.Describe(m)}"); e.Set("model", ""); }
            }
            // a lone "angle" is the yaw (-1 up, -2 down), as Source's KeyValue("angle") sets it
            if (e.Get("angles") == null && e.Get("angle") is { } a && float.TryParse(a, NumberStyles.Float, CultureInfo.InvariantCulture, out var yaw))
                e.Set("angles", yaw == -1 ? "-90 0 0" : yaw == -2 ? "90 0 0" : $"0 {F(yaw)} 0");
        }

        var byName = new Dictionary<string, List<Ent>>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in ents)
            if (e.Get("targetname") is { Length: > 0 } tn) { if (!byName.TryGetValue(tn, out var l)) byName[tn] = l = []; l.Add(e); }

        var lumps = new JsonObject();
        var removed = new HashSet<Ent>();
        var tplIndex = 0;
        foreach (var t in ents.Where(e => e.Get("classname")?.Equals("point_template", StringComparison.OrdinalIgnoreCase) == true).ToList())
        {
            var names = Enumerable.Range(1, 16).Select(k => t.Get($"Template{k:00}")).Where(s => !string.IsNullOrEmpty(s)).Select(s => s!).ToList();
            // CPointTemplate::StartBuildingTemplates finds each name with gEntList.FindEntityByName, whose NamesMatch takes
            // a trailing '*' as a prefix (ze_surf_dark_fantasy's boss_PT_queen: "boss_queen_*")
            var members = names.SelectMany(n => n.EndsWith('*')
                    ? ents.Where(e => e.Get("targetname") is { Length: > 0 } tn && tn.StartsWith(n[..^1], StringComparison.OrdinalIgnoreCase))
                    : byName.TryGetValue(n, out var l) ? l : [])
                .Distinct().Where(e => e != t).ToList();
            if (members.Count == 0) continue;
            var flags = int.TryParse(t.Get("spawnflags"), out var sf) ? sf : 0;
            if ((flags & 1) == 0) foreach (var e in members) removed.Add(e);
            var fixup = (flags & 2) == 0;
            var memberNames = new HashSet<string>(members.Select(e => e.Get("targetname") ?? "").Where(s => s.Length > 0), StringComparer.OrdinalIgnoreCase);
            string Fix(string s) => fixup && memberNames.Contains(s) ? s + "&0000" : s;

            var tplPose = Pose(t);
            var inv = Invert(tplPose);
            var arr = new JsonArray();
            foreach (var e in members)
            {
                var local = Mul(inv, Pose(e));
                var kv = new JsonObject();
                foreach (var (k, v) in e.Kv)
                {
                    var lk = k.ToLowerInvariant();
                    if (lk == "origin") kv[lk] = $"{F(local.T[0])} {F(local.T[1])} {F(local.T[2])}";
                    else if (lk == "angles") { var an = Angles(local.R); kv[lk] = $"{F(an[0])} {F(an[1])} {F(an[2])}"; }
                    else kv[lk] = Fix(v);
                }
                if (!kv.ContainsKey("origin")) kv["origin"] = $"{F(local.T[0])} {F(local.T[1])} {F(local.T[2])}";
                // a rotated template turns an entity that had no angles of its own
                if (!kv.ContainsKey("angles") && Angles(local.R) is var la && la.Any(x => Math.Abs(x) > 1e-3)) kv["angles"] = $"{F(la[0])} {F(la[1])} {F(la[2])}";
                var io = new JsonArray();
                foreach (var c in e.Io)
                {
                    var n = (JsonObject)c.DeepClone();
                    n["target"] = Fix((string)n["target"]!);
                    if (fixup) n["param"] = FixTokens((string)n["param"]!, memberNames);
                    io.Add(n);
                }
                arr.Add(new JsonObject { ["kv"] = kv, ["io"] = io });
            }
            var lump = $"tpl_{tplIndex++}";
            lumps[lump] = arr;
            t.Set("entitylumpname", lump);
        }

        var world = new JsonArray();
        foreach (var e in ents)
        {
            if (removed.Contains(e)) continue;
            var kv = new JsonObject();
            foreach (var (k, v) in e.Kv) kv[k.ToLowerInvariant()] = v;
            world.Add(new JsonObject { ["kv"] = kv, ["io"] = new JsonArray([.. e.Io.Select(c => c.DeepClone())]) });
        }
        var outLumps = new JsonObject { ["default_ents"] = world };
        foreach (var (k, v) in lumps) outLumps[k] = v!.DeepClone();
        return outLumps;
    }

    // template names inside an AddOutput-style parameter ("OnTrigger foo:Kill::0:1"), delimited by spaces or colons
    static string FixTokens(string s, HashSet<string> names)
    {
        if (s.Length == 0) return s;
        var sb = new StringBuilder();
        foreach (var part in System.Text.RegularExpressions.Regex.Split(s, "([ :,])"))
            sb.Append(names.Contains(part) ? part + "&0000" : part);
        return sb.ToString();
    }

    // ---- Source's AngleMatrix / MatrixAngles (mathlib.cpp): columns forward, left, up; angles pitch yaw roll in degrees

    public sealed record Xf(double[,] R, double[] T);

    static Xf Pose(Ent e) => new(AngleMatrix(Vec(e.Get("angles"))), Vec(e.Get("origin")));

    static double[] Vec(string? s)
    {
        var p = (s ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var v = new double[3];
        for (var i = 0; i < 3 && i < p.Length; i++) double.TryParse(p[i], NumberStyles.Float, CultureInfo.InvariantCulture, out v[i]);
        return v;
    }

    public static double[,] AngleMatrix(double[] a)
    {
        const double D = Math.PI / 180;
        double sp = Math.Sin(a[0] * D), cp = Math.Cos(a[0] * D), sy = Math.Sin(a[1] * D), cy = Math.Cos(a[1] * D), sr = Math.Sin(a[2] * D), cr = Math.Cos(a[2] * D);
        return new double[,]
        {
            { cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy },
            { cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy },
            { -sp, sr * cp, cr * cp },
        };
    }

    public static double[] Angles(double[,] m)
    {
        const double D = 180 / Math.PI;
        var xy = Math.Sqrt(m[0, 0] * m[0, 0] + m[1, 0] * m[1, 0]);
        if (xy > 0.001)
            return [Math.Atan2(-m[2, 0], xy) * D, Math.Atan2(m[1, 0], m[0, 0]) * D, Math.Atan2(m[2, 1], m[2, 2]) * D];
        return [Math.Atan2(-m[2, 0], xy) * D, Math.Atan2(-m[0, 1], m[1, 1]) * D, 0];
    }

    static Xf Invert(Xf x)
    {
        var r = new double[3, 3];
        for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) r[i, j] = x.R[j, i];
        var t = new double[3];
        for (var i = 0; i < 3; i++) t[i] = -(r[i, 0] * x.T[0] + r[i, 1] * x.T[1] + r[i, 2] * x.T[2]);
        return new Xf(r, t);
    }

    static Xf Mul(Xf a, Xf b)
    {
        var r = new double[3, 3];
        var t = new double[3];
        for (var i = 0; i < 3; i++)
        {
            for (var j = 0; j < 3; j++) r[i, j] = a.R[i, 0] * b.R[0, j] + a.R[i, 1] * b.R[1, j] + a.R[i, 2] * b.R[2, j];
            t[i] = a.R[i, 0] * b.T[0] + a.R[i, 1] * b.T[1] + a.R[i, 2] * b.T[2] + a.T[i];
        }
        return new Xf(r, t);
    }

    static string F(double v) => Math.Abs(v) < 1e-4 ? "0" : Math.Round(v, 4).ToString(CultureInfo.InvariantCulture);
}
