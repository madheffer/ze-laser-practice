using System.Numerics;
using System.Text;

namespace Source2.Compiler.Physics;

// The map's compiled physics as the bake writes it (bake/RubikonBake.cs -> maps/<map>/physics.bin) and Rubikon reads it
// (wasm/Interop.cs): every model's VPhysXAggregateData_t reduced to what vphysics2 builds bodies from. Shared source,
// compiled into both, so the two sides cannot disagree. Shapes are Valve's own cooked ones (RnHull_t / RnMesh_t, read
// through VRF as source2-compiler's SettleWorld.Hull / Mesh do), never rebuilt.
//
// Layout (little endian): "RNPH", u32 version; surfaces; models. Strings: u16 byte length + UTF-8.

/// <summary>A surface property's physics, from scripts/surfaceproperties.vsurf with its base chain resolved.</summary>
public readonly record struct PhysSurface(uint Hash, string Name, float Density, float Friction, float Elasticity, float Thickness,
                                          float SoftContactFrequency, float SoftContactDampingRatio);

/// <summary>A VPhysXCollisionAttributes_t: its layer and group names, turned into bits by <see cref="CollisionRules"/> at load.</summary>
public sealed record PhysAttributes(string[] InteractAs, string[] InteractWith, string[] InteractExclude, string Group);

/// <summary>One shape of a part. Type: 0 sphere, 1 capsule, 2 hull, 3 mesh (the order a VPhysXAggregateData_t lists them).</summary>
public sealed class PhysShape
{
    public int Type;
    public int AttributeIndex = -1;
    public int SurfaceIndex = -1;
    public string Name = "";
    public Vector3 A, B;
    public float Radius;
    public RnHull? Hull;
    public RnMesh? Mesh;
}

/// <summary>A VPhysXBodyPart_t. A key the model leaves out keeps the schema default (the drags 1, the rest 0).</summary>
public sealed class PhysPart
{
    public uint Flags;
    public float Mass, InertiaScale, LinearDamping, AngularDamping, LinearDrag = 1f, AngularDrag = 1f;
    public bool OverrideMassCenter;
    public Vector3 MassCenterOverride;
    /// <summary>The part's place in the model (m_bindPose of its bone; identity for a single part).</summary>
    public float[] Transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    public List<PhysShape> Shapes = [];
}

/// <summary>A model's physics: its parts, its surfaces (m_surfacePropertyHashes) and its collision attributes.</summary>
public sealed class PhysModel
{
    public string Key = "";
    public uint[] SurfaceHashes = [];
    public List<PhysAttributes> Attributes = [];
    public List<PhysPart> Parts = [];
}

public sealed class PhysFile
{
    public const uint Version = 1;
    public List<PhysSurface> Surfaces = [];
    public List<PhysModel> Models = [];

    public byte[] Write()
    {
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms, Encoding.UTF8);
        w.Write("RNPH"u8);
        w.Write(Version);
        w.Write(Surfaces.Count);
        foreach (var s in Surfaces)
        {
            w.Write(s.Hash); Str(w, s.Name);
            w.Write(s.Density); w.Write(s.Friction); w.Write(s.Elasticity); w.Write(s.Thickness);
            w.Write(s.SoftContactFrequency); w.Write(s.SoftContactDampingRatio);
        }
        w.Write(Models.Count);
        foreach (var m in Models)
        {
            Str(w, m.Key);
            w.Write(m.SurfaceHashes.Length);
            foreach (var h in m.SurfaceHashes) w.Write(h);
            w.Write(m.Attributes.Count);
            foreach (var a in m.Attributes)
            {
                Strs(w, a.InteractAs); Strs(w, a.InteractWith); Strs(w, a.InteractExclude); Str(w, a.Group);
            }
            w.Write(m.Parts.Count);
            foreach (var p in m.Parts)
            {
                w.Write(p.Flags); w.Write(p.Mass); w.Write(p.InertiaScale); w.Write(p.LinearDamping); w.Write(p.AngularDamping);
                w.Write(p.LinearDrag); w.Write(p.AngularDrag); w.Write(p.OverrideMassCenter); V3(w, p.MassCenterOverride);
                foreach (var f in p.Transform) w.Write(f);
                w.Write(p.Shapes.Count);
                foreach (var s in p.Shapes)
                {
                    w.Write((byte)s.Type); w.Write(s.AttributeIndex); w.Write(s.SurfaceIndex); Str(w, s.Name);
                    switch (s.Type)
                    {
                        case 0: V3(w, s.A); w.Write(s.Radius); break;
                        case 1: V3(w, s.A); V3(w, s.B); w.Write(s.Radius); break;
                        case 2: Hull(w, s.Hull!); break;
                        case 3: Mesh(w, s.Mesh!); break;
                        default: throw new InvalidDataException($"shape type {s.Type}");
                    }
                }
            }
        }
        w.Flush();
        return ms.ToArray();
    }

    public static PhysFile Read(byte[] data)
    {
        using var r = new BinaryReader(new MemoryStream(data, false), Encoding.UTF8);
        if (!r.ReadBytes(4).AsSpan().SequenceEqual("RNPH"u8)) throw new InvalidDataException("not a physics.bin");
        var version = r.ReadUInt32();
        if (version != Version) throw new InvalidDataException($"physics.bin version {version}, expected {Version}");
        var f = new PhysFile();
        for (int i = 0, n = Count(r); i < n; i++)
            f.Surfaces.Add(new PhysSurface(r.ReadUInt32(), Str(r), r.ReadSingle(), r.ReadSingle(), r.ReadSingle(), r.ReadSingle(),
                                           r.ReadSingle(), r.ReadSingle()));
        for (int i = 0, n = Count(r); i < n; i++)
        {
            var m = new PhysModel { Key = Str(r) };
            m.SurfaceHashes = new uint[Count(r)];
            for (var k = 0; k < m.SurfaceHashes.Length; k++) m.SurfaceHashes[k] = r.ReadUInt32();
            for (int k = 0, na = Count(r); k < na; k++) m.Attributes.Add(new PhysAttributes(Strs(r), Strs(r), Strs(r), Str(r)));
            for (int k = 0, np = Count(r); k < np; k++)
            {
                var p = new PhysPart
                {
                    Flags = r.ReadUInt32(), Mass = r.ReadSingle(), InertiaScale = r.ReadSingle(), LinearDamping = r.ReadSingle(),
                    AngularDamping = r.ReadSingle(), LinearDrag = r.ReadSingle(), AngularDrag = r.ReadSingle(),
                    OverrideMassCenter = r.ReadBoolean(), MassCenterOverride = V3(r),
                };
                for (var t = 0; t < 12; t++) p.Transform[t] = r.ReadSingle();
                for (int s = 0, ns = Count(r); s < ns; s++)
                {
                    var sh = new PhysShape { Type = r.ReadByte(), AttributeIndex = r.ReadInt32(), SurfaceIndex = r.ReadInt32(), Name = Str(r) };
                    switch (sh.Type)
                    {
                        case 0: sh.A = V3(r); sh.Radius = r.ReadSingle(); break;
                        case 1: sh.A = V3(r); sh.B = V3(r); sh.Radius = r.ReadSingle(); break;
                        case 2: sh.Hull = Hull(r); break;
                        case 3: sh.Mesh = Mesh(r); break;
                        default: throw new InvalidDataException($"shape type {sh.Type}");
                    }
                    p.Shapes.Add(sh);
                }
                m.Parts.Add(p);
            }
            f.Models.Add(m);
        }
        return f;
    }

    // ---- RnHull_t / RnMesh_t, every field the simulation reads

    static void Hull(BinaryWriter w, RnHull h)
    {
        V3(w, h.Centroid); w.Write(h.MaxAngularRadius); w.Write(h.MinCentroidRadius);
        V3(w, h.BoundsMin); V3(w, h.BoundsMax); V3(w, h.OrthographicAreas);
        for (var i = 0; i < 12; i++) w.Write(i < h.MassProperties.Length ? h.MassProperties[i] : 0f);
        w.Write(h.Volume); w.Write(h.SurfaceArea); w.Write(h.Flags);
        w.Write(h.VertexPositions.Length); foreach (var v in h.VertexPositions) V3(w, v);
        w.Write(h.Planes.Length); foreach (var (n, d) in h.Planes) { V3(w, n); w.Write(d); }
        w.Write(h.Vertices.Length); w.Write(h.Vertices);
        w.Write(h.Edges.Length); foreach (var e in h.Edges) { w.Write(e.Next); w.Write(e.Twin); w.Write(e.Origin); w.Write(e.Face); }
        w.Write(h.Faces.Length); w.Write(h.Faces);
        w.Write(h.RegionSvm != null);
        if (h.RegionSvm is { } svm)
        {
            w.Write(svm.Planes.Length); foreach (var (n, d) in svm.Planes) { V3(w, n); w.Write(d); }
            w.Write(svm.Nodes.Length); foreach (var x in svm.Nodes) w.Write(x);
        }
    }

    static RnHull Hull(BinaryReader r)
    {
        var h = new RnHull
        {
            Centroid = V3(r), MaxAngularRadius = r.ReadSingle(), MinCentroidRadius = r.ReadSingle(),
            BoundsMin = V3(r), BoundsMax = V3(r), OrthographicAreas = V3(r),
        };
        for (var i = 0; i < 12; i++) h.MassProperties[i] = r.ReadSingle();
        h.Volume = r.ReadSingle(); h.SurfaceArea = r.ReadSingle(); h.Flags = r.ReadUInt32();
        h.VertexPositions = new Vector3[Count(r)]; for (var i = 0; i < h.VertexPositions.Length; i++) h.VertexPositions[i] = V3(r);
        h.Planes = new (Vector3, float)[Count(r)]; for (var i = 0; i < h.Planes.Length; i++) h.Planes[i] = (V3(r), r.ReadSingle());
        h.Vertices = r.ReadBytes(Count(r));
        h.Edges = new (byte, byte, byte, byte)[Count(r)];
        for (var i = 0; i < h.Edges.Length; i++) h.Edges[i] = (r.ReadByte(), r.ReadByte(), r.ReadByte(), r.ReadByte());
        h.Faces = r.ReadBytes(Count(r));
        if (r.ReadBoolean())
        {
            var svm = new RegionSvm();
            svm.Planes = new (Vector3, float)[Count(r)]; for (var i = 0; i < svm.Planes.Length; i++) svm.Planes[i] = (V3(r), r.ReadSingle());
            svm.Nodes = new uint[Count(r)]; for (var i = 0; i < svm.Nodes.Length; i++) svm.Nodes[i] = r.ReadUInt32();
            h.RegionSvm = svm;
        }
        return h;
    }

    static void Mesh(BinaryWriter w, RnMesh m)
    {
        V3(w, m.Min); V3(w, m.Max); V3(w, m.OrthographicAreas); w.Write(m.SurfaceArea); w.Write(m.Flags); w.Write(m.DebugFlags);
        w.Write(m.Nodes.Length);
        foreach (var n in m.Nodes) { V3(w, n.Min); w.Write(n.Children); V3(w, n.Max); w.Write(n.TriangleOffset); }
        w.Write(m.Vertices.Length); foreach (var v in m.Vertices) V3(w, v);
        w.Write(m.Triangles.Length); foreach (var (a, b, c) in m.Triangles) { w.Write(a); w.Write(b); w.Write(c); }
        w.Write(m.Materials.Length); w.Write(m.Materials);
    }

    static RnMesh Mesh(BinaryReader r)
    {
        var m = new RnMesh { Min = V3(r), Max = V3(r), OrthographicAreas = V3(r), SurfaceArea = r.ReadSingle(), Flags = r.ReadUInt32(), DebugFlags = r.ReadUInt32() };
        m.Nodes = new RnMesh.Node[Count(r)];
        for (var i = 0; i < m.Nodes.Length; i++) m.Nodes[i] = new RnMesh.Node(V3(r), r.ReadUInt32(), V3(r), r.ReadUInt32());
        m.Vertices = new Vector3[Count(r)]; for (var i = 0; i < m.Vertices.Length; i++) m.Vertices[i] = V3(r);
        m.Triangles = new (int, int, int)[Count(r)];
        for (var i = 0; i < m.Triangles.Length; i++) m.Triangles[i] = (r.ReadInt32(), r.ReadInt32(), r.ReadInt32());
        m.Materials = r.ReadBytes(Count(r));
        return m;
    }

    // ---- primitives

    static int Count(BinaryReader r)
    {
        var n = r.ReadInt32();
        if (n < 0 || n > 64 << 20) throw new InvalidDataException($"bad count {n}"); // the file is the bake's, but never trusted
        return n;
    }
    static void V3(BinaryWriter w, Vector3 v) { w.Write(v.X); w.Write(v.Y); w.Write(v.Z); }
    static Vector3 V3(BinaryReader r) => new(r.ReadSingle(), r.ReadSingle(), r.ReadSingle());
    static void Str(BinaryWriter w, string s)
    {
        var b = Encoding.UTF8.GetBytes(s);
        if (b.Length > ushort.MaxValue) throw new InvalidDataException("string too long");
        w.Write((ushort)b.Length); w.Write(b);
    }
    static string Str(BinaryReader r) => Encoding.UTF8.GetString(r.ReadBytes(r.ReadUInt16()));
    static void Strs(BinaryWriter w, string[] a) { w.Write(a.Length); foreach (var s in a) Str(w, s); }
    static string[] Strs(BinaryReader r) { var a = new string[Count(r)]; for (var i = 0; i < a.Length; i++) a[i] = Str(r); return a; }
}
