// A BSP model's drawn faces (the world is model 0, brush entities 1..n) -> a Glb: one primitive per material, UVs
// from the face's texinfo (s/t vectors over the material's size), and a second UV into the lightmap atlas
// (LightmapAtlas: the face's own luxels). Displacements are built from their face's
// corners and their offset verts (CDispInfo: power p, (2^p + 1)^2 verts). Faces Source never draws (nodraw, sky,
// hint, skip, tool textures) are left out; their collision is BrushGeometry's.
using System.Numerics;

namespace Lasers.Bake.Source1;

static class FaceMesh
{
    public static Glb Build(Bsp bsp, int model, Materials mats, LightmapAtlas atlas, string lightmapFile, Vector3 offset, out List<Materials.Info> used)
    {
        var glb = new Glb();
        var matIndex = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        used = [];
        if (model < 0 || model >= bsp.Models.Length) return glb;
        var m = bsp.Models[model];
        for (var f = m.FirstFace; f < m.FirstFace + m.NumFaces && f < bsp.Faces.Length; f++)
        {
            if (f < 0) continue;
            var face = bsp.Faces[f];
            if (face.TexInfo < 0 || face.TexInfo >= bsp.TexInfos.Length) continue;
            var ti = bsp.TexInfos[face.TexInfo];
            if ((ti.Flags & (Bsp.SurfNoDraw | Bsp.SurfSky | Bsp.SurfSky2d | Bsp.SurfHint | Bsp.SurfSkip)) != 0) continue;
            var name = bsp.TexName(face.TexInfo);
            var info = mats.Get(name);
            if (info.Tool) continue;
            if (!matIndex.TryGetValue(info.Name, out var mi))
            {
                mi = glb.Materials.Count;
                glb.Materials.Add(new Glb.Material(info.Name, info.Texture, info.AlphaMode, info.Cutoff, info.DoubleSided, info.Color, lightmapFile, info.Additive));
                matIndex[info.Name] = mi;
                used.Add(info);
            }
            var prim = glb.For(mi);
            var td = ti.TexData >= 0 && ti.TexData < bsp.TexDatas.Length ? bsp.TexDatas[ti.TexData] : default;
            float tw = info.Width > 0 ? info.Width : Math.Max(1, td.Width), th = info.Height > 0 ? info.Height : Math.Max(1, td.Height);
            var plane = face.Plane < bsp.Planes.Length ? bsp.Planes[face.Plane] : default;
            var normal = face.Side != 0 ? -plane.Normal : plane.Normal;

            var verts = new List<Vector3>();
            for (var e = 0; e < face.NumEdges; e++)
            {
                var si = face.FirstEdge + e;
                if (si < 0 || si >= bsp.SurfEdges.Length) { verts.Clear(); break; }
                var se = bsp.SurfEdges[si];
                var ei = Math.Abs(se);
                if (ei >= bsp.Edges.Length) { verts.Clear(); break; }
                var vi = se >= 0 ? bsp.Edges[ei].A : bsp.Edges[ei].B;
                if (vi >= bsp.Vertexes.Length) { verts.Clear(); break; }
                verts.Add(bsp.Vertexes[vi]);
            }
            if (verts.Count < 3) continue;
            Vector2 Uv(Vector3 p) => new((Vector3.Dot(p, new(ti.S.X, ti.S.Y, ti.S.Z)) + ti.S.W) / tw, (Vector3.Dot(p, new(ti.T.X, ti.T.Y, ti.T.Z)) + ti.T.W) / th);

            if (face.DispInfo >= 0 && face.DispInfo < bsp.Disps.Length)
            {
                Displacement(bsp, f, face, verts, normal, prim, Uv, atlas, offset);
                continue;
            }
            // the vertex's luxel: the lightmap vectors minus the face's luxel mins (clamped: rounding can step past)
            Vector2 Lm(Vector3 p)
            {
                var s = Vector3.Dot(p, new(ti.LS.X, ti.LS.Y, ti.LS.Z)) + ti.LS.W - face.LmMinsX;
                var t = Vector3.Dot(p, new(ti.LT.X, ti.LT.Y, ti.LT.Z)) + ti.LT.W - face.LmMinsY;
                return atlas.Uv(f, Math.Clamp(s, 0, face.LmW), Math.Clamp(t, 0, face.LmH));
            }
            var first = (uint)prim.Count;
            foreach (var v in verts) prim.Add(v - offset, normal, Uv(v), Lm(v));
            // Source winds faces clockwise seen from the front; glTF wants counter-clockwise
            for (var k = 2; k < verts.Count; k++) { prim.Idx.Add(first); prim.Idx.Add(first + (uint)k); prim.Idx.Add(first + (uint)k - 1); }
        }
        return glb;
    }

    // the displacement's triangles (also its collision: Triangles below)
    static void Displacement(Bsp bsp, int f, Bsp.Face face, List<Vector3> corners, Vector3 normal, Glb.Prim prim, Func<Vector3, Vector2> uv, LightmapAtlas atlas, Vector3 offset)
    {
        var grid = DispGrid(bsp, face, corners, out var n);
        if (grid == null) return;
        var first = (uint)prim.Count;
        for (var i = 0; i < n; i++)
            for (var j = 0; j < n; j++)
            {
                var (pos, basePos) = grid[i * n + j];
                // a displacement's lightmap spans its face's luxel rectangle evenly over the grid
                prim.Add(pos - offset, normal, uv(basePos), atlas.Uv(f, (float)j / (n - 1) * face.LmW, (float)i / (n - 1) * face.LmH));
            }
        foreach (var (a, b, c) in DispTris(grid, n, normal))
        {
            prim.Idx.Add(first + (uint)a); prim.Idx.Add(first + (uint)b); prim.Idx.Add(first + (uint)c);
        }
    }

    // collision / particle triangles of a model's displacements (world only: displacements live on world faces)
    public static void DispTriangles(Bsp bsp, List<float> tris, List<uint>? layers)
    {
        var m = bsp.Models.Length > 0 ? bsp.Models[0] : default;
        for (var f = m.FirstFace; f < m.FirstFace + m.NumFaces && f < bsp.Faces.Length; f++)
        {
            var face = bsp.Faces[f];
            if (face.DispInfo < 0 || face.DispInfo >= bsp.Disps.Length) continue;
            var corners = new List<Vector3>();
            for (var e = 0; e < face.NumEdges && face.FirstEdge + e < bsp.SurfEdges.Length; e++)
            {
                var se = bsp.SurfEdges[face.FirstEdge + e];
                var ei = Math.Abs(se);
                if (ei >= bsp.Edges.Length) break;
                var vi = se >= 0 ? bsp.Edges[ei].A : bsp.Edges[ei].B;
                if (vi < bsp.Vertexes.Length) corners.Add(bsp.Vertexes[vi]);
            }
            var grid = DispGrid(bsp, face, corners, out var n);
            if (grid == null) continue;
            var plane = bsp.Planes[face.Plane];
            var normal = face.Side != 0 ? -plane.Normal : plane.Normal;
            foreach (var (a, b, c) in DispTris(grid, n, normal))
            {
                foreach (var k in new[] { a, b, c }) { var p = grid[k].Pos; tris.Add(p.X); tris.Add(p.Y); tris.Add(p.Z); }
                layers?.Add(1);
            }
        }
    }

    static (Vector3 Pos, Vector3 Base)[]? DispGrid(Bsp bsp, Bsp.Face face, List<Vector3> corners, out int n)
    {
        n = 0;
        if (corners.Count != 4) return null;
        var d = bsp.Disps[face.DispInfo];
        if (d.Power is < 1 or > 4) return null;
        n = (1 << d.Power) + 1;
        if (d.VertStart < 0 || d.VertStart + n * n > bsp.DispVerts.Length) return null;
        // the corner nearest startPosition is the grid's first
        var s = 0;
        for (var k = 1; k < 4; k++) if (Vector3.DistanceSquared(corners[k], d.Start) < Vector3.DistanceSquared(corners[s], d.Start)) s = k;
        Vector3 c0 = corners[s], c1 = corners[(s + 1) % 4], c2 = corners[(s + 2) % 4], c3 = corners[(s + 3) % 4];
        var grid = new (Vector3, Vector3)[n * n];
        for (var i = 0; i < n; i++)
        {
            var t = (float)i / (n - 1);
            Vector3 left = Vector3.Lerp(c0, c1, t), right = Vector3.Lerp(c3, c2, t);
            for (var j = 0; j < n; j++)
            {
                var b = Vector3.Lerp(left, right, (float)j / (n - 1));
                var dv = bsp.DispVerts[d.VertStart + i * n + j];
                grid[i * n + j] = (b + dv.Vec * dv.Dist, b);
            }
        }
        return grid;
    }

    // two triangles per cell, the diagonal alternating as CCoreDispInfo does; wound to face the face's normal
    static IEnumerable<(int, int, int)> DispTris((Vector3 Pos, Vector3 Base)[] g, int n, Vector3 normal)
    {
        for (var i = 0; i < n - 1; i++)
            for (var j = 0; j < n - 1; j++)
            {
                int a = i * n + j, b = a + 1, c = a + n, dd = c + 1;
                var tris = (i + j) % 2 == 0 ? new[] { (a, c, dd), (a, dd, b) } : new[] { (a, c, b), (b, c, dd) };
                foreach (var (x, y, z) in tris)
                {
                    var nrm = Vector3.Cross(g[y].Base - g[x].Base, g[z].Base - g[x].Base);
                    yield return Vector3.Dot(nrm, normal) >= 0 ? (x, y, z) : (x, z, y);
                }
            }
    }
}
