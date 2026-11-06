using System.Numerics;
using Source2.Compiler.Simulation;

namespace Source2.Compiler.Game;

/// <summary>
/// CS2's phys_keepupright (server CKeepUpright, vtable 1819bbbd0, its IMotionEvent at +0x4a8, vtable 1819bc348;
/// rubikon/CS2_RUNTIME.md). Spawn (180e914c0): the local test axis (+0x4bc) is (0, 0, 1), the world goal axis (+0x4b0)
/// the entity's own up vector, active (+0x4e0) unless spawnflag 1. Its event is synchronous (vfn 0x28 false): after
/// every step Simulate (180e91090) turns the goal axis into the body's frame and adds the angular velocity that brings
/// the test axis onto it within one step, no faster than angularlimit (deg/s), through body vfn 0x240.
/// </summary>
public sealed class KeepUpright : IMotionEvent
{
    public Vec3 WorldGoalAxis = new(0f, 0f, 1f);
    public Vec3 LocalTestAxis = new(0f, 0f, 1f);
    /// <summary>+0x4dc: the angularlimit keyvalue (SetAngularLimit input).</summary>
    public float AngularLimit;
    /// <summary>+0x4e0: TurnOn / TurnOff.</summary>
    public bool Active;
    /// <summary>+0x4e1: the dampallrotation keyvalue.</summary>
    public bool DampAllRotation;
    public MotionController? Controller;

    public bool Async => false;

    public void Simulate(MotionController controller, RnBody body, float dt)
    {
        if (!Active) return;
        ref var b = ref body.State;
        var w = LocalAngularVelocity(b);                        // body vfn 0x248
        var goal = ConjugateRotate(TransformRotation(b), WorldGoalAxis); // vfn 0x1b0, then 180e8de00
        Vec3 add;
        if (!DampAllRotation)
            add = Correction(LocalTestAxis, goal, w, 1f, 1f / dt, AngularLimit);
        else
        {
            var c = Correction(LocalTestAxis, goal, w, 0f, 1f / dt, AngularLimit);
            add = new Vec3(c.X - w.X, c.Y - w.Y, c.Z - w.Z);
        }
        BodyOps.AddLocalAngularVelocity(controller.World.World, body, add);
    }

    // body vfn 0x248 (vphysics2 180014550): the angular velocity in the body's frame, in degrees
    static Vec3 LocalAngularVelocity(in RnBodyState b)
    {
        var q = b.Orientation;
        var v = b.AngularVelocity;
        var tx = (v.X * q.W) - ((v.Z * q.Y) - (v.Y * q.Z));
        var ty = (v.Y * q.W) - ((v.X * q.Z) - (v.Z * q.X));
        var tz = (v.Z * q.W) - ((v.Y * q.X) - (v.X * q.Y));
        var uz = (ty * q.X) - (tx * q.Y);
        var ux = (q.Y * tz) - (ty * q.Z);
        var uy = (tx * q.Z) - (q.X * tz);
        const float deg = 57.295776f;
        return new Vec3((v.X - (ux + ux)) * deg, (v.Y - (uy + uy)) * deg, (v.Z - (uz + uz)) * deg);
    }

    // body vfn 0x1b0 (vphysics2 180011fb0), its rotation: the orientation as a matrix, back to a quaternion
    // (MatrixQuaternion: the trace branch, else the largest diagonal), normalized by dpps (Intel SDM: (x*x + y*y) +
    // (z*z + w*w)), the identity when it has no length
    static Quat TransformRotation(in RnBodyState b)
    {
        var q = b.Orientation;
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
        var len = MathF.Sqrt(((cx * cx) + (cy * cy)) + ((cz * cz) + (cw * cw)));
        if (len == 0f) return new Quat { X = 0f, Y = 0f, Z = 0f, W = 1f };
        return new Quat { X = cx / len, Y = cy / len, Z = cz / len, W = cw / len };
    }

    // 180e8de00: the vector turned by the conjugate rotation (the transform's quaternion with x, y, z negated, normalized
    // by dpps). Operation order from the decompile, not yet checked against the disassembly
    static Vec3 ConjugateRotate(Quat t, Vec3 v)
    {
        float x = -t.X, y = -t.Y, z = -t.Z, w = t.W;
        var len = MathF.Sqrt(((x * x) + (y * y)) + ((z * z) + (w * w)));
        if (len == 0f) { x = 0f; y = 0f; z = 0f; w = 1f; }
        else { x /= len; y /= len; z /= len; w /= len; }
        var f6 = (v.Z * y) - (v.Y * z); f6 += f6;
        var f7 = (v.X * z) - (v.Z * x); f7 += f7;
        var f8 = (v.Y * x) - (v.X * y); f8 += f8;
        return new Vec3((((f8 * y) - (f7 * z)) + v.X) + (w * f6),
                        (((f6 * z) - (f8 * x)) + v.Y) + (w * f7),
                        (((f7 * x) - (f6 * y)) + v.Z) + (w * f8));
    }

    // 180e69700: the axis of the turn from test to goal (their cross product, normalized) times (invDt x the angle
    // between them in degrees - gain x the angular velocity about that axis), then normalized and held to the limit.
    // Operation order from the decompile, not yet checked against the disassembly. A cross product shorter than 1e-17
    // (FUN_181471150, a scaled normalize) is normalized directly here
    static Vec3 Correction(Vec3 test, Vec3 goal, Vec3 w, float gain, float invDt, float limit)
    {
        var ax = (test.Y * goal.Z) - (goal.Y * test.Z);
        var ay = (test.Z * goal.X) - (goal.Z * test.X);
        var az = (goal.Y * test.X) - (test.Y * goal.X);
        var sin = MathF.Sqrt(((az * az) + (ay * ay)) + (ax * ax));
        float nx, ny, nz;
        if (sin < 1e-17f || 1e+17f < sin)
        {
            if (sin != 0f) { nx = ax / sin; ny = ay / sin; nz = az / sin; }
            else { nx = 0f; ny = 0f; nz = 0f; }
        }
        else { var r = 1f / sin; nx = r * ax; ny = r * ay; nz = r * az; }
        var cos = ((goal.Y * test.Y) + (test.Z * goal.Z)) + (test.X * goal.X);
        var angle = CrtMath.Atan2(sin, cos) * 57.295776f;
        var proj = ((w.Y * ny) + (w.Z * nz)) + (w.X * nx);
        var rx = ((nx * invDt) * angle) - ((nx * gain) * proj);
        var ry = ((ny * invDt) * angle) - ((ny * gain) * proj);
        var rz = ((nz * invDt) * angle) - ((nz * gain) * proj);
        var len = MathF.Sqrt(((ry * ry) + (rz * rz)) + (rx * rx));
        float dx, dy, dz;
        if (len < 1e-17f || 1e+17f < len)
        {
            if (len != 0f) { dx = rx / len; dy = ry / len; dz = rz / len; }
            else { dx = 0f; dy = 0f; dz = 0f; len = 0f; }
        }
        else { var r = 1f / len; dx = r * rx; dy = r * ry; dz = r * rz; }
        if (len <= limit) limit = len;
        return new Vec3(dx * limit, dy * limit, dz * limit);
    }

    public static Vec3 UpVector(Quaternion orientation)
    {
        var u = Vector3.Transform(Vector3.UnitZ, orientation);
        return new Vec3(u.X, u.Y, u.Z);
    }
}
