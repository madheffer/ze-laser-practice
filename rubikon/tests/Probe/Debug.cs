// rubikon-probe --dump <physics.bin> <model>: a model's parts, shapes and collision attributes as baked
using Source2.Compiler.Physics;
static class Dump
{
    public static void Run(string bin, string key)
    {
        var f = PhysFile.Read(File.ReadAllBytes(bin));
        var m = f.Models.FirstOrDefault(x => x.Key == key);
        if (m == null) { Console.WriteLine("no model"); return; }
        Console.WriteLine($"{key}: {m.Parts.Count} parts, surfaces [{string.Join(",", m.SurfaceHashes)}]");
        for (var i = 0; i < m.Attributes.Count; i++) { var a = m.Attributes[i]; Console.WriteLine($"  attr {i}: as [{string.Join(",", a.InteractAs)}] with [{string.Join(",", a.InteractWith)}] excl [{string.Join(",", a.InteractExclude)}] group '{a.Group}'"); }
        foreach (var p in m.Parts)
        {
            Console.WriteLine($"  part flags {p.Flags} mass {p.Mass} shapes {p.Shapes.Count}");
            foreach (var g in p.Shapes.GroupBy(s => (s.Type, s.AttributeIndex, s.SurfaceIndex)).Take(12))
                Console.WriteLine($"    type {g.Key.Type} attr {g.Key.AttributeIndex} surf {g.Key.SurfaceIndex}: {g.Count()}");
        }
    }
}
