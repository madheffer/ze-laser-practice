// lasers-bake --gfl <GFL content .vpk> <web/public/gfl> [--cs2 <game/csgo>]: the particle effects of GFL's own content
// pack that the game plays. GFL's servers send every player their workshop pack (workshop 3793587501 as of 2026-11);
// it carries their hitmarkers (particles/gfl/hitmarker*.vpcf). Only the boss one is used (fx/screen-effects.js), baked
// as a map's effects are (ParticleBake.Write: <out>/fx/index.json, systems/, textures/), so the particle runtime plays
// it as it plays a map's. Everything goes to <out> (gitignored: GFL's content, generated from the local workshop copy).
using SteamDatabase.ValvePak;
using ValveResourceFormat.IO;

namespace Lasers.Bake;

static class GflBake
{
    public static readonly string[] Effects = ["particles/gfl/hitmarker_boss.vpcf"];

    public static int Run(string vpk, string outDir, string? cs2)
    {
        if (!File.Exists(vpk)) { Console.Error.WriteLine($"no such VPK: {vpk}"); return 1; }
        Directory.CreateDirectory(outDir);
        using var pak = new Package();
        pak.Read(vpk);
        using var loader = new GameFileLoader(pak, null);
        // CS2's error system (ParticleBake queues it for every set) comes from the stock paks
        if (cs2 != null) foreach (var stock in Program.StockPaks(cs2)) loader.AddPackageToSearch(stock);
        var missing = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        ParticleBake.Write(loader, Effects, outDir, Console.WriteLine, missing);
        if (missing.Count > 0) Console.WriteLine($"missing: {string.Join(", ", missing)}");
        return Effects.Any(e => missing.Contains(e + "_c")) ? 1 : 0;
    }
}
