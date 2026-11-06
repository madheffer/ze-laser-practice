using Source2.Compiler.Simulation;

namespace Source2.Compiler.Game;

// vphysics2's CPhysicsBody calls the server's physics entities make (vtable 1803f44e0, vphysics2_20260924; the same code
// at the same addresses in the 20260923 build), on the body's RnBodyState (CRnBody +0x08). Operation order and constants
// from the disassembly (rubikon/CS2_RUNTIME.md). q is the body's orientation (+0x120), the mass centre's world position
// +0xfc, the linear velocity +0x108, the angular velocity +0x114 (radians, world).
public static class BodyOps
{
    // 0x1d8 (180013390 -> 180010b10): a body-frame vector in world space, v + 2 q x (q x v + w v)
    public static Vec3 LocalToWorldVector(in RnBodyState b, Vec3 v)
    {
        var q = b.Orientation;
        var tx = ((v.Z * q.Y) - (v.Y * q.Z)) + (v.X * q.W);
        var ty = ((v.X * q.Z) - (v.Z * q.X)) + (v.Y * q.W);
        var tz = ((v.Y * q.X) - (v.X * q.Y)) + (v.Z * q.W);
        var uz = (ty * q.X) - (tx * q.Y);
        var uy = (tx * q.Z) - (tz * q.X);
        var ux = (tz * q.Y) - (ty * q.Z);
        return new Vec3((ux + ux) + v.X, (uy + uy) + v.Y, (uz + uz) + v.Z);
    }

    // 0x1d0 (180013230): a world vector in the body's frame (the inverse rotation)
    public static Vec3 WorldToLocalVector(in RnBodyState b, Vec3 v)
    {
        var q = b.Orientation;
        var tx = (v.X * q.W) - ((v.Z * q.Y) - (v.Y * q.Z));
        var ty = (v.Y * q.W) - ((v.X * q.Z) - (v.Z * q.X));
        var tz = (v.Z * q.W) - ((v.Y * q.X) - (v.X * q.Y));
        var uz = (ty * q.X) - (tx * q.Y);
        var uy = (tx * q.Z) - (tz * q.X);
        var ux = (tz * q.Y) - (ty * q.Z);
        return new Vec3(v.X - (ux + ux), v.Y - (uy + uy), v.Z - (uz + uz));
    }

    // 0x1e8 (180013400 -> 180009d10): a body-frame point in world space. The frame's origin is the mass centre less the
    // local mass centre (times the scale +0x88) turned to world: R = (q x t) + (v + w t), t = 2 (q x v), packed in SSE
    public static Vec3 LocalToWorldPoint(in RnBodyState b, Vec3 p)
    {
        var q = b.Orientation;
        // the point turned (scalar)
        var tx = ((p.Z * q.Y) - (p.Y * q.Z)) + (q.W * p.X);
        var ty = ((p.X * q.Z) - (p.Z * q.X)) + (q.W * p.Y);
        var tz = ((p.Y * q.X) - (p.X * q.Y)) + (q.W * p.Z);
        var uy = (q.Z * tx) - (tz * q.X);
        var ux = (tz * q.Y) - (ty * q.Z);
        var uz = (ty * q.X) - (q.Y * tx);
        // the local mass centre turned (packed)
        var s = b.Scale;
        float vx = s * b.LocalMassCenter.X, vy = s * b.LocalMassCenter.Y, vz = s * b.LocalMassCenter.Z;
        var cx = (vz * q.Y) - (vy * q.Z);
        var cy = (vx * q.Z) - (vz * q.X);
        var cz = (vy * q.X) - (vx * q.Y);
        cx += cx; cy += cy; cz += cz;
        var ax = vx + (q.W * cx);
        var ay = vy + (q.W * cy);
        var az = vz + (q.W * cz);
        var rx = ((cz * q.Y) - (cy * q.Z)) + ax;
        var ry = ((cx * q.Z) - (cz * q.X)) + ay;
        var rz = ((cy * q.X) - (cx * q.Y)) + az;
        return new Vec3((b.Position.X - rx) + ((ux + ux) + p.X),
                        ((uy + uy) + p.Y) + (b.Position.Y - ry),
                        ((uz + uz) + p.Z) + (b.Position.Z - rz));
    }

    static bool Finite(float f) => (BitConverter.SingleToUInt32Bits(f) & 0x7f800000) != 0x7f800000;

    // 0x208 (180012620): linear velocity += v; nothing when a sum is not finite or the body is static (+0x54 == 0); the
    // new velocity's |v|^2 over 0.16 wakes it (FUN_1801c0ff0, the timer kept)
    public static void AddVelocity(RnWorld w, RnBody body, Vec3 v)
    {
        ref var b = ref body.State;
        var x = b.LinearVelocity.X + v.X;
        var y = b.LinearVelocity.Y + v.Y;
        var z = b.LinearVelocity.Z + v.Z;
        if (!Finite(x) || !Finite(y) || !Finite(z) || b.BodyType == 0) return;
        if (0.16000001f < ((y * y) + (x * x)) + (z * z)) ContactLifecycle.Wake(w, body, false);
        b.LinearVelocity = new Vec3(x, y, z);
    }

    // 0x240 (1800147d0): angular velocity += the body-frame vector (degrees) turned to world, in radians (x 0.0174532924);
    // the same finiteness and static rule, a wake over 0.0048738797
    public static void AddLocalAngularVelocity(RnWorld w, RnBody body, Vec3 d)
    {
        ref var b = ref body.State;
        var q = b.Orientation;
        var tx = ((q.Y * d.Z) - (q.Z * d.Y)) + (d.X * q.W);
        var ty = ((q.Z * d.X) - (q.X * d.Z)) + (d.Y * q.W);
        var tz = ((q.X * d.Y) - (q.Y * d.X)) + (d.Z * q.W);
        var uz = (ty * q.X) - (tx * q.Y);
        var uy = (tx * q.Z) - (tz * q.X);
        var ux = (tz * q.Y) - (ty * q.Z);
        const float k = 0.0174532924f;
        var z = (((uz + uz) + d.Z) * k) + b.AngularVelocity.Z;
        var y = (((uy + uy) + d.Y) * k) + b.AngularVelocity.Y;
        var x = (((ux + ux) + d.X) * k) + b.AngularVelocity.X;
        if (!Finite(x) || !Finite(y) || !Finite(z) || b.BodyType == 0) return;
        if (0.0048738797f < ((y * y) + (x * x)) + (z * z)) ContactLifecycle.Wake(w, body, false);
        b.AngularVelocity = new Vec3(x, y, z);
    }

    // 0x270 (180014a20): a force at a world point as velocity changes: linear = F x invMass; angular = the world inverse
    // inertia (+0xd8) x ((point - mass centre) x F), in degrees
    public static (Vec3 Linear, Vec3 Angular) VelocityOffset(in RnBodyState b, Vec3 f, Vec3 point)
    {
        var im = b.InvMass;
        var linear = new Vec3(im * f.X, im * f.Y, im * f.Z);
        var rx = point.X - b.Position.X;
        var ry = point.Y - b.Position.Y;
        var rz = point.Z - b.Position.Z;
        var a = (ry * f.Z) - (rz * f.Y);
        var c = (rx * f.Y) - (ry * f.X);
        var bb = (rz * f.X) - (rx * f.Z);
        ref readonly var m = ref b.WorldInvInertia;
        const float deg = 57.2957764f;
        var angular = new Vec3((((bb * m.M3) + (a * m.M0)) + (c * m.M6)) * deg,
                               (((bb * m.M4) + (a * m.M1)) + (c * m.M7)) * deg,
                               (((bb * m.M5) + (a * m.M2)) + (c * m.M8)) * deg);
        return (linear, angular);
    }

    /// <summary>
    /// The body's frame origin: its mass centre less the scaled local mass centre turned by its orientation, as SetType
    /// (1801bd3e0), SetMass (1801bbb60) and SetMassCenter (1801bb9a0) compute it for the mass update.
    /// </summary>
    public static Vec3 FrameOrigin(in RnBodyState s)
    {
        var q = s.Orientation;
        var sc = s.Scale;
        float f18 = sc * s.LocalMassCenter.X, f16 = sc * s.LocalMassCenter.Z, f17 = sc * s.LocalMassCenter.Y;
        var f19 = (f16 * q.Y) - (f17 * q.Z); f19 += f19;
        var f20 = (f18 * q.Z) - (f16 * q.X); f20 += f20;
        var f21 = (f17 * q.X) - (f18 * q.Y); f21 += f21;
        return new Vec3(s.Position.X - ((((f21 * q.Y) - (f20 * q.Z)) + f18) + (q.W * f19)),
                        s.Position.Y - ((((f19 * q.Z) - (f21 * q.X)) + f17) + (q.W * f20)),
                        s.Position.Z - ((((f20 * q.X) - (f19 * q.Y)) + f16) + (q.W * f21)));
    }

    /// <summary>
    /// Body vfn 0x100 (vphysics2 1801bbb60, SetMass): the mass set by hand (+0x4a bit 8), held to 1e6 and 500 when not
    /// positive; the mass update with flags 0x13 when it changed (else 0, which does nothing).
    /// </summary>
    public static void SetMass(RnBody body, IReadOnlyList<RnMassUpdate.Shape> shapes, float mass, bool addSum = false)
    {
        ref var s = ref body.State;
        var origin = FrameOrigin(s);
        s.Flags4A |= 0x100;
        var m = 1e6f;
        if (mass <= 1e6f) m = mass;
        if (m <= 0f) m = 500f;
        uint flags = 0;
        if (m != s.InertiaDivisor) { s.InertiaDivisor = m; flags = 0x13; }
        RnMassUpdate.Run(ref s, shapes, origin, s.Orientation, flags, addSum);
    }

    /// <summary>Body vfn 0x128 (vphysics2 1800118c0): the mass, +0xa0.</summary>
    public static float GetMass(RnBody body) => body.State.InertiaDivisor;

    /// <summary>Body vfn 0x150 (vphysics2 180011da0): the local mass centre, +0xc8.</summary>
    public static Vec3 GetLocalMassCenter(RnBody body) => body.State.LocalMassCenter;

    /// <summary>
    /// Body vfn 0x108 (vphysics2 1801bb9a0, SetMassCenter): the local mass centre set by hand (+0x4a bit 10); the mass
    /// update with flags 0x14 when it changed (else 0).
    /// </summary>
    public static void SetLocalMassCenter(RnBody body, IReadOnlyList<RnMassUpdate.Shape> shapes, Vec3 center)
    {
        ref var s = ref body.State;
        var origin = FrameOrigin(s);
        s.Flags4A |= 0x400;
        uint flags = 0;
        if (s.LocalMassCenter.X != center.X || s.LocalMassCenter.Y != center.Y || s.LocalMassCenter.Z != center.Z)
        {
            s.LocalMassCenter = center;
            flags = 0x14;
        }
        RnMassUpdate.Run(ref s, shapes, origin, s.Orientation, flags);
    }
}
