// Source 1 materials (VMT, KeyValues 1 text): the shader and the flat parameters the bake draws with. "Patch"
// materials are resolved through their "include" (insert / replace blocks applied), at most a few levels deep.
// Nested blocks (Proxies, >=dx90 fallbacks) are skipped except the patch blocks; [conditions] are ignored.
using System.Text;

namespace Lasers.Bake.Source1;

sealed class Vmt
{
    public string Shader = "";
    public readonly Dictionary<string, string> P = new(StringComparer.OrdinalIgnoreCase);

    public string? Get(string k) => P.TryGetValue(k, out var v) ? v : null;
    public bool Flag(string k) => P.TryGetValue(k, out var v) && v.Trim() is "1" or "true";
    public float Num(string k, float dflt) => P.TryGetValue(k, out var v) && float.TryParse(v.Trim(), out var f) ? f : dflt;

    public static Vmt? Load(GameFiles files, string material, int depth = 0)
    {
        var bytes = files.Read("materials/" + material.Trim().TrimEnd('/') + ".vmt") ?? files.Read(material);
        if (bytes == null || bytes.Length > 1 << 20) return null;
        var toks = Tokens(Encoding.UTF8.GetString(bytes)).ToList();
        if (toks.Count < 2 || toks[1] != "{") return null;
        var m = new Vmt { Shader = toks[0].ToLowerInvariant() };
        var i = 2;
        Block(toks, ref i, m, out var patch);
        if (m.Shader == "patch" && depth < 4 && m.Get("include") is { } inc)
        {
            // only the leading "materials/" goes ("KMATERIALS/..." has it inside the name too)
            var path = GameFiles.Norm(inc);
            if (path.StartsWith("materials/")) path = path["materials/".Length..];
            if (path.EndsWith(".vmt")) path = path[..^4];
            var baseMat = Load(files, path, depth + 1);
            if (baseMat == null) return null;
            foreach (var (k, v) in patch) baseMat.P[k] = v;
            return baseMat;
        }
        return m;
    }

    // top-level pairs into m.P; an "insert" / "replace" block's pairs into patch; other blocks skipped
    static void Block(List<string> t, ref int i, Vmt m, out Dictionary<string, string> patch)
    {
        patch = new(StringComparer.OrdinalIgnoreCase);
        while (i < t.Count && t[i] != "}")
        {
            var key = t[i++];
            if (i >= t.Count) break;
            if (t[i] == "{")
            {
                i++;
                var into = key.Equals("insert", StringComparison.OrdinalIgnoreCase) || key.Equals("replace", StringComparison.OrdinalIgnoreCase);
                var depth = 1;
                while (i < t.Count && depth > 0)
                {
                    if (t[i] == "{") { depth++; i++; continue; }
                    if (t[i] == "}") { depth--; i++; continue; }
                    if (into && depth == 1 && i + 1 < t.Count && t[i + 1] != "{" && t[i + 1] != "}") { patch[t[i]] = t[i + 1]; i += 2; continue; }
                    i++;
                }
                continue;
            }
            m.P[key] = t[i++];
        }
    }

    static IEnumerable<string> Tokens(string s)
    {
        var i = 0;
        while (i < s.Length)
        {
            var c = s[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (c == '/' && i + 1 < s.Length && s[i + 1] == '/') { while (i < s.Length && s[i] != '\n') i++; continue; }
            if (c == '[') { while (i < s.Length && s[i] != ']') i++; i++; continue; } // a [$WIN32] condition
            if (c is '{' or '}') { i++; yield return c.ToString(); continue; }
            var sb = new StringBuilder();
            if (c == '"')
            {
                i++;
                while (i < s.Length && s[i] != '"') sb.Append(s[i++]);
                i++;
            }
            else
                while (i < s.Length && !char.IsWhiteSpace(s[i]) && s[i] is not '{' and not '}' and not '"') sb.Append(s[i++]);
            yield return sb.ToString();
        }
    }
}
