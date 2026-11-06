using Source2.Compiler.Simulation;

namespace Source2.Compiler.Game;

/// <summary>A CTransform: position, uniform scale (the position vector's fourth lane) and rotation.</summary>
public readonly record struct GameTransform(Vec3 Position, float Scale, Quat Rotation);

/// <summary>
/// CS2's SSE transform code, lane for lane (rubikon/CS2_RUNTIME.md "Transform code"). Every lane is a separate IEEE
/// single operation in the order the disassembly does it (no FMA: addps / subps / mulps / divps / sqrtps round each
/// step), so these give the binaries' bits. dpps (0xff) sums (x*x + y*y) + (z*z + w*w) (Intel SDM).
/// </summary>
public static class Transforms
{
    const float FltEpsilon = 1.1920929e-07f; // 0x34000000: what a zero length becomes before a divide (181e85760)

    static float Dpps(in Quat q) => ((q.X * q.X) + (q.Y * q.Y)) + ((q.Z * q.Z) + (q.W * q.W));

    /// <summary>
    /// v turned by the unit quaternion q, as every rotate in these functions does it: t = (q.xyz x v) + (q.xyz x v),
    /// then (q.xyz x t) + (v + q.w t). (180e8de00, 180011fb0, 1802c5230, 181473ba0, 1814738d0 all keep this order.)
    /// </summary>
    public static Vec3 Rotate(in Quat q, in Vec3 v)
    {
        var tx = (v.Z * q.Y) - (v.Y * q.Z); tx += tx;
        var ty = (v.X * q.Z) - (v.Z * q.X); ty += ty;
        var tz = (v.Y * q.X) - (v.X * q.Y); tz += tz;
        return new Vec3(((tz * q.Y) - (ty * q.Z)) + (v.X + (q.W * tx)),
                        ((tx * q.Z) - (tz * q.X)) + (v.Y + (q.W * ty)),
                        ((ty * q.X) - (tx * q.Y)) + (v.Z + (q.W * tz)));
    }

    /// <summary>
    /// The body's frame origin as vphysics2's SSE paths work it out (body vfn 0x1b0, 180011fb0; the keyframe target's
    /// wake test, 1802c5230): the mass centre (+0xfc) minus the orientation (+0x120) turning scale (+0x88) x the local
    /// mass centre (+0xc8). The same value as BodyOps.FrameOrigin up to the last add's association.
    /// </summary>
    public static Vec3 FrameOrigin(in RnBodyState s)
    {
        var l = new Vec3(s.Scale * s.LocalMassCenter.X, s.Scale * s.LocalMassCenter.Y, s.Scale * s.LocalMassCenter.Z);
        var r = Rotate(s.Orientation, l);
        return new Vec3(s.Position.X - r.X, s.Position.Y - r.Y, s.Position.Z - r.Z);
    }

    /// <summary>
    /// Body vfn 0x1b0 (vphysics2 180011fb0): the body's transform, its frame origin, scale 1 and its orientation through a
    /// matrix and back (MatrixQuaternion: the trace branch, else the largest diagonal), normalized by dpps.
    /// </summary>
    public static GameTransform BodyTransform(in RnBodyState s) => new(FrameOrigin(s), 1f, BodyRotation(s.Orientation));

    /// <summary>180011fb0's rotation (also KeepUpright's vfn 0x1b0 read).</summary>
    public static Quat BodyRotation(in Quat q)
    {
        float x = q.X, y = q.Y, z = q.Z, w = q.W;
        var a7 = (z * z) + (y * y);
        var a23 = (w * y) + (z * x); a23 += a23;
        var a26 = (z * x) - (w * y); a26 += a26;
        var a15 = (z * z) + (x * x);
        var a17 = (y * y) + (x * x);
        var m00 = 1f - (a7 + a7);
        var a8 = (y * x) - (w * z); a8 += a8;
        var a11 = (w * z) + (y * x); a11 += a11;
        var m11 = 1f - (a15 + a15);
        var m22 = 1f - (a17 + a17);
        var a19 = (z * y) + (w * x); a19 += a19;
        var a9 = (z * y) - (w * x); a9 += a9;
        var trace = (m00 + m11) + m22;
        float cx, cy, cz, cw;
        if (trace < 0f)
        {
            if (m00 <= m11 || m00 <= m22)
            {
                if (m11 <= m22) { cx = a23 + a26; cy = a9 + a19; cz = ((m22 - m00) - m11) + 1f; cw = a11 - a8; }
                else { cx = a8 + a11; cy = ((m11 - m22) - m00) + 1f; cz = a9 + a19; cw = a23 - a26; }
            }
            else { cx = ((m00 - m11) - m22) + 1f; cy = a8 + a11; cz = a23 + a26; cw = a19 - a9; }
        }
        else { cx = a19 - a9; cy = a23 - a26; cz = a11 - a8; cw = trace + 1f; }
        var c = new Quat(cx, cy, cz, cw);
        var len = MathF.Sqrt(Dpps(c));
        // divps, then blendvps the identity (vphysics2 18055e870, filled at load) where the length is 0
        if (len == 0f) return Quat.Identity;
        return new Quat(cx / len, cy / len, cz / len, cw / len);
    }

    /// <summary>
    /// The inverse of a transform (server 181473ba0). The rotation's conjugate (mulps by (-1, -1, -1, 1)) normalized by
    /// dpps (a zero length divides by FLT_EPSILON). Scale 1: the position turned by the conjugate before it is normalized,
    /// negated (0 - r). Any other scale (0 read as FLT_EPSILON): turned by the normalized conjugate, times -1/s; scale 1/s.
    /// </summary>
    public static GameTransform Inverse(in GameTransform t)
    {
        var c = new Quat(t.Rotation.X * -1f, t.Rotation.Y * -1f, t.Rotation.Z * -1f, t.Rotation.W * 1f);
        var len = MathF.Sqrt(Dpps(c));
        if (len == 0f) len = FltEpsilon; // cmpeqps / andps / orps: 0 | FLT_EPSILON
        var n = new Quat(c.X / len, c.Y / len, c.Z / len, c.W / len);
        var p = t.Position;
        if (t.Scale == 1f)
        {
            var r = Rotate(c, p);
            return new GameTransform(new Vec3(0f - r.X, 0f - r.Y, 0f - r.Z), t.Scale, n);
        }
        var s = t.Scale == 0f ? FltEpsilon : t.Scale;
        var inv = 1f / s;
        var neg = 0f - inv;
        var rr = Rotate(n, p);
        return new GameTransform(new Vec3(rr.X * neg, rr.Y * neg, rr.Z * neg), inv, n);
    }

    /// <summary>
    /// a then b (server 1814738d0, ConcatTransforms): position a.q(b.p) x a.s + a.p, scale a.s x b.s, rotation a.q b.q
    /// as ((a.w b + a.x (b.w, -b.z, b.y, -b.x)) + a.y (b.z, b.w, -b.x, -b.y)) + a.z (-b.y, b.x, b.w, -b.z), normalized
    /// by dpps (the identity where the length is 0: 181f46f00, filled at load).
    /// </summary>
    public static GameTransform Concat(in GameTransform a, in GameTransform b)
    {
        var r = Rotate(a.Rotation, b.Position);
        var pos = new Vec3((r.X * a.Scale) + a.Position.X, (r.Y * a.Scale) + a.Position.Y, (r.Z * a.Scale) + a.Position.Z);
        var scale = a.Scale * b.Scale;
        Quat qa = a.Rotation, qb = b.Rotation;
        var q = new Quat(
            (((qa.W * qb.X) + (qa.X * qb.W)) + (qa.Y * qb.Z)) + (qa.Z * -qb.Y),
            (((qa.W * qb.Y) + (qa.X * -qb.Z)) + (qa.Y * qb.W)) + (qa.Z * qb.X),
            (((qa.W * qb.Z) + (qa.X * qb.Y)) + (qa.Y * -qb.X)) + (qa.Z * qb.W),
            (((qa.W * qb.W) + (qa.X * -qb.X)) + (qa.Y * -qb.Y)) + (qa.Z * -qb.Z));
        var len = MathF.Sqrt(Dpps(q));
        var rot = len == 0f ? Quat.Identity : new Quat(q.X / len, q.Y / len, q.Z / len, q.W / len);
        return new GameTransform(pos, scale, rot);
    }

    /// <summary>
    /// A quaternion's angles (server 181473400 -> 181470cb0): the rotation matrix 181473400 builds (q2 = q + q, the
    /// diagonal (1 - y 2y) - z 2z ..., the off-diagonals 2y x -+ 2z w ...), then MatrixAngles: with xy =
    /// sqrt(m10^2 + m00^2) over 0.001 yaw atan2(m10, m00), pitch atan2(-m20, xy), roll atan2(m21, m22), else yaw
    /// atan2(-m01, m11), pitch atan2(-m20, xy), roll 0; each times 57.29578 (pitch, yaw, roll in degrees).
    /// </summary>
    public static Vec3 QuaternionAngles(in Quat q)
    {
        float x2 = q.X + q.X, y2 = q.Y + q.Y, z2 = q.Z + q.Z;
        float sx = q.X * x2, sy = q.Y * y2, sz = q.Z * z2;
        var m00 = (1f - sy) - sz;
        var m11 = (1f - sx) - sz;
        var m22 = (1f - sx) - sy;
        float yx = y2 * q.X, zy = z2 * q.Y, zx = z2 * q.X; // xmm5: (2y x, 2z y, 2z x)
        float zw = z2 * q.W, xw = x2 * q.W, yw = y2 * q.W; // xmm3: (2z w, 2x w, 2y w)
        var m01 = yx - zw;
        var m10 = zw + yx;
        var m20 = zx - yw;
        var m21 = xw + zy;
        var xy = MathF.Sqrt((m10 * m10) + (m00 * m00));
        const float r2d = 57.29578f; // 0x42652ee0
        if (xy > 0.001f)
            return new Vec3(CrtMath.Atan2(-m20, xy) * r2d, CrtMath.Atan2(m10, m00) * r2d, CrtMath.Atan2(m21, m22) * r2d);
        return new Vec3(CrtMath.Atan2(-m20, xy) * r2d, CrtMath.Atan2(-m01, m11) * r2d, 0f);
    }
}
