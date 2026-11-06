// Studio models into the map folder:
//  - static props (the "sprp" game lump, v4-v11): placed into the world glb (they never move), each vertex lit by
//    the ambient cube at the prop's lighting origin with the visible world lights folded in (AmbientLight.LitCube), as
//    Source lights a prop without baked vertex light
//    (the map ships no .vhv). STATIC_PROP_NO_DRAW props are left out.
//  - entity models (prop_dynamic, prop_physics, ...): models/<path>.glb in model space, lit at runtime by the
//    ambient cube where the entity stands (material extras.lightmap "cube", world/source1-light.js).
// A model is read once per (path, skin).
using System.Numerics;

namespace Lasers.Bake.Source1;

static class PropBake
{
    const int StaticPropUseLightingOrigin = 0x2, StaticPropNoDraw = 0x4;

    public sealed record StaticProp(string Model, Vector3 Origin, Vector3 Angles, int Solid, int Flags, int Skin, Vector3 LightingOrigin, float Scale);

    public static List<StaticProp> StaticProps(Bsp bsp, Action<string> log)
    {
        var list = new List<StaticProp>();
        if (bsp.GameLump("sprp") is not var (ver, d)) return list;
        if (ver is < 4 or > 11) { log($"  static props v{ver}: not read"); return list; }
        int p = 0;
        int Int() { var v = BitConverter.ToInt32(d, p); p += 4; return v; }
        var dict = Int();
        if (dict < 0 || dict > 65536 || p + dict * 128 > d.Length) return list;
        var names = new string[dict];
        for (var i = 0; i < dict; i++)
        {
            var end = Array.IndexOf(d, (byte)0, p, 128);
            names[i] = System.Text.Encoding.ASCII.GetString(d, p, (end < 0 ? p + 128 : end) - p);
            p += 128;
        }
        var leafs = Int();
        p += leafs * 2;
        var count = Int();
        if (count <= 0 || p > d.Length) return list;
        var size = (d.Length - p) / count;
        if (size < 56) { log($"  static props: {size} bytes each, not read"); return list; }
        for (var i = 0; i < count; i++)
        {
            var o = p + i * size;
            var type = BitConverter.ToUInt16(d, o + 24);
            if (type >= names.Length) continue;
            var scale = ver >= 11 && size >= 80 ? BitConverter.ToSingle(d, o + 76) : 1;
            list.Add(new StaticProp(GameFiles.Norm(names[type]), Bsp.V3(d, o), Bsp.V3(d, o + 12), d[o + 30], d[o + 31],
                BitConverter.ToInt32(d, o + 32), Bsp.V3(d, o + 44), scale > 0 && scale < 100 ? scale : 1));
        }
        return list;
    }

    sealed class Cache(GameFiles files, Action<string> log)
    {
        readonly Dictionary<string, StudioModel?> models = new(StringComparer.OrdinalIgnoreCase);
        public StudioModel? Get(string path, int skin)
        {
            var key = $"{path}|{skin}";
            if (!models.TryGetValue(key, out var m)) models[key] = m = StudioModel.Load(files, path, skin, log);
            return m;
        }
    }

    // static props into the world glb; returns how many were placed
    public static int AddStaticProps(Glb world, List<StaticProp> props, GameFiles files, Materials mats, AmbientLight light, List<Materials.Info> used, Action<string> log)
    {
        var cache = new Cache(files, log);
        var matIndex = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var placed = 0;
        var missing = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var sp in props)
        {
            if ((sp.Flags & StaticPropNoDraw) != 0) continue;
            var model = cache.Get(sp.Model, sp.Skin);
            if (model == null) { missing.Add(sp.Model); continue; }
            var r = Entities.AngleMatrix([sp.Angles.X, sp.Angles.Y, sp.Angles.Z]);
            Vector3 Rot(Vector3 v) => new((float)(r[0, 0] * v.X + r[0, 1] * v.Y + r[0, 2] * v.Z), (float)(r[1, 0] * v.X + r[1, 1] * v.Y + r[1, 2] * v.Z), (float)(r[2, 0] * v.X + r[2, 1] * v.Y + r[2, 2] * v.Z));
            var cube = light.LitCube((sp.Flags & StaticPropUseLightingOrigin) != 0 ? sp.LightingOrigin : sp.Origin + new Vector3(0, 0, 4));
            foreach (var mesh in model.Meshes)
            {
                var info = mats.Get(mesh.Material);
                if (info.Tool) continue;
                var key = info.Name + "|vertex";
                if (!matIndex.TryGetValue(key, out var mi))
                {
                    mi = world.Materials.Count;
                    world.Materials.Add(new Glb.Material(info.Name, info.Texture, info.AlphaMode, info.Cutoff, info.DoubleSided, info.Color, "vertex", info.Additive));
                    matIndex[key] = mi;
                    used.Add(info);
                }
                var prim = world.For(mi);
                var first = (uint)prim.Count;
                for (var i = 0; i < mesh.Pos.Count; i++)
                {
                    var n = Vector3.Normalize(Rot(mesh.Nrm[i]));
                    prim.Add(Rot(mesh.Pos[i] * sp.Scale) + sp.Origin, n, mesh.Uv[i], AmbientLight.Eval(cube, n));
                }
                foreach (var ix in mesh.Idx) prim.Idx.Add(first + (uint)ix);
            }
            placed++;
        }
        foreach (var mm in missing.Take(20)) log($"  static prop model missing: {mm}");
        return placed;
    }

    // the solid static props' collision triangles, world space: solid 6 (SOLID_VPHYSICS) = the model's .phy, solid 2
    // (SOLID_BBOX) = its hull box (studiohdr hull_min / hull_max), unrotated as Source's bbox props are (an AABB);
    // 0 = not solid. Returns how many props were added
    public static int StaticCollision(List<StaticProp> props, GameFiles files, List<float> tris, Action<string> log)
    {
        var phy = new Dictionary<string, List<List<Vector3>>>(StringComparer.OrdinalIgnoreCase);
        var count = 0;
        foreach (var sp in props)
        {
            if (sp.Solid == 0) continue;
            var r = Entities.AngleMatrix([sp.Angles.X, sp.Angles.Y, sp.Angles.Z]);
            Vector3 Place(Vector3 v) => sp.Origin + sp.Scale * new Vector3(
                (float)(r[0, 0] * v.X + r[0, 1] * v.Y + r[0, 2] * v.Z), (float)(r[1, 0] * v.X + r[1, 1] * v.Y + r[1, 2] * v.Z), (float)(r[2, 0] * v.X + r[2, 1] * v.Y + r[2, 2] * v.Z));
            if (sp.Solid == 6)
            {
                if (!phy.TryGetValue(sp.Model, out var pieces)) phy[sp.Model] = pieces = PhyFile.Read(files.Read(sp.Model[..^4] + ".phy"));
                if (pieces.Count == 0) continue;
                foreach (var piece in pieces)
                    foreach (var v in piece) { var w = Place(v); tris.Add(w.X); tris.Add(w.Y); tris.Add(w.Z); }
                count++;
            }
            else if (sp.Solid == 2 && files.Read(sp.Model) is { Length: >= 128 } mdl)
            {
                var mn = Bsp.V3(mdl, 104) * sp.Scale + sp.Origin;
                var mx = Bsp.V3(mdl, 116) * sp.Scale + sp.Origin;
                BoxTris(mn, mx, tris);
                count++;
            }
        }
        return count;
    }

    static void BoxTris(Vector3 a, Vector3 b, List<float> t)
    {
        Vector3 C(int i) => new((i & 1) != 0 ? b.X : a.X, (i & 2) != 0 ? b.Y : a.Y, (i & 4) != 0 ? b.Z : a.Z);
        int[][] faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
        foreach (var f in faces)
            foreach (var k in new[] { 0, 1, 2, 0, 2, 3 }) { var v = C(f[k]); t.Add(v.X); t.Add(v.Y); t.Add(v.Z); }
    }

    // hulls.json entries for an entity model: its .phy's first solid's convex pieces, model space
    public static System.Text.Json.Nodes.JsonArray ModelHulls(string path, GameFiles files)
    {
        var list = new System.Text.Json.Nodes.JsonArray();
        foreach (var piece in PhyFile.Read(files.Read(path[..^4] + ".phy")))
        {
            var (verts, planes) = PhyFile.Hull(piece);
            if (verts.Count < 4 || planes.Count < 4) continue;
            var vj = new System.Text.Json.Nodes.JsonArray();
            foreach (var v in verts) { vj.Add(MathF.Round(v.X, 3)); vj.Add(MathF.Round(v.Y, 3)); vj.Add(MathF.Round(v.Z, 3)); }
            var pj = new System.Text.Json.Nodes.JsonArray();
            foreach (var p in planes) { pj.Add(MathF.Round(p.X, 5)); pj.Add(MathF.Round(p.Y, 5)); pj.Add(MathF.Round(p.Z, 5)); pj.Add(MathF.Round(p.W, 3)); }
            list.Add(new System.Text.Json.Nodes.JsonObject { ["verts"] = vj, ["planes"] = pj, ["solid"] = true, ["layers"] = 1 });
        }
        return list;
    }

    // one glb per entity model (models/<path>.glb); returns the paths written (manifest renderModels)
    // animations: each animated model's sequences for animations.json ({ name, duration, loop, fadeIn, fadeOut }, the
    // model's own order: props.js falls back to sequence 0 by index, as Source does)
    public static List<string> EntityModels(IEnumerable<string> paths, string outDir, GameFiles files, Materials mats, Action<string> log,
        System.Text.Json.Nodes.JsonObject? animations = null)
    {
        var cache = new Cache(files, log);
        var written = new List<string>();
        foreach (var path in paths)
        {
            if (!path.EndsWith(".mdl", StringComparison.OrdinalIgnoreCase)) continue; // sprites (.vmt / .spr) are not models
            var model = cache.Get(path, 0);
            if (model == null) { log($"  entity model missing: {path}"); continue; }
            var glb = new Glb();
            var matIndex = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var used = new List<Materials.Info>();
            // a model that animates is exported skinned: its skeleton, unposed vertices and a clip per sequence
            var sk = model.Animated ? model.Skeleton : null;
            if (sk != null) AddSkeleton(glb, sk, path, animations);
            // a still model's sequences are listed too (no clips): the engine times SetAnimation / OnAnimationDone from them
            else if (model.Skeleton is { Sequences.Count: > 0 } still && animations != null) animations[path] = SequenceList(still);
            foreach (var mesh in model.Meshes)
            {
                var info = mats.Get(mesh.Material);
                if (info.Tool) continue;
                if (!matIndex.TryGetValue(info.Name, out var mi))
                {
                    mi = glb.Materials.Count;
                    glb.Materials.Add(new Glb.Material(info.Name, info.Texture, info.AlphaMode, info.Cutoff, info.DoubleSided, info.Color, "cube", info.Additive));
                    matIndex[info.Name] = mi;
                    used.Add(info);
                }
                var prim = glb.For(mi);
                var first = (uint)prim.Count;
                for (var i = 0; i < mesh.Pos.Count; i++)
                {
                    if (sk == null) { prim.Add(mesh.Pos[i], mesh.Nrm[i], mesh.Uv[i], Vector2.Zero); continue; }
                    var w = mesh.Weights[i];
                    var sum = w.W0 + w.W1 + w.W2;
                    if (sum <= 0) sum = 1;
                    ushort Bone(byte b) => (ushort)Math.Min(b, sk.Count - 1);
                    prim.Add(mesh.RawPos[i], mesh.RawNrm[i], mesh.Uv[i], [Bone(w.B0), Bone(w.B1), Bone(w.B2), 0], [w.W0 / sum, w.W1 / sum, w.W2 / sum, 0]);
                }
                foreach (var ix in mesh.Idx) prim.Idx.Add(first + (uint)ix);
            }
            if (glb.Empty) continue;
            try
            {
                var target = SafePath.OutFile(outDir, "models/" + Path.ChangeExtension(path, ".glb"));
                foreach (var m in used) mats.WriteImage(m, Path.GetDirectoryName(target)!);
                glb.Write(target, Path.GetFileNameWithoutExtension(path));
                written.Add(path);
            }
            catch (InvalidDataException e) { log($"  model {SafePath.Describe(path)}: {e.Message}"); }
        }
        return written;
    }

    // the skeleton (rest = the bones' defaults, inverse bind = poseToBone) and every sequence as a clip: frame k at
    // k / fps. Source's cycle is (frames - 1) / fps (a looping sequence's last frame repeats its first)
    static void AddSkeleton(Glb glb, StudioPose sk, string path, System.Text.Json.Nodes.JsonObject? animations)
    {
        glb.Skeleton = new Glb.Skin(sk.Names, sk.Parent, sk.Pos, sk.Rot, sk.PoseToBone);
        foreach (var seq in sk.Sequences)
        {
            var (frames, fps) = FramesOf(seq);
            var times = new float[frames];
            var pos = new Vector3[frames][];
            var rot = new Quaternion[frames][];
            for (var k = 0; k < frames; k++)
            {
                times[k] = k / fps;
                (pos[k], rot[k]) = sk.Frame(seq.Anim, k);
            }
            glb.Clips.Add(new Glb.Clip(seq.Name, times, pos, rot));
        }
        if (animations != null) animations[path] = SequenceList(sk);
    }

    static (int Frames, float Fps) FramesOf(StudioPose.Sequence seq) =>
        (Math.Clamp(seq.Frames, 1, 2000), seq.Fps > 0 && seq.Fps < 1000 ? seq.Fps : 30);

    // animations.json's entry for a model: its sequences in order, with Source's cycle length and blend times
    static System.Text.Json.Nodes.JsonArray SequenceList(StudioPose sk)
    {
        var list = new System.Text.Json.Nodes.JsonArray();
        foreach (var seq in sk.Sequences)
        {
            var (frames, fps) = FramesOf(seq);
            list.Add(new System.Text.Json.Nodes.JsonObject
            {
                ["name"] = seq.Name,
                ["duration"] = MathF.Round(frames > 1 ? (frames - 1) / fps : 1 / fps, 4),
                ["loop"] = seq.Loop,
                ["fadeIn"] = MathF.Round(seq.FadeIn, 4),
                ["fadeOut"] = MathF.Round(seq.FadeOut, 4),
            });
        }
        return list;
    }
}
