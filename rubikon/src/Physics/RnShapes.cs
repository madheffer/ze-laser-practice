// The cooked shape data the simulation reads, copied from source2-compiler (src/Source2.Compiler/Physics: RnHullBuilder.cs,
// RnMeshBuilder.cs, RegionSvm.cs at a12333d) without the builders: the game takes Valve's own compiled shapes from the bake.
using System.Numerics;

namespace Source2.Compiler.Physics;

/// <summary>A cooked convex hull, laid out as <c>RnHull_t</c> (0xf8 bytes).</summary>
public sealed class RnHull
{
    public Vector3 Centroid;
    public float MaxAngularRadius;
    public float MinCentroidRadius;
    public Vector3 BoundsMin;
    public Vector3 BoundsMax;
    public Vector3 OrthographicAreas;
    /// <summary>Row-major 3x4: inertia in the first three columns, the mass centre in the fourth.</summary>
    public float[] MassProperties = new float[12];
    public float Volume;
    public float SurfaceArea;
    public Vector3[] VertexPositions = [];
    public (Vector3 Normal, float Offset)[] Planes = [];
    /// <summary>Per vertex, one outgoing half-edge.</summary>
    public byte[] Vertices = [];
    public (byte Next, byte Twin, byte Origin, byte Face)[] Edges = [];
    /// <summary>Per face, one half-edge.</summary>
    public byte[] Faces = [];
    public uint Flags;
    public RegionSvm? RegionSvm;
}

/// <summary>A cooked triangle-mesh shape, laid out as <c>RnMesh_t</c>.</summary>
public sealed class RnMesh
{
    /// <summary>One BVH node: a box, the right child's distance (or a leaf's triangle count) with the split axis in the top two bits (3 = leaf), and a leaf's first triangle.</summary>
    public readonly record struct Node(Vector3 Min, uint Children, Vector3 Max, uint TriangleOffset);

    public Vector3 Min;
    public Vector3 Max;
    public Node[] Nodes = [];
    public Vector3[] Vertices = [];
    public (int A, int B, int C)[] Triangles = [];
    /// <summary>Per triangle, when the mesh was given materials.</summary>
    public byte[] Materials = [];
    public Vector3 OrthographicAreas;
    public float SurfaceArea;
    public uint Flags;
    /// <summary>+0xb8: bit 0 when a mesh that would be closed touches itself.</summary>
    public uint DebugFlags;
}

/// <summary>
/// A hull's region SVM (<c>CRegionSVM</c>, <c>m_pRegionSVM</c>): a plane tree
/// that takes a point to the hull feature nearest it. Its leaves are the
/// hull's Voronoi regions: the inside (0), a vertex (0x20000000, its first
/// outgoing half-edge shifted 8, the vertex), an edge (0x40000000 and the
/// even half-edge) or a face (0x60000000 and the face). A split node is
/// 0x8000 and the plane in its top half and, in its bottom half, how far past
/// the next node its front child sits; the back child follows the front one.
/// </summary>
public sealed class RegionSvm
{
    public (Vector3 Normal, float Offset)[] Planes = [];
    public uint[] Nodes = [];
}
