// A studio model's collision (.phy: VCollide) as convex pieces in model space. Header (16 bytes: size, id, solid
// count, checksum), then per solid its size and an IVP compact surface, after a 28-byte "VPHY" header in newer files.
// The surface's ledge tree (28-byte nodes: right-child offset 0 = a leaf) holds the convex ledges at its leaves; a
// ledge (16-byte header: point offset, client data, flags, triangle count) is followed by 16-byte triangles whose
// edges name 16-byte points. IVP space is metres, Y down: Source = (x, z, -y) / 0.0254 (vphysics ConvertPositionToHL).
// Attacker-made data: every offset is checked; a bad solid is skipped.
using System.Numerics;

namespace Lasers.Bake.Source1;

static class PhyFile
{
    const float MetersToInches = 1 / 0.0254f;

    // each convex piece: its triangles (3 points each, counter-clockwise seen from outside)
    public static List<List<Vector3>> Read(byte[]? d, int maxSolids = 1)
    {
        var pieces = new List<List<Vector3>>();
        if (d == null || d.Length < 16) return pieces;
        int headerSize = I(d, 0), solids = I(d, 8);
        var p = headerSize;
        for (var s = 0; s < solids && s < maxSolids && p + 4 <= d.Length; s++)
        {
            var size = I(d, p);
            var start = p + 4;
            p = start + size;
            if (size <= 0 || p > d.Length) break;
            var surf = start + (d[start] == 'V' && d[start + 1] == 'P' && d[start + 2] == 'H' && d[start + 3] == 'Y' ? 28 : 0);
            try { Ledges(d, surf, surf + I(d, surf + 32), pieces, 0); }
            catch (InvalidDataException) { }
        }
        return pieces;
    }

    static void Ledges(byte[] d, int surf, int node, List<List<Vector3>> pieces, int depth)
    {
        if (depth > 64 || pieces.Count > 4096) return;
        Check(d, node, 28);
        int right = I(d, node), ledgeOfs = I(d, node + 4);
        if (right != 0)
        {
            Ledges(d, surf, node + 28, pieces, depth + 1);
            Ledges(d, surf, node + right, pieces, depth + 1);
            return;
        }
        var ledge = node + ledgeOfs;
        Check(d, ledge, 16);
        int pointOfs = I(d, ledge), tris = BitConverter.ToInt16(d, ledge + 12);
        if (tris <= 0 || tris > 65536) return;
        Check(d, ledge + 16, tris * 16);
        var pts = new List<Vector3>(tris * 3);
        for (var t = 0; t < tris; t++)
        {
            var tri = ledge + 16 + t * 16;
            for (var e = 0; e < 3; e++)
            {
                var idx = BitConverter.ToUInt16(d, tri + 4 + e * 4);
                var pt = ledge + pointOfs + idx * 16;
                Check(d, pt, 12);
                float x = BitConverter.ToSingle(d, pt), y = BitConverter.ToSingle(d, pt + 4), z = BitConverter.ToSingle(d, pt + 8);
                pts.Add(new Vector3(x, z, -y) * MetersToInches);
            }
        }
        // wind every triangle to face away from the piece's centre (IVP's own winding, read through the axis swap,
        // is not relied on)
        var c = Vector3.Zero;
        foreach (var v in pts) c += v;
        c /= pts.Count;
        for (var i = 0; i + 2 < pts.Count; i += 3)
        {
            var n = Vector3.Cross(pts[i + 1] - pts[i], pts[i + 2] - pts[i]);
            if (Vector3.Dot(n, pts[i] - c) < 0) (pts[i + 1], pts[i + 2]) = (pts[i + 2], pts[i + 1]);
        }
        pieces.Add(pts);
    }

    // a convex piece as hulls.json wants it: unique verts and its planes (n.x n.y n.z d), model space
    public static (List<Vector3> Verts, List<Vector4> Planes) Hull(List<Vector3> tris)
    {
        var verts = new List<Vector3>();
        foreach (var v in tris) if (!verts.Any(u => Vector3.DistanceSquared(u, v) < 0.01f)) verts.Add(v);
        var planes = new List<Vector4>();
        for (var i = 0; i + 2 < tris.Count; i += 3)
        {
            var n = Vector3.Cross(tris[i + 1] - tris[i], tris[i + 2] - tris[i]);
            if (n.LengthSquared() < 1e-8f) continue;
            n = Vector3.Normalize(n);
            var pl = new Vector4(n, Vector3.Dot(n, tris[i]));
            if (!planes.Any(q => Vector3.Dot(new(q.X, q.Y, q.Z), n) > 0.9999f && MathF.Abs(q.W - pl.W) < 0.05f)) planes.Add(pl);
        }
        return (verts, planes);
    }

    static void Check(byte[] d, int o, int len)
    {
        if (o < 0 || len < 0 || (long)o + len > d.Length) throw new InvalidDataException("offset outside the file");
    }
    static int I(byte[] d, int o) { Check(d, o, 4); return BitConverter.ToInt32(d, o); }
}
