using System.Numerics;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using Source2.Compiler.Game;
using Source2.Compiler.Physics;
using Source2.Compiler.Simulation;

namespace Source2.Compiler.Wasm;

// The game's physics world over JS (web/src/world/rubikon.js wraps it): a GameWorld per map, bodies and motion
// controllers by index. Vectors are double[3], quaternions double[4] (x, y, z, w), in the map's units.
[SupportedOSPlatform("browser")]
public static partial class WorldApi
{
    sealed class Session(GameWorld world)
    {
        public readonly GameWorld World = world;
        public readonly List<IMotionEvent?> Events = [];
    }

    static readonly Dictionary<int, Session> Worlds = [];
    static int _next = 1;

    static Session S(int id) => Worlds[id];
    static Vector3 V(double[] a) => new((float)a[0], (float)a[1], (float)a[2]);
    static Quaternion Q(double[] a) => new((float)a[0], (float)a[1], (float)a[2], (float)a[3]);

    /// <summary>A world from the bake's physics.bin, the map's static world body in it. Returns its id.</summary>
    [JSExport]
    public static int Create(byte[] physicsBin, double svGravity)
    {
        var w = new GameWorld(PhysFile.Read(physicsBin), (float)svGravity);
        w.AddBody("world", Vector3.Zero, Quaternion.Identity);
        var id = _next++;
        Worlds[id] = new Session(w);
        return id;
    }

    [JSExport]
    public static void Destroy(int id) => Worlds.Remove(id);

    [JSExport]
    public static bool HasModel(int id, string key) => S(id).World.HasModel(key);

    /// <summary>A func_physbox (PhysBox.Spawn); -1 when the model has no physics. <paramref name="strings"/>: collisionGroup, interactsAs, interactsWith, interactsExclude.</summary>
    [JSExport]
    public static int SpawnPhysBox(int id, string key, double[] pos, double[] quat, int spawnFlags, double massScale, double gameMass,
                                   double[] massCenterOffset, int damageToEnableMotion, double forceToEnableMotion, string[] strings)
        => PhysBox.Spawn(S(id).World, key, V(pos), Q(quat), new PhysBoxKeys
        {
            SpawnFlags = spawnFlags,
            MassScale = (float)massScale,
            GameMass = (float)gameMass,
            MassCenterOffset = V(massCenterOffset),
            DamageToEnableMotion = damageToEnableMotion,
            ForceToEnableMotion = (float)forceToEnableMotion,
            CollisionGroup = strings.Length > 0 ? strings[0] : null,
            InteractsAs = strings.Length > 1 ? strings[1] : null,
            InteractsWith = strings.Length > 2 ? strings[2] : null,
            InteractsExclude = strings.Length > 3 ? strings[3] : null,
        });

    /// <summary>
    /// A brush entity's keyframed body (a mover, door, train or solid brush the map moves): its model, keyframed at the
    /// entity's frame, with the record a solid brush gets. -1 when the model has no physics.
    /// </summary>
    [JSExport]
    public static int SpawnKeyframed(int id, string key, double[] pos, double[] quat)
    {
        var w = S(id).World;
        var b = w.AddBody(key, V(pos), Q(quat));
        if (b < 0) return -1;
        w.SetBodyType(b, 1);
        // UNSETTLED: a brush entity's collision record is not decompiled (CFuncBrush / CBaseToggle); the solid
        // interactions a simulated class gets, so physics objects meet it
        w.SetEntityAttributes(b, BrushRecord);
        return b;
    }

    static readonly CollisionAttributes BrushRecord = new() { InteractsAs = 1, InteractsWith = 0xc3001, EntityId = -1, OwnerId = -1, Flags = 7, Group = 4 };

    /// <summary>A keyframed brush turned solid or not (a func_brush toggled, a door's solidity): its record or none.</summary>
    [JSExport]
    public static void SetBrushSolid(int id, int body, bool solid)
        => S(id).World.SetEntityAttributes(body, solid ? BrushRecord : new CollisionAttributes { EntityId = -1, OwnerId = -1 });

    /// <summary>The server's per-tick keyframe (Keyframe.Drive); false when it would be a teleport (not ported).</summary>
    [JSExport]
    public static bool Drive(int id, int body, double[] pos, double[] quat, bool teleport) => Keyframe.Drive(S(id).World, body, V(pos), Q(quat), 0f, teleport);

    /// <summary>EnableMotion / DisableMotion.</summary>
    [JSExport]
    public static void SetMotion(int id, int body, bool on) => PhysBox.SetMotion(S(id).World, body, on);

    /// <summary>Wake (body vfn 0x400) or Sleep.</summary>
    [JSExport]
    public static void SetAwake(int id, int body, bool awake)
    {
        var w = S(id).World;
        var b = w.World.Bodies[body];
        if (awake) ContactLifecycle.Wake(w.World, b, true);
        else StepGlue.SleepBody(w.World, b);
    }

    /// <summary>
    /// The entity is gone. NOT PORTED: CRnWorld's body removal; the body turns static and interacts with nothing (its
    /// contacts are refiltered away by SetType).
    /// </summary>
    [JSExport]
    public static void Remove(int id, int body)
    {
        var w = S(id).World;
        w.SetEntityAttributes(body, new CollisionAttributes { EntityId = -1, OwnerId = -1 });
        w.SetBodyType(body, 0);
    }

    /// <summary>A phys_thruster on a body (OnActivate at spawn). Returns its handle; it starts with <see cref="ThrusterOn"/>.</summary>
    [JSExport]
    public static int AddThruster(int id, int body, int spawnFlags, double force, double[] angles, double[] pos, double[] quat)
    {
        var s = S(id);
        var t = new Thruster { SpawnFlags = spawnFlags, Force = (float)force, LocalAngles = V(angles), Body = s.World.World.Bodies[body] };
        t.OnActivate(V(pos), Q(quat));
        s.Events.Add(t);
        return s.Events.Count - 1;
    }

    /// <summary>The thruster's start (180e73b40, once when not running: SetupForces, its controller) or stop (180e73a40).</summary>
    [JSExport]
    public static void ThrusterOn(int id, int handle, bool on, double force, double scale, double[] angles)
    {
        var s = S(id);
        if (s.Events[handle] is not Thruster t || t.Body == null) return;
        if (on)
        {
            if (t.Controller != null) return;
            // without orient-locally the thruster's own angles now (a map re-aims it with KeyValues before Activate)
            if ((t.SpawnFlags & 8) == 0) t.LocalAngles = V(angles);
            // m_force (+0x4b8) as the map last set it (KeyValues force); UNSETTLED: the Scale input is not decompiled,
            // it scales the force here
            t.Force = (float)(force * scale);
            ref var b = ref t.Body.State;
            var o = BodyOps.LocalToWorldPoint(b, default);
            t.SetupForces(o, b.Orientation);
            t.Controller = s.World.CreateController(t);
            t.Controller.Attach(t.Body);
            ContactLifecycle.Wake(s.World.World, t.Body, false);
        }
        else if (t.Controller != null)
        {
            s.World.DestroyController(t.Controller);
            t.Controller = null;
        }
    }

    /// <summary>A phys_keepupright on a body: its world goal axis (the entity's up), angular limit, on, dampallrotation.</summary>
    [JSExport]
    public static int AddKeepUpright(int id, int body, double[] goalAxis, double limit, bool active, bool dampAll)
    {
        var s = S(id);
        var k = new KeepUpright { WorldGoalAxis = new Vec3((float)goalAxis[0], (float)goalAxis[1], (float)goalAxis[2]), AngularLimit = (float)limit, Active = active, DampAllRotation = dampAll };
        k.Controller = s.World.CreateController(k);
        k.Controller.Attach(s.World.World.Bodies[body]);
        s.Events.Add(k);
        return s.Events.Count - 1;
    }

    [JSExport]
    public static void KeepUprightOn(int id, int handle, bool on)
    {
        if (S(id).Events[handle] is KeepUpright k) k.Active = on;
    }

    [JSExport]
    public static void SetAngularLimit(int id, int handle, double limit)
    {
        if (S(id).Events[handle] is KeepUpright k) k.AngularLimit = (float)limit;
    }

    /// <summary>One server tick.</summary>
    [JSExport]
    public static void Tick(int id) => S(id).World.Tick();

    /// <summary>
    /// Every body's entity frame (its frame origin, the model's origin, and orientation) and whether it is awake, 8
    /// numbers a body: x, y, z, qx, qy, qz, qw, awake.
    /// </summary>
    [JSExport]
    public static double[] Poses(int id)
    {
        var bodies = S(id).World.World.Bodies;
        var out_ = new double[bodies.Count * 8];
        for (var i = 0; i < bodies.Count; i++)
        {
            ref var st = ref bodies[i].State;
            var o = BodyOps.FrameOrigin(st);
            var q = st.Orientation;
            var k = i * 8;
            out_[k] = o.X; out_[k + 1] = o.Y; out_[k + 2] = o.Z;
            out_[k + 3] = q.X; out_[k + 4] = q.Y; out_[k + 5] = q.Z; out_[k + 6] = q.W;
            out_[k + 7] = bodies[i].ActiveIndex >= 0 ? 1 : 0;
        }
        return out_;
    }

    /// <summary>A body's linear velocity (for the entity's GetVelocity-like reads).</summary>
    [JSExport]
    public static double[] Velocity(int id, int body)
    {
        var v = S(id).World.State(body).LinearVelocity;
        return [v.X, v.Y, v.Z];
    }
}
