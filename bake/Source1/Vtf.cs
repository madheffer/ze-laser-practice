// Source 1 textures (VTF 7.0-7.5) -> RGBA8: the top mip of the first frame and face. Formats are the SDK's
// ImageFormat enum (public/bitmap/imageformat.h); DXT1/3/5 decoded per the S3TC spec. Sizes and offsets come from
// the file: anything that would read past its end, or claims a side over MaxSide, is refused (null).
namespace Lasers.Bake.Source1;

static class Vtf
{
    const int MaxSide = 8192;

    public sealed record Image(int Width, int Height, byte[] Rgba, bool HasAlpha);

    public static Image? Decode(byte[] d)
    {
        if (d.Length < 64 || d[0] != 'V' || d[1] != 'T' || d[2] != 'F' || d[3] != 0) return null;
        int minor = BitConverter.ToInt32(d, 8), headerSize = BitConverter.ToInt32(d, 12);
        int w = BitConverter.ToUInt16(d, 16), h = BitConverter.ToUInt16(d, 18);
        uint flags = BitConverter.ToUInt32(d, 20);
        int frames = Math.Max(1, (int)BitConverter.ToUInt16(d, 24));
        int firstFrame = BitConverter.ToUInt16(d, 26);
        int fmt = BitConverter.ToInt32(d, 52), mips = d[56], lowFmt = BitConverter.ToInt32(d, 57);
        int lowW = d[61], lowH = d[62];
        int depth = minor >= 2 && d.Length > 65 ? Math.Max(1, (int)BitConverter.ToUInt16(d, 63)) : 1;
        if (w == 0 || h == 0 || w > MaxSide || h > MaxSide || mips == 0 || mips > 16 || depth > 64) return null;
        var faces = (flags & 0x4000) != 0 ? (minor < 5 && firstFrame != 0xffff ? 7 : 6) : 1;

        long start = -1;
        if (minor >= 3 && d.Length >= 80)
        {
            var n = BitConverter.ToInt32(d, 68);
            for (var i = 0; i < n && 80 + i * 8 + 8 <= d.Length && i < 32; i++)
            {
                var o = 80 + i * 8;
                if (d[o] == 0x30 && d[o + 1] == 0 && d[o + 2] == 0) start = BitConverter.ToUInt32(d, o + 4);
            }
        }
        if (start < 0) start = headerSize + (lowFmt >= 0 && lowW > 0 ? Size(lowFmt, lowW, lowH) : 0);
        // mips are stored smallest first: skip every smaller mip's frames x faces x slices
        for (var m = mips - 1; m >= 1; m--)
            start += (long)Size(fmt, Math.Max(1, w >> m), Math.Max(1, h >> m)) * frames * faces * Math.Max(1, depth >> m);
        var len = Size(fmt, w, h);
        if (len <= 0 || start < 0 || start + len > d.Length) return null;
        var rgba = ToRgba(fmt, d.AsSpan((int)start, len), w, h);
        if (rgba == null) return null;
        var alpha = fmt is 0 or 1 or 6 or 8 or 11 or 12 or 14 or 15 or 19 or 20 or 21;
        return new Image(w, h, rgba, alpha);
    }

    static int Size(int fmt, int w, int h) => fmt switch
    {
        13 or 20 => Math.Max(1, (w + 3) / 4) * Math.Max(1, (h + 3) / 4) * 8,
        14 or 15 => Math.Max(1, (w + 3) / 4) * Math.Max(1, (h + 3) / 4) * 16,
        0 or 1 or 11 or 12 or 16 or 23 or 26 => w * h * 4,
        2 or 3 or 9 or 10 => w * h * 3,
        4 or 6 or 17 or 18 or 19 or 21 or 22 => w * h * 2,
        5 or 7 or 8 => w * h,
        24 or 25 => w * h * 8,
        _ => -1,
    };

    static byte[]? ToRgba(int fmt, ReadOnlySpan<byte> s, int w, int h)
    {
        var o = new byte[w * h * 4];
        var n = w * h;
        switch (fmt)
        {
            case 0: s[..(n * 4)].CopyTo(o); break; // RGBA8888
            case 1: for (var i = 0; i < n; i++) Set(o, i, s[i * 4 + 3], s[i * 4 + 2], s[i * 4 + 1], s[i * 4]); break; // ABGR
            case 2: case 9: for (var i = 0; i < n; i++) Set(o, i, s[i * 3], s[i * 3 + 1], s[i * 3 + 2], 255); break;
            case 3: case 10: for (var i = 0; i < n; i++) Set(o, i, s[i * 3 + 2], s[i * 3 + 1], s[i * 3], 255); break;
            case 11: for (var i = 0; i < n; i++) Set(o, i, s[i * 4 + 1], s[i * 4 + 2], s[i * 4 + 3], s[i * 4]); break; // ARGB
            case 12: for (var i = 0; i < n; i++) Set(o, i, s[i * 4 + 2], s[i * 4 + 1], s[i * 4], s[i * 4 + 3]); break; // BGRA
            case 16: for (var i = 0; i < n; i++) Set(o, i, s[i * 4 + 2], s[i * 4 + 1], s[i * 4], 255); break; // BGRX
            case 5: for (var i = 0; i < n; i++) Set(o, i, s[i], s[i], s[i], 255); break; // I8
            case 6: for (var i = 0; i < n; i++) Set(o, i, s[i * 2], s[i * 2], s[i * 2], s[i * 2 + 1]); break; // IA88
            case 8: for (var i = 0; i < n; i++) Set(o, i, 255, 255, 255, s[i]); break; // A8
            case 4: case 17:
                for (var i = 0; i < n; i++)
                {
                    var v = s[i * 2] | s[i * 2 + 1] << 8;
                    byte a = (byte)((v >> 11 & 31) * 255 / 31), g = (byte)((v >> 5 & 63) * 255 / 63), b = (byte)((v & 31) * 255 / 31);
                    if (fmt == 4) Set(o, i, b, g, a, 255); else Set(o, i, a, g, b, 255); // RGB565 is stored B-low in VTF's sense
                }
                break;
            case 19:
                for (var i = 0; i < n; i++)
                {
                    var v = s[i * 2] | s[i * 2 + 1] << 8;
                    Set(o, i, (byte)((v >> 8 & 15) * 17), (byte)((v >> 4 & 15) * 17), (byte)((v & 15) * 17), (byte)((v >> 12 & 15) * 17));
                }
                break;
            case 18: case 21:
                for (var i = 0; i < n; i++)
                {
                    var v = s[i * 2] | s[i * 2 + 1] << 8;
                    Set(o, i, (byte)((v >> 10 & 31) * 255 / 31), (byte)((v >> 5 & 31) * 255 / 31), (byte)((v & 31) * 255 / 31), fmt == 21 && (v & 0x8000) == 0 ? (byte)0 : (byte)255);
                }
                break;
            case 22: for (var i = 0; i < n; i++) Set(o, i, s[i * 2], s[i * 2 + 1], 255, 255); break; // UV88 (a normal map's xy)
            case 23: case 26: s[..(n * 4)].CopyTo(o); break;
            case 24:
                for (var i = 0; i < n; i++)
                {
                    // linear HDR halves -> sRGB bytes, clipped at 1
                    var c = new byte[3];
                    for (var k = 0; k < 3; k++)
                        c[k] = (byte)Math.Clamp(Math.Pow(Math.Clamp((float)BitConverter.ToHalf(s.Slice(i * 8 + k * 2, 2)), 0, 1), 1 / 2.2) * 255, 0, 255);
                    Set(o, i, c[0], c[1], c[2], 255);
                }
                break;
            case 13: case 20: Dxt(s, w, h, o, 1); break;
            case 14: Dxt(s, w, h, o, 3); break;
            case 15: Dxt(s, w, h, o, 5); break;
            default: return null;
        }
        return o;
    }

    static void Set(byte[] o, int i, byte r, byte g, byte b, byte a) { o[i * 4] = r; o[i * 4 + 1] = g; o[i * 4 + 2] = b; o[i * 4 + 3] = a; }

    static void Dxt(ReadOnlySpan<byte> s, int w, int h, byte[] o, int kind)
    {
        int bw = Math.Max(1, (w + 3) / 4), bh = Math.Max(1, (h + 3) / 4), bs = kind == 1 ? 8 : 16;
        var pal = new byte[16];
        Span<byte> alpha = stackalloc byte[16];
        for (var by = 0; by < bh; by++)
            for (var bx = 0; bx < bw; bx++)
            {
                var blk = s.Slice((by * bw + bx) * bs, bs);
                var col = kind == 1 ? blk : blk[8..];
                alpha.Fill(255);
                if (kind == 3)
                    for (var i = 0; i < 16; i++) alpha[i] = (byte)((blk[i / 2] >> (i % 2 * 4) & 15) * 17);
                else if (kind == 5)
                {
                    int a0 = blk[0], a1 = blk[1];
                    ulong bits = 0;
                    for (var i = 0; i < 6; i++) bits |= (ulong)blk[2 + i] << (8 * i);
                    for (var i = 0; i < 16; i++)
                    {
                        var c = (int)(bits >> (3 * i) & 7);
                        alpha[i] = (byte)(c == 0 ? a0 : c == 1 ? a1 : a0 > a1 ? ((8 - c) * a0 + (c - 1) * a1) / 7
                            : c == 6 ? 0 : c == 7 ? 255 : ((6 - c) * a0 + (c - 1) * a1) / 5);
                    }
                }
                int c0 = col[0] | col[1] << 8, c1 = col[2] | col[3] << 8;
                void Rgb(int c, int k) { pal[k * 4] = (byte)((c >> 11 & 31) * 255 / 31); pal[k * 4 + 1] = (byte)((c >> 5 & 63) * 255 / 63); pal[k * 4 + 2] = (byte)((c & 31) * 255 / 31); pal[k * 4 + 3] = 255; }
                Rgb(c0, 0); Rgb(c1, 1);
                var four = c0 > c1 || kind != 1;
                for (var ch = 0; ch < 3; ch++)
                {
                    pal[8 + ch] = (byte)(four ? (2 * pal[ch] + pal[4 + ch]) / 3 : (pal[ch] + pal[4 + ch]) / 2);
                    pal[12 + ch] = (byte)(four ? (pal[ch] + 2 * pal[4 + ch]) / 3 : 0);
                }
                pal[11] = 255; pal[15] = (byte)(four ? 255 : 0);
                var idx = (uint)(col[4] | col[5] << 8 | col[6] << 16 | col[7] << 24);
                for (var i = 0; i < 16; i++)
                {
                    int x = bx * 4 + i % 4, y = by * 4 + i / 4;
                    if (x >= w || y >= h) continue;
                    var k = (int)(idx >> (2 * i) & 3);
                    var p = (y * w + x) * 4;
                    o[p] = pal[k * 4]; o[p + 1] = pal[k * 4 + 1]; o[p + 2] = pal[k * 4 + 2];
                    o[p + 3] = kind == 1 ? pal[k * 4 + 3] : alpha[i];
                }
            }
    }
}
