// The map's light probes, for lighting what has no lightmap (props, moving models) the way CS2 does (VRF:
// Renderer/Shaders/common/lighting_lpv.slang): each env_combined_light_probe_volume / env_light_probe_volume is a
// grid of ambient cubes (6 faces: +X +Y +Z -X -Y -Z), packed into one atlas, env_light_probe_volume_atlas (a BC6H
// volume texture: depth = 6 x the atlas's probe depth, the faces in six consecutive blocks), plus a BC7 volume of
// baked light-shadow masks (_dlshd, one per probe).
//
// The full probe grids are millions of probes (tens to hundreds of MB), so each volume's grid is box-filtered down by
// DOWN on every axis (the average light of each 4 x 4 x 4 block) and saved as half floats:
//   lighting/probes/probes.json  [{ index, handshake, dims, file }] (index = the volume's order in entities.json)
//   lighting/probes/<index>.bin  RGBA16F, x fastest, then y, then z, faces in six blocks of z (face-major, as CS2):
//                                rgb = the face's irradiance, a = the sun's baked visibility at that probe (1 = lit)
// Volume sizes come from the map's own entities (entities.json, already in the map folder); every number is checked
// against the atlas's size before a texel is read.
using System.Text.Json;
using System.Text.Json.Nodes;
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.ResourceTypes;

namespace Lasers.Bake;

static class ProbeBake
{
    const int DOWN = 4;
    const int MaxVolumes = 256;
    const long MaxProbes = 64L * 1024 * 1024;

    static int Int(JsonObject kv, string k) => kv.TryGetPropertyValue(k, out var v) && int.TryParse(v?.ToString(), out var n) ? n : -1;

    public static JsonArray? Write(Func<string, Resource?> load, string mapName, string mapDir, string outDir, Action<string> log)
    {
        var entPath = Path.Combine(mapDir, "entities.json");
        if (!File.Exists(entPath)) { log("  probes: no entities.json"); return null; }
        var ents = JsonNode.Parse(File.ReadAllText(entPath))?["lumps"]?.AsObject();
        if (ents == null) return null;
        var all = ents.SelectMany(l => l.Value?.AsArray() ?? []).Select(e => e?["kv"]?.AsObject()).Where(kv => kv != null).Cast<JsonObject>().ToList();
        var vols = all.Where(kv => kv["classname"]?.ToString() is "env_combined_light_probe_volume" or "env_light_probe_volume").ToList();
        if (vols.Count == 0 || vols.Count > MaxVolumes) { log($"  probes: {vols.Count} volumes"); return null; }
        // the sun's channel in the shadow masks (light_environment bakedshadowindex: 0 R .. 3 A)
        var env = all.FirstOrDefault(kv => kv["classname"]?.ToString() == "light_environment");
        var sunCh = env == null ? -1 : Int(env, "bakedshadowindex") is >= 0 and <= 3 and var s ? s : Int(env, "bakelightindex");

        using var atlasRes = load($"maps/{mapName}/lightmaps/env_light_probe_volume_atlas.vtex_c");
        using var shadowRes = load($"maps/{mapName}/lightmaps/env_light_probe_volume_atlas_dlshd.vtex_c");
        if (atlasRes?.DataBlock is not Texture atlas || atlas.Depth % 6 != 0) { log("  probes: no atlas"); return null; }
        var shadows = shadowRes?.DataBlock as Texture;
        int W = atlas.Width, H = atlas.Height, D6 = atlas.Depth / 6;
        if (shadows != null && (shadows.Width != W || shadows.Height != H || shadows.Depth != D6)) shadows = null;

        // decoded slices, kept while consecutive volumes reuse them
        var cache = new Dictionary<(bool, int), float[]>();
        float[] Slice(bool shadow, int z)
        {
            if (cache.TryGetValue((shadow, z), out var f)) return f;
            if (cache.Count > 64) cache.Clear();
            var tex = shadow ? shadows! : atlas;
            using var bmp = tex.GenerateBitmap(depth: (uint)z, face: Texture.CubemapFace.PositiveX, mipLevel: 0);
            var px = new float[W * H * 4];
            if (bmp.ColorType == SkiaSharp.SKColorType.RgbaF32) System.Runtime.InteropServices.MemoryMarshal.Cast<byte, float>(bmp.GetPixelSpan()).CopyTo(px);
            else { var b = bmp.GetPixelSpan(); for (var i = 0; i < W * H * 4; i++) px[i] = b[i] / 255f; } // 8-bit (the shadow masks)
            cache[(shadow, z)] = px;
            return px;
        }

        var dir = Path.Combine(outDir, "probes");
        Directory.CreateDirectory(dir);
        var index = new JsonArray();
        long probes = 0;
        for (var vi = 0; vi < vols.Count; vi++)
        {
            var kv = vols[vi];
            int sx = Int(kv, "light_probe_size_x"), sy = Int(kv, "light_probe_size_y"), sz = Int(kv, "light_probe_size_z");
            int ax = Int(kv, "light_probe_atlas_x"), ay = Int(kv, "light_probe_atlas_y"), az = Int(kv, "light_probe_atlas_z");
            if (sx < 1 || sy < 1 || sz < 1 || ax < 0 || ay < 0 || az < 0 || ax + sx > W || ay + sy > H || az + sz > D6) { log($"  probes: volume {vi} doesn't fit the atlas"); continue; }
            if ((probes += (long)sx * sy * sz) > MaxProbes) { log("  probes: too many"); break; }
            int gx = (sx + DOWN - 1) / DOWN, gy = (sy + DOWN - 1) / DOWN, gz = (sz + DOWN - 1) / DOWN;
            var acc = new double[gx * gy * gz * 6 * 4];
            var cnt = new int[gx * gy * gz];
            var sun = new double[gx * gy * gz];
            for (var k = 0; k < sz; k++)
            {
                var gk = k / DOWN;
                var sh = shadows != null && sunCh >= 0 ? Slice(true, az + k) : null;
                for (var f = 0; f < 6; f++)
                {
                    var px = Slice(false, f * D6 + az + k);
                    for (var j = 0; j < sy; j++)
                        for (var i = 0; i < sx; i++)
                        {
                            var src = ((ay + j) * W + ax + i) * 4;
                            var cell = (gk * gy + j / DOWN) * gx + i / DOWN;
                            var dst = ((f * gz + gk) * gy * gx + (j / DOWN) * gx + i / DOWN) * 4;
                            for (var c = 0; c < 3; c++) { var v = px[src + c]; acc[dst + c] += float.IsFinite(v) ? v : 0; }
                            if (f == 0)
                            {
                                cnt[cell]++;
                                sun[cell] += sh == null ? 1 : 1 - Math.Clamp(sh[src + sunCh], 0f, 1f);
                            }
                        }
                }
            }
            var half = new Half[acc.Length];
            for (var f = 0; f < 6; f++)
                for (var cell = 0; cell < gx * gy * gz; cell++)
                {
                    var n = Math.Max(1, cnt[cell]);
                    var dst = (f * gx * gy * gz + cell) * 4;
                    for (var c = 0; c < 3; c++) half[dst + c] = (Half)(acc[dst + c] / n);
                    half[dst + 3] = (Half)(sun[cell] / n);
                }
            var bytes = new byte[half.Length * 2];
            System.Runtime.InteropServices.MemoryMarshal.Cast<Half, byte>(half).CopyTo(bytes);
            File.WriteAllBytes(SafePath.OutFile(dir, $"{vi}.bin"), bytes);
            index.Add(new JsonObject { ["index"] = vi, ["handshake"] = kv["handshake"]?.ToString() ?? "", ["dims"] = new JsonArray(gx, gy, gz), ["file"] = $"{vi}.bin", ["bytes"] = bytes.Length });
        }
        log($"  probes: {index.Count} volumes, {probes} probes -> 1/{DOWN} per axis");
        return index;
    }
}
