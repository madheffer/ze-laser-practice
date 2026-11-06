using System.Numerics;
using Source2.Compiler.Simulation;

namespace Source2.Compiler.Game;

/// <summary>The func_physbox keyvalues its spawn reads (rubikon/CS2_RUNTIME.md "func_physbox spawn").</summary>
public sealed record PhysBoxKeys
{
    public int SpawnFlags;
    /// <summary>m_damageToEnableMotion (+0x92c), "damagetoenablemotion".</summary>
    public int DamageToEnableMotion;
    /// <summary>m_flForceToEnableMotion (+0x930), "forcetoenablemotion".</summary>
    public float ForceToEnableMotion;
    public float GameMass;
    /// <summary>"massScale" (the keyvalue lookup ignores case).</summary>
    public float MassScale;
    public Vector3 MassCenterOffset;
    /// <summary>m_iszCollisionGroup / m_iszInteractsAs / m_iszInteractsWith / m_iszInteractsExclude (+0x958..+0x970).</summary>
    public string? CollisionGroup, InteractsAs, InteractsWith, InteractsExclude;
}

/// <summary>
/// func_physbox's spawn as CS2's server runs it. CPhysBox::Spawn (180ed7520) first runs CBreakable::Spawn (180dc0d50),
/// which creates the physics (CPhysBox vfn 0x238, 180ebce10) and then sets the mass; then the debris group.
/// </summary>
public static class PhysBox
{
    // interaction layers (CollisionRules: solid 0, window 12, passbullets 13, touchall 17, player 18, npc 19,
    // debris 20, physics_prop 21)
    const ulong TouchAll = 1ul << 17, Debris = 1ul << 20, PhysicsProp = 1ul << 21;
    const ulong SimulatedInteractsWith = 0xc3001;

    /// <summary>Spawns the physbox's body; returns its index, or -1 when the model has no physics.</summary>
    public static int Spawn(GameWorld w, string modelKey, Vector3 origin, Quaternion angles, PhysBoxKeys k)
    {
        // CreateVPhysics (180ebce10) -> VPhysicsInitNormal (180d087f0): the body, motion type 1 (dynamic; a parented
        // entity passes 2 -> 3 only from other callers), the collision property's group (4 when it has none) and
        // interacts-with 0xc3001 added, solid type 6, move type 5 (VPHYSICS)
        var b = w.AddBody(modelKey, origin, angles);
        if (b < 0) return -1;
        w.MakeDynamic(b);
        var record = new CollisionAttributes
        {
            InteractsWith = SimulatedInteractsWith,
            EntityId = -1,
            OwnerId = -1,
            Flags = 7, // UNSETTLED: the collision property's flag byte (+0x3f); 7 as resourcecompiler's entity record
            Group = 4,
        };
        // the keyvalue strings, each added to its mask (FUN_180ceaa80 / FUN_180ceaba0 / FUN_180ceab10)
        if (!string.IsNullOrEmpty(k.CollisionGroup) && w.GroupIndex(k.CollisionGroup) is var g and >= 0) record.Group = (byte)g;
        if (!string.IsNullOrEmpty(k.InteractsAs)) record.InteractsAs |= w.LayerMask(k.InteractsAs);
        if (!string.IsNullOrEmpty(k.InteractsWith)) record.InteractsWith |= w.LayerMask(k.InteractsWith);
        if (!string.IsNullOrEmpty(k.InteractsExclude)) record.InteractsExclude |= w.LayerMask(k.InteractsExclude);
        Push(w, b, ref record);
        var body = w.World.Bodies[b];
        // spawnflag 0x100000 clear: Wake (body vfn 0x400); MakeDynamic leaves the body awake already. With it set the
        // server skips the wake. NOT PORTED: whether a new body starts asleep then (no tyranny2 physbox sets it)
        // spawnflag 0x8000 (start motion disabled), or a damage / force to enable motion: DisableMotion (180ea56c0 ->
        // FUN_1803df550(entity, 0): the aggregate's motion type 3, every part keyframed, velocities zeroed)
        if ((k.SpawnFlags & 0x8000) != 0 || k.DamageToEnableMotion > 0 || k.ForceToEnableMotion > 0f)
            SetMotion(w, b, false);

        // CBreakable::Spawn after CreateVPhysics: gamemass, then massScale, then masscenteroffset (body vfns 0x100,
        // 0x128, 0x150, 0x108). buoyancyscale / fluiddragscale (vfns 0x330, 0x320, 0x328) are water: NOT PORTED
        var shapes = w.MassShapes(b);
        if (k.GameMass > 0f) BodyOps.SetMass(body, shapes, k.GameMass);
        if (k.MassScale > 0f && k.MassScale != 1f) BodyOps.SetMass(body, shapes, BodyOps.GetMass(body) * k.MassScale);
        if (k.MassCenterOffset != Vector3.Zero)
        {
            var c = BodyOps.GetLocalMassCenter(body);
            BodyOps.SetLocalMassCenter(body, shapes, new Vec3(k.MassCenterOffset.X + c.X, k.MassCenterOffset.Y + c.Y, k.MassCenterOffset.Z + c.Z));
        }

        // CPhysBox::Spawn: spawnflag 0x4000 (debris) without a collisionGroup keyvalue: group 5 (FUN_180d07730)
        if ((k.SpawnFlags & 0x4000) != 0 && string.IsNullOrEmpty(k.CollisionGroup))
        {
            record.Group = 5;
            Push(w, b, ref record);
        }
        return b;
    }

    /// <summary>EnableMotion / DisableMotion (180ea5630 / 180ea56c0): every part dynamic, or keyframed with no velocity.</summary>
    public static void SetMotion(GameWorld w, int index, bool on)
    {
        if (on)
        {
            w.SetBodyType(index, 2); // motion type 1: by the part's flags, dynamic for a physbox's one part
            return;
        }
        ref var s = ref w.State(index);
        s.LinearVelocity = default;  // body vfns 0x200 / 0x220
        s.AngularVelocity = default;
        w.SetBodyType(index, 1);
    }

    // The group's layers (FUN_180d07730: debris 5 is debris and not touchall; any group but 2 and 14 is touchall and
    // not debris), then the record as the physics gets it (FUN_180d11800: physics_prop while the move type is 5),
    // onto the shapes (the entity's vfn 0x5e0 -> the aggregate's vfn 0xf0)
    static void Push(GameWorld w, int index, ref CollisionAttributes record)
    {
        if (record.Group == 5) record.InteractsAs = (record.InteractsAs & ~TouchAll) | Debris;
        else if (record.Group != 2 && record.Group != 14) record.InteractsAs = (record.InteractsAs & ~Debris) | TouchAll;
        record.InteractsAs |= PhysicsProp;
        w.SetEntityAttributes(index, record);
    }
}
