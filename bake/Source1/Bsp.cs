// A Source 1 map (VBSP, CS:GO's version 21; CS:S's 19/20 share every lump read here) read into plain arrays.
// Layouts are the Source SDK's public/bspfile.h; CS:GO's leaf is version 1 (no ambient lighting, 32 bytes).
// Every count and offset comes from an attacker-made file: lumps are bounds-checked against the file and
// indexes against their arrays by the readers that follow them (BrushGeometry, FaceMesh).
using System.Numerics;
using System.Text;

namespace Lasers.Bake.Source1;

sealed class Bsp
{
    public const int LumpEntities = 0, LumpPlanes = 1, LumpTexdata = 2, LumpVertexes = 3, LumpNodes = 5, LumpTexinfo = 6,
        LumpFaces = 7, LumpLighting = 8, LumpLeafs = 10, LumpEdges = 12, LumpSurfedges = 13, LumpModels = 14,
        LumpLeafBrushes = 17, LumpBrushes = 18, LumpBrushSides = 19, LumpDispInfo = 26, LumpDispVerts = 33,
        LumpGame = 35, LumpPakfile = 40, LumpTexStrData = 43, LumpTexStrTable = 44, LumpLightingHdr = 53, LumpFacesHdr = 58;

    // bspflags.h
    public const int ContentsSolid = 0x1, ContentsWindow = 0x2, ContentsGrate = 0x8, ContentsSlime = 0x10, ContentsWater = 0x20,
        ContentsMoveable = 0x4000, ContentsPlayerClip = 0x10000, ContentsMonsterClip = 0x20000, ContentsLadder = 0x20000000;
    public const int SurfSky2d = 0x2, SurfSky = 0x4, SurfWarp = 0x8, SurfTrans = 0x10, SurfNoDraw = 0x80, SurfHint = 0x100, SurfSkip = 0x200;

    public readonly record struct Plane(Vector3 Normal, float Dist);
    public readonly record struct TexInfo(Vector4 S, Vector4 T, Vector4 LS, Vector4 LT, int Flags, int TexData);
    public readonly record struct TexData(int NameId, int Width, int Height);
    public readonly record struct Face(int Plane, int Side, int FirstEdge, int NumEdges, int TexInfo, int DispInfo,
        int LightOfs, int LmMinsX, int LmMinsY, int LmW, int LmH, byte Style0);
    public readonly record struct Model(Vector3 Mins, Vector3 Maxs, Vector3 Origin, int HeadNode, int FirstFace, int NumFaces);
    public readonly record struct Node(int Plane, int Child0, int Child1);
    public readonly record struct Leaf(int Contents, int FirstLeafBrush, int NumLeafBrushes);
    public readonly record struct Brush(int FirstSide, int NumSides, int Contents);
    public readonly record struct BrushSide(int Plane, int TexInfo, int DispInfo, bool Bevel);
    public readonly record struct DispInfo(Vector3 Start, int VertStart, int Power, int Contents, int MapFace, int Flags);
    public readonly record struct DispVert(Vector3 Vec, float Dist, float Alpha);

    public int Version;
    public byte[] Data = [];
    public (int Ofs, int Len)[] Lumps = new (int, int)[64];
    public Plane[] Planes = [];
    public Vector3[] Vertexes = [];
    public (int A, int B)[] Edges = [];
    public int[] SurfEdges = [];
    public TexInfo[] TexInfos = [];
    public TexData[] TexDatas = [];
    public string[] TexNames = [];
    public Face[] Faces = [];
    public Model[] Models = [];
    public Node[] Nodes = [];
    public Leaf[] Leafs = [];
    public int[] LeafBrushes = [];
    public Brush[] Brushes = [];
    public BrushSide[] BrushSides = [];
    public DispInfo[] Disps = [];
    public DispVert[] DispVerts = [];
    public byte[] Lighting = [];
    public string EntityText = "";

    public static Bsp Read(string path)
    {
        var b = new Bsp { Data = File.ReadAllBytes(path) };
        var d = b.Data;
        if (d.Length < 1036 || Encoding.ASCII.GetString(d, 0, 4) != "VBSP") throw new InvalidDataException("not a VBSP file");
        b.Version = BitConverter.ToInt32(d, 4);
        if (b.Version is < 19 or > 21) throw new InvalidDataException($"VBSP version {b.Version} not supported (19-21: CS:S, CS:GO)");
        for (var i = 0; i < 64; i++)
        {
            int ofs = BitConverter.ToInt32(d, 8 + i * 16), len = BitConverter.ToInt32(d, 12 + i * 16), fourCC = BitConverter.ToInt32(d, 20 + i * 16);
            if (ofs < 0 || len < 0 || (long)ofs + len > d.Length) throw new InvalidDataException($"lump {i} outside the file");
            // an LZMA-compressed lump (console / some CS:GO bakes) is read as empty rather than as garbage
            b.Lumps[i] = fourCC != 0 && i != LumpPakfile && i != LumpGame ? (0, 0) : (ofs, len);
            if (fourCC != 0 && i != LumpPakfile && i != LumpGame) Console.WriteLine($"  lump {i} is compressed: skipped");
        }
        b.Planes = b.Array(LumpPlanes, 20, (o) => new Plane(V3(d, o), F(d, o + 12)));
        b.Vertexes = b.Array(LumpVertexes, 12, (o) => V3(d, o));
        b.Edges = b.Array(LumpEdges, 4, (o) => ((int)U16(d, o), (int)U16(d, o + 2)));
        b.SurfEdges = b.Array(LumpSurfedges, 4, (o) => BitConverter.ToInt32(d, o));
        b.TexInfos = b.Array(LumpTexinfo, 72, (o) => new TexInfo(V4(d, o), V4(d, o + 16), V4(d, o + 32), V4(d, o + 48), I(d, o + 64), I(d, o + 68)));
        b.TexDatas = b.Array(LumpTexdata, 32, (o) => new TexData(I(d, o + 12), I(d, o + 16), I(d, o + 20)));
        // with HDR lightmaps, the HDR face lump: the same faces, their lightofs into the HDR lighting
        var hdr = b.Lumps[LumpLightingHdr].Len > 0 && b.Lumps[LumpFacesHdr].Len > 0;
        var faceLump = hdr || b.Lumps[LumpFaces].Len == 0 ? LumpFacesHdr : LumpFaces;
        b.Faces = b.Array(faceLump, 56, (o) => new Face(U16(d, o), d[o + 2], I(d, o + 4), S16(d, o + 8), S16(d, o + 10), S16(d, o + 12),
            I(d, o + 20), I(d, o + 28), I(d, o + 32), I(d, o + 36), I(d, o + 40), d[o + 16]));
        b.Models = b.Array(LumpModels, 48, (o) => new Model(V3(d, o), V3(d, o + 12), V3(d, o + 24), I(d, o + 36), I(d, o + 40), I(d, o + 44)));
        b.Nodes = b.Array(LumpNodes, 32, (o) => new Node(I(d, o), I(d, o + 4), I(d, o + 8)));
        var leafSize = b.Version >= 20 ? 32 : 56; // version 19 leaves carry ambient lighting (CompressedLightCube, 24 bytes)
        b.Leafs = b.Array(LumpLeafs, leafSize, (o) => new Leaf(I(d, o), U16(d, o + 24), U16(d, o + 26)));
        b.LeafBrushes = b.Array(LumpLeafBrushes, 2, (o) => (int)U16(d, o));
        b.Brushes = b.Array(LumpBrushes, 12, (o) => new Brush(I(d, o), I(d, o + 4), I(d, o + 8)));
        b.BrushSides = b.Array(LumpBrushSides, 8, (o) => new BrushSide(U16(d, o), S16(d, o + 2), S16(d, o + 4), d[o + 6] != 0));
        b.Disps = b.Array(LumpDispInfo, 176, (o) => new DispInfo(V3(d, o), I(d, o + 12), I(d, o + 20), I(d, o + 28), U16(d, o + 32), 0));
        b.DispVerts = b.Array(LumpDispVerts, 20, (o) => new DispVert(V3(d, o), F(d, o + 12), F(d, o + 16)));
        // the HDR lightmaps when the map has them (CS:GO draws HDR)
        var lt = hdr ? b.Lumps[LumpLightingHdr] : b.Lumps[LumpLighting];
        b.Lighting = d.AsSpan(lt.Ofs, lt.Len).ToArray();
        var ent = b.Lumps[LumpEntities];
        b.EntityText = Encoding.UTF8.GetString(d, ent.Ofs, ent.Len).TrimEnd('\0');

        var table = b.Array(LumpTexStrTable, 4, (o) => I(d, o));
        var (sOfs, sLen) = b.Lumps[LumpTexStrData];
        b.TexNames = table.Select(t =>
        {
            if (t < 0 || t >= sLen) return "";
            var end = System.Array.IndexOf(d, (byte)0, sOfs + t, sLen - t);
            return Encoding.UTF8.GetString(d, sOfs + t, (end < 0 ? sOfs + sLen : end) - sOfs - t);
        }).ToArray();
        return b;
    }

    public string TexName(int texinfo)
    {
        if (texinfo < 0 || texinfo >= TexInfos.Length) return "";
        var td = TexInfos[texinfo].TexData;
        if (td < 0 || td >= TexDatas.Length) return "";
        var n = TexDatas[td].NameId;
        return n >= 0 && n < TexNames.Length ? TexNames[n] : "";
    }

    public ReadOnlySpan<byte> Lump(int i) => Data.AsSpan(Lumps[i].Ofs, Lumps[i].Len);

    // Game lump `id` ("sprp" static props): (version, bytes). Offsets in the game lump directory are from the file start.
    public (int Version, byte[] Bytes)? GameLump(string id)
    {
        var (ofs, len) = Lumps[LumpGame];
        if (len < 4) return null;
        var n = I(Data, ofs);
        for (var i = 0; i < n && 4 + (i + 1) * 16 <= len; i++)
        {
            var o = ofs + 4 + i * 16;
            var tag = Encoding.ASCII.GetString(new[] { Data[o + 3], Data[o + 2], Data[o + 1], Data[o] });
            if (tag != id) continue;
            int flags = U16(Data, o + 4), ver = U16(Data, o + 6), fo = I(Data, o + 8), fl = I(Data, o + 12);
            if (flags != 0) { Console.WriteLine($"  game lump {id} is compressed: skipped"); return null; }
            if (fo < 0 || fl < 0 || (long)fo + fl > Data.Length) return null;
            return (ver, Data.AsSpan(fo, fl).ToArray());
        }
        return null;
    }

    T[] Array<T>(int lump, int size, Func<int, T> read)
    {
        var (ofs, len) = Lumps[lump];
        var n = len / size;
        var a = new T[n];
        for (var i = 0; i < n; i++) a[i] = read(ofs + i * size);
        return a;
    }

    internal static float F(byte[] d, int o) => BitConverter.ToSingle(d, o);
    internal static int I(byte[] d, int o) => BitConverter.ToInt32(d, o);
    internal static int U16(byte[] d, int o) => BitConverter.ToUInt16(d, o);
    internal static int S16(byte[] d, int o) => BitConverter.ToInt16(d, o);
    internal static Vector3 V3(byte[] d, int o) => new(F(d, o), F(d, o + 4), F(d, o + 8));
    static Vector4 V4(byte[] d, int o) => new(F(d, o), F(d, o + 4), F(d, o + 8), F(d, o + 12));
}
