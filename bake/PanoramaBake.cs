// lasers-bake --panorama: CS2's HUD assets for the web HUD.
//   - SVG icons from pak01 (health/armor, weapon icons, ammo glyphs), decompiled by VRF
//   - the HUD's layout + style sources (vxml/vcss) for reference while matching sizes and colours
//   - the Stratum2 fonts, unpacked from panorama/fonts/stratum2.uifont (Valve's encrypted font package)
// Everything goes to <out> (gitignored: it is Valve's content, generated from the local install).
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.ValveFont;

namespace Lasers.Bake;

static class PanoramaBake
{
    static readonly string[] BaseFiles =
    [
        // HUD icons
        "panorama/images/icons/ui/health.vsvg_c",
        "panorama/images/icons/ui/armor.vsvg_c",
        "panorama/images/icons/ui/ct_logo_1c.vsvg_c",
        "panorama/images/icons/ui/t_logo_1c.vsvg_c",
        "panorama/images/hud/weapon_pip.vsvg_c",
        "panorama/images/icons/ui/shoppingcart.vsvg_c",
        "panorama/images/icons/ui/buyzone.vsvg_c",
        "panorama/images/icons/ui/dollar_sign.vsvg_c",
        "panorama/layout/hud/hudmoney.vxml_c",
        "panorama/styles/hud/hudmoney.vcss_c",
        "panorama/layout/hud/hud.vxml_c",
        "panorama/styles/hud/hud.vcss_c",
        "panorama/styles/csgostyles.vcss_c",
        "panorama/images/hud/armor.vsvg_c",
        "panorama/images/hud/armor_helmet.vsvg_c",
        "panorama/images/hud/bullet_auto.vsvg_c",
        "panorama/images/hud/bullet_single.vsvg_c",
        "panorama/images/hud/ammo_reserve_magazine.vsvg_c",
        "panorama/images/hud/ammo_fullauto.vsvg_c",
        // weapon icons (weapon select + ammo panel)
        "panorama/images/icons/equipment/ak47.vsvg_c",
        "panorama/images/icons/equipment/knife.vsvg_c",
        "panorama/images/icons/equipment/knife_t.vsvg_c",
        // the real layout/styles, for reference
        "panorama/layout/hud/hudhealthammocenter.vxml_c",
        "panorama/styles/hud/hudhealthammocenter.vcss_c",
        "panorama/layout/hud/hudweaponselection.vxml_c",
        "panorama/styles/hud/hudweaponselection.vcss_c",
        "panorama/layout/hud/hudhealthbars.vxml_c",
        "panorama/styles/hud/hudhealthbars.vcss_c",
        // the chat (ui/chat.js): map / CS2Fixes "Console" messages
        "panorama/layout/hud/hudchat.vxml_c",
        "panorama/styles/hud/hudchat.vcss_c",
        // the radar (ui/radar.js): layout, style, the north indicator and the player icons
        "panorama/layout/hud/hudradar.vxml_c",
        "panorama/styles/hud/hudradar.vcss_c",
        "panorama/images/hud/radar/icon_direction_indicator.vsvg_c",
        "panorama/images/hud/radar/icon-direction-indicator_png.vtex_c",
        "panorama/images/hud/radar/icon-on-map_png.vtex_c",
        "panorama/images/hud/radar/icon-player-indicator_png.vtex_c",
        "panorama/images/hud/radar/icon-selected_png.vtex_c",
        "panorama/images/hud/radar/icon-speaking-on-map_png.vtex_c",
        "panorama/images/hud/radar/icon-ct-ghost_png.vtex_c",
        "panorama/images/hud/radar/icon-enemy-on-map_png.vtex_c",
        "panorama/images/hud/radar/mapoverview/icon-death.vsvg_c",
        "panorama/images/hud/direction_png.vtex_c",
        "panorama/images/icons/ui/map_view_angle.vsvg_c",
        "panorama/images/icons/ui/map_view_selected.vsvg_c",
        "panorama/images/icons/ui/map_death.vsvg_c",
        "panorama/images/icons/ui/map_enemy_offmap.vsvg_c",
        // the kill feed (ui/killfeed.js): CS2's death notices, the no-attacker icons and the modifiers
        "panorama/layout/hud/huddeathnotice.vxml_c",
        "panorama/styles/hud/huddeathnotice.vcss_c",
        "panorama/images/icons/equipment/world.vsvg_c",
        "panorama/images/icons/equipment/worldent.vsvg_c",
        "panorama/images/icons/equipment/trigger_hurt.vsvg_c",
        "panorama/images/icons/equipment/disconnect.vsvg_c",
        "panorama/images/hud/deathnotice/icon_suicide.vsvg_c",
        "panorama/images/hud/deathnotice/icon_headshot.vsvg_c",
        "panorama/images/hud/deathnotice/penetrate.vsvg_c",
        // who is talking (ui/voice-hud.js): CS2's voice status popups and their CT / T speaker icons
        "panorama/layout/hud/hudvoicestatus.vxml_c",
        "panorama/styles/hud/hudvoicestatus.vcss_c",
        "panorama/images/hud/voicestatus/iconct42_png.vtex_c",
        "panorama/images/hud/voicestatus/icont42_png.vtex_c",
        "panorama/images/icons/ui/sound_off.vsvg_c",
        "panorama/images/icons/ui/sound_1.vsvg_c",
        "panorama/images/icons/ui/sound_2.vsvg_c",
        "panorama/images/icons/ui/sound_3.vsvg_c",
        "panorama/images/icons/ui/kill.vsvg_c",
    ];
    // every buyable gun's and the spawn pistol's equipment icon (weapon select + ammo panel): icons/equipment/<vdata name without weapon_>
    static readonly string[] Files = [.. BaseFiles, .. WeaponBake.All.Select(g => $"panorama/images/icons/equipment/{g.Vdata["weapon_".Length..]}.vsvg_c")];

    public static void Run(string cs2, string outDir)
    {
        Directory.CreateDirectory(outDir);
        var pak = new Package();
        pak.Read(Path.Combine(cs2, "pak01_dir.vpk"));
        using var loader = new GameFileLoader(pak, null);
        var ok = 0;
        foreach (var path in Files)
        {
            var entry = pak.FindEntry(path);
            if (entry == null) { Console.WriteLine($"missing {path}"); continue; }
            pak.ReadEntry(entry, out var bytes);
            try
            {
                using var res = new Resource { FileName = path };
                res.Read(new MemoryStream(bytes));
                if (res.DataBlock is Texture tex)
                {
                    // panorama/images/hud/radar/icon-on-map_png.vtex_c -> hud/radar/icon-on-map.png
                    var trel = path["panorama/images/".Length..^"_png.vtex_c".Length] + ".png";
                    using var bmp = tex.GenerateBitmap();
                    using var img = SkiaSharp.SKImage.FromBitmap(bmp);
                    using var png = img.Encode(SkiaSharp.SKEncodedImageFormat.Png, 100);
                    File.WriteAllBytes(SafePath.OutFile(outDir, trel), png.ToArray());
                    ok++;
                    continue;
                }
                using var content = FileExtract.Extract(res, loader);
                if (content.Data == null) { Console.WriteLine($"no data {path}"); continue; }
                // panorama/images/icons/ui/health.vsvg_c -> icons/ui/health.svg
                var rel = path["panorama/".Length..];
                if (rel.StartsWith("images/", StringComparison.Ordinal)) rel = rel["images/".Length..];
                rel = rel[..^2]; // drop _c
                rel = rel.Replace(".vsvg", ".svg").Replace(".vxml", ".xml").Replace(".vcss", ".css");
                File.WriteAllBytes(SafePath.OutFile(outDir, rel), content.Data);
                ok++;
            }
            catch (Exception e)
            {
                Console.WriteLine($"failed {path}: {e.Message}");
            }
        }
        Console.WriteLine($"panorama: {ok}/{Files.Length} files");

        // Stratum2: the font package is a protobuf of encrypted font files.
        var uifont = Path.Combine(cs2, "panorama", "fonts", "stratum2.uifont");
        if (File.Exists(uifont))
        {
            var fontsDir = Path.Combine(outDir, "fonts");
            Directory.CreateDirectory(fontsDir);
            var pkg = new UIFontFilePackage();
            pkg.Read(uifont);
            var n = 0;
            foreach (var f in pkg.FontFiles)
            {
                var name = Path.GetFileName(f.FileName);
                // only what the HUD uses: Stratum2 regular/medium/bold (+ condensed for digits)
                if (!name.StartsWith("stratum2", StringComparison.OrdinalIgnoreCase)) continue;
                File.WriteAllBytes(SafePath.OutFile(fontsDir, name), f.OpenTypeFontData);
                n++;
            }
            Console.WriteLine($"fonts: {n} Stratum2 files -> {fontsDir}");
        }
        else Console.WriteLine($"no {uifont}");
    }
}
