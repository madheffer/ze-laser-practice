using System.Numerics;
using Source2.Compiler.Simulation;

namespace Source2.Compiler.Game;

/// <summary>
/// CS2's phys_thruster (server CPhysThruster, vtable 1819bab40; rubikon/CS2_RUNTIME.md), its physics half: the offset and
/// facing it takes when activated, the push it works out once when it starts, and its controller's event, which adds
/// that push x dt to the body's velocities after every step. The entity half (inputs, forcetime's stop, the
/// angles a KeyValues sets) is the game's (web/src/world/entities/classes/physics.js), which calls in here.
/// </summary>
public sealed class Thruster : IMotionEvent
{
    /// <summary>+0x360: 1 start on, 2 force, 4 torque, 8 orient locally, 16 ignore mass (never read), 32 ignore position.</summary>
    public int SpawnFlags;
    /// <summary>+0x4b8: the force keyvalue (Scale input sets it).</summary>
    public float Force;
    /// <summary>The scene node's local angles (+0x270 +0xb8: pitch, yaw, roll in degrees); with 8, relative to the body.</summary>
    public Vector3 LocalAngles;
    /// <summary>+0x508: the offset from the body's frame, in the body's frame (0 unless orient locally).</summary>
    public Vec3 LocalOrigin;
    /// <summary>+0x4d4 / +0x4e0: the velocity changes per second SetupForces worked out.</summary>
    public Vec3 Linear, Angular;
    /// <summary>+0x4c0: the attached body.</summary>
    public RnBody? Body;
    /// <summary>+0x4a8 (+0x95 x 8): the controller while running.</summary>
    public MotionController? Controller;

    public bool Async => false; // vfn 0x28 (1803e58a0) returns 0
    bool Local => (SpawnFlags & 8) != 0; // the event's +8 byte (180e91610: entity +0x4d0 = spawnflags bit 3)

    /// <summary>
    /// OnActivate (slot 0x778, 180e84c70), at spawn: with 8 the thruster's transform relative to the body (its
    /// position the offset, its rotation the local angles); with 32 the offset is zeroed.
    /// SEMANTIC PORT: the server's transform inverse / concat (181473ba0, 1814738d0) and MatrixAngles (181473400 ->
    /// 181470cb0) are SSE transform code not matched bit for bit; this is the same transform in plain float math.
    /// </summary>
    public void OnActivate(Vector3 thrusterPosition, Quaternion thrusterOrientation)
    {
        if (Body == null) return;
        if (Local)
        {
            ref var b = ref Body.State;
            var o = BodyOps.LocalToWorldPoint(b, default);
            var inv = Quaternion.Conjugate(new Quaternion(b.Orientation.X, b.Orientation.Y, b.Orientation.Z, b.Orientation.W));
            var rel = Vector3.Transform(thrusterPosition - new Vector3(o.X, o.Y, o.Z), inv);
            LocalOrigin = new Vec3(rel.X, rel.Y, rel.Z);
            LocalAngles = MatrixAngles(Quaternion.Normalize(inv * thrusterOrientation));
        }
        if ((SpawnFlags & 32) != 0) LocalOrigin = default;
    }

    /// <summary>
    /// SetupForces (slot 0x770, 180e8f680), once when the force starts (180e73b40): F = forward(local angles) x force x
    /// 1000. Without 8: F is world, at the offset placed by the body's entity transform. With 8: F and the offset are the
    /// body's, turned to world; the results go back to the body's frame. Spawnflag 2 clear zeroes the linear part, 4 the
    /// angular. <paramref name="entityPosition"/> / <paramref name="entityOrientation"/>: the body entity's transform
    /// (FUN_1803cf340), scale 1.
    /// </summary>
    public void SetupForces(Vec3 entityPosition, Quat entityOrientation)
    {
        Linear = default; Angular = default;
        if (Body == null) return;
        ref var b = ref Body.State;
        var dir = Forward(LocalAngles);
        var k = Force * 1000f;
        var f = new Vec3(dir.X * k, dir.Y * k, dir.Z * k);
        if (!Local)
        {
            // the offset turned by the entity's rotation, times its scale (1), plus its origin (180e8f680's first branch)
            var q = entityOrientation;
            var lo = LocalOrigin;
            var fy = ((lo.Z * q.Y) - (lo.Y * q.Z)); var fx = fy + fy;
            var gy = ((lo.X * q.Z) - (lo.Z * q.X)); var gx = gy + gy;
            var hy = ((lo.Y * q.X) - (lo.X * q.Y)); var hx = hy + hy;
            const float scale = 1f;
            var point = new Vec3(((((hx * q.Y) - (gx * q.Z)) + lo.X) + (q.W * fx)) * scale + entityPosition.X,
                                 ((((fx * q.Z) - (hx * q.X)) + lo.Y) + (q.W * gx)) * scale + entityPosition.Y,
                                 ((((gx * q.X) - (fx * q.Y)) + lo.Z) + (q.W * hx)) * scale + entityPosition.Z);
            (Linear, Angular) = BodyOps.VelocityOffset(b, f, point);
        }
        else
        {
            var point = BodyOps.LocalToWorldPoint(b, LocalOrigin);
            var fw = BodyOps.LocalToWorldVector(b, f);
            var (lin, ang) = BodyOps.VelocityOffset(b, fw, point);
            Linear = BodyOps.WorldToLocalVector(b, lin);
            Angular = BodyOps.WorldToLocalVector(b, ang);
        }
        if ((SpawnFlags & 2) == 0) Linear = default;
        if ((SpawnFlags & 4) == 0) Angular = default;
    }

    /// <summary>The event's Simulate (180e90eb0): linear x dt (turned to world with 8) to body vfn 0x208, angular x dt to 0x240.</summary>
    public void Simulate(MotionController controller, RnBody body, float dt)
    {
        var w = controller.World.World;
        var lin = new Vec3(dt * Linear.X, dt * Linear.Y, dt * Linear.Z);
        if (Local) lin = BodyOps.LocalToWorldVector(body.State, lin);
        BodyOps.AddVelocity(w, body, lin);
        BodyOps.AddLocalAngularVelocity(w, body, new Vec3(dt * Angular.X, dt * Angular.Y, dt * Angular.Z));
    }

    // AngleVectors' forward (18146e220): sincos of yaw and pitch (degrees x 0.017453292, tier0's V_sincosf = CrtMath)
    static Vec3 Forward(Vector3 a)
    {
        float sy = CrtMath.Sin(a.Y * 0.017453292f), cy = CrtMath.Cos(a.Y * 0.017453292f);
        float sp = CrtMath.Sin(a.X * 0.017453292f), cp = CrtMath.Cos(a.X * 0.017453292f);
        return new Vec3(cy * cp, sy * cp, -sp);
    }

    // Source's MatrixAngles of a rotation (pitch, yaw, roll in degrees). SEMANTIC PORT (see OnActivate)
    static Vector3 MatrixAngles(Quaternion q)
    {
        var m = Matrix4x4.CreateFromQuaternion(q); // row-vector convention: rows are the rotated axes
        float fx = m.M11, fy = m.M12, fz = m.M13, lx = m.M21, ly = m.M22, lz = m.M23, uz = m.M33;
        var xy = MathF.Sqrt((fx * fx) + (fy * fy));
        const float r2d = 57.29578f;
        if (xy > 0.001f)
            return new Vector3(CrtMath.Atan2(-fz, xy) * r2d, CrtMath.Atan2(fy, fx) * r2d, CrtMath.Atan2(lz, uz) * r2d);
        return new Vector3(CrtMath.Atan2(-fz, xy) * r2d, CrtMath.Atan2(-lx, ly) * r2d, 0f);
    }
}
