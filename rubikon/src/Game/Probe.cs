using System.Numerics;
using System.Runtime.InteropServices;
using System.Text;
using Source2.Compiler.Physics;
using Source2.Compiler.Simulation;

namespace Source2.Compiler.Game;

// A fixed scenario run the same way natively (rubikon/tests/Probe) and in WebAssembly (wasm/Interop.cs Probe): the map's
// static world, one model dropped as a dynamic body, stepped at 64 Hz. Prints the body's path and an FNV-1a hash of every
// body's state bytes at the end, so the two builds can be compared bit for bit.
public static class Probe
{
    public static string Run(byte[] physicsBin, string modelKey, Vector3 at, int steps)
    {
        var sb = new StringBuilder();
        var world = new GameWorld(PhysFile.Read(physicsBin));
        var w = world.AddBody("world", Vector3.Zero, Quaternion.Identity);
        var b = world.AddBody(modelKey, at, Quaternion.Identity);
        sb.AppendLine($"world body {w}, probe body {b} ({modelKey})");
        if (b < 0) return sb.Append("no such model").ToString();
        // STAND-IN until the server's entity collision rule is known: resourcecompiler's settle rule for a
        // BasePhysicsSimulated class (source2-compiler SettleWorld.Aggregate EntityAttributes: interacts with solid,
        // window, passbullets, player, npc = 0xc3001). A model's own attributes interact with nothing.
        world.AddInteractsWith(b, 0xc3001);
        world.MakeDynamic(b);
        ref var s = ref world.State(b);
        sb.AppendLine($"mass {1f / s.InvMass:R} at {s.Position}");
        for (var i = 1; i <= steps; i++)
        {
            world.Tick();
            if (i % 32 == 0) sb.AppendLine($"t={i / 64f:F2} pos=({s.Position.X:R}, {s.Position.Y:R}, {s.Position.Z:R}) vel=({s.LinearVelocity.X:R}, {s.LinearVelocity.Y:R}, {s.LinearVelocity.Z:R})");
        }
        return sb.Append(Hash(world)).ToString();
    }

    /// <summary>
    /// A model dropped as a dynamic body with one phys_thruster on it, always on: spawnflags, force, offset and angles as
    /// a map gives them (offset in the model's frame). Prints the body's path and the state hash.
    /// </summary>
    /// <remarks>
    /// With <paramref name="physBox"/> the body spawns as a func_physbox with those spawnflags and massscale
    /// (<see cref="PhysBox.Spawn"/>); otherwise with the stand-in collision of <see cref="Run"/>.
    /// </remarks>
    public static string RunThruster(byte[] physicsBin, string modelKey, Vector3 at, int flags, float force, Vector3 offset, Vector3 angles, int ticks, float keepUprightLimit = 0f, PhysBoxKeys? physBox = null)
    {
        var sb = new StringBuilder();
        var world = new GameWorld(PhysFile.Read(physicsBin));
        world.AddBody("world", Vector3.Zero, Quaternion.Identity);
        int b;
        if (physBox != null)
            b = PhysBox.Spawn(world, modelKey, at, Quaternion.Identity, physBox);
        else
        {
            b = world.AddBody(modelKey, at, Quaternion.Identity);
            if (b >= 0)
            {
                world.AddInteractsWith(b, 0xc3001); // STAND-IN, see Run
                world.MakeDynamic(b);
            }
        }
        if (b < 0) return sb.Append("no such model").ToString();
        var body = world.World.Bodies[b];
        var t = new Thruster { SpawnFlags = flags, Force = force, LocalAngles = angles, Body = body };
        // the thruster's own transform: the template places it at the body's origin + offset, its angles as given
        var yaw = angles.Y * MathF.PI / 180f; var pitch = angles.X * MathF.PI / 180f; var roll = angles.Z * MathF.PI / 180f;
        var tq = Quaternion.CreateFromAxisAngle(Vector3.UnitZ, yaw) * Quaternion.CreateFromAxisAngle(Vector3.UnitY, pitch) * Quaternion.CreateFromAxisAngle(Vector3.UnitX, roll);
        t.OnActivate(at + offset, tq);
        ref var s = ref body.State;
        t.Start(new Vec3(at.X, at.Y, at.Z), s.Orientation);
        t.Controller = world.CreateController(t);
        t.Controller.Attach(body);
        if (keepUprightLimit > 0f)
        {
            // a phys_keepupright on the body, spawned unrotated (its up axis is the goal), as the boss templates have it
            var k = new KeepUpright { AngularLimit = keepUprightLimit, Active = true };
            k.Controller = world.CreateController(k);
            k.Controller.Attach(body);
        }
        sb.AppendLine($"mass {1f / s.InvMass:R}, linear {t.Linear}, angular {t.Angular}, local angles {t.LocalAngles}");
        for (var i = 1; i <= ticks; i++)
        {
            world.Tick();
            if (i % 32 == 0) sb.AppendLine($"t={i / 64f:F2} pos=({s.Position.X:R}, {s.Position.Y:R}, {s.Position.Z:R}) vel={s.LinearVelocity} angvel={s.AngularVelocity}");
        }
        return sb.Append(Hash(world)).ToString();
    }

    /// <summary>
    /// A model dropped as a dynamic body; at tick <paramref name="offAt"/> it becomes keyframed (DisableMotion: SetType 1,
    /// velocities zeroed), at <paramref name="onAt"/> dynamic again (EnableMotion): SetType on a body with contacts.
    /// </summary>
    public static string RunSetType(byte[] physicsBin, string modelKey, Vector3 at, int offAt, int onAt, int ticks)
    {
        var sb = new StringBuilder();
        var world = new GameWorld(PhysFile.Read(physicsBin));
        world.AddBody("world", Vector3.Zero, Quaternion.Identity);
        var b = world.AddBody(modelKey, at, Quaternion.Identity);
        if (b < 0) return sb.Append("no such model").ToString();
        world.AddInteractsWith(b, 0xc3001); // STAND-IN, see Run
        world.MakeDynamic(b);
        ref var s = ref world.State(b);
        for (var i = 1; i <= ticks; i++)
        {
            if (i == offAt) { world.SetBodyType(b, 1); s.LinearVelocity = default; s.AngularVelocity = default; sb.AppendLine($"tick {i}: keyframed, contacts {Simulation.ContactLifecycle.ContactsOf(world.World.Bodies[b]).Count()}"); }
            if (i == onAt) { world.SetBodyType(b, 2); sb.AppendLine($"tick {i}: dynamic, contacts {Simulation.ContactLifecycle.ContactsOf(world.World.Bodies[b]).Count()}"); }
            world.Tick();
            if (i % 32 == 0) sb.AppendLine($"t={i / 64f:F2} type {s.BodyType} pos=({s.Position.X:R}, {s.Position.Y:R}, {s.Position.Z:R}) vel={s.LinearVelocity}");
        }
        return sb.Append(Hash(world)).ToString();
    }

    /// <summary>
    /// A func_physbox spawned motion disabled (keyframed) and driven each tick (<see cref="Keyframe.Drive"/>) by
    /// <paramref name="step"/> from <paramref name="at"/>; a second model dropped as a dynamic physbox onto it.
    /// </summary>
    public static string RunKeyframe(byte[] physicsBin, string moverKey, Vector3 at, Vector3 step, string riderKey, Vector3 riderAt, int ticks)
    {
        var sb = new StringBuilder();
        var world = new GameWorld(PhysFile.Read(physicsBin));
        world.AddBody("world", Vector3.Zero, Quaternion.Identity);
        var m = PhysBox.Spawn(world, moverKey, at, Quaternion.Identity, new PhysBoxKeys { SpawnFlags = 0x8000 });
        var r = PhysBox.Spawn(world, riderKey, riderAt, Quaternion.Identity, new PhysBoxKeys());
        if (m < 0 || r < 0) return sb.Append("no such model").ToString();
        ref var ms = ref world.State(m);
        ref var rs = ref world.State(r);
        sb.AppendLine($"mover type {ms.BodyType} target {world.World.Bodies[m].Target != null}");
        for (var i = 1; i <= ticks; i++)
        {
            if (!Keyframe.Drive(world, m, at + step * i, Quaternion.Identity)) return sb.Append("teleport").ToString();
            world.Tick();
            if (i % 32 == 0) sb.AppendLine($"t={i / 64f:F2} mover=({ms.Position.X:R}, {ms.Position.Y:R}, {ms.Position.Z:R}) v={ms.LinearVelocity} rider=({rs.Position.X:R}, {rs.Position.Y:R}, {rs.Position.Z:R})");
        }
        return sb.Append(Hash(world)).ToString();
    }

    static string Hash(GameWorld world)
    {
        var h = 2166136261u;
        foreach (var body in world.World.Bodies)
        {
            var st = body.State;
            foreach (var x in MemoryMarshal.AsBytes(MemoryMarshal.CreateSpan(ref st, 1))) h = (h ^ x) * 16777619u;
        }
        return $"state hash {h:x8}\n";
    }
}
