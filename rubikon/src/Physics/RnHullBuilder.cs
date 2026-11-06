using System.Numerics;

namespace Source2.Compiler.Physics;

// The two pieces of source2-compiler's RnHullBuilder (src/Source2.Compiler/Physics/RnHullBuilder.cs at a12333d) a hull
// loaded from a compiled model needs (the load's post pass, FUN_1801314f0): the rest builds hulls, which the game never does.
public static class RnHullBuilder
{
    // FUN_1801302f0
    internal static void CentroidRadius(RnHull hull)
    {
        var min = float.MaxValue;
        var c = hull.Centroid;
        foreach (var (n, d) in hull.Planes)
        {
            var dist = -((((n.Z * c.Z) + (n.Y * c.Y)) + (n.X * c.X)) - d);
            if (dist <= min)
                min = dist;
        }
        hull.MinCentroidRadius = min;
    }

    // FUN_18012ffd0: area by fanning each face from its first corner.
    internal static void Areas(RnHull hull)
    {
        float area = 0f, ox = 0f, oy = 0f, oz = 0f;
        var p = hull.VertexPositions;
        var edges = hull.Edges;
        foreach (var fe in hull.Faces)
        {
            var first = fe;
            var a = p[edges[first].Origin];
            var b = edges[first].Next;
            var c = edges[b].Next;
            while (true)
            {
                var pb = p[edges[b].Origin];
                var pc = p[edges[c].Origin];
                var ux = pb.X - a.X;
                var uy = pb.Y - a.Y;
                var uz = pb.Z - a.Z;
                var vx = pc.X - a.X;
                var vy = pc.Y - a.Y;
                var vz = pc.Z - a.Z;
                var cxv = ((uy * vz) - (uz * vy)) * 0.5f;
                var cyv = ((vx * uz) - (ux * vz)) * 0.5f;
                var czv = ((ux * vy) - (vx * uy)) * 0.5f;
                var len = MathF.Sqrt(((czv * czv) + (cyv * cyv)) + (cxv * cxv));
                if (cyv <= 0f) cyv = 0f;
                if (czv <= 0f) czv = 0f;
                if (cxv <= 0f) cxv = 0f;
                area = area + len;
                var next = edges[c].Next;
                oy = oy + cyv;
                oz = oz + czv;
                ox = ox + cxv;
                b = c;
                c = next;
                if (first == next)
                    break;
            }
        }
        var dy = hull.BoundsMax.Y - hull.BoundsMin.Y;
        var dx = hull.BoundsMax.X - hull.BoundsMin.X;
        hull.SurfaceArea = area;
        var dz = hull.BoundsMax.Z - hull.BoundsMin.Z;
        ox = (1f / (dz * dy)) * ox;
        oy = (1f / (dz * dx)) * oy;
        if (1f <= ox) ox = 1f;
        oz = (1f / (dy * dx)) * oz;
        if (1f <= oy) oy = 1f;
        if (1f <= oz) oz = 1f;
        hull.OrthographicAreas = new Vector3(ox, oy, oz);
    }
}
