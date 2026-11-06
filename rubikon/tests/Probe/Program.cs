// rubikon-probe <physics.bin> <model key> <x> <y> <z> [steps]: src/Game/Probe.cs natively
using System.Globalization;
using System.Numerics;
if (args[0] == "--dump") { Dump.Run(args[1], args[2]); return; }
var f = (int i) => float.Parse(args[i], CultureInfo.InvariantCulture);
if (args[0] == "--settype")
{
    // --settype <physics.bin> <model> x y z offTick onTick ticks
    Console.Write(Source2.Compiler.Game.Probe.RunSetType(File.ReadAllBytes(args[1]), args[2], new Vector3(f(3), f(4), f(5)), int.Parse(args[6]), int.Parse(args[7]), int.Parse(args[8])));
    return;
}
if (args[0] == "--keyframe")
{
    // --keyframe <physics.bin> <mover> x y z dx dy dz <rider> rx ry rz ticks
    Console.Write(Source2.Compiler.Game.Probe.RunKeyframe(File.ReadAllBytes(args[1]), args[2], new Vector3(f(3), f(4), f(5)), new Vector3(f(6), f(7), f(8)),
        args[9], new Vector3(f(10), f(11), f(12)), int.Parse(args[13])));
    return;
}
if (args[0] == "--thruster")
{
    // --thruster <physics.bin> <model> x y z flags force ox oy oz pitch yaw roll ticks [keepupright angularlimit
    //            [physbox spawnflags massscale]]
    var box = args.Length > 17 ? new Source2.Compiler.Game.PhysBoxKeys { SpawnFlags = int.Parse(args[16]), MassScale = f(17) } : null;
    Console.Write(Source2.Compiler.Game.Probe.RunThruster(File.ReadAllBytes(args[1]), args[2], new Vector3(f(3), f(4), f(5)), int.Parse(args[6]), f(7),
        new Vector3(f(8), f(9), f(10)), new Vector3(f(11), f(12), f(13)), int.Parse(args[14]), args.Length > 15 ? f(15) : 0f, box));
    return;
}
Console.Write(Source2.Compiler.Game.Probe.Run(File.ReadAllBytes(args[0]), args[1], new Vector3(f(2), f(3), f(4)), args.Length > 5 ? int.Parse(args[5]) : 192));
