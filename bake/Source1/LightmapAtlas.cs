// Every lit face's baked lightmap (style 0; a bumped face's first, flat one) packed into one atlas, as Source keeps
// them in its lightmap pages: (w+1) x (h+1) luxels per face, ColorRGBExp32 (c * 2^exp / 255, linear light, 1 = the
// texture as authored). Written RGBM (rgb * a * Range, linear, 8-bit PNG) beside each glb that uses it; FaceMesh
// gives each vertex its atlas UV (TEXCOORD_1) and the renderer multiplies the texture by the decoded light
// (world/source1-light.js). Faces with no lightmap (unlit, fullbright) sample a white luxel = L 1.
using SkiaSharp;

namespace Lasers.Bake.Source1;

sealed class LightmapAtlas
{
    public const float Range = 8; // RGBM's multiplier: lightmaps sit well under it (Sample caps at 4 too)
    const int Pad = 1;
    public int Size;
    public readonly Dictionary<int, (int X, int Y)> Origin = [];
    public (int X, int Y) White;
    float[] px = [];

    public static LightmapAtlas Build(Bsp bsp)
    {
        var a = new LightmapAtlas();
        var faces = new List<int>();
        for (var f = 0; f < bsp.Faces.Length; f++)
        {
            var fc = bsp.Faces[f];
            if (fc.LightOfs < 0 || fc.Style0 == 255 || fc.LmW < 0 || fc.LmH < 0 || fc.LmW > 256 || fc.LmH > 256) continue;
            if ((long)fc.LightOfs + (fc.LmW + 1) * (fc.LmH + 1) * 4 > bsp.Lighting.Length) continue;
            faces.Add(f);
        }
        // shelf packing, tallest first; grow the square until everything fits
        faces.Sort((x, y) => (bsp.Faces[y].LmH).CompareTo(bsp.Faces[x].LmH));
        for (a.Size = 512; a.Size <= 8192; a.Size *= 2)
        {
            a.Origin.Clear();
            int x = 0, y = 0, shelf = 0;
            var ok = true;
            foreach (var f in faces)
            {
                int w = bsp.Faces[f].LmW + 1 + Pad * 2, h = bsp.Faces[f].LmH + 1 + Pad * 2;
                if (x + w > a.Size) { x = 0; y += shelf; shelf = 0; }
                if (y + h > a.Size) { ok = false; break; }
                a.Origin[f] = (x + Pad, y + Pad);
                x += w; shelf = Math.Max(shelf, h);
            }
            if (!ok) continue;
            if (x + 3 > a.Size) { x = 0; y += shelf; shelf = 0; }
            if (y + 3 > a.Size) continue;
            a.White = (x + 1, y + 1);
            break;
        }
        if (a.Size > 8192) throw new InvalidDataException("lightmaps do not fit an 8192 atlas");

        var n = a.Size;
        a.px = new float[n * n * 3];
        foreach (var (f, (ox, oy)) in a.Origin)
        {
            var fc = bsp.Faces[f];
            int w = fc.LmW + 1, h = fc.LmH + 1;
            // the padding repeats the edge luxels so bilinear filtering never reaches a neighbour
            for (var y = -Pad; y < h + Pad; y++)
                for (var x = -Pad; x < w + Pad; x++)
                {
                    int sx = Math.Clamp(x, 0, w - 1), sy = Math.Clamp(y, 0, h - 1);
                    var o = fc.LightOfs + (sy * w + sx) * 4;
                    var e = MathF.Pow(2, (sbyte)bsp.Lighting[o + 3]) / 255f;
                    var p = ((oy + y) * n + ox + x) * 3;
                    a.px[p] = bsp.Lighting[o] * e; a.px[p + 1] = bsp.Lighting[o + 1] * e; a.px[p + 2] = bsp.Lighting[o + 2] * e;
                }
        }
        for (var y = -1; y <= 1; y++)
            for (var x = -1; x <= 1; x++) { var p = ((a.White.Y + y) * n + a.White.X + x) * 3; a.px[p] = a.px[p + 1] = a.px[p + 2] = 1; }
        return a;
    }

    public byte[] Png()
    {
        var n = Size;
        var info = new SKImageInfo(n, n, SKColorType.Rgba8888, SKAlphaType.Unpremul);
        using var bmp = new SKBitmap(info);
        var bytes = new byte[n * n * 4];
        for (var i = 0; i < n * n; i++)
        {
            float r = Math.Min(px[i * 3], Range), g = Math.Min(px[i * 3 + 1], Range), b = Math.Min(px[i * 3 + 2], Range);
            var m = Math.Clamp(MathF.Ceiling(Math.Max(Math.Max(r, g), Math.Max(b, 1e-4f)) / Range * 255), 1, 255) / 255f;
            bytes[i * 4] = (byte)Math.Clamp(MathF.Round(r / (m * Range) * 255), 0, 255);
            bytes[i * 4 + 1] = (byte)Math.Clamp(MathF.Round(g / (m * Range) * 255), 0, 255);
            bytes[i * 4 + 2] = (byte)Math.Clamp(MathF.Round(b / (m * Range) * 255), 0, 255);
            bytes[i * 4 + 3] = (byte)MathF.Round(m * 255);
        }
        System.Runtime.InteropServices.Marshal.Copy(bytes, 0, bmp.GetPixels(), bytes.Length);
        using var img = SKImage.FromBitmap(bmp);
        using var data = img.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    // a face's luxel (s, t) -> atlas UV; faces outside the atlas get the white luxel
    public System.Numerics.Vector2 Uv(int face, float s, float t)
    {
        if (!Origin.TryGetValue(face, out var o)) return new((White.X + 0.5f) / Size, (White.Y + 0.5f) / Size);
        return new((o.X + s + 0.5f) / Size, (o.Y + t + 0.5f) / Size);
    }
}
