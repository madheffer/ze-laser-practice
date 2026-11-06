// A Source 1 studio model (.mdl v44-49 + .vvd + .dx90.vtx) read into triangle meshes in model space: the root LOD of
// body part i's model 0 (the default body group), each mesh's material by skin family `skin` through the skin table
// and the model's $cdmaterials paths. Layouts are the SDK's studio.h / optimize.h (VTX strip groups carry CS:GO's
// topology fields from MDL 49 on). Vertices are the VVD's bind pose, LOD 0 through its fixup table. Every offset is
// bounds-checked: a model is attacker-made data; a bad one is skipped (null), never read out of range.
using System.Numerics;
using System.Text;

namespace Lasers.Bake.Source1;

sealed class StudioModel
{
    public sealed class Mesh
    {
        public string Material = "";
        public readonly List<Vector3> Pos = [], Nrm = [];
        public readonly List<Vector2> Uv = [];
        public readonly List<int> Idx = [];
        // the unposed vertex (VVD as stored, the skeleton's bind space) and its bone weights, for a skinned export
        public readonly List<Vector3> RawPos = [], RawNrm = [];
        public readonly List<(byte B0, byte B1, byte B2, float W0, float W1, float W2)> Weights = [];
    }

    public readonly List<Mesh> Meshes = [];
    public Vector3 HullMin, HullMax;
    public StudioPose? Skeleton;
    // a sequence with more than one frame: the model animates (exported skinned, with clips)
    public bool Animated => Skeleton?.Sequences.Any(s => s.Frames > 1) == true;

    public static StudioModel? Load(GameFiles files, string mdlPath, int skin, Action<string> log)
    {
        var mdl = files.Read(mdlPath);
        var baseName = mdlPath[..^4];
        var vvd = files.Read(baseName + ".vvd");
        var vtx = files.Read(baseName + ".dx90.vtx") ?? files.Read(baseName + ".vtx");
        if (mdl == null || vvd == null || vtx == null) return null;
        try { return Parse(mdl, vvd, vtx, skin, files); }
        catch (Exception e) when (e is ArgumentOutOfRangeException or IndexOutOfRangeException or InvalidDataException or ArgumentException)
        {
            log($"  model {mdlPath}: {e.Message}");
            return null;
        }
    }

    static StudioModel Parse(byte[] m, byte[] vvd, byte[] vtx, int skin, GameFiles files)
    {
        if (m.Length < 408 || Encoding.ASCII.GetString(m, 0, 4) != "IDST") throw new InvalidDataException("not an MDL");
        var ver = I(m, 4);
        if (ver is < 44 or > 49) throw new InvalidDataException($"MDL version {ver}");
        var sm = new StudioModel { HullMin = V3(m, 104), HullMax = V3(m, 116), Skeleton = StudioPose.Read(m) };

        // materials: texture names x cdmaterials dirs, the first that exists
        int numTex = I(m, 204), texIdx = I(m, 208), numCd = I(m, 212), cdIdx = I(m, 216);
        int numSkinRef = I(m, 220), numFamilies = I(m, 224), skinIdx = I(m, 228);
        Check(m, texIdx, numTex * 64); Check(m, cdIdx, numCd * 4); Check(m, skinIdx, numSkinRef * numFamilies * 2);
        var cds = Enumerable.Range(0, Math.Min(numCd, 64)).Select(i => Str(m, I(m, cdIdx + i * 4)).Replace('\\', '/')).ToList();
        var mats = new string[numTex];
        for (var t = 0; t < numTex && t < 1024; t++)
        {
            var o = texIdx + t * 64;
            var name = Str(m, o + I(m, o)).Replace('\\', '/');
            mats[t] = cds.Select(cd => (cd.TrimEnd('/') + "/" + name).TrimStart('/'))
                .FirstOrDefault(p => files.Read("materials/" + p + ".vmt") != null) ?? name;
        }
        var family = Math.Clamp(skin, 0, Math.Max(0, numFamilies - 1));
        string MatOf(int skinRef)
        {
            if (skinRef < 0 || skinRef >= numSkinRef) return skinRef >= 0 && skinRef < mats.Length ? mats[skinRef] : "";
            var t = (short)BitConverter.ToUInt16(m, skinIdx + (family * numSkinRef + skinRef) * 2);
            return t >= 0 && t < mats.Length ? mats[t] : "";
        }

        // vertices: VVD LOD 0 through the fixups
        if (Encoding.ASCII.GetString(vvd, 0, 4) != "IDSV") throw new InvalidDataException("not a VVD");
        int numFix = I(vvd, 48), fixStart = I(vvd, 52), vStart = I(vvd, 56), lod0Count = I(vvd, 16);
        var raw = new List<int>();
        if (numFix == 0) for (var i = 0; i < lod0Count; i++) raw.Add(i);
        else
            for (var f = 0; f < numFix; f++)
            {
                var o = fixStart + f * 12;
                Check(vvd, o, 12);
                if (I(vvd, o) < 0) continue; // fixups for LODs below 0 don't exist; every fixup with lod >= 0 is in LOD 0
                for (var k = 0; k < I(vvd, o + 8); k++) raw.Add(I(vvd, o + 4) + k);
            }
        // drawn in sequence 0 frame 0 (StudioPose), each vertex skinned by its up to 3 bone weights (mstudioboneweight_t:
        // float weight[3], byte bone[3], byte numbones); no pose = the vertices as stored
        var bones = StudioPose.SkinMatrices(m);
        Vector3 Skinned(int o, Vector3 v, bool normal)
        {
            if (bones == null) return v;
            var nb = Math.Clamp((int)vvd[o + 15], 1, 3);
            var sum = Vector3.Zero;
            for (var k = 0; k < nb; k++)
            {
                var bone = vvd[o + 12 + k];
                var w = nb == 1 ? 1 : BitConverter.ToSingle(vvd, o + k * 4);
                if (bone >= bones.Length || w <= 0) continue;
                sum += w * (normal ? Vector3.TransformNormal(v, bones[bone]) : Vector3.Transform(v, bones[bone]));
            }
            return normal ? (sum.LengthSquared() > 0 ? Vector3.Normalize(sum) : v) : sum;
        }
        Vector3 VPos(int i) { var o = vStart + raw[i] * 48; Check(vvd, o, 48); return Skinned(o, V3(vvd, o + 16), false); }
        Vector3 VNrm(int i) { var o = vStart + raw[i] * 48; return Skinned(o, V3(vvd, o + 28), true); }
        Vector2 VUv(int i) { var o = vStart + raw[i] * 48; return new(BitConverter.ToSingle(vvd, o + 40), BitConverter.ToSingle(vvd, o + 44)); }

        // VTX: body parts -> models -> LOD 0 -> meshes -> strip groups (triangle lists)
        int vtxBodyParts = I(vtx, 28), vtxBodyOfs = I(vtx, 32);
        int numBody = I(m, 232), bodyIdx = I(m, 236);
        var sgSize = ver >= 49 ? 33 : 25;
        for (var bp = 0; bp < numBody && bp < vtxBodyParts && bp < 256; bp++)
        {
            var mb = bodyIdx + bp * 16;
            Check(m, mb, 16);
            if (I(m, mb + 4) < 1) continue;
            var mmodel = mb + I(m, mb + 12); // model 0 of this body part
            Check(m, mmodel, 148);
            int mNumMeshes = I(m, mmodel + 72), mMeshIdx = mmodel + I(m, mmodel + 76), mVertIndex = I(m, mmodel + 84) / 48;

            var vb = vtxBodyOfs + bp * 8;
            Check(vtx, vb, 8);
            var vm = vb + I(vtx, vb + 4); // model 0
            Check(vtx, vm, 8);
            var vl = vm + I(vtx, vm + 4); // LOD 0
            Check(vtx, vl, 12);
            int vNumMeshes = I(vtx, vl), vMeshOfs = vl + I(vtx, vl + 4);
            for (var me = 0; me < mNumMeshes && me < vNumMeshes && me < 1024; me++)
            {
                var mm = mMeshIdx + me * 116;
                Check(m, mm, 116);
                int skinRef = I(m, mm), meshVertOfs = I(m, mm + 12);
                var mesh = new Mesh { Material = MatOf(skinRef) };
                var map = new Dictionary<int, int>();
                var vmesh = vMeshOfs + me * 9;
                Check(vtx, vmesh, 9);
                int numSg = I(vtx, vmesh), sgOfs = vmesh + I(vtx, vmesh + 4);
                for (var g = 0; g < numSg && g < 64; g++)
                {
                    var sg = sgOfs + g * sgSize;
                    Check(vtx, sg, 25);
                    int numV = I(vtx, sg), vOfs = sg + I(vtx, sg + 4), numI = I(vtx, sg + 8), iOfs = sg + I(vtx, sg + 12);
                    Check(vtx, vOfs, numV * 9); Check(vtx, iOfs, numI * 2);
                    for (var k = 0; k + 2 < numI; k += 3)
                        // Source winds clockwise; glTF counter-clockwise
                        foreach (var c in new[] { 0, 2, 1 })
                        {
                            int sv = BitConverter.ToUInt16(vtx, iOfs + (k + c) * 2);
                            if (sv >= numV) throw new InvalidDataException("strip index out of range");
                            var orig = BitConverter.ToUInt16(vtx, vOfs + sv * 9 + 4);
                            var vi = mVertIndex + meshVertOfs + orig;
                            if (vi < 0 || vi >= raw.Count) throw new InvalidDataException("vertex out of range");
                            if (!map.TryGetValue(vi, out var li))
                            {
                                li = mesh.Pos.Count;
                                map[vi] = li;
                                mesh.Pos.Add(VPos(vi)); mesh.Nrm.Add(VNrm(vi)); mesh.Uv.Add(VUv(vi));
                                var vo = vStart + raw[vi] * 48;
                                mesh.RawPos.Add(V3(vvd, vo + 16)); mesh.RawNrm.Add(V3(vvd, vo + 28));
                                var nb = Math.Clamp((int)vvd[vo + 15], 1, 3);
                                mesh.Weights.Add((vvd[vo + 12], nb > 1 ? vvd[vo + 13] : (byte)0, nb > 2 ? vvd[vo + 14] : (byte)0,
                                    nb == 1 ? 1 : BitConverter.ToSingle(vvd, vo), nb > 1 ? BitConverter.ToSingle(vvd, vo + 4) : 0, nb > 2 ? BitConverter.ToSingle(vvd, vo + 8) : 0));
                            }
                            mesh.Idx.Add(li);
                        }
                }
                if (mesh.Idx.Count > 0) sm.Meshes.Add(mesh);
            }
        }
        return sm;
    }

    static void Check(byte[] d, int o, int len)
    {
        if (o < 0 || len < 0 || (long)o + len > d.Length) throw new InvalidDataException("offset outside the file");
    }

    static int I(byte[] d, int o) { Check(d, o, 4); return BitConverter.ToInt32(d, o); }
    static Vector3 V3(byte[] d, int o) { Check(d, o, 12); return new(BitConverter.ToSingle(d, o), BitConverter.ToSingle(d, o + 4), BitConverter.ToSingle(d, o + 8)); }

    static string Str(byte[] d, int o)
    {
        if (o < 0 || o >= d.Length) return "";
        var end = Array.IndexOf(d, (byte)0, o);
        return Encoding.UTF8.GetString(d, o, (end < 0 ? d.Length : end) - o);
    }
}
