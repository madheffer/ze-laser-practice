// How Source 1 lights a model: the ambient cube vrad baked for the leaf it stands in (LUMP_LEAF_AMBIENT_INDEX(_HDR) +
// LUMP_LEAF_AMBIENT_LIGHTING(_HDR): per leaf, samples of a CompressedLightCube, 6 ColorRGBExp32 for +X -X +Y -Y +Z -Z,
// at a position given as 0..255 fractions of the leaf's bounds). A point finds its leaf down the world's BSP tree and
// takes the nearest sample; a normal n gets sum over axes of n_i^2 x the face it points at (Source's ambient cube
// lighting). Linear light, 1 = the texture as authored. Leaves with no samples give a neutral grey.
using System.Numerics;

namespace Lasers.Bake.Source1;

sealed class AmbientLight
{
    const int LeafAmbientIndexHdr = 51, LeafAmbientIndex = 52, LeafAmbientHdr = 55, LeafAmbient = 56;
    readonly Bsp bsp;
    readonly (int Count, int First)[] index;
    readonly (Vector3[] Cube, byte X, byte Y, byte Z)[] samples;
    readonly (Vector3 Min, Vector3 Max)[] leafBounds;

    public AmbientLight(Bsp b)
    {
        bsp = b;
        var hdr = b.Lumps[LeafAmbientHdr].Len > 0 && b.Lumps[LeafAmbientIndexHdr].Len > 0;
        var (io, il) = b.Lumps[hdr ? LeafAmbientIndexHdr : LeafAmbientIndex];
        var (so, sl) = b.Lumps[hdr ? LeafAmbientHdr : LeafAmbient];
        var d = b.Data;
        index = new (int, int)[il / 4];
        for (var i = 0; i < index.Length; i++) index[i] = (Bsp.U16(d, io + i * 4), Bsp.U16(d, io + i * 4 + 2));
        samples = new (Vector3[], byte, byte, byte)[sl / 28];
        for (var i = 0; i < samples.Length; i++)
        {
            var o = so + i * 28;
            var cube = new Vector3[6];
            for (var f = 0; f < 6; f++)
            {
                // ColorRGBExp32ToVector: c x 2^exp, NOT over 255 (that's the lightmap pages' scale): the cube is used as is
                var e = MathF.Pow(2, (sbyte)d[o + f * 4 + 3]);
                cube[f] = new Vector3(d[o + f * 4], d[o + f * 4 + 1], d[o + f * 4 + 2]) * e;
            }
            samples[i] = (cube, d[o + 24], d[o + 25], d[o + 26]);
        }
        var (lo, ll) = b.Lumps[Bsp.LumpLeafs];
        var size = b.Version >= 20 ? 32 : 56;
        leafBounds = new (Vector3, Vector3)[ll / size];
        for (var i = 0; i < leafBounds.Length; i++)
        {
            var o = lo + i * size + 8;
            leafBounds[i] = (new(Bsp.S16(d, o), Bsp.S16(d, o + 2), Bsp.S16(d, o + 4)), new(Bsp.S16(d, o + 6), Bsp.S16(d, o + 8), Bsp.S16(d, o + 10)));
        }
    }

    public bool Has => samples.Length > 0;

    int LeafOf(Vector3 p)
    {
        if (bsp.Models.Length == 0) return -1;
        var n = bsp.Models[0].HeadNode;
        for (var guard = 0; n >= 0 && guard < 4096; guard++)
        {
            if (n >= bsp.Nodes.Length) return -1;
            var node = bsp.Nodes[n];
            if (node.Plane < 0 || node.Plane >= bsp.Planes.Length) return -1;
            var pl = bsp.Planes[node.Plane];
            n = Vector3.Dot(pl.Normal, p) - pl.Dist >= 0 ? node.Child0 : node.Child1;
        }
        return n < 0 ? -1 - n : -1;
    }

    // the ambient cube at p (+X -X +Y -Y +Z -Z)
    public Vector3[] Cube(Vector3 p)
    {
        var leaf = LeafOf(p);
        if (leaf < 0 || leaf >= index.Length) return Grey();
        var (count, first) = index[leaf];
        if (count == 0) return Grey();
        var (mn, mx) = leaf < leafBounds.Length ? leafBounds[leaf] : (p, p);
        Vector3[]? best = null;
        var bestD = float.MaxValue;
        for (var i = first; i < first + count && i < samples.Length; i++)
        {
            var s = samples[i];
            var at = mn + (mx - mn) * new Vector3(s.X, s.Y, s.Z) / 255f;
            var dd = Vector3.DistanceSquared(at, p);
            if (dd < bestD) { bestD = dd; best = s.Cube; }
        }
        return best ?? Grey();
    }

    // ---- world lights (LUMP_WORLDLIGHTS_HDR 54, else 15; CS:GO's dworldlight_t is 100 bytes: shadow_cast_offset added)
    // A model's light in Source is the leaf cube plus the world lights' direct light; lights it doesn't light
    // dynamically are folded into its cube by direction (AddWorldLightToAmbientCube: face i += max(0, n_i . L) x
    // intensity x falloff). Here every visible point / spot light is folded, at bake time. Falloff: 1 / (constant +
    // linear d + quadratic d^2), a point light's radius as a cut-off, a spot's cone from stopdot2 (0) to stopdot (full)
    // raised to its exponent. Visible = a line from the light to the point crosses no solid leaf (TraceSolid).
    // Not folded: emit_surface, the sky lights (skylight would need a trace to the sky) and light styles.
    public sealed record WorldLight(Vector3 Origin, Vector3 Intensity, Vector3 Normal, int Type, float StopDot, float StopDot2,
        float Exponent, float Radius, float C, float L, float Q);

    List<WorldLight>? lights;
    List<WorldLight> Lights()
    {
        if (lights != null) return lights;
        lights = [];
        var (o, len) = bsp.Lumps[54].Len > 0 ? bsp.Lumps[54] : bsp.Lumps[15];
        var size = bsp.Version >= 21 ? 100 : 88;
        var off = size == 100 ? 12 : 0; // the fields after normal move down 12 with shadow_cast_offset
        var d = bsp.Data;
        for (var i = 0; i < len / size; i++)
        {
            var q = o + i * size;
            lights.Add(new WorldLight(Bsp.V3(d, q), Bsp.V3(d, q + 12), Bsp.V3(d, q + 24), Bsp.I(d, q + 40 + off),
                Bsp.F(d, q + 48 + off), Bsp.F(d, q + 52 + off), Bsp.F(d, q + 56 + off), Bsp.F(d, q + 60 + off),
                Bsp.F(d, q + 64 + off), Bsp.F(d, q + 68 + off), Bsp.F(d, q + 72 + off)));
        }
        return lights;
    }

    static readonly Vector3[] Axes = [Vector3.UnitX, -Vector3.UnitX, Vector3.UnitY, -Vector3.UnitY, Vector3.UnitZ, -Vector3.UnitZ];

    // the leaf cube with the visible world lights folded in: what lights a model at p
    public Vector3[] LitCube(Vector3 p)
    {
        var cube = Cube(p).ToArray();
        foreach (var l in Lights())
        {
            if (l.Type is not (1 or 2)) continue; // emit_point, emit_spotlight
            var delta = l.Origin - p;
            var dist = delta.Length();
            if (dist < 1) continue;
            if (l.Radius > 0 && dist > l.Radius) continue;
            var dir = delta / dist;
            var denom = l.C + l.L * dist + l.Q * dist * dist;
            if (denom <= 0) continue;
            var ratio = 1 / denom;
            if (l.Type == 2)
            {
                var dot = -Vector3.Dot(dir, l.Normal);
                if (dot <= l.StopDot2) continue;
                if (dot < l.StopDot)
                {
                    var t = (dot - l.StopDot2) / Math.Max(1e-4f, l.StopDot - l.StopDot2);
                    ratio *= l.Exponent > 0 && l.Exponent != 1 ? MathF.Pow(t, l.Exponent) : t;
                }
            }
            var mag = ratio * Math.Max(l.Intensity.X, Math.Max(l.Intensity.Y, l.Intensity.Z));
            if (mag < 1e-4f) continue; // too faint to see: skip the trace
            if (TraceSolid(l.Origin, p)) continue;
            for (var i = 0; i < 6; i++)
            {
                var t = Vector3.Dot(Axes[i], dir);
                if (t > 0) cube[i] += l.Intensity * (t * ratio);
            }
        }
        return cube;
    }

    // does the segment a -> b cross a solid leaf of the world's BSP? (Source's line trace, contents only)
    public bool TraceSolid(Vector3 a, Vector3 b) => bsp.Models.Length > 0 && Hits(bsp.Models[0].HeadNode, a, b, 0);

    bool Hits(int node, Vector3 a, Vector3 b, int depth)
    {
        if (depth > 256) return false;
        if (node < 0)
        {
            var leaf = -1 - node;
            return leaf < bsp.Leafs.Length && (bsp.Leafs[leaf].Contents & Bsp.ContentsSolid) != 0;
        }
        if (node >= bsp.Nodes.Length) return false;
        var n = bsp.Nodes[node];
        if (n.Plane < 0 || n.Plane >= bsp.Planes.Length) return false;
        var pl = bsp.Planes[n.Plane];
        float da = Vector3.Dot(pl.Normal, a) - pl.Dist, db = Vector3.Dot(pl.Normal, b) - pl.Dist;
        if (da >= 0 && db >= 0) return Hits(n.Child0, a, b, depth + 1);
        if (da < 0 && db < 0) return Hits(n.Child1, a, b, depth + 1);
        var mid = Vector3.Lerp(a, b, da / (da - db));
        var (near, far) = da >= 0 ? (n.Child0, n.Child1) : (n.Child1, n.Child0);
        return Hits(near, a, mid, depth + 1) || Hits(far, mid, b, depth + 1);
    }

    public static Vector3 Eval(Vector3[] cube, Vector3 n)
    {
        var n2 = n * n;
        return n2.X * cube[n.X >= 0 ? 0 : 1] + n2.Y * cube[n.Y >= 0 ? 2 : 3] + n2.Z * cube[n.Z >= 0 ? 4 : 5];
    }

    static Vector3[] Grey() => [.. Enumerable.Repeat(new Vector3(0.5f), 6)];
}
