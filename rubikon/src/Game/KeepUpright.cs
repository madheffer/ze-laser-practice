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
        var goal = ConjugateRotate(Transforms.BodyRotation(b.Orientation), WorldGoalAxis); // vfn 0x1b0, then 180e8de00
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

    // 180e8de00 (checked against its disassembly): the transform's rotation (+0x10) with x, y, z negated (xorps
    // 181e857d0), normalized by dpps (divps; a zero length takes 181f46f00, filled at load: the identity), turning v as
    // Transforms.Rotate does: (q x t) + (v + w t)
    static Vec3 ConjugateRotate(Quat t, Vec3 v)
    {
        float x = -t.X, y = -t.Y, z = -t.Z, w = t.W;
        var len = MathF.Sqrt(((x * x) + (y * y)) + ((z * z) + (w * w)));
        var q = len == 0f ? Quat.Identity : new Quat(x / len, y / len, z / len, w / len);
        return Transforms.Rotate(q, v);
    }

    // 180e69700 (checked against its disassembly): the axis of the turn from test to goal (their cross product,
    // normalized) times (invDt x the angle between them in degrees - gain x the angular velocity about that axis), then
    // normalized and held to the limit (minss limit, len). A length outside [1e-17, 1e17] (and not 0) is normalized by
    // FUN_181471150 in double precision
    static Vec3 Correction(Vec3 test, Vec3 goal, Vec3 w, float gain, float invDt, float limit)
    {
        var ax = (test.Y * goal.Z) - (goal.Y * test.Z);
        var ay = (test.Z * goal.X) - (goal.Z * test.X);
        var az = (goal.Y * test.X) - (test.Y * goal.X);
        var sin = MathF.Sqrt(((az * az) + (ay * ay)) + (ax * ax));
        float nx, ny, nz;
        if (sin < 1e-17f || 1e+17f < sin)
        {
            if (sin != 0f) sin = NormalizeDouble(ref ax, ref ay, ref az);
            else { ax = 0f; ay = 0f; az = 0f; sin = 0f; }
            nx = ax; ny = ay; nz = az;
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
            if (len != 0f) { len = NormalizeDouble(ref rx, ref ry, ref rz); dx = rx; dy = ry; dz = rz; }
            else { dx = 0f; dy = 0f; dz = 0f; len = 0f; }
        }
        else { var r = 1f / len; dx = r * rx; dy = r * ry; dz = r * rz; }
        var m = limit < len ? limit : len; // minss xmm1(limit), xmm0(len)
        return new Vec3(dx * m, dy * m, dz * m);
    }

    // FUN_181471150: the vector normalized in double precision (sqrt((y*y + x*x) + z*z), times 1.0 / length, each rounded
    // to float), returning (float)min(length, FLT_MAX)
    static float NormalizeDouble(ref float x, ref float y, ref float z)
    {
        double dx = x, dy = y, dz = z;
        var len = Math.Sqrt(((dy * dy) + (dx * dx)) + (dz * dz));
        var r = 1.0 / len;
        x = (float)(r * dx);
        y = (float)(r * dy);
        z = (float)(r * dz);
        return (float)(len < 3.4028234663852886e+38 ? len : 3.4028234663852886e+38);
    }

    public static Vec3 UpVector(Quaternion orientation)
    {
        var u = Vector3.Transform(Vector3.UnitZ, orientation);
        return new Vec3(u.X, u.Y, u.Z);
    }
}
