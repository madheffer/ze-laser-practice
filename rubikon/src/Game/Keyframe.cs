using System.Numerics;
using Source2.Compiler.Simulation;

namespace Source2.Compiler.Game;

/// <summary>
/// Keyframed bodies as CS2 moves them (rubikon/CS2_RUNTIME.md "Keyframed movers"): the body wrapper's SetType keeps a
/// move-to-target object (CRnBody +0x80, <see cref="KinematicTarget"/>) on a keyframed body, and each tick the server
/// (FUN_1805836c0) hands every keyframed part the entity's transform through the aggregate's vfn 0x78 (180045bf0),
/// which sets the target (1802c5230) for the solver to reach over dt, or teleports when asked.
/// </summary>
public static class Keyframe
{
    /// <summary>
    /// The wrapper's SetType (vphysics2 180011210): CRnBody::SetType, then a keyframed body gets its target (1801b3ce0:
    /// the current frame origin and orientation, no time left) and any other loses it (1801b3e90). +0x4a bit 5 (a
    /// dynamic body that keeps one, FUN_1801c0fe0) is never set by the calls ported here.
    /// </summary>
    public static void SetType(RnWorld w, RnBody body, int type, IReadOnlyList<RnMassUpdate.Shape> shapes)
    {
        if (body.State.BodyType == type) return;
        BodyType.Set(w, body, type, shapes);
        ref var s = ref body.State;
        var keeps = s.BodyType == 1 || (s.BodyType == 2 && ((s.Flags4A >> 5) & 1) != 0);
        if (keeps)
        {
            body.Target ??= new KinematicTarget { Orientation = s.Orientation, Position = BodyOps.FrameOrigin(s), Time = 0f };
            s.Controller = 1; // +0x80 not null: the solver drives the body to the target (IslandSolver)
        }
        else
        {
            body.Target = null;
            s.Controller = 0;
        }
    }

    /// <summary>
    /// The shadow controller's target (1802c5230): the frame to reach and the time to take (not below 0). A sleeping body
    /// wakes when the target is more than 1/32 unit away (squared 0.0009765625) or turned more than 0.0349 rad (2 deg).
    /// </summary>
    /// <remarks>
    /// Checked against the disassembly: the frame origin is Transforms.FrameOrigin's; the turn is 2 atan2(|v|, w) of
    /// target x conj(body) (each lane ((a tw + .. tx) + .. ty) + .. tz on the sign-masked swizzles of 180449190..1c0),
    /// |v|^2 summed (y^2 + x^2) + z^2, wrapped by +-2pi past +-pi.
    /// </remarks>
    public static void SetTarget(RnWorld w, RnBody body, Vec3 position, Quat orientation, float dt)
    {
        var t = body.Target;
        if (t == null) return;
        t.Position = position;
        t.Orientation = orientation;
        t.Time = 0f <= dt ? dt : 0f;
        ref var s = ref body.State;
        if ((s.Flags249 & 4) == 0) return;
        var o = Transforms.FrameOrigin(s);
        float dx = position.X - o.X, dy = position.Y - o.Y, dz = position.Z - o.Z;
        if ((dx * dx) + (dy * dy) + (dz * dz) <= 0.0009765625f)
        {
            // a = conj(body) (xorps 180449190), t = the target
            var c = s.Orientation;
            float ax = -c.X, ay = -c.Y, az = -c.Z, aw = c.W;
            var q = orientation;
            var rx = (((ax * q.W) + (aw * q.X)) + (az * q.Y)) + (-ay * q.Z);
            var ry = (((ay * q.W) + (-az * q.X)) + (aw * q.Y)) + (ax * q.Z);
            var rz = (((az * q.W) + (ay * q.X)) + (-ax * q.Y)) + (aw * q.Z);
            var rw = (((aw * q.W) + (-ax * q.X)) + (-ay * q.Y)) + (-az * q.Z);
            var angle = CrtMath.Atan2(MathF.Sqrt(((ry * ry) + (rx * rx)) + (rz * rz)), rw);
            angle += angle;
            if (angle > 3.1415927f) angle += -6.2831855f;
            else if (-3.1415927f > angle) angle += 6.2831855f;
            if (MathF.Abs(angle) <= 0.03490659f) return;
        }
        ContactLifecycle.Wake(w, body, false);
    }

    /// <summary>
    /// The server's per-tick keyframe of an entity's physics (FUN_1805836c0 -> aggregate vfn 0x78, 180045bf0) for a
    /// one-part model: a keyframed body with a target gets the entity's frame over dt (phys_timescale x 1/64 x
    /// host_timescale when not given); <paramref name="teleport"/> or no target sets the transform instead (body vfn
    /// 0x1b8, 1801bd3b0: NOT PORTED, reported by the false return).
    /// </summary>
    public static bool Drive(GameWorld world, int index, Vector3 origin, Quaternion orientation, float dt = 0f, bool teleport = false)
    {
        var body = world.World.Bodies[index];
        if (body.State.BodyType != 1) return true;
        if (dt <= 0f) dt = world.PhysTimescale * 0.015625f;
        if (teleport || body.Target == null) return false;
        SetTarget(world.World, body, new Vec3(origin.X, origin.Y, origin.Z), new Quat(orientation.X, orientation.Y, orientation.Z, orientation.W), dt);
        return true;
    }
}
