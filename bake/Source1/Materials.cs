// Source 1 materials -> glTF materials + PNGs: the VMT's $basetexture (WorldVertexTransition: its first layer),
// alpha from $translucent / $additive (blend) and $alphatest (mask at $alphatestreference), $nocull, $color / $alpha.
// Each texture is decoded once and written (capped at Baker.MaxTexture px) into whichever folder a glb needs it in.
using System.Globalization;
using System.Numerics;
using SkiaSharp;

namespace Lasers.Bake.Source1;

sealed class Materials(GameFiles files, Action<string> log)
{
    public sealed record Info(string Name, string? Texture, string AlphaMode, float Cutoff, bool DoubleSided, Vector4 Color, int Width, int Height, bool Tool, bool Additive);

    readonly Dictionary<string, Info> cache = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, byte[]?> png = new(StringComparer.OrdinalIgnoreCase);
    public readonly SortedSet<string> Missing = new(StringComparer.OrdinalIgnoreCase);

    public Info Get(string material)
    {
        var key = GameFiles.Norm(material);
        if (cache.TryGetValue(key, out var hit)) return hit;
        var vmt = Vmt.Load(files, key);
        if (vmt == null) Missing.Add($"materials/{key}.vmt");
        var tex = vmt?.Get("$basetexture")?.Replace('\\', '/').Trim();
        int w = 0, h = 0;
        string? file = null;
        if (!string.IsNullOrEmpty(tex))
        {
            var bytes = Png(tex, out w, out h);
            if (bytes != null) file = FileName(tex);
            else Missing.Add($"materials/{GameFiles.Norm(tex)}.vtf");
        }
        // additive: $additive, or a Sprite material drawn in an additive sprite render mode (glow 3, add 5,
        // add-frameblend 7, alpha-add 8, world glow 9: Source's kRender* values). ze_ffvii_malgo_reactor's lasers are
        // brushes textured with sprites/bluelaser1 ($spriterendermode 5)
        var spriteMode = (int)(vmt?.Num("$spriterendermode", 0) ?? 0);
        var additive = vmt != null && (vmt.Flag("$additive") || (vmt.Shader == "sprite" && spriteMode is 3 or 5 or 7 or 8 or 9));
        var translucent = vmt != null && (vmt.Flag("$translucent") || additive);
        var alphaTest = vmt != null && vmt.Flag("$alphatest");
        var color = Vector3.One;
        if (vmt?.Get("$color") is { } c) color = Color(c);
        var alpha = vmt?.Num("$alpha", 1) ?? 1;
        var shader = vmt?.Shader ?? "";
        if (file == null && shader.Contains("water")) { color = new Vector3(0.2f, 0.3f, 0.35f); alpha = 0.6f; translucent = true; }
        var info = new Info(key, file, translucent || alpha < 1 ? "BLEND" : alphaTest ? "MASK" : "OPAQUE",
            vmt?.Num("$alphatestreference", 0.5f) ?? 0.5f, vmt?.Flag("$nocull") == true || translucent,
            new Vector4(color, alpha), w, h, key.StartsWith("tools/") && key != "tools/toolsblack", additive);
        cache[key] = info;
        return info;
    }

    // write the material's PNG into dir (once per dir); false when it has none
    public void WriteImage(Info m, string dir)
    {
        if (m.Texture == null) return;
        var path = Path.Combine(dir, m.Texture);
        if (File.Exists(path)) return;
        var bytes = png.GetValueOrDefault(TexKeyOf(m.Texture));
        if (bytes != null) File.WriteAllBytes(path, bytes);
    }

    readonly Dictionary<string, string> fileToTex = [];
    string TexKeyOf(string file) => fileToTex.GetValueOrDefault(file, "");

    byte[]? Png(string tex, out int w, out int h)
    {
        w = h = 0;
        var key = GameFiles.Norm(tex);
        var raw = files.Read($"materials/{key}.vtf");
        if (raw == null) return null;
        var img = Vtf.Decode(raw);
        if (img == null) { log($"  texture {key}: unsupported VTF"); return null; }
        w = img.Width; h = img.Height;
        if (png.TryGetValue(key, out var done)) return done;
        var info = new SKImageInfo(img.Width, img.Height, SKColorType.Rgba8888, SKAlphaType.Unpremul);
        using var bmp = new SKBitmap(info);
        System.Runtime.InteropServices.Marshal.Copy(img.Rgba, 0, bmp.GetPixels(), img.Rgba.Length);
        var max = Baker.MaxTexture;
        SKBitmap outBmp = bmp;
        if (img.Width > max || img.Height > max)
        {
            var s = (float)max / Math.Max(img.Width, img.Height);
            outBmp = bmp.Resize(new SKImageInfo(Math.Max(1, (int)(img.Width * s)), Math.Max(1, (int)(img.Height * s)), SKColorType.Rgba8888, SKAlphaType.Unpremul),
                new SKSamplingOptions(SKCubicResampler.Mitchell));
        }
        using var image = SKImage.FromBitmap(outBmp);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        var bytes = data.ToArray();
        if (outBmp != bmp) outBmp.Dispose();
        png[key] = bytes;
        fileToTex[FileName(tex)] = key;
        return bytes;
    }

    // a texture path as one safe file name (letters, digits, _): "metal/metalwall01a" -> "metal_metalwall01a.png"
    static string FileName(string tex)
    {
        var s = new string(GameFiles.Norm(tex).Select(ch => char.IsAsciiLetterOrDigit(ch) ? ch : '_').ToArray());
        if (s.Length > 100) s = s[..80] + "_" + Fnv(s).ToString("x8");
        return s + ".png";
    }

    static uint Fnv(string s) { var h = 2166136261u; foreach (var ch in s) h = (h ^ ch) * 16777619u; return h; }

    static Vector3 Color(string s)
    {
        var t = s.Trim().Trim('[', '{', ']', '}').Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var v = new float[3] { 1, 1, 1 };
        for (var i = 0; i < 3 && i < t.Length; i++) float.TryParse(t[i], NumberStyles.Float, CultureInfo.InvariantCulture, out v[i]);
        var braces = s.Contains('{');
        return braces ? new Vector3(v[0], v[1], v[2]) / 255 : new Vector3(v[0], v[1], v[2]);
    }
}
