using System.Numerics;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;

namespace Source2.Compiler.Wasm;

// The JS side of Rubikon (rubikon/src): what the game and the co-op server call. For now only the probe, to compare this
// build with the native one bit for bit (rubikon/tests/Probe); the game's world API comes with the entity port.
[SupportedOSPlatform("browser")]
public static partial class Interop
{
    public static void Main() { }

    [JSExport]
    public static string Probe(byte[] physicsBin, string modelKey, double x, double y, double z, int steps)
        => Game.Probe.Run(physicsBin, modelKey, new Vector3((float)x, (float)y, (float)z), steps);

    [JSExport]
    public static string ProbeThruster(byte[] physicsBin, string modelKey, double[] at, int flags, double force, double[] offset, double[] angles, int ticks, double keepUpright, int boxFlags, double boxMassScale)
        => Game.Probe.RunThruster(physicsBin, modelKey, V(at), flags, (float)force, V(offset), V(angles), ticks, (float)keepUpright,
                                  boxFlags < 0 ? null : new Game.PhysBoxKeys { SpawnFlags = boxFlags, MassScale = (float)boxMassScale });

    [JSExport]
    public static string ProbeSetType(byte[] physicsBin, string modelKey, double[] at, int offAt, int onAt, int ticks)
        => Game.Probe.RunSetType(physicsBin, modelKey, V(at), offAt, onAt, ticks);

    [JSExport]
    public static string ProbeKeyframe(byte[] physicsBin, string moverKey, double[] at, double[] step, string riderKey, double[] riderAt, int ticks)
        => Game.Probe.RunKeyframe(physicsBin, moverKey, V(at), V(step), riderKey, V(riderAt), ticks);

    static Vector3 V(double[] a) => new((float)a[0], (float)a[1], (float)a[2]);
}
