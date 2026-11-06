// Source 1 content lookup, in the engine's order: the map's own pakfile (the zip in lump 40) first, then the
// game's VPKs (CS:GO's csgo/pak01_dir.vpk: stock textures, props, sounds). Paths are case-insensitive with
// forward slashes, as Source's file system treats them. Read-only: nothing here writes anywhere.
using System.IO.Compression;
using SteamDatabase.ValvePak;

namespace Lasers.Bake.Source1;

sealed class GameFiles : IDisposable
{
    readonly Dictionary<string, ZipArchiveEntry> pak = new(StringComparer.OrdinalIgnoreCase);
    readonly ZipArchive? zip;
    readonly List<Package> vpks = [];
    public readonly List<string> Sources = [];

    public GameFiles(byte[] pakfile, IEnumerable<string> vpkPaths)
    {
        if (pakfile.Length > 0)
        {
            try
            {
                zip = new ZipArchive(new MemoryStream(pakfile), ZipArchiveMode.Read);
                foreach (var e in zip.Entries) pak[Norm(e.FullName)] = e;
                Sources.Add($"pakfile ({pak.Count} files)");
            }
            catch (Exception e) { Console.WriteLine($"  pakfile unreadable: {e.Message}"); }
        }
        foreach (var p in vpkPaths)
        {
            if (!File.Exists(p)) continue;
            var pkg = new Package();
            pkg.Read(p);
            vpks.Add(pkg);
            Sources.Add(p);
        }
    }

    public static string Norm(string p) => p.Replace('\\', '/').TrimStart('/').ToLowerInvariant();

    public IEnumerable<string> PakFiles => pak.Keys;

    public bool InPak(string path) => pak.ContainsKey(Norm(path));

    public byte[]? Read(string path)
    {
        var n = Norm(path);
        if (pak.TryGetValue(n, out var z))
        {
            try
            {
                // a pakfile entry can claim any size: cap what is read (the largest real VTF / MDL is well under this)
                if (z.Length > 256 << 20) return null;
                using var s = z.Open();
                var ms = new MemoryStream();
                s.CopyTo(ms);
                return ms.ToArray();
            }
            catch { return null; } // LZMA (method 14) entries: System.IO.Compression has no LZMA
        }
        foreach (var v in vpks)
        {
            var e = v.FindEntry(n);
            if (e == null) continue;
            v.ReadEntry(e, out var bytes);
            return bytes;
        }
        return null;
    }

    public void Dispose()
    {
        zip?.Dispose();
        foreach (var v in vpks) v.Dispose();
    }
}
