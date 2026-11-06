using System.Numerics;
using Source2.Compiler.Physics;
using Source2.Compiler.Simulation;

namespace Source2.Compiler.Game;

// The game's Rubikon world: built from physics.bin (PhysFile) the way source2-compiler's SettleWorld.CreateWorld builds
// one (src/Source2.Compiler/Maps/SettleWorld.World.cs at a12333d): a world at Rubikon's defaults with vphysics2's
// starting collision group table, the world's own shapeless body first, then each body created static at its frame
// with its shapes added and the mass update run once with every shape in; a body made dynamic is SetType(2), its mass
// update and drag run again, then woken (FUN_1801c0ff0). Body handles are indices into Bodies.
//
// What CS2's server does on top of this (entity mass overrides, collision groups by class, controllers, the tick's step)
// is the caller's: wasm/Interop.cs and the game's entity code (web/src/world/entities/classes/physics.js).
public sealed class GameWorld
{
    public readonly RnWorld World = new();
    readonly Dictionary<string, PhysModel> _models = new(StringComparer.Ordinal);
    readonly Dictionary<uint, ContactSolver.Material> _surfaces = [];
    readonly CollisionRules _rules = new();
    readonly ContactSolver.Material _defaultMaterial;
    readonly List<List<RnMassUpdate.Shape>> _massShapes = [];
    // each shape's palette entry, the base an entity record goes on (vphysics2 180256c80 keeps it at shape +0x78 / +0xac)
    readonly List<List<CollisionAttributes>> _baseAttributes = [];
    readonly List<PhysModel?> _bodyModels = [];

    /// <summary>The name hash of the surface property "default", which a shape without one gets (SettleWorld.DefaultSurface).</summary>
    public const uint DefaultSurface = 1977497166;

    /// <summary>The motion controllers, in creation order (CVPhys2World +0xa0).</summary>
    public readonly List<MotionController> Controllers = [];
    bool _pendingAsync; // CVPhys2World +0x148

    /// <param name="svGravity">sv_gravity (CS2 default 800): GameInit sets the world's gravity to (0, 0, -sv_gravity)
    /// through world slot 0x90 (CRnWorld +0x190), not Rubikon's -360.</param>
    public GameWorld(PhysFile file, float svGravity = 800f)
    {
        World.Gravity = new Vec3(0f, 0f, -svGravity);
        foreach (var s in file.Surfaces)
            _surfaces[s.Hash] = new ContactSolver.Material
            {
                Density = s.Density * 1.6387063e-05f, // kg/m^3 to kg/in^3 (FUN_180072c70)
                Friction = s.Friction,
                Restitution = s.Elasticity,
                Thickness = s.Thickness,
                Frequency = s.SoftContactFrequency,
                DampingRatio = s.SoftContactDampingRatio,
            };
        _defaultMaterial = _surfaces.GetValueOrDefault(DefaultSurface);
        foreach (var m in file.Models) _models[m.Key] = m;
        World.Islands.Colouring = true;
        World.Broadphase = new Broadphase(CollisionGroupTable.Build(), 0);
        World.AddBody(NewBody(new Vec3(0f, 0f, 0f), 1f, Quat.Identity));
        _massShapes.Add([]);
        _baseAttributes.Add([]);
        _bodyModels.Add(null);
    }

    public bool HasModel(string key) => _models.ContainsKey(key);

    /// <summary>
    /// The aggregate's interaction layers (CPhysAggregateInstance vfn 0xe8, vphysics2 180046280): the model's collision
    /// attribute palette entry to stand for it (the first, unless it is below group 4 and a later one is not, which then
    /// takes over), its interacts-as (the default mask for an empty group-4 one: the palette here holds that already),
    /// its exclude and its group. Null for a body with no palette.
    /// </summary>
    public (ulong As, ulong Exclude, byte Group)? ModelLayers(int index)
    {
        var m = index >= 0 && index < _bodyModels.Count ? _bodyModels[index] : null;
        if (m == null || m.Attributes.Count == 0) return null;
        var sel = Entry(m, 0);
        for (var i = 1; i < m.Attributes.Count; i++)
        {
            if (sel.Group >= 4) continue;
            var c = Entry(m, i);
            if (c.Group >= 4) sel = c;
        }
        return (sel.InteractsAs, sel.InteractsExclude, sel.Group);
    }

    // a palette entry as 180046280 reads it: an empty interacts-as is the default mask only in group 4
    CollisionAttributes Entry(PhysModel m, int i)
    {
        var c = Attributes(m, i);
        if (m.Attributes[i].InteractAs.Length == 0 && c.Group != 4) c.InteractsAs = 0;
        return c;
    }

    /// <summary>
    /// The entity's record takes the model's layers when its physics is created (server FUN_180d0a6e0, solid type 1 or
    /// 6, which VPhysicsInitNormal sets): interacts-as |= the aggregate's (vfn 0xe8) without blocksound (bit 10) unless
    /// that entry is group 3 (FUN_180ceaa80), interacts-exclude |= its exclude when it has one (FUN_180ceab10).
    /// </summary>
    public void MergeModelLayers(int index, ref CollisionAttributes record)
    {
        if (ModelLayers(index) is not { } l) return;
        var add = l.As;
        if ((add & 0x400) != 0 && l.Group != 3) add &= ~0x400ul;
        record.InteractsAs |= add;
        if (l.Exclude != 0) record.InteractsExclude |= l.Exclude;
    }

    /// <summary>A body for a model's first part, static at the frame. Returns its index, or -1 when the model has no physics.</summary>
    public int AddBody(string modelKey, Vector3 position, Quaternion orientation, float scale = 1f)
    {
        if (!_models.TryGetValue(modelKey, out var model) || model.Parts.Count == 0) return -1;
        var q = new Quat(orientation.X, orientation.Y, orientation.Z, orientation.W);
        var origin = new Vec3(position.X, position.Y, position.Z);
        var b = World.AddBody(NewBody(origin, scale, q));
        RnMassUpdate.Run(ref b.State, [], origin, q);
        var joined = new List<RnMassUpdate.Shape>();
        var bases = new List<CollisionAttributes>();
        var part = model.Parts[0];
        foreach (var s in part.Shapes)
        {
            var attributes = Attributes(model, s.AttributeIndex);
            bases.Add(attributes);
            var material = Material(model, s.SurfaceIndex);
            (Vec3 A, Vec3 B, float Radius)? round = s.Type switch
            {
                0 => (new Vec3(scale * s.A.X, scale * s.A.Y, scale * s.A.Z), default, scale * s.Radius),
                1 => (new Vec3(scale * s.A.X, scale * s.A.Y, scale * s.A.Z), new Vec3(scale * s.B.X, scale * s.B.Y, scale * s.B.Z), scale * s.Radius),
                _ => null,
            };
            World.AddShape(b, s.Type, s.Hull is { } hull ? new HullRef(hull, scale) : default, s.Mesh, new Vec3(scale, scale, scale),
                           attributes, material, round: round);
            var counts = ((attributes.MaskIsDirect == 1 ? attributes.FunctionMask : ~attributes.FunctionMask) & 1) != 0;
            joined.Add(new RnMassUpdate.Shape(s.Type, s.Hull, scale, s.Mesh, new Vector3(scale), material, counts)
            {
                Sphere = s.Type == 0 ? (s.A, s.Radius) : null,
                Capsule = s.Type == 1 ? (s.A, s.B, s.Radius) : null,
            });
        }
        if (joined.Count > 0)
            RnMassUpdate.Run(ref b.State, joined, origin, q);
        _massShapes.Add(joined);
        _baseAttributes.Add(bases);
        _bodyModels.Add(model);
        return b.Index;
    }

    /// <summary>SetType(2), the mass update and drag again, then woken: a settled body in SettleWorld.CreateWorld.</summary>
    public void MakeDynamic(int index)
    {
        var b = World.Bodies[index];
        var origin = RnTransform.Of(b.State).T;
        World.MakeDynamic(b);
        RnMassUpdate.Run(ref b.State, _massShapes[index], origin, b.State.Orientation); // ends in the drag
        b.State.StaticFlag = 0;
        b.State.Flags249 &= 0xfb;
        b.State.SleepTimer = 0f;
        ContactLifecycle.AddAwake(World, b);
        b.State.Flags4A &= 0xff7f;
    }

    /// <summary>Adds layers to every shape's interact-with mask (an entity's own collision settings on top of its model's).</summary>
    public void AddInteractsWith(int index, ulong layers)
    {
        foreach (var s in World.Bodies[index].Shapes) s.Attributes.InteractsWith |= layers;
    }

    /// <summary>The mass update's view of the body's shapes.</summary>
    public IReadOnlyList<RnMassUpdate.Shape> MassShapes(int index) => _massShapes[index];

    /// <summary>A layer mask from a comma separated list of names (the collision interface's string parse).</summary>
    public ulong LayerMask(string list) => _rules.Mask(list);

    /// <summary>A collision group's index by name, -1 when the rules have none of that name.</summary>
    public int GroupIndex(string name) => _rules.Group(name);

    /// <summary>
    /// The entity's collision record on every shape of its body (the aggregate's vfn 0xf0, vphysics2 180046220 ->
    /// body 1801ba7e0 -> shape 180256d00 with refilter): source2-compiler's capture-checked <c>Layered</c>. For a body
    /// that has contacts, they are refiltered as the game's shape setter does (FUN_180255860).
    /// </summary>
    public void SetEntityAttributes(int index, CollisionAttributes record)
    {
        var body = World.Bodies[index];
        var shapes = body.Shapes;
        for (var i = 0; i < shapes.Count; i++)
            shapes[i].Attributes = Layered(_baseAttributes[index][i], record);
        // with refilter (180256d00's third argument): FUN_180255860 destroys each contact of the shape whose pair the
        // world ignores (FUN_1801faf20: world +0x790, a set this port never fills), whose pair flags (FUN_1802faf00) are
        // no longer the contact's (+0x78) or that ShouldCollide (FUN_1801bdea0) refuses; then the shape is marked for the
        // pre-step query (FUN_1802d6c90), so a pair the change allows gets its contact
        if (World.Broadphase is not { } bp) return;
        foreach (var c in ContactLifecycle.ContactsOf(body).ToList())
        {
            var f = CollisionFilter.Flags(bp.GroupTable, c.A.Proxy.Attributes, c.B.Proxy.Attributes);
            if (f != c.Flags78 || !CollisionFilter.BodiesMayCollide(c.A.Proxy, c.B.Proxy, f)) ContactLifecycle.Destroy(World, c);
        }
        foreach (var shape in shapes) bp.Touch(shape.ProxyId);
    }

    // source2-compiler Maps/SettleWorld.Aggregate.cs Layered (a12333d), the shape's attributes once 180044bc0 has set
    // its palette entry as the base (180256c80: the base layers when not the default mask 18045b2a0, the solid layers
    // an empty InteractAs list gets; the base group the entry's when not 0, else 4) and the entity record goes on top
    // (180256d00): the record's fields, its layers with the base's added, the base's group when it is below 4
    static CollisionAttributes Layered(CollisionAttributes entry, CollisionAttributes entity)
    {
        var baseLayers = entry.InteractsAs == CollisionRules.ContentsSolid && entry.Group != 3 ? 0ul : entry.InteractsAs;
        var baseGroup = entry.Group != 0 ? entry.Group : (byte)4;
        var a = entity;
        a.InteractsAs |= baseLayers;
        if (baseGroup < 4)
            a.Group = baseGroup;
        a.FunctionMask = entity.FunctionMask;
        a.MaskIsDirect = entity.MaskIsDirect;
        a.EntityId = -1;
        return a;
    }

    /// <summary>The body wrapper's SetType (Keyframe.SetType: CRnBody::SetType and the keyframe target): 0 static, 1 keyframed, 2 dynamic.</summary>
    public void SetBodyType(int index, int type) => Keyframe.SetType(World, World.Bodies[index], type, _massShapes[index]);

    public void Step(float dt, bool first) => World.Step(dt, first);

    /// <summary>A motion controller for the event (world slot 0x3e8, 18005bb90).</summary>
    public MotionController CreateController(IMotionEvent ev)
    {
        var c = new MotionController(this, ev);
        Controllers.Add(c);
        return c;
    }

    public void DestroyController(MotionController c) => Controllers.Remove(c);

    /// <summary>
    /// One server tick (rubikon/CS2_RUNTIME.md "The tick"): CPhysicsGameSystem's substeps = 1 and step dt = 1/64,
    /// times phys_timescale, through SimulateWorlds: CPhysicsWorld_Simulate (the step when dt > 1e-5, then each
    /// controller's vfn 0x20), then BeginAsyncPostTickJobs (each controller's vfn 0x28 when one gathered time).
    /// </summary>
    public void Tick() => Tick(PhysTimescale);

    /// <summary>phys_timescale (default 1), which also scales a keyframe's dt (<see cref="Keyframe.Drive"/>).</summary>
    public float PhysTimescale = 1f;

    public void Tick(float physTimescale)
    {
        const int substeps = 1; // FUN_180589b50: clamp(floor(1.5), 1, 3)
        var dt = physTimescale * (0.015625f / substeps);
        for (var i = 0; i < substeps; i++) Simulate(dt, i == 0);
        if (_pendingAsync)
        {
            foreach (var c in Controllers.ToArray()) c.Apply();
            _pendingAsync = false;
        }
    }

    // CPhysicsWorld_Simulate (180059f30)
    void Simulate(float dt, bool first)
    {
        if (1e-05f < dt) World.Step(dt, first);
        _pendingAsync = false;
        foreach (var c in Controllers.ToArray())
        {
            var ran = c.Advance(dt);
            _pendingAsync = _pendingAsync || !ran;
        }
    }

    public ref RnBodyState State(int index) => ref World.Bodies[index].State;

    ContactSolver.Material Material(PhysModel m, int index)
        => index >= 0 && index < m.SurfaceHashes.Length && _surfaces.TryGetValue(m.SurfaceHashes[index], out var mat) ? mat : _defaultMaterial;

    // SettleWorld.CollisionRules.Convert: a model's VPhysXCollisionAttributes_t as the loaded aggregate holds it
    CollisionAttributes Attributes(PhysModel m, int index)
    {
        if (index < 0 || index >= m.Attributes.Count) return default;
        var a = m.Attributes[index];
        ulong Bits(string[] names) => names.Aggregate(0ul, (x, n) => x | _rules.Layer(n));
        var c = new CollisionAttributes
        {
            InteractsAs = Bits(a.InteractAs),
            InteractsWith = Bits(a.InteractWith),
            InteractsExclude = Bits(a.InteractExclude),
            EntityId = -1,
            OwnerId = -1,
            Flags = 7,
        };
        if (a.InteractAs.Length == 0)
            c.InteractsAs = CollisionRules.ContentsSolid;
        var group = _rules.Group(a.Group);
        c.Group = (byte)(group < 0 ? 0 : group);
        return c;
    }

    // SettleWorld.NewBody: a body as the world's default description leaves it (world vfn 0x1e8, read from a fresh
    // vphysics2 body), then static at the given frame
    static RnBodyState NewBody(Vec3 position, float scale, Quat orientation)
    {
        var s = new RnBodyState
        {
            Scale = 1f,
            MassScale = 1f,
            InertiaScale = 1f,
            GravityScale = 1f,
            FrictionScale = 1f,
            TimeScale = 1f,
            InertiaDivisor = 500f,
            LocalInvInertia = new Mat3 { M0 = 1f, M4 = 1f, M8 = 1f },
            Orientation = Quat.Identity,
            PreviousOrientation = Quat.Identity,
            LinearDrag = 1f,
            AngularDrag = 1f,
            LinearVelocityScale = 1f,
            AngularVelocityScale = 1f,
            InnerRadius = float.MaxValue,
            FrameOrigin = new Vec3(float.MaxValue, float.MaxValue, float.MaxValue),
            MinVelocityIterations = 1,
            Flags249 = 0x3f,
        };
        s.ActiveIndex = -1;
        s.StaticFlag = 1;
        s.Word150 = 1f;
        s.Word154 = 1f;
        s.Word1AC = 0x00c80000;
        s.Word1CC = 1f;
        if (MathF.Abs(scale - 1f) >= 0.001f && scale > 0f)
            s.Scale = scale;
        s.Position = position;
        s.Orientation = orientation;
        return s;
    }
}
