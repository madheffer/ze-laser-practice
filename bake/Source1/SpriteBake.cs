// A Source 1 map's env_sprite / env_glow sprites (and env_smoketrail's puff materials) -> sprites/<name>.png +
// sprites/sprites.json, which the player draws (web/src/world/sprites-source1.js, smoketrail-source1.js):
//   sprites.json   { "<model as the entity names it, lower case>": { file, width, height, orientation } }
// An entity names a sprite material ("sprites/glow.vmt") or an old sprite file ("sprites/glow01.spr"), which Source's
// model loader opens as the material of the same name (materials/sprites/glow01.vmt). width / height are the
// material's texture size in texels, the size Source draws a sprite at scale 1 (one texel a unit). orientation is the
// Sprite shader's $spriteorientation (vp_parallel when unset: facing the view). The first frame of an animated
// sprite's texture is baked (UNSETTLED: the player doesn't animate sprite frames). Names are the map's data: files are
// written under cleaned names.
using System.Text.Json.Nodes;

namespace Lasers.Bake.Source1;

static class SpriteBake
{
    const int MaxSide = 512, MaxSprites = 512;
    static readonly HashSet<string> Classes = new(StringComparer.OrdinalIgnoreCase) { "env_sprite", "env_glow", "env_sprite_oriented" };
    // the client's dust puff materials (g_Mat_DustPuff: c_smoke_trail.cpp), which env_smoketrail's particles use
    public static readonly string[] SmokeTrailMaterials = ["particle/particle_smokegrenade.vmt", "particle/particle_noisesphere.vmt"];

    public static int Bake(JsonObject lumps, GameFiles files, string outDir, Action<string> log)
    {
        var names = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (_, arr) in lumps)
            foreach (var d in arr?.AsArray() ?? [])
            {
                if (d?["kv"] is not JsonObject kv || names.Count >= MaxSprites) continue;
                var cls = kv["classname"]?.GetValue<string>() ?? "";
                if (Classes.Contains(cls) && kv["model"]?.GetValue<string>() is { Length: > 0 } m) names.Add(GameFiles.Norm(m));
                // env_smoketrail's puffs: C_SmokeTrail draws them with g_Mat_DustPuff[0 / 1], not its smokesprite keyvalue
                if (cls.Equals("env_smoketrail", StringComparison.OrdinalIgnoreCase)) foreach (var p in SmokeTrailMaterials) names.Add(p);
            }
        var dir = Path.Combine(outDir, "sprites");
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
        var index = new JsonObject();
        foreach (var name in names)
        {
            var mat = name.StartsWith("materials/") ? name["materials/".Length..] : name;
            if (mat.EndsWith(".vmt") || mat.EndsWith(".spr")) mat = mat[..^4];
            var vmt = Vmt.Load(files, mat);
            var tex = vmt?.Get("$basetexture")?.Replace('\\', '/').Trim();
            if (string.IsNullOrEmpty(tex)) { log($"  sprite {name}: no material"); continue; }
            var t = GameFiles.Norm(tex);
            if (t.EndsWith(".vtf")) t = t[..^4];
            if (files.Read($"materials/{t}.vtf") is not { } raw || Vtf.Decode(raw) is not { } img) { log($"  sprite {name}: texture materials/{t}.vtf missing"); continue; }
            var file = new string(mat.Select(c => char.IsAsciiLetterOrDigit(c) ? c : '_').ToArray()) + ".png";
            var rel = SafePath.Rel("sprites/" + file);
            if (rel == null) continue;
            File.WriteAllBytes(SafePath.OutFile(outDir, rel), Materials.EncodePng(img, MaxSide));
            index[name] = new JsonObject
            {
                ["file"] = file, ["width"] = img.Width, ["height"] = img.Height,
                ["orientation"] = (vmt!.Get("$spriteorientation") ?? "vp_parallel").Trim().ToLowerInvariant(),
            };
        }
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "sprites.json"), index.ToJsonString());
        log($"sprites: {index.Count} of {names.Count}");
        return index.Count;
    }
}
