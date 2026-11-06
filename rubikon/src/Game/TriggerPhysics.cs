using Source2.Compiler.Simulation;

namespace Source2.Compiler.Game;

/// <summary>
/// A trigger's collision record (rubikon/CS2_RUNTIME.md "Trigger touches"), and whether its shapes and a body's would
/// make touch events: vphysics2 reports a touch for a pair whose contact flags keep bit 2 (the pair filter
/// FUN_1802faf00, both function masks with 4), and the server's OnSimulate dispatches them (18057ad70).
/// </summary>
public static class TriggerPhysics
{
    /// <summary>
    /// CBaseTrigger's spawn (1803e5d60: exclude bit 30 added, then the subclass sets function mask bit 0x20, 180ceae90)
    /// and InitTrigger (1803d7230): interacts-as the trigger layer (bit 2) with touchall taken off the constructor's;
    /// interacts-with from the spawnflags (0x400 debris, 64 touchall, 8 physics_prop, 1 player, 2 npc, 0x2000 bit 38);
    /// function mask 7 | 0x20 without 0x48 (FUN_180ce7980; spawnflag 0x10000000's FUN_180ceacb0 is not used by these
    /// maps), and bits 0-2 cleared while disabled (FUN_180ce76c0) or set (FUN_180cea920). Group 4, as constructed.
    /// </summary>
    public static CollisionAttributes Record(int spawnFlags, bool enabled)
    {
        // CBaseTrigger's spawn first: 0x810 adds 2, 32 adds 1, 512 adds 1
        if ((spawnFlags & 0x810) != 0) spawnFlags |= 2;
        if ((spawnFlags & 32) != 0) spawnFlags |= 1;
        if ((spawnFlags & 512) != 0) spawnFlags |= 1;
        ulong with = 0;
        if ((spawnFlags & 0x400) != 0) with |= 0x100000;
        if ((spawnFlags & 64) != 0) with |= 0x20000;
        if ((spawnFlags & 8) != 0) with |= 0x200000;
        if ((spawnFlags & 1) != 0) with |= 0x40000;
        if ((spawnFlags & 2) != 0) with |= 0x80000;
        if ((spawnFlags & 0x2000) != 0) with |= 0x4000000000;
        byte mask = (byte)((7 | 0x20) & ~0x48);
        if (!enabled) mask = (byte)(mask & ~7);
        return new CollisionAttributes { InteractsAs = 4, InteractsWith = with, InteractsExclude = 0x40000000, EntityId = -2, OwnerId = -1, Flags = mask, Group = 4 };
    }

    /// <summary>
    /// Would a trigger with this record and any shape of the body make touch events (the pair's flags keep bit 2)? The
    /// trigger's model shapes take the record as it is (their base layers are the default mask, so Layered adds none).
    /// </summary>
    public static bool Touches(GameWorld w, int body, in CollisionAttributes trigger)
    {
        if (w.World.Broadphase is not { } bp) return false;
        foreach (var shape in w.World.Bodies[body].Shapes)
        {
            var a = shape.Attributes;
            a.EntityId = body; // the shape's id is its body's (shape +0x68), not the trigger's
            if ((CollisionFilter.Flags(bp.GroupTable, trigger, a) & 4) != 0) return true;
        }
        return false;
    }
}
