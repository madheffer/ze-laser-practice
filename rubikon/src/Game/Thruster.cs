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
    /// <summary>+0x4b8: the force keyvalue (KeyValues force changes it; read by the next start's SetupForces).</summary>
    public float Force;
    /// <summary>
    /// The scene node's local angles (m_angRotation, +0x270 +0xb8: pitch, yaw, roll in degrees), read by SetupForces at
    /// every start. With 8 OnActivate sets them (180e84c70 -> 1803e4440) to the thruster's rotation relative to the body.
    /// </summary>
    public Vector3 LocalAngles;
    /// <summary>+0x508: the offset from the body's frame, in the body's frame (0 unless orient locally).</summary>
    public Vec3 LocalOrigin;
    /// <summary>+0x4d4 / +0x4e0: the velocity changes per second the controller adds (the Scale input rescales them).</summary>
    public Vec3 Linear, Angular;
    /// <summary>+0x4ec / +0x4f8: SetupForces' result as the start kept it, what Scale multiplies (180e8e520).</summary>
    public Vec3 BaseLinear, BaseAngular;
    /// <summary>+0x4c0: the attached body.</summary>
    public RnBody? Body;
    /// <summary>+0x4a8 (+0x95 x 8): the controller while running.</summary>
    public MotionController? Controller;

    public bool Async => false; // vfn 0x28 (1803e58a0) returns 0
    bool Local => (SpawnFlags & 8) != 0; // the event's +8 byte (180e91610: entity +0x4d0 = spawnflags bit 3)

    /// <summary>
    /// OnActivate (slot 0x778, 180e84c70), at spawn: with 8 the thruster's transform relative to the body's (body vfn
    /// 0x1b0, inverted by 181473ba0, concatenated with the thruster's by 1814738d0): its position is the offset (+0x508),
    /// its rotation's angles (181473400) become the thruster's local angles; with 32 the offset is zeroed. Lane for lane
    /// as the server's SSE code (Transforms); the thruster's own transform is the game's, from its angles.
    /// </summary>
    public void OnActivate(Vector3 thrusterPosition, Quaternion thrusterOrientation)
    {
        if (Body == null) return;
        if (Local)
        {
            var inv = Transforms.Inverse(Transforms.BodyTransform(Body.State));
            var rel = Transforms.Concat(inv, new GameTransform(new Vec3(thrusterPosition.X, thrusterPosition.Y, thrusterPosition.Z), 1f,
                new Quat(thrusterOrientation.X, thrusterOrientation.Y, thrusterOrientation.Z, thrusterOrientation.W)));
            LocalOrigin = rel.Position;
            var a = Transforms.QuaternionAngles(rel.Rotation);
            LocalAngles = new Vector3(a.X, a.Y, a.Z);
        }
        if ((SpawnFlags & 32) != 0) LocalOrigin = default;
    }

    /// <summary>The start's SetupForces (180e73b40): the result is both the running push and the base Scale works from.</summary>
    public void Start(Vec3 entityPosition, Quat entityOrientation)
    {
        SetupForces(entityPosition, entityOrientation);
        BaseLinear = Linear;
        BaseAngular = Angular;
    }

    /// <summary>The Scale input (180e3fc80 -> 180e8e520): the running push is scale x the base, lane by lane.</summary>
    public void Scale(float scale)
    {
        Linear = new Vec3(scale * BaseLinear.X, scale * BaseLinear.Y, scale * BaseLinear.Z);
        Angular = new Vec3(scale * BaseAngular.X, scale * BaseAngular.Y, scale * BaseAngular.Z);
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
}
