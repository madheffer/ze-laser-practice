using Source2.Compiler.Simulation;

namespace Source2.Compiler.Game;

/// <summary>
/// The physics a brush or prop entity creates (its CreateVPhysics, vtable slot 0x238; rubikon/CS2_RUNTIME.md "Brush
/// entities"), and the collision record its shapes get. Every class here passes motion type 3 (keyframed: move type 6,
/// PUSH) to VPhysicsInitNormal (180d087f0), which sets the collision group (FUN_180d07730) and replaces interacts-with
/// with the class's mask. The record starts as CCollisionProperty's constructor (180cd6e90) leaves it: interacts-as
/// touchall (0x20000), interacts-with and exclude 0, group 4, function mask 7 (+0x3c = 0x07000000). The record builder
/// (FUN_180d11800) adds physics_prop only for move type 5, so a keyframed brush never has it.
/// </summary>
public static class BrushPhysics
{
    const ulong TouchAll = 1ul << 17, Debris = 1ul << 20;
    const ulong Simulated = 0xc3001; // solid, window, passbullets, player, npc

    /// <summary>The record for a class, or null when its CreateVPhysics makes no physics (returns 0).</summary>
    public static CollisionAttributes? Record(string className)
    {
        byte group = 4;
        ulong with, asAdd = 0;
        switch (className)
        {
            case "func_brush": with = 0; break;                              // CFuncBrush 180e1af60
            case "func_door": with = 0x80c3001; break;                       // CBaseDoor 180d399f0
            case "func_door_rotating":                                       // CRotDoor 180d39a50
            case "func_movelinear":                                          // CFuncMoveLinear 180d8b6e0
            case "func_tracktrain": case "func_tanktrain":                   // CFuncTrackTrain 180fbefd0
            case "func_rotating":                                            // CFuncRotating 180d8b7f0
            case "func_breakable":                                           // CBreakable 180d8b670
            case "func_wall": case "func_wall_toggle":                       // CFuncWall 180ce6660 (group 4)
            case "prop_dynamic": case "prop_dynamic_override": case "dynamic_prop": // CDynamicProp 180b9a3d0
                with = Simulated; break;
            case "func_button": case "momentary_rot_button":                 // CBaseButton / CMomentaryRotButton 180ce61b0
                with = Simulated; asAdd = 0x800000; break;                   // interacts-as bit 23 set when clear
            case "func_clip_vphysics":                                       // CFuncVPhysicsClip 180ce6490
                group = 3; with = 0x200000; break;                           // physics_prop only; solid bit cleared
            default: return null;                                            // func_train (CFuncTrain): 1803c9f60, none
        }
        var asMask = TouchAll;
        // FUN_180d07730: a new group re-derives touchall / debris (group 5 debris, any but 2 and 14 touchall)
        if (group == 5) asMask = (asMask & ~TouchAll) | Debris;
        else if (group != 2 && group != 14) asMask = (asMask & ~Debris) | TouchAll;
        asMask |= asAdd;
        if (className == "func_clip_vphysics") asMask &= ~1ul;
        return new CollisionAttributes { InteractsAs = asMask, InteractsWith = with, EntityId = -1, OwnerId = -1, Flags = 7, Group = group };
    }
}
