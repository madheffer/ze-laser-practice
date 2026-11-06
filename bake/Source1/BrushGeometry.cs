// Brushes -> what the game collides with: each brush is a convex solid (its sides' planes), so a brush entity's
// hulls.json entry is one hull per brush, and the world's collision.bin is every player-solid brush's faces.
// A brush's polygon per side comes from clipping a large quad on that side's plane by every other side's plane;
// bevel sides (vbsp's added axial planes for box traces) bound the solid but make no polygon of their own.
// Brushes of a model are the ones its BSP tree reaches (model headnode -> leaves -> leafbrushes).
using System.Numerics;
using System.Text.Json.Nodes;

namespace Lasers.Bake.Source1;

static class BrushGeometry
{
    const float Big = 65536;

    // Contents a player stands on / is blocked by (CS's MASK_PLAYERSOLID: solid, window, grate, moveable, playerclip)
    public const int PlayerSolid = Bsp.ContentsSolid | Bsp.ContentsWindow | Bsp.ContentsGrate | Bsp.ContentsMoveable | Bsp.ContentsPlayerClip;

    // CS2 interaction-layer bits (Program.cs LayerNames) for a brush's contents, as a CS2 port of the brush would carry
    public static uint Layers(int contents)
    {
        uint b = 0;
        if ((contents & (Bsp.ContentsSolid | Bsp.ContentsMoveable)) != 0) b |= 1u << 0;
        if ((contents & Bsp.ContentsPlayerClip) != 0) b |= 1u << 4;
        if ((contents & Bsp.ContentsMonsterClip) != 0) b |= 1u << 5;
        if ((contents & Bsp.ContentsLadder) != 0) b |= 1u << 8;
        if ((contents & Bsp.ContentsWindow) != 0) b |= 1u << 12;
        if ((contents & Bsp.ContentsGrate) != 0) b |= 1u << 13;
        if ((contents & Bsp.ContentsWater) != 0) b |= 1u << 15;
        if ((contents & Bsp.ContentsSlime) != 0) b |= 1u << 16;
        return b;
    }

    public static List<int> BrushesOf(Bsp bsp, int model)
    {
        var seen = new HashSet<int>();
        var stack = new Stack<int>();
        if (model < 0 || model >= bsp.Models.Length) return [];
        stack.Push(bsp.Models[model].HeadNode);
        var guard = 0;
        while (stack.Count > 0 && guard++ < 4_000_000)
        {
            var n = stack.Pop();
            if (n >= 0)
            {
                if (n >= bsp.Nodes.Length) continue;
                stack.Push(bsp.Nodes[n].Child0);
                stack.Push(bsp.Nodes[n].Child1);
                continue;
            }
            var li = -1 - n;
            if (li >= bsp.Leafs.Length) continue;
            var leaf = bsp.Leafs[li];
            for (var k = 0; k < leaf.NumLeafBrushes; k++)
            {
                var idx = leaf.FirstLeafBrush + k;
                if (idx >= 0 && idx < bsp.LeafBrushes.Length && bsp.LeafBrushes[idx] < bsp.Brushes.Length) seen.Add(bsp.LeafBrushes[idx]);
            }
        }
        return [.. seen.Order()];
    }

    public sealed record Poly(List<Vector3> Verts, int TexInfo, Vector3 Normal);

    // The brush's sides as polygons (non-bevel sides with any area), and every side's plane (bevels included).
    public static (List<Poly> Polys, List<Bsp.Plane> Planes) Solid(Bsp bsp, int brush)
    {
        var b = bsp.Brushes[brush];
        var sides = new List<Bsp.BrushSide>();
        for (var s = 0; s < b.NumSides; s++)
        {
            var i = b.FirstSide + s;
            if (i >= 0 && i < bsp.BrushSides.Length && bsp.BrushSides[i].Plane < bsp.Planes.Length) sides.Add(bsp.BrushSides[i]);
        }
        var planes = sides.Select(s => bsp.Planes[s.Plane]).ToList();
        var polys = new List<Poly>();
        for (var s = 0; s < sides.Count; s++)
        {
            if (sides[s].Bevel) continue;
            var p = planes[s];
            var w = BaseWinding(p);
            for (var o = 0; o < planes.Count && w.Count >= 3; o++)
                if (o != s) w = Clip(w, planes[o]);
            if (w.Count >= 3) polys.Add(new Poly(w, sides[s].TexInfo, p.Normal));
        }
        return (polys, planes);
    }

    // hulls.json entry for a brush model: one convex hull per brush (verts, planes as n.x n.y n.z d, solid, layers)
    public static JsonArray Hulls(Bsp bsp, int model, bool trigger, Vector3 offset)
    {
        var list = new JsonArray();
        foreach (var br in BrushesOf(bsp, model))
        {
            var (polys, planes) = Solid(bsp, br);
            if (polys.Count < 4) continue;
            var verts = new JsonArray();
            var uniq = new List<Vector3>();
            foreach (var v in polys.SelectMany(p => p.Verts))
                if (!uniq.Any(u => Vector3.DistanceSquared(u, v) < 0.01f)) uniq.Add(v);
            foreach (var v in uniq) { verts.Add(R(v.X - offset.X)); verts.Add(R(v.Y - offset.Y)); verts.Add(R(v.Z - offset.Z)); }
            var pl = new JsonArray();
            foreach (var p in planes) { pl.Add(R(p.Normal.X)); pl.Add(R(p.Normal.Y)); pl.Add(R(p.Normal.Z)); pl.Add(R(p.Dist - Vector3.Dot(p.Normal, offset))); }
            var contents = bsp.Brushes[br].Contents;
            list.Add(new JsonObject
            {
                ["verts"] = verts,
                ["planes"] = pl,
                ["solid"] = !trigger && (contents & PlayerSolid) != 0,
                ["layers"] = trigger ? 0 : Layers(contents),
            });
        }
        return list;
    }

    // collision triangles (9 floats each) of a model's brushes whose contents meet `mask`, with each triangle's layers
    public static void Triangles(Bsp bsp, int model, int mask, List<float> tris, List<uint>? layers)
    {
        foreach (var br in BrushesOf(bsp, model))
        {
            var contents = bsp.Brushes[br].Contents;
            if ((contents & mask) == 0) continue;
            var lb = Layers(contents);
            foreach (var p in Solid(bsp, br).Polys)
            {
                // a sky face is CS2's sky layer (bullets stop on it, particles pass), not solid
                var flags = p.TexInfo >= 0 && p.TexInfo < bsp.TexInfos.Length ? bsp.TexInfos[p.TexInfo].Flags : 0;
                var l = (flags & (Bsp.SurfSky | Bsp.SurfSky2d)) != 0 ? (lb & ~1u) | 1u << 3 : lb;
                Fan(p.Verts, tris);
                for (var k = 2; k < p.Verts.Count; k++) layers?.Add(l);
            }
        }
    }

    public static void Fan(List<Vector3> w, List<float> tris)
    {
        for (var k = 2; k < w.Count; k++)
        {
            Add(tris, w[0]); Add(tris, w[k - 1]); Add(tris, w[k]);
        }
    }

    static void Add(List<float> t, Vector3 v) { t.Add(v.X); t.Add(v.Y); t.Add(v.Z); }

    // A quad on the plane, counter-clockwise about its normal (Source's BaseWindingForPlane, reversed: glTF winding)
    static List<Vector3> BaseWinding(Bsp.Plane p)
    {
        var n = p.Normal;
        var ax = Math.Abs(n.X) >= Math.Abs(n.Y) && Math.Abs(n.X) >= Math.Abs(n.Z) ? 0 : Math.Abs(n.Y) >= Math.Abs(n.Z) ? 1 : 2;
        var up = ax == 2 ? Vector3.UnitX : Vector3.UnitZ;
        up = Vector3.Normalize(up - n * Vector3.Dot(up, n));
        var org = n * p.Dist;
        var right = Vector3.Cross(up, n) * Big;
        up *= Big;
        return [org - right - up, org + right - up, org + right + up, org - right + up];
    }

    // keep the part behind the plane (inside the brush)
    static List<Vector3> Clip(List<Vector3> w, Bsp.Plane p)
    {
        const float Eps = 0.01f;
        var o = new List<Vector3>(w.Count + 2);
        for (var i = 0; i < w.Count; i++)
        {
            var a = w[i];
            var b = w[(i + 1) % w.Count];
            float da = Vector3.Dot(a, p.Normal) - p.Dist, db = Vector3.Dot(b, p.Normal) - p.Dist;
            if (da <= Eps) o.Add(a);
            if ((da > Eps && db < -Eps) || (da < -Eps && db > Eps))
                o.Add(Vector3.Lerp(a, b, da / (da - db)));
        }
        return o;
    }

    static float R(float v) => MathF.Round(v, 3);
}
