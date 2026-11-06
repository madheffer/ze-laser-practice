// Source 1 binary DMX (the container .pcf particle files use): "<!-- dmx encoding binary N format pcf M -->\n\0", a
// string table, the elements (type, name, id) and then each element's attributes. Read from the encoder's layout
// (dmserializerbinary): from version 2 a string table holds element types and attribute names, its count and indices
// int16 below version 4 and int32 from it (CS:GO's error.pcf is version 2, its other files 5); from version 4 element names are table indices too, and from version 5
// single string attribute values (arrays of strings stay inline). Attribute types are DmAttributeType_t: 1 element
// (an index, -1 none, -2 an external id string), 2 int, 3 float, 4 bool, 5 string, 6 binary, 7 time (int / 10000),
// 8 color (4 bytes), 9-11 vector2/3/4, 12 qangle, 13 quaternion, 14 matrix; 15-28 the arrays of 1-14.
// Data only: counts are checked against the bytes left, nothing is executed.
using System.Text;

namespace Lasers.Bake.Source1;

sealed class DmxElement
{
    public string Type = "", Name = "";
    public readonly Dictionary<string, object?> Attr = new(StringComparer.OrdinalIgnoreCase);

    public object? this[string k] => Attr.TryGetValue(k, out var v) ? v : null;
    public List<DmxElement> Elements(string k) => this[k] is List<object?> l ? l.OfType<DmxElement>().ToList() : [];
}

static class Dmx
{
    public static (int version, List<DmxElement> elements) Read(byte[] b)
    {
        var nl = Array.IndexOf(b, (byte)'\n');
        if (nl < 0 || nl > 200) throw new InvalidDataException("not a DMX file");
        var header = Encoding.ASCII.GetString(b, 0, nl);
        var at = header.IndexOf("binary ", StringComparison.Ordinal);
        if (at < 0) throw new InvalidDataException($"not binary DMX: {header}");
        var ver = int.Parse(header[(at + 7)..].Split(' ')[0]);
        if (ver < 2 || ver > 5) throw new InvalidDataException($"DMX binary version {ver} not read");
        var p = nl + 1;
        if (p < b.Length && b[p] == 0) p++;

        int I32() { if (p + 4 > b.Length) throw new EndOfStreamException(); var v = BitConverter.ToInt32(b, p); p += 4; return v; }
        string Cstr() { var e = Array.IndexOf(b, (byte)0, p); if (e < 0) throw new EndOfStreamException(); var s = Encoding.Latin1.GetString(b, p, e - p); p = e + 1; return s; }
        int count;
        if (ver >= 4) count = I32(); else { count = BitConverter.ToInt16(b, p); p += 2; }
        if (count < 0 || count > b.Length) throw new InvalidDataException("bad string table");
        var table = new string[count];
        for (var i = 0; i < count; i++) table[i] = Cstr();
        int Idx() { int v; if (ver >= 4) v = I32(); else { v = BitConverter.ToInt16(b, p); p += 2; } return v; }
        string Str() { var i = Idx(); return i >= 0 && i < table.Length ? table[i] : ""; }

        var n = I32();
        if (n < 0 || n > b.Length / 16) throw new InvalidDataException("bad element count");
        var els = new List<DmxElement>(n);
        for (var i = 0; i < n; i++)
        {
            var e = new DmxElement { Type = Str() };
            e.Name = ver >= 4 ? Str() : Cstr();
            p += 16; // the element id
            els.Add(e);
        }
        var refs = new List<(DmxElement e, string k, int idx, List<object?>? list, int slot)>();
        object? Value(int t, bool inArray, DmxElement owner, string key, List<object?>? list, int slot)
        {
            switch (t)
            {
                case 1:
                    var i = I32();
                    if (i == -2) { Cstr(); return null; }
                    if (i >= 0) refs.Add((owner, key, i, list, slot));
                    return null;
                case 2: return I32();
                case 3: { var v = BitConverter.ToSingle(b, p); p += 4; return v; }
                case 4: return b[p++] != 0;
                case 5: return ver >= 5 && !inArray ? Str() : Cstr();
                case 6: { var len = I32(); if (len < 0 || p + len > b.Length) throw new EndOfStreamException(); var v = b[p..(p + len)]; p += len; return v; }
                case 7: return I32() / 10000.0;
                case 8: { var v = new[] { (int)b[p], b[p + 1], b[p + 2], b[p + 3] }; p += 4; return v; }
                case 9: case 10: case 11: case 12: case 13: case 14:
                    {
                        var c = t switch { 9 => 2, 10 => 3, 12 => 3, 14 => 16, _ => 4 };
                        if (p + c * 4 > b.Length) throw new EndOfStreamException();
                        var v = new float[c];
                        for (var k = 0; k < c; k++) v[k] = BitConverter.ToSingle(b, p + k * 4);
                        p += c * 4;
                        return v;
                    }
                default: throw new InvalidDataException($"DMX attribute type {t}");
            }
        }
        foreach (var e in els)
        {
            var na = I32();
            if (na < 0 || na > 100000) throw new InvalidDataException("bad attribute count");
            for (var a = 0; a < na; a++)
            {
                var key = Str();
                var t = b[p++];
                if (t >= 15 && t <= 28)
                {
                    var c = I32();
                    if (c < 0 || c > b.Length - p) throw new InvalidDataException("bad array length");
                    var list = new List<object?>(c);
                    for (var k = 0; k < c; k++) list.Add(Value(t - 14, true, e, key, list, k));
                    e.Attr[key] = list;
                }
                else e.Attr[key] = Value(t, false, e, key, null, 0);
            }
        }
        foreach (var (e, k, idx, list, slot) in refs)
        {
            if (idx >= els.Count) continue;
            if (list != null) list[slot] = els[idx];
            else e.Attr[k] = els[idx];
        }
        return (ver, els);
    }
}
