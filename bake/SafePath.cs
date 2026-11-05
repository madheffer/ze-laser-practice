// Every output path the bake builds from a VPK goes through here. VPK contents are attacker-controlled (a
// workshop map anyone can publish): entity model names, sound file names, the map's own name. A path that is
// rooted, has a drive letter or UNC prefix, a ".." segment, or anything Windows would quietly rewrite
// (trailing dots/spaces, device names like NUL or COM1) is refused, and the final full path must still sit
// inside the output folder. The web player applies the same rules (web/src/lib/paths.js).
using System.Text.RegularExpressions;

namespace Lasers.Bake;

static partial class SafePath
{
    const int MaxLength = 240;

    // A map folder name: same pattern as web/src/lib/paths.js MAP_NAME.
    [GeneratedRegex("^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$")]
    private static partial Regex MapNameRe();

    [GeneratedRegex("^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\\..*)?$", RegexOptions.IgnoreCase)]
    private static partial Regex DeviceRe();

    public static bool IsMapName(string? name) => name != null && MapNameRe().IsMatch(name);

    /// A VPK path as a safe relative path with forward slashes, or null if it is not one.
    public static string? Rel(string? path)
    {
        if (string.IsNullOrEmpty(path) || path.Length > MaxLength) return null;
        var s = path.Replace('\\', '/');
        if (s.StartsWith('/')) return null;
        foreach (var c in s)
        {
            if (char.IsControl(c) || c is ':' or '<' or '>' or '"' or '|' or '?' or '*') return null;
        }
        foreach (var seg in s.Split('/'))
        {
            if (seg.Length == 0 || seg == "." || seg == "..") return null;
            if (seg.EndsWith('.') || seg.EndsWith(' ') || seg.StartsWith(' ')) return null; // Windows trims these
            if (DeviceRe().IsMatch(seg)) return null;
        }
        return s;
    }

    /// The full path of `relative` under `root`, or null if it is unsafe or would land outside root.
    public static string? Under(string root, string? relative)
    {
        var rel = Rel(relative);
        if (rel == null) return null;
        var rootFull = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)) + Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(Path.Combine(rootFull, rel.Replace('/', Path.DirectorySeparatorChar)));
        return full.StartsWith(rootFull, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal) ? full : null;
    }

    /// Under(), creating the file's directory; throws when the path is refused (callers log and skip it).
    public static string OutFile(string root, string? relative)
    {
        var full = Under(root, relative) ?? throw new InvalidDataException($"unsafe output path refused: {Describe(relative)}");
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        return full;
    }

    public static string Describe(string? s) => s == null ? "(null)" : s.Length > 120 ? s[..120] + "..." : s;
}
