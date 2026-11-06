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
    public static void Destroy(int id)
    {
        Worlds.Remove(id);
        foreach (var k in Records.Keys.Where(k => k.Item1 == id).ToList()) Records.Remove(k);
    }

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
    /// A brush or prop entity's keyframed body (a mover, door, train or solid brush the map moves): its model, keyframed
    /// at the entity's frame, with the collision record its class's CreateVPhysics gives it (BrushPhysics). -1 when the
    /// model has no physics or the class makes none (func_train).
    /// </summary>
    [JSExport]
    public static int SpawnKeyframed(int id, string key, double[] pos, double[] quat, string className)
    {
        if (BrushPhysics.Record(className) is not { } record) return -1;
        var w = S(id).World;
        var b = w.AddBody(key, V(pos), Q(quat));
        if (b < 0) return -1;
        w.SetBodyType(b, 1);
        w.MergeModelLayers(b, ref record); // VPhysicsInitNormal's FUN_180d0a6e0
        w.SetEntityAttributes(b, record);
        Records[(id, b)] = record;
        return b;
    }

    static readonly Dictionary<(int, int), CollisionAttributes> Records = [];

    /// <summary>
    /// A keyframed brush turned solid or not. CFuncBrush's TurnOff (180e3d060) clears the collision function mask's
    /// bits 0-2 (FUN_180ce76c0: solid contact, trace, touch) and TurnOn (180e3d120) sets them back (FUN_180cea920); the
    /// layers and group stay. Pairs whose group entry has bit 0 then make no contact with it.
    /// </summary>
    [JSExport]
    public static void SetBrushSolid(int id, int body, bool solid)
    {
        if (!Records.TryGetValue((id, body), out var r)) return;
        r.Flags = solid ? (byte)(r.Flags | 7) : (byte)(r.Flags & ~7);
        S(id).World.SetEntityAttributes(body, r);
    }

    /// <summary>Would a trigger (its spawnflags, enabled or not) get touch events from this body (TriggerPhysics.Touches)?</summary>
    [JSExport]
    public static bool TriggerTouches(int id, int body, int spawnFlags, bool enabled)
        => TriggerPhysics.Touches(S(id).World, body, TriggerPhysics.Record(spawnFlags, enabled));

    /// <summary>The server's per-tick keyframe (Keyframe.Drive); false when it would be a teleport (not ported).</summary>
    [JSExport]
    public static bool Drive(int id, int body, double[] pos, double[] quat, bool teleport) => Keyframe.Drive(S(id).World, body, V(pos), Q(quat), 0f, teleport);

    /// <summary>EnableMotion / DisableMotion.</summary>
    [JSExport]
    public static void SetMotion(int id, int body, bool on) => PhysBox.SetMotion(S(id).World, body, on);

    /// <summary>The motion type a move type change gives (1803de760 -> FUN_1801a4a40): 1 (by part flags) or 3 (keyframed), velocities kept.</summary>
    [JSExport]
    public static void SetMotionType(int id, int body, int motion) => PhysBox.SetMotionType(S(id).World, body, motion);

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

    /// <summary>A phys_thruster on a body (OnActivate at spawn). Returns its handle; it starts with <see cref="ThrusterStart"/>.</summary>
    [JSExport]
    public static int AddThruster(int id, int body, int spawnFlags, double force, double[] angles, double[] pos, double[] quat)
    {
        var s = S(id);
        var t = new Thruster { SpawnFlags = spawnFlags, Force = (float)force, LocalAngles = V(angles), Body = s.World.World.Bodies[body] };
        t.OnActivate(V(pos), Q(quat));
        s.Events.Add(t);
        return s.Events.Count - 1;
    }

    /// <summary>The thruster's local angles after OnActivate (with orient locally, the ones it set on the entity).</summary>
    [JSExport]
    public static double[] ThrusterAngles(int id, int handle)
        => S(id).Events[handle] is Thruster t ? [t.LocalAngles.X, t.LocalAngles.Y, t.LocalAngles.Z] : [0, 0, 0];

    /// <summary>
    /// The thruster's start (180e73b40, only when not running): SetupForces from the force and the entity's local angles
    /// as they are now (m_force, m_angRotation: KeyValues may have changed them), its controller with the body attached,
    /// the body woken. False when it was running already.
    /// </summary>
    [JSExport]
    public static bool ThrusterStart(int id, int handle, double force, double[] angles)
    {
        var s = S(id);
        if (s.Events[handle] is not Thruster t || t.Body == null || t.Controller != null) return false;
        t.LocalAngles = V(angles);
        t.Force = (float)force;
        ref var b = ref t.Body.State;
        var o = BodyOps.LocalToWorldPoint(b, default);
        t.Start(o, b.Orientation);
        t.Controller = s.World.CreateController(t);
        t.Controller.Attach(t.Body);
        ContactLifecycle.Wake(s.World.World, t.Body, false);
        return true;
    }

    /// <summary>The stop (180e73a40): the controller destroyed, the body woken.</summary>
    [JSExport]
    public static void ThrusterStop(int id, int handle)
    {
        var s = S(id);
        if (s.Events[handle] is not Thruster t || t.Controller == null) return;
        s.World.DestroyController(t.Controller);
        t.Controller = null;
        if (t.Body != null) ContactLifecycle.Wake(s.World.World, t.Body, false);
    }

    /// <summary>The Scale input after its start (180e3fc80): the push is scale x the start's, every attached body woken (controller vfn 0x60).</summary>
    [JSExport]
    public static void ThrusterScale(int id, int handle, double scale)
    {
        var s = S(id);
        if (s.Events[handle] is not Thruster t || t.Controller == null) return;
        t.Scale((float)scale);
        if (t.Body != null) ContactLifecycle.Wake(s.World.World, t.Body, false);
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
