using Source2.Compiler.Io;

namespace Source2.Compiler.Physics;

// vphysics2's collision rules, copied from source2-compiler (src/Source2.Compiler/Maps/SettleWorld.cs SettleWorld.CollisionRules
// at a12333d) without its Convert, which reads VRF's KV3 and lives in the bake (bake/RubikonBake.cs).
/// <summary>
/// vphysics2's default collision rules (FUN_180296fa0): the collision
/// groups and interaction layers by name, the presets that stand for
/// several layers, and the layers a model names that the rules do not
/// know, which take the next free bit from 32 on in the order they are
/// first met.
/// </summary>
public sealed class CollisionRules
{
    private static readonly string[] Groups =
    [
        "always", "never", "trigger", "ConditionallySolid", "Default", "debris", "interactive_debris", "interactive",
        "Player", "breakable_glass", "vehicle", "player_movement", "npc", "in_vehicle", "weapon", "", "Projectile",
        "door_blocker", "passable_door", "dissolving", "pushaway", "npc_actor", "npc_scripted", "pz_clip", "props",
    ];

    private static readonly string[] Layers =
    [
        "solid", "hitboxes", "trigger", "sky", "playerclip", "npcclip", "blocklos", "blocklight", "ladder", "pickup",
        "blocksound", "nodraw", "window", "passbullets", "worldGeometry", "water", "slime", "touchall", "player", "npc",
        "debris", "physics_prop", "NavIgnore", "NavLocalIgnore", "PostProcessingVolume", "vehicleclip", "CarriedObject",
        "pushaway", "serverentityonclient", "CarriedWeapon", "StaticLevel",
    ];

    private readonly Dictionary<string, ulong> _layers = new(Tier0Strings.IgnoreCase);
    // A name the rules do not know takes the lowest free bit, and 31 is
    // the first (FUN_180296fa0 registers 0 to 30): atixref's csgo_grenadeclip
    // takes 31 and csgo_thrown_grenade 32, c2m2's first new layer 31.
    private int _next = 31;

    /// <summary>CONTENTS_SOLID: solid, blocksound, blocklos, blocklight; also what an empty interact-as means.</summary>
    public const ulong ContentsSolid = 0x4c1;

    public CollisionRules()
    {
        for (var i = 0; i < Layers.Length; i++)
            _layers[Layers[i]] = 1ul << i;
        _layers["CONTENTS_SOLID"] = ContentsSolid;
        _layers["CONTENTS_SOLID_NO_BLOCK_LOS"] = ContentsSolid & ~0x40ul;
    }

    public int Group(string name)
    {
        var i = Array.FindIndex(Groups, g => g.EqualsAscii(name));
        return i;
    }

    /// <summary>
    /// A layer's bit, registering an unknown name. An empty name is a name
    /// like any other: Mako's spindle_01_a lists "" as its interact-as and
    /// Valve gives it a new bit (32). Lists parsed from text drop empty
    /// entries before they get here (see <see cref="Mask"/>).
    /// </summary>
    public ulong Layer(string name)
    {
        if (!_layers.TryGetValue(name, out var bits))
            _layers[name] = bits = 1ul << _next++;
        return bits;
    }

    /// <summary>A layer's bit when the rules know the name, without registering it.</summary>
    public bool TryLayer(string name, out ulong bits) => _layers.TryGetValue(name, out bits);

    /// <summary>A comma separated list of layer names as one mask (the collision interface's string parse).</summary>
    public ulong Mask(string list)
        => list.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Aggregate(0ul, (a, n) => a | Layer(n));

}
