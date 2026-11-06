// physics.bin: the map's compiled physics for Rubikon (rubikon/, CS2's vphysics2 as source2-compiler ported it): the
// world's physics and every entity model's, as Valve cooked them (RnHull_t / RnMesh_t read through VRF, never rebuilt),
// with each part's mass, damping and drag, its collision attributes by name and the surfaces' physics. Format and reader:
// rubikon/src/Physics/PhysFile.cs (compiled into this bake too).
//
// Reading follows source2-compiler (src/Source2.Compiler/Maps at a12333d): SettleWorld.Hull / Mesh for the shapes (the
// load's post pass included: a hull without explicit vertex indices gets each vertex's last outgoing edge, a zero
// surface area / centroid radius is computed), SettleWorld.Aggregate's part fields (a key left out keeps the
// VPhysXBodyPart_t default: drags 1, the rest 0) and shape order (spheres, capsules, hulls, then meshes), and
// SettleWorld.SurfaceMaterials for the surfaces (density, friction, elasticity straight from the compiled entry; a
// thickness left out comes from the base surface up the chain, 0.1 with none). The mesh's own m_nFlags, m_nDebugFlags,
// m_vOrthographicAreas and m_flSurfaceArea are read too (the simulation tests the closed bit; SettleWorld leaves them 0).
using System.Globalization;
using System.Numerics;
using SteamDatabase.ValvePak;
using ValveResourceFormat;
using ValveResourceFormat.IO;
using ValveResourceFormat.ResourceTypes;
using ValveResourceFormat.ResourceTypes.RubikonPhysics;
using ValveKeyValue;
using ValveResourceFormat.Serialization.KeyValues;
using Source2.Compiler.Physics;
using VrfHull = ValveResourceFormat.ResourceTypes.RubikonPhysics.Shapes.Hull;
using VrfMesh = ValveResourceFormat.ResourceTypes.RubikonPhysics.Shapes.Mesh;

namespace Lasers.Bake;

static class RubikonBake
{
    // the world's physics is the model "maps/<map>/world_physics.vmdl"; entity models by their own path
    public const string WorldKey = "world";

    public static void Write(GameFileLoader loader, string mapName, IEnumerable<string> entityModels, IEnumerable<Package> mapPackages,
                             IEnumerable<string> stockPaks, string outDir)
    {
        var file = new PhysFile();
        var used = new HashSet<uint>();
        void Add(string key, PhysAggregateData phys)
        {
            var m = Model(key, phys);
            file.Models.Add(m);
            foreach (var h in m.SurfaceHashes) used.Add(h);
        }
        if (loader.LoadFile($"maps/{mapName}/world_physics.vmdl_c")?.DataBlock is Model world && PhysOf(loader, world) is { } wp)
            Add(WorldKey, wp);
        else Console.WriteLine("physics: no world_physics");
        var skipped = 0;
        foreach (var path in entityModels)
        {
            try
            {
                if (loader.LoadFileCompiled(path)?.DataBlock is not Model model || PhysOf(loader, model) is not { } phys) continue;
                Add(path.ToLowerInvariant(), phys);
            }
            catch (Exception e) { skipped++; Console.WriteLine($"physics: {SafePath.Describe(path)}: {e.Message}"); }
        }
        file.Surfaces.AddRange(Surfaces(SurfaceBake.Load(mapPackages, stockPaks), used));
        var bytes = file.Write();
        File.WriteAllBytes(Path.Combine(outDir, "physics.bin"), bytes);
        var hulls = file.Models.Sum(m => m.Parts.Sum(p => p.Shapes.Count(s => s.Type == 2)));
        var meshes = file.Models.Sum(m => m.Parts.Sum(p => p.Shapes.Count(s => s.Type == 3)));
        Console.WriteLine($"physics: {file.Models.Count} models, {hulls} hulls, {meshes} meshes, {file.Surfaces.Count} surfaces, {bytes.Length / 1024} KB{(skipped > 0 ? $", {skipped} skipped" : "")}");
    }

    static PhysAggregateData? PhysOf(GameFileLoader loader, Model model)
    {
        if (model.GetEmbeddedPhys() is { } phys) return phys;
        foreach (var name in model.GetReferencedPhysNames())
            if (loader.LoadFileCompiled(name)?.DataBlock is PhysAggregateData p) return p;
        return null;
    }

    static PhysModel Model(string key, PhysAggregateData phys)
    {
        var m = new PhysModel { Key = key, SurfaceHashes = phys.SurfacePropertyHashes ?? [] };
        foreach (var a in phys.CollisionAttributes)
            m.Attributes.Add(new PhysAttributes(Strings(a, "m_InteractAsStrings"), Strings(a, "m_InteractWithStrings"),
                                                Strings(a, "m_InteractExcludeStrings"), a.GetStringProperty("m_CollisionGroupString") ?? ""));
        var raw = phys.Data.GetArray("m_parts");
        var bind = phys.Data.GetArray("m_bindPose");
        for (var i = 0; i < phys.Parts.Length; i++)
        {
            var part = phys.Parts[i];
            var p = raw[i];
            float Field(string k, float fallback) => p.ContainsKey(k) ? p.GetFloatProperty(k) : fallback;
            var pp = new PhysPart
            {
                Flags = (uint)part.Flags, Mass = part.Mass,
                InertiaScale = Field("m_flInertiaScale", 0f), LinearDamping = Field("m_flLinearDamping", 0f),
                AngularDamping = Field("m_flAngularDamping", 0f), LinearDrag = Field("m_flLinearDrag", 1f), AngularDrag = Field("m_flAngularDrag", 1f),
                OverrideMassCenter = p.ContainsKey("m_bOverrideMassCenter") && p.GetIntegerProperty("m_bOverrideMassCenter") != 0,
            };
            if (p.ContainsKey("m_vMassCenterOverride") && p.GetArray<float>("m_vMassCenterOverride") is { Length: 3 } mc)
                pp.MassCenterOverride = new Vector3(mc[0], mc[1], mc[2]);
            if (bind != null && i < bind.Count && Floats(bind[i]) is { Length: 12 } bp) pp.Transform = bp;
            var shape = part.Shape;
            var perShape = shape.CollisionAttributeIndices ?? [];
            var k = 0;
            int Attr() { var index = perShape.Length > 0 ? (k < perShape.Length ? perShape[k] : -1) : part.CollisionAttributeIndex; k++; return index; }
            foreach (var s in shape.Spheres)
                pp.Shapes.Add(new PhysShape { Type = 0, AttributeIndex = Attr(), SurfaceIndex = s.SurfacePropertyIndex, Name = s.UserFriendlyName ?? "", A = s.Shape.Center, Radius = s.Shape.Radius });
            foreach (var c in shape.Capsules)
                pp.Shapes.Add(new PhysShape { Type = 1, AttributeIndex = Attr(), SurfaceIndex = c.SurfacePropertyIndex, Name = c.UserFriendlyName ?? "", A = c.Shape.Center[0], B = c.Shape.Center[1], Radius = c.Shape.Radius });
            foreach (var h in shape.Hulls)
                pp.Shapes.Add(new PhysShape { Type = 2, AttributeIndex = Attr(), SurfaceIndex = h.SurfacePropertyIndex, Name = h.UserFriendlyName ?? "", Hull = Hull(h.Shape) });
            foreach (var me in shape.Meshes)
                pp.Shapes.Add(new PhysShape { Type = 3, AttributeIndex = Attr(), SurfaceIndex = me.SurfacePropertyIndex, Name = me.UserFriendlyName ?? "", Mesh = Mesh(me.Shape) });
            m.Parts.Add(pp);
        }
        return m;
    }

    static string[] Strings(KVObject o, string key) => o.GetArray<string>(key) ?? [];

    // a matrix3x4 (or any nested numeric array) as its numbers in order
    static float[] Floats(KVObject o)
    {
        var list = new List<float>();
        void Walk(KVObject x)
        {
            if (x.IsArray || x.IsCollection) { foreach (var (_, c) in x.Children) if (c != null) Walk(c); }
            else list.Add(Convert.ToSingle(x.ToDouble(CultureInfo.InvariantCulture)));
        }
        Walk(o);
        return [.. list];
    }

    // source2-compiler SettleWorld.Hull: an RnHull_t as a model stores it
    static RnHull Hull(VrfHull h)
    {
        var mass = h.Data.GetArray<object>("m_MassProperties")?.Select(x => Convert.ToSingle(x, CultureInfo.InvariantCulture)).ToArray() ?? new float[12];
        var hull = new RnHull
        {
            Centroid = h.Centroid,
            MaxAngularRadius = h.MaxAngularRadius,
            BoundsMin = h.Min,
            BoundsMax = h.Max,
            OrthographicAreas = h.OrthographicAreas,
            MassProperties = mass,
            Volume = h.Volume,
            VertexPositions = h.GetVertexPositions().ToArray(),
            Vertices = h.GetVertices().ToArray(),
            Edges = h.GetEdges().ToArray().Select(e => (e.Next, e.Twin, e.Origin, e.Face)).ToArray(),
            Faces = h.GetFaces().ToArray().Select(f => f.Edge).ToArray(),
            Planes = h.GetPlanes().ToArray().Select(p => (p.Normal, p.Offset)).ToArray(),
            Flags = (uint)h.Data.GetInt32Property("m_nFlags"),
        };
        if (hull.Vertices.Length == 0)
        {
            hull.Vertices = new byte[hull.VertexPositions.Length];
            for (var i = 0; i < hull.Edges.Length; i++)
                hull.Vertices[hull.Edges[i].Origin] = (byte)i;
        }
        hull.SurfaceArea = h.Data.GetFloatProperty("m_flSurfaceArea");
        hull.MinCentroidRadius = h.Data.GetFloatProperty("m_flMinCentroidRadius");
        if (hull.SurfaceArea == 0f)
            RnHullBuilder.Areas(hull);
        if (hull.MinCentroidRadius == 0f)
            RnHullBuilder.CentroidRadius(hull);
        return hull;
    }

    // source2-compiler SettleWorld.Mesh, plus the mesh's own flags and areas
    static RnMesh Mesh(VrfMesh m)
    {
        var nodes = m.ParseNodes();
        var triangles = m.GetTriangles();
        var mesh = new RnMesh
        {
            Min = m.Min,
            Max = m.Max,
            Nodes = nodes.ToArray().Select(n => new RnMesh.Node(n.Min, (uint)n.Type << 30 | n.ChildOffset, n.Max, n.TriangleOffset)).ToArray(),
            Vertices = m.GetVertices().ToArray(),
            Triangles = triangles.ToArray().Select(t => (t.X, t.Y, t.Z)).ToArray(),
            Materials = m.Materials.Select(x => (byte)x).ToArray(),
            OrthographicAreas = m.OrthographicAreas,
        };
        if (m.Data.ContainsKey("m_nFlags")) mesh.Flags = (uint)m.Data.GetInt32Property("m_nFlags");
        if (m.Data.ContainsKey("m_nDebugFlags")) mesh.DebugFlags = (uint)m.Data.GetInt32Property("m_nDebugFlags");
        if (m.Data.ContainsKey("m_flSurfaceArea")) mesh.SurfaceArea = m.Data.GetFloatProperty("m_flSurfaceArea");
        return mesh;
    }

    // source2-compiler SettleWorld.SurfaceMaterials, for the surfaces the map's models name (and "default")
    static IEnumerable<PhysSurface> Surfaces(Dictionary<uint, SurfaceBake.Surf> all, HashSet<uint> used)
    {
        const uint DefaultSurface = 1977497166;
        used.Add(DefaultSurface);
        float F(KVObject? p, string key) => p != null && p.ContainsKey(key) ? p.GetFloatProperty(key) : 0f;
        float Thickness(SurfaceBake.Surf s)
        {
            for (var (at, guard) = (s, 0); at != null && guard < 32; guard++)
            {
                if (at.Physics != null && at.Physics.ContainsKey("thickness")) return at.Physics.GetFloatProperty("thickness");
                at = all.GetValueOrDefault(at.Base);
            }
            return 0.1f;
        }
        foreach (var h in used.OrderBy(x => x))
        {
            if (!all.TryGetValue(h, out var s)) continue;
            yield return new PhysSurface(h, s.Name, F(s.Physics, "density"), F(s.Physics, "friction"), F(s.Physics, "elasticity"), Thickness(s),
                                         F(s.Physics, "softcontactfrequency"), F(s.Physics, "softcontactdampingratio"));
        }
    }
}
