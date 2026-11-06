// The 3D skybox of a Source 1 map: what the sky_camera sees is the area (dleaf_t area) it stands in, drawn behind the
// world at its scale (Source's view setup renders the area of the sky camera's leaf from skyOrigin + eye / scale).
// Each entity in that area gets "_s1sky": "<x> <y> <z> <scale>" (the sky camera's origin and scale), which the
// player's engine turns into e.sky, the 3D skybox path the CS2 skybox_reference worlds already use
// (web/src/world/skybox.js skyMatrix, render.js skyMeshes). Where an entity is: its origin (+ its template's origin for
// a template member, as StampAmbient places them), + its brush model's centre (a brush entity without an origin
// brush has origin 0 0 0 and world-space bounds).
// ze_xenovation_v3_5's ending spawns break29, an unlit grey box around its sky camera, which fills the whole sky.
// UNSETTLED: the area's world brushwork isn't drawn as sky (only its entities); it is cropped away with the rest.
using System.Globalization;
using System.Numerics;
using System.Text.Json.Nodes;

namespace Lasers.Bake.Source1;

static class SkyArea
{
    public static int Stamp(JsonObject lumps, Bsp bsp, string mapName, Action<string> log)
    {
        static Vector3 Vec(string? s)
        {
            var p = (s ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries);
            var v = new float[3];
            for (var i = 0; i < 3 && i < p.Length; i++) float.TryParse(p[i], NumberStyles.Float, CultureInfo.InvariantCulture, out v[i]);
            return new Vector3(v[0], v[1], v[2]);
        }
        JsonObject? cam = null;
        foreach (var d in lumps["default_ents"]?.AsArray() ?? [])
            if (d?["kv"] is JsonObject kv && string.Equals(kv["classname"]?.GetValue<string>(), "sky_camera", StringComparison.OrdinalIgnoreCase)) { cam = kv; break; }
        if (cam == null) return 0;
        var camAt = Vec(cam["origin"]?.GetValue<string>());
        var scale = float.TryParse(cam["scale"]?.GetValue<string>(), NumberStyles.Float, CultureInfo.InvariantCulture, out var s) && s > 0 && s <= 1024 ? s : 16;
        var area = AreaAt(bsp, camAt);
        if (area <= 0) { log("sky: sky_camera is in no area"); return 0; }
        var stamp = string.Join(' ', new[] { camAt.X, camAt.Y, camAt.Z, scale }.Select(f => f.ToString(CultureInfo.InvariantCulture)));
        var tplOrigin = new Dictionary<string, Vector3>(StringComparer.OrdinalIgnoreCase);
        foreach (var d in lumps["default_ents"]!.AsArray())
            if (d?["kv"]?["entitylumpname"]?.GetValue<string>() is { } ln) tplOrigin[ln] = Vec(d["kv"]?["origin"]?.GetValue<string>());
        var prefix = $"maps/{mapName}/entities/brush_";
        var n = 0;
        foreach (var (lump, arr) in lumps)
            foreach (var d in arr!.AsArray())
            {
                var kv = d?["kv"]?.AsObject();
                if (kv == null || string.Equals(kv["classname"]?.GetValue<string>(), "sky_camera", StringComparison.OrdinalIgnoreCase)) continue;
                var at = Vec(kv["origin"]?.GetValue<string>()) + (lump == "default_ents" ? Vector3.Zero : tplOrigin.GetValueOrDefault(lump));
                if (kv["model"]?.GetValue<string>() is { } mp && mp.StartsWith(prefix) && int.TryParse(mp[prefix.Length..^5], out var bm) && bm > 0 && bm < bsp.Models.Length)
                    at += (bsp.Models[bm].Mins + bsp.Models[bm].Maxs) / 2;
                if (AreaAt(bsp, at) != area) continue;
                kv["_s1sky"] = stamp;
                n++;
            }
        log($"sky: 3D skybox area {area} (sky_camera scale {scale}), {n} entities");
        return n;
    }

    // the area of the world leaf holding p (dleaf_t: area is the low 9 bits of the short at byte 6), -1 outside
    static int AreaAt(Bsp bsp, Vector3 p)
    {
        if (bsp.Models.Length == 0) return -1;
        var node = bsp.Models[0].HeadNode;
        for (var guard = 0; node >= 0 && guard < 4096; guard++)
        {
            if (node >= bsp.Nodes.Length) return -1;
            var nd = bsp.Nodes[node];
            if (nd.Plane < 0 || nd.Plane >= bsp.Planes.Length) return -1;
            var pl = bsp.Planes[nd.Plane];
            node = Vector3.Dot(pl.Normal, p) - pl.Dist >= 0 ? nd.Child0 : nd.Child1;
        }
        var leaf = node < 0 ? -1 - node : -1;
        return leaf >= 0 && leaf < bsp.Leafs.Length ? bsp.Leafs[leaf].Area : -1;
    }
}
