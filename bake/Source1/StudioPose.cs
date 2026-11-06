// A studio model's skeleton and sequences (the SDK's studio.h, v44-49). Bones (mstudiobone_t, 216 bytes): parent,
// default position / rotation, the euler + scales compressed channels are relative to, and poseToBone. A sequence
// (mstudioseqdesc_t, 212 bytes) plays its first blend's animation (mstudioanimdesc_t, 100 bytes; in this .mdl:
// animblock 0, else the reference pose); a frame is decoded per bone from its mstudioanim_t: raw Quaternion48 /
// Quaternion64 / Vector48, or run-length mstudioanimvalue_t channels (ExtractAnimValue) times the bone's rotscale /
// posscale, added to the defaults unless STUDIO_ANIM_DELTA; long animations are cut into sections of sectionframes.
// Source draws a still model in sequence 0 frame 0: SkinMatrices. Every read is bounds-checked (attacker data).
using System.Numerics;
using System.Text;

namespace Lasers.Bake.Source1;

sealed class StudioPose
{
    const int AnimRawPos = 0x01, AnimRawRot = 0x02, AnimAnimPos = 0x04, AnimAnimRot = 0x08, AnimDelta = 0x10, AnimRawRot2 = 0x20;
    const int StudioLooping = 0x0001;

    public sealed record Sequence(string Name, int Anim, float Fps, int Frames, bool Loop, float FadeIn, float FadeOut);

    readonly byte[] m;
    public readonly int Count;
    public readonly string[] Names;
    public readonly int[] Parent;
    public readonly Vector3[] Pos, Euler, PosScale, RotScale;
    public readonly Quaternion[] Rot;
    public readonly Matrix4x4[] PoseToBone; // row-vector convention (v' = v x M)
    public readonly List<Sequence> Sequences = [];

    StudioPose(byte[] mdl, int n)
    {
        m = mdl;
        Count = n;
        Names = new string[n]; Parent = new int[n]; Pos = new Vector3[n]; Euler = new Vector3[n];
        PosScale = new Vector3[n]; RotScale = new Vector3[n]; Rot = new Quaternion[n]; PoseToBone = new Matrix4x4[n];
    }

    public static StudioPose? Read(byte[] m)
    {
        try
        {
            int numBones = I(m, 156), boneIdx = I(m, 160);
            if (numBones <= 0 || numBones > 256) return null;
            Check(m, boneIdx, numBones * 216);
            var s = new StudioPose(m, numBones);
            for (var b = 0; b < numBones; b++)
            {
                var o = boneIdx + b * 216;
                s.Names[b] = Str(m, o + I(m, o));
                s.Parent[b] = I(m, o + 4);
                s.Pos[b] = V3(m, o + 32);
                s.Rot[b] = new Quaternion(F(m, o + 44), F(m, o + 48), F(m, o + 52), F(m, o + 56));
                s.Euler[b] = V3(m, o + 60);
                s.PosScale[b] = V3(m, o + 72);
                s.RotScale[b] = V3(m, o + 84);
                // matrix3x4_t rows [r00 r01 r02 t0] [r10 r11 r12 t1] [r20 r21 r22 t2] (column vectors) -> row vectors
                var p = o + 96;
                s.PoseToBone[b] = new Matrix4x4(
                    F(m, p), F(m, p + 16), F(m, p + 32), 0,
                    F(m, p + 4), F(m, p + 20), F(m, p + 36), 0,
                    F(m, p + 8), F(m, p + 24), F(m, p + 40), 0,
                    F(m, p + 12), F(m, p + 28), F(m, p + 44), 1);
            }
            int numSeq = I(m, 188), seqIdx = I(m, 192), numAnim = I(m, 180), animIdx = I(m, 184);
            for (var q = 0; q < numSeq && q < 512; q++)
            {
                var sd = seqIdx + q * 212;
                Check(m, sd, 212);
                var anim = (short)U16(m, sd + I(m, sd + 60));
                if (anim < 0 || anim >= numAnim) continue;
                var ad = animIdx + anim * 100;
                Check(m, ad, 100);
                s.Sequences.Add(new Sequence(Str(m, sd + I(m, sd + 4)), anim, F(m, ad + 8), I(m, ad + 16),
                    (I(m, sd + 12) & StudioLooping) != 0, F(m, sd + 104), F(m, sd + 108)));
            }
            return s;
        }
        catch (InvalidDataException) { return null; }
    }

    // each bone's local position / rotation at a frame of an animation (the defaults where it has no data)
    public (Vector3[] Pos, Quaternion[] Rot) Frame(int anim, int frame)
    {
        var pos = (Vector3[])Pos.Clone();
        var rot = (Quaternion[])Rot.Clone();
        try { Decode(anim, frame, pos, rot); }
        catch (InvalidDataException) { /* the defaults stand */ }
        return (pos, rot);
    }

    // sequence 0 frame 0 skin matrices (boneToModel x poseToBone, row vectors), or null without a sequence
    public static Matrix4x4[]? SkinMatrices(byte[] mdl)
    {
        var s = Read(mdl);
        if (s == null) return null;
        var (pos, rot) = s.Sequences.Count > 0 ? s.Frame(s.Sequences[0].Anim, 0) : (s.Pos, s.Rot);
        var world = s.World(pos, rot);
        var skin = new Matrix4x4[s.Count];
        for (var b = 0; b < s.Count; b++) skin[b] = s.PoseToBone[b] * world[b];
        return skin;
    }

    public Matrix4x4[] World(Vector3[] pos, Quaternion[] rot)
    {
        var world = new Matrix4x4[Count];
        for (var b = 0; b < Count; b++)
        {
            var local = Matrix4x4.CreateFromQuaternion(rot[b]) * Matrix4x4.CreateTranslation(pos[b]);
            world[b] = Parent[b] >= 0 && Parent[b] < b ? local * world[Parent[b]] : local;
        }
        return world;
    }

    void Decode(int anim, int frame, Vector3[] pos, Quaternion[] rot)
    {
        var ad = I(m, 184) + anim * 100;
        Check(m, ad, 100);
        int animBlock = I(m, ad + 52), animIndex = I(m, ad + 56), sectionIndex = I(m, ad + 80), sectionFrames = I(m, ad + 84);
        if (sectionFrames > 0)
        {
            var section = frame / sectionFrames;
            frame -= section * sectionFrames;
            animBlock = I(m, ad + sectionIndex + section * 8);
            animIndex = I(m, ad + sectionIndex + section * 8 + 4);
        }
        if (animBlock != 0) return; // in an external .ani
        var a = ad + animIndex;
        for (var guard = 0; guard <= Count; guard++)
        {
            Check(m, a, 4);
            int bone = m[a], flags = m[a + 1], next = (short)U16(m, a + 2);
            if (bone < Count)
            {
                var data = a + 4;
                var delta = (flags & AnimDelta) != 0;
                if ((flags & AnimRawRot2) != 0) rot[bone] = Quat64(m, data);
                else if ((flags & AnimRawRot) != 0) rot[bone] = Quat48(m, data);
                else if ((flags & AnimAnimRot) != 0)
                {
                    var ang = new Vector3(Value(data, 0, frame), Value(data, 1, frame), Value(data, 2, frame)) * RotScale[bone];
                    if (!delta) ang += Euler[bone];
                    rot[bone] = AngleQuaternion(ang);
                }
                var posData = data + ((flags & AnimAnimRot) != 0 ? 6 : 0) + ((flags & AnimRawRot) != 0 ? 6 : 0) + ((flags & AnimRawRot2) != 0 ? 8 : 0);
                if ((flags & AnimRawPos) != 0) pos[bone] = new Vector3((float)H(m, posData), (float)H(m, posData + 2), (float)H(m, posData + 4));
                else if ((flags & AnimAnimPos) != 0)
                {
                    var v = new Vector3(Value(posData, 0, frame), Value(posData, 1, frame), Value(posData, 2, frame)) * PosScale[bone];
                    pos[bone] = delta ? v : Pos[bone] + v;
                }
            }
            if (next == 0) break;
            a += next;
        }
    }

    // ExtractAnimValue: channel i of an mstudioanim_valueptr_t (3 shorts, offsets from it; 0 = no data) at a frame.
    // mstudioanimvalue_t is 2 bytes: a run header {byte valid, byte total} then `valid` shorts; frames past the
    // valid ones repeat the last value
    float Value(int valuePtr, int i, int frame)
    {
        var off = (short)U16(m, valuePtr + i * 2);
        if (off == 0) return 0;
        var v = valuePtr + off;
        var k = frame;
        for (var guard = 0; guard < 65536; guard++)
        {
            Check(m, v, 2);
            int valid = m[v], total = m[v + 1];
            if (total == 0) return 0;
            if (k < total) return (short)U16(m, v + 2 * (valid > k ? k + 1 : valid));
            k -= total;
            v += 2 * (valid + 1);
        }
        return 0;
    }

    static Quaternion Quat48(byte[] m, int o)
    {
        Check(m, o, 6);
        int x = U16(m, o), y = U16(m, o + 2), zw = U16(m, o + 4);
        float fx = (x - 32768) / 32768f, fy = (y - 32768) / 32768f, fz = ((zw & 0x7fff) - 16384) / 16384f;
        var w = MathF.Sqrt(Math.Max(0, 1 - fx * fx - fy * fy - fz * fz));
        return new Quaternion(fx, fy, fz, (zw & 0x8000) != 0 ? -w : w);
    }

    static Quaternion Quat64(byte[] m, int o)
    {
        Check(m, o, 8);
        var v = BitConverter.ToUInt64(m, o);
        float fx = ((long)(v & 0x1fffff) - 1048576) / 1048576.5f;
        float fy = ((long)((v >> 21) & 0x1fffff) - 1048576) / 1048576.5f;
        float fz = ((long)((v >> 42) & 0x1fffff) - 1048576) / 1048576.5f;
        var w = MathF.Sqrt(Math.Max(0, 1 - fx * fx - fy * fy - fz * fz));
        return new Quaternion(fx, fy, fz, (v >> 63) != 0 ? -w : w);
    }

    // mathlib AngleQuaternion(RadianEuler): x roll, y pitch, z yaw
    static Quaternion AngleQuaternion(Vector3 a)
    {
        float sr = MathF.Sin(a.X * 0.5f), cr = MathF.Cos(a.X * 0.5f), sp = MathF.Sin(a.Y * 0.5f), cp = MathF.Cos(a.Y * 0.5f);
        float sy = MathF.Sin(a.Z * 0.5f), cy = MathF.Cos(a.Z * 0.5f);
        float srXcp = sr * cp, crXsp = cr * sp, crXcp = cr * cp, srXsp = sr * sp;
        return new Quaternion(srXcp * cy - crXsp * sy, crXsp * cy + srXcp * sy, crXcp * sy - srXsp * cy, crXcp * cy + srXsp * sy);
    }

    static void Check(byte[] d, int o, int len)
    {
        if (o < 0 || len < 0 || (long)o + len > d.Length) throw new InvalidDataException("offset outside the file");
    }
    static int I(byte[] d, int o) { Check(d, o, 4); return BitConverter.ToInt32(d, o); }
    static int U16(byte[] d, int o) { Check(d, o, 2); return BitConverter.ToUInt16(d, o); }
    static float F(byte[] d, int o) { Check(d, o, 4); return BitConverter.ToSingle(d, o); }
    static Half H(byte[] d, int o) { Check(d, o, 2); return BitConverter.ToHalf(d, o); }
    static Vector3 V3(byte[] d, int o) => new(F(d, o), F(d, o + 4), F(d, o + 8));
    static string Str(byte[] d, int o)
    {
        if (o < 0 || o >= d.Length) return "";
        var end = Array.IndexOf(d, (byte)0, o);
        return Encoding.UTF8.GetString(d, o, Math.Min(128, (end < 0 ? d.Length : end) - o));
    }
}
