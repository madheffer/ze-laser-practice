// lasers-bake --player: the player's own third-person body (CS2Fixes !tp), from the local CS2 install.
//   - the stock CT agent a ZR human class wears (agents/models/ctm_sas/ctm_sas.vmdl, CS2Fixes playerclass example), full body + skeleton
//   - the default CT knife world model, WITH its skeleton (`weapon` / `weapon_offset` are the mount bones, and VRF
//     only writes the bones when animations are exported; the same trap Source2Viewer-CLI has)
// glTF as VRF writes it (metres, Y up), textures beside each glb capped like the map bake's. The stance clips the
// body is posed with are not models: README "Third person" (tools/tp-pose.mjs).
// Everything goes to <out> (gitignored: Valve's content, generated from the local install).
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;

namespace Lasers.Bake;

static class PlayerBake
{
    // vpk path -> output path under <out>. Fixed strings, but they still go through SafePath like every other output.
    // Anims: VRF writes a model's skeleton only with ExportAnimations on, so each model keeps a small filter (the
    // body: its knife idle, a cross-check for the stance JSON; empty = all, the knife's two).
    static readonly (string Vmdl, string Out, string[] Anims)[] Models =
    [
        ("agents/models/ctm_sas/ctm_sas.vmdl_c", "ctm_sas/ctm_sas.glb", ["idle_knife"]),
        ("weapons/models/knife/knife_default_ct/weapon_knife_default_ct.vmdl_c", "knife_default_ct/weapon_knife_default_ct.glb", []),
    ];

    public static int Run(string cs2, string outDir)
    {
        Directory.CreateDirectory(outDir);
        var pak = new Package();
        pak.Read(Path.Combine(cs2, "pak01_dir.vpk"));
        using var loader = new GameFileLoader(pak, null);
        var failed = 0;
        foreach (var (vmdl, rel, anims) in Models)
        {
            try
            {
                var res = loader.LoadFileCompiled(vmdl[..^2]);
                if (res?.DataBlock is not Model) { Console.WriteLine($"missing {vmdl}"); failed++; continue; }
                var exporter = new GltfModelExporter(loader)
                {
                    ProgressReporter = new Progress<string>(_ => { }),
                    ExportMaterials = true,
                    ExportAnimations = true,
                    AdaptTextures = true,
                    SatelliteImages = true,
                    ExportExtras = true,
                };
                foreach (var a in anims) exporter.AnimationFilter.Add(a);
                var target = SafePath.OutFile(outDir, rel);
                exporter.Export(res, target);
                Console.WriteLine($"{vmdl} -> {rel} ({new FileInfo(target).Length / 1024} KB)");
            }
            catch (Exception e)
            {
                Console.WriteLine($"failed {vmdl}: {e.Message}");
                failed++;
            }
        }
        // the same texture cap as a map: the body is seen from 15..150 units, 1024 px is plenty
        long before = 0, after = 0;
        foreach (var png in Directory.EnumerateFiles(outDir, "*.png", SearchOption.AllDirectories))
        {
            before += new FileInfo(png).Length;
            try { Baker.ResizePng(png, Baker.MaxTexture); }
            catch (Exception e) { Console.WriteLine($"  texture {Path.GetFileName(png)}: {e.Message}"); }
            after += new FileInfo(png).Length;
        }
        Console.WriteLine($"textures: {before / 1048576} MB -> {after / 1048576} MB");
        return failed == 0 ? 0 : 1;
    }
}
