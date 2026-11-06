// A minimal glTF 2.0 binary writer for the Source 1 bake: triangle primitives (position, normal, uv, lightmap uv)
// with one material each, in VRF's glTF space as every other glb the game loads (gltf = (y, z, x) * 0.0254, Source
// units in). Images are satellite PNGs referenced by file name (beside the glb), as the CS2 bake writes them.
// A lightmapped material carries the atlas in its occlusion slot on TEXCOORD_1, marked extras.lightmap =
// "rgbm<range>": the renderer draws it unlit (Source's LightmappedGeneric is texture x baked light, no runtime lights)
// and decodes the atlas as light, not as ambient occlusion (world/source1-light.js). Not KHR_materials_unlit: three's
// loader drops the occlusion texture of an unlit material. Models: extras.lightmap "vertex" (a static prop's light baked
// into COLOR_0) or "cube" (an entity model, lit at runtime by the ambient cube where the entity is).
using System.Numerics;
using System.Text;
using System.Text.Json.Nodes;

namespace Lasers.Bake.Source1;

sealed class Glb
{
    public sealed record Material(string Name, string? Image, string AlphaMode, float Cutoff, bool DoubleSided, Vector4 Color, string? Lightmap = null, bool Additive = false);

    public sealed class Prim
    {
        public int Material;
        public readonly List<float> Pos = [], Nrm = [], Uv = [], Uv1 = [], Col = [], Wgt = [];
        public readonly List<ushort> Jnt = [];
        public readonly List<uint> Idx = [];
        public int Count => Pos.Count / 3;

        // a vertex in Source space (inches, Z up); returns its index
        public uint Add(Vector3 p, Vector3 n, Vector2 uv, Vector2 uv1)
        {
            Pos.Add(p.Y * Scale); Pos.Add(p.Z * Scale); Pos.Add(p.X * Scale);
            Nrm.Add(n.Y); Nrm.Add(n.Z); Nrm.Add(n.X);
            Uv.Add(uv.X); Uv.Add(uv.Y);
            Uv1.Add(uv1.X); Uv1.Add(uv1.Y);
            return (uint)(Pos.Count / 3 - 1);
        }

        // a skinned vertex: up to 4 joints (skin joint indices) and their weights
        public uint Add(Vector3 p, Vector3 n, Vector2 uv, ReadOnlySpan<ushort> joints, ReadOnlySpan<float> weights)
        {
            var i = Add(p, n, uv, Vector2.Zero);
            for (var k = 0; k < 4; k++) { Jnt.Add(k < joints.Length ? joints[k] : (ushort)0); Wgt.Add(k < weights.Length ? weights[k] : 0); }
            return i;
        }

        // a vertex with baked light (linear, COLOR_0) and no lightmap UV: a static prop's ambient-cube light
        public uint Add(Vector3 p, Vector3 n, Vector2 uv, Vector3 light)
        {
            var i = Add(p, n, uv, Vector2.Zero);
            Col.Add(light.X); Col.Add(light.Y); Col.Add(light.Z);
            return i;
        }
    }

    const float Scale = 0.0254f;
    public readonly List<Material> Materials = [];

    // a skeleton, in Source space (converted on write): parent per bone (-1 = a root, parents first), the rest local
    // position / rotation, and each bone's inverse bind (Source's poseToBone, row-vector convention)
    public sealed record Skin(string[] Names, int[] Parent, Vector3[] Pos, Quaternion[] Rot, Matrix4x4[] InverseBind);
    // an animation: key times (seconds) and per key per bone local position / rotation (Source space)
    public sealed record Clip(string Name, float[] Times, Vector3[][] Pos, Quaternion[][] Rot);
    public Skin? Skeleton;
    public readonly List<Clip> Clips = [];

    // Source -> glTF (VRF's space): positions (y, z, x) x 0.0254; a rotation's axis the same way, so a quaternion's
    // (x, y, z, w) becomes (y, z, x, w) (the axis swap is a proper rotation); a row-vector matrix M becomes S^-1 M S
    static Vector3 G(Vector3 v) => new Vector3(v.Y, v.Z, v.X) * Scale;
    static Quaternion G(Quaternion q) => new(q.Y, q.Z, q.X, q.W);
    static readonly Matrix4x4 S = new(0, 0, Scale, 0, Scale, 0, 0, 0, 0, Scale, 0, 0, 0, 0, 0, 1);
    static Matrix4x4 G(Matrix4x4 m) { Matrix4x4.Invert(S, out var si); return si * m * S; }
    public readonly Dictionary<string, Prim> Prims = [];

    public Prim For(int material)
    {
        var key = material.ToString();
        if (!Prims.TryGetValue(key, out var p)) Prims[key] = p = new Prim { Material = material };
        return p;
    }

    public bool Empty => Prims.Values.All(p => p.Idx.Count == 0);

    public void Write(string path, string nodeName)
    {
        var bin = new MemoryStream();
        var views = new JsonArray();
        var accessors = new JsonArray();
        int View(byte[] bytes, int? target)
        {
            while (bin.Length % 4 != 0) bin.WriteByte(0);
            var v = new JsonObject { ["buffer"] = 0, ["byteOffset"] = bin.Length, ["byteLength"] = bytes.Length };
            if (target != null) v["target"] = target;
            bin.Write(bytes);
            views.Add(v);
            return views.Count - 1;
        }
        int Acc(List<float> data, int comps, string type, bool minmax)
        {
            var bytes = new byte[data.Count * 4];
            Buffer.BlockCopy(data.ToArray(), 0, bytes, 0, bytes.Length);
            var a = new JsonObject { ["bufferView"] = View(bytes, 34962), ["componentType"] = 5126, ["count"] = data.Count / comps, ["type"] = type };
            if (minmax)
            {
                var mn = new JsonArray(); var mx = new JsonArray();
                for (var c = 0; c < comps; c++)
                {
                    float lo = float.MaxValue, hi = float.MinValue;
                    for (var i = c; i < data.Count; i += comps) { lo = Math.Min(lo, data[i]); hi = Math.Max(hi, data[i]); }
                    mn.Add(lo); mx.Add(hi);
                }
                a["min"] = mn; a["max"] = mx;
            }
            accessors.Add(a);
            return accessors.Count - 1;
        }

        var prims = new JsonArray();
        foreach (var p in Prims.Values.Where(p => p.Idx.Count > 0))
        {
            var ib = new byte[p.Idx.Count * 4];
            Buffer.BlockCopy(p.Idx.ToArray(), 0, ib, 0, ib.Length);
            accessors.Add(new JsonObject { ["bufferView"] = View(ib, 34963), ["componentType"] = 5125, ["count"] = p.Idx.Count, ["type"] = "SCALAR" });
            var idx = accessors.Count - 1;
            var attrs = new JsonObject
            {
                ["POSITION"] = Acc(p.Pos, 3, "VEC3", true),
                ["NORMAL"] = Acc(p.Nrm, 3, "VEC3", false),
                ["TEXCOORD_0"] = Acc(p.Uv, 2, "VEC2", false),
                ["TEXCOORD_1"] = Acc(p.Uv1, 2, "VEC2", false),
            };
            if (p.Col.Count == p.Pos.Count) attrs["COLOR_0"] = Acc(p.Col, 3, "VEC3", false);
            if (Skeleton != null && p.Jnt.Count == p.Count * 4)
            {
                var jointBytes = new byte[p.Jnt.Count * 2];
                Buffer.BlockCopy(p.Jnt.ToArray(), 0, jointBytes, 0, jointBytes.Length);
                accessors.Add(new JsonObject { ["bufferView"] = View(jointBytes, 34962), ["componentType"] = 5123, ["count"] = p.Count, ["type"] = "VEC4" });
                attrs["JOINTS_0"] = accessors.Count - 1;
                attrs["WEIGHTS_0"] = Acc(p.Wgt, 4, "VEC4", false);
            }
            prims.Add(new JsonObject
            {
                ["attributes"] = attrs,
                ["indices"] = idx,
                ["material"] = p.Material,
                ["mode"] = 4,
            });
        }

        var images = new JsonArray();
        var textures = new JsonArray();
        var mats = new JsonArray();
        var imageIndex = new Dictionary<string, int>();
        foreach (var m in Materials)
        {
            var pbr = new JsonObject
            {
                ["baseColorFactor"] = new JsonArray(m.Color.X, m.Color.Y, m.Color.Z, m.Color.W),
                ["metallicFactor"] = 0,
                ["roughnessFactor"] = 1,
            };
            int Tex(string uri, int sampler)
            {
                if (imageIndex.TryGetValue(uri, out var ti)) return ti;
                images.Add(new JsonObject { ["uri"] = uri });
                textures.Add(new JsonObject { ["source"] = images.Count - 1, ["sampler"] = sampler });
                return imageIndex[uri] = textures.Count - 1;
            }
            if (m.Image != null) pbr["baseColorTexture"] = new JsonObject { ["index"] = Tex(m.Image, 0) };
            var mat = new JsonObject { ["name"] = m.Name, ["pbrMetallicRoughness"] = pbr, ["doubleSided"] = m.DoubleSided };
            if (m.Lightmap is "vertex" or "cube") mat["extras"] = new JsonObject { ["lightmap"] = m.Lightmap };
            else if (m.Lightmap != null)
            {
                // the atlas: clamped, linear filtering, no mips (a mip would blend neighbouring faces' luxels)
                mat["occlusionTexture"] = new JsonObject { ["index"] = Tex(m.Lightmap, 1), ["texCoord"] = 1 };
                mat["extras"] = new JsonObject { ["lightmap"] = $"rgbm{LightmapAtlas.Range}" };
            }
            // $additive: drawn added to what is behind it (glTF has no additive blend; the renderer reads this)
            if (m.Additive) ((JsonObject)(mat["extras"] ??= new JsonObject()))["additive"] = true;
            if (m.AlphaMode != "OPAQUE") mat["alphaMode"] = m.AlphaMode;
            if (m.AlphaMode == "MASK") mat["alphaCutoff"] = m.Cutoff;
            mats.Add(mat);
        }

        // nodes: 0 = the mesh; with a skeleton, 1 + b = bone b (children under their parents, roots in the scene)
        var nodes = new JsonArray(new JsonObject { ["name"] = nodeName, ["mesh"] = 0 });
        var sceneNodes = new JsonArray(0);
        JsonArray? skins = null, animations = null;
        // an animation sampler's data (no buffer target); input times need min / max
        int AccRaw(IReadOnlyList<float> data, int comps, string type)
        {
            var arr = data.ToArray();
            var bytes = new byte[arr.Length * 4];
            Buffer.BlockCopy(arr, 0, bytes, 0, bytes.Length);
            var a = new JsonObject { ["bufferView"] = View(bytes, null), ["componentType"] = 5126, ["count"] = arr.Length / comps, ["type"] = type };
            if (comps == 1 && arr.Length > 0) { a["min"] = new JsonArray(arr.Min()); a["max"] = new JsonArray(arr.Max()); }
            accessors.Add(a);
            return accessors.Count - 1;
        }
        if (Skeleton is { } sk)
        {
            var n = sk.Names.Length;
            for (var b = 0; b < n; b++)
            {
                var t = G(sk.Pos[b]); var r = G(sk.Rot[b]);
                var node = new JsonObject { ["name"] = sk.Names[b], ["translation"] = new JsonArray(t.X, t.Y, t.Z), ["rotation"] = new JsonArray(r.X, r.Y, r.Z, r.W) };
                var kids = new JsonArray();
                for (var c = 0; c < n; c++) if (sk.Parent[c] == b && c > b) kids.Add(1 + c);
                if (kids.Count > 0) node["children"] = kids;
                nodes.Add(node);
                if (sk.Parent[b] < 0 || sk.Parent[b] >= b) sceneNodes.Add(1 + b);
            }
            // inverse bind matrices: glTF wants column-major column-vector matrices = a row-vector matrix row by row
            var ibm = new List<float>();
            foreach (var m in sk.InverseBind)
            {
                var g = G(m);
                ibm.AddRange([g.M11, g.M12, g.M13, g.M14, g.M21, g.M22, g.M23, g.M24, g.M31, g.M32, g.M33, g.M34, g.M41, g.M42, g.M43, g.M44]);
            }
            var ibmBytes = new byte[ibm.Count * 4];
            Buffer.BlockCopy(ibm.ToArray(), 0, ibmBytes, 0, ibmBytes.Length);
            accessors.Add(new JsonObject { ["bufferView"] = View(ibmBytes, null), ["componentType"] = 5126, ["count"] = n, ["type"] = "MAT4" });
            skins = new JsonArray(new JsonObject { ["joints"] = new JsonArray([.. Enumerable.Range(1, n).Select(i => (JsonNode)i!)]), ["inverseBindMatrices"] = accessors.Count - 1 });
            ((JsonObject)nodes[0]!)["skin"] = 0;

            animations = new JsonArray();
            foreach (var clip in Clips)
            {
                var input = AccRaw(clip.Times, 1, "SCALAR");
                var samplers = new JsonArray();
                var channels = new JsonArray();
                for (var b = 0; b < n; b++)
                {
                    var tr = new List<float>(); var ro = new List<float>();
                    for (var k = 0; k < clip.Times.Length; k++)
                    {
                        var t = G(clip.Pos[k][b]); var r = G(clip.Rot[k][b]);
                        tr.AddRange([t.X, t.Y, t.Z]); ro.AddRange([r.X, r.Y, r.Z, r.W]);
                    }
                    samplers.Add(new JsonObject { ["input"] = input, ["output"] = AccRaw(tr, 3, "VEC3"), ["interpolation"] = "LINEAR" });
                    channels.Add(new JsonObject { ["sampler"] = samplers.Count - 1, ["target"] = new JsonObject { ["node"] = 1 + b, ["path"] = "translation" } });
                    samplers.Add(new JsonObject { ["input"] = input, ["output"] = AccRaw(ro, 4, "VEC4"), ["interpolation"] = "LINEAR" });
                    channels.Add(new JsonObject { ["sampler"] = samplers.Count - 1, ["target"] = new JsonObject { ["node"] = 1 + b, ["path"] = "rotation" } });
                }
                animations.Add(new JsonObject { ["name"] = clip.Name, ["samplers"] = samplers, ["channels"] = channels });
            }
        }

        var json = new JsonObject
        {
            ["asset"] = new JsonObject { ["version"] = "2.0", ["generator"] = "lasers-bake source1" },
            ["scene"] = 0,
            ["scenes"] = new JsonArray(new JsonObject { ["nodes"] = sceneNodes }),
            ["nodes"] = nodes,
            ["meshes"] = new JsonArray(new JsonObject { ["name"] = nodeName, ["primitives"] = prims }),
            ["materials"] = mats,
            ["accessors"] = accessors,
            ["bufferViews"] = views,
            ["buffers"] = new JsonArray(new JsonObject { ["byteLength"] = bin.Length }),
            ["samplers"] = new JsonArray(
                new JsonObject { ["magFilter"] = 9729, ["minFilter"] = 9987, ["wrapS"] = 10497, ["wrapT"] = 10497 },
                new JsonObject { ["magFilter"] = 9729, ["minFilter"] = 9729, ["wrapS"] = 33071, ["wrapT"] = 33071 }),
        };
        if (images.Count > 0) { json["images"] = images; json["textures"] = textures; }
        if (skins != null) json["skins"] = skins;
        if (animations is { Count: > 0 }) json["animations"] = animations;
        while (bin.Length % 4 != 0) bin.WriteByte(0);
        var jb = Encoding.UTF8.GetBytes(json.ToJsonString());
        var pad = (4 - jb.Length % 4) % 4;
        using var f = File.Create(path);
        using var w = new BinaryWriter(f);
        w.Write(0x46546C67u); w.Write(2u); w.Write((uint)(12 + 8 + jb.Length + pad + 8 + bin.Length));
        w.Write((uint)(jb.Length + pad)); w.Write(0x4E4F534Au); w.Write(jb); for (var i = 0; i < pad; i++) w.Write((byte)' ');
        w.Write((uint)bin.Length); w.Write(0x004E4942u); w.Write(bin.ToArray());
    }
}
