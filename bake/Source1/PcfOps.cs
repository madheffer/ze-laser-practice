// One Source 1 particle function (a .pcf's DmeParticleOperator: "functionName" + its attributes) -> the CS2 class the
// player's runtime (web/src/fx/particles, particles.dll's own classes) runs for it, as a compiled .vpcf would hold it:
// only the fields that differ from the class default (the runtime fills the rest from particles.dll's defaults).
// CS2's particles are Source 1's grown up: each class here is the one Source 1's function became, with the same
// parameters under m_ names (Lifespan Decay -> C_OP_Decay, Position Within Sphere Random ->
// C_INIT_CreateWithinSphereTransform, render_animated_sprites -> C_OP_RenderSprites, ...). Where CS2 folded several
// initializers into one (Lifetime / Radius / Alpha / Rotation / Trail Length Random -> C_INIT_InitFloat on that particle
// field), the random draw is a float input: uniform, or biased exponentially by Source's random exponent
// (pow(r, e): PF_BIAS_TYPE_EXPONENTIAL's parameter is 1 - e for e <= 1, (20 - e) / 19 - 1 above).
// A .pcf stores only the attributes an author changed, so each function's Source 1 defaults are written out below
// (the DMXELEMENT_UNPACK_FIELD defaults of Source's particle_ops). Old names are renamed first as Source's
// RemapOperatorName table does ("lifespan_decay" -> "Lifespan Decay"). A function with no CS2 counterpart here is
// skipped and reported (the caller logs it), as Source itself skips a function it doesn't know.
using System.Text.Json.Nodes;

namespace Lasers.Bake.Source1;

static class PcfOps
{
    // particles.cpp's s_RemapOperatorNameTable (the names Source 1 accepted before the rename)
    static readonly Dictionary<string, string> Renamed = new(StringComparer.OrdinalIgnoreCase)
    {
        ["alpha_fade"] = "Alpha Fade and Decay", ["alpha_fade_in_random"] = "Alpha Fade In Random", ["alpha_fade_out_random"] = "Alpha Fade Out Random",
        ["basic_movement"] = "Movement Basic", ["color_fade"] = "Color Fade", ["Dampen Movement Relative to Control Point"] = "Movement Dampen Relative to Control Point",
        ["Distance to Control Points Scale"] = "Remap Distance to Control Point to Scalar", ["lifespan_decay"] = "Lifespan Decay",
        ["postion_lock_to_controlpoint"] = "Movement Lock to Control Point", ["noise"] = "Noise Scalar", ["vector noise"] = "Noise Vector",
        ["oscillate_scalar"] = "Oscillate Scalar", ["oscillate_vector"] = "Oscillate Vector", ["radius_scale"] = "Radius Scale",
        ["rotation_movement"] = "Rotation Basic", ["rotation_spin"] = "Rotation Spin Roll", ["alpha_random"] = "Alpha Random",
        ["color_random"] = "Color Random", ["create from parent particles"] = "Position From Parent Particles",
        ["sequential position along path"] = "Position Along Path Sequential", ["position_offset_random"] = "Position Modify Offset Random",
        ["position_warp_random"] = "Position Modify Warp Random", ["position_within_box"] = "Position Within Box Random",
        ["position_within_sphere"] = "Position Within Sphere Random", ["Initial Repulsion Velocity"] = "Velocity Repulse from World",
        ["Initial Velocity Noise"] = "Velocity Noise", ["Initial Scalar Noise"] = "Remap Noise to Scalar", ["Pre-Age Noise"] = "Lifetime Pre-Age Noise",
        ["lifetime_random"] = "Lifetime Random", ["radius_random"] = "Radius Random", ["Randomly Flip Yaw"] = "Rotation Yaw Flip Random",
        ["rotation_random"] = "Rotation Random", ["rotationspeed_random"] = "Rotation Speed Random", ["sequence_random"] = "Sequence Random",
        ["second_sequence_random"] = "Sequence Two Random", ["trail_length_random"] = "Trail Length Random", ["velocity_random"] = "Velocity Random",
        ["remap initial scalar"] = "Remap Initial Scalar", ["lifetime from sequence"] = "Lifetime From Sequence",
    };

    const double Deg = Math.PI / 180;

    /// What a renderer needs from the system's material (Source1Particles reads the .vmt and bakes the texture)
    public sealed record Material(string? Texture, int Height, bool Additive, double Overbright, double AddSelf,
        double? MinSize, double? MaxSize, double? StartFade, double? EndFade, double? DepthBlend);

    // a function's attributes with Source 1's defaults
    sealed class A(DmxElement e)
    {
        public double F(string k, double d) => e[k] switch { float f => f, int i => i, bool b => b ? 1 : 0, double x => x, _ => d };
        public int I(string k, int d) => e[k] switch { int i => i, float f => (int)f, bool b => b ? 1 : 0, _ => d };
        public bool B(string k, bool d) => e[k] switch { bool b => b, int i => i != 0, float f => f != 0, _ => d };
        public string S(string k, string d) => e[k] as string ?? d;
        public double[] V(string k, params double[] d) => e[k] is float[] v && v.Length >= 3 ? [v[0], v[1], v[2]] : d;
        public int[] C(string k, params int[] d) => e[k] is int[] c && c.Length == 4 ? c : d;
    }

    static JsonArray Arr(params double[] v) => new([.. v.Select(x => (JsonNode)Math.Round(x, 6))]);
    static JsonArray Rgb(int[] c) => new(c[0], c[1], c[2]);

    // a float input drawn in [lo, hi] with Source's random exponent; a plain number when it can't vary
    static JsonNode Rand(double lo, double hi, double exp)
    {
        if (lo == hi || exp == 0) return Math.Round(exp == 0 ? hi : lo, 6);
        var o = new JsonObject { ["m_nType"] = exp == 1 ? "PF_TYPE_RANDOM_UNIFORM" : "PF_TYPE_RANDOM_BIASED", ["m_flRandomMin"] = Math.Round(lo, 6), ["m_flRandomMax"] = Math.Round(hi, 6) };
        if (exp != 1)
        {
            o["m_nBiasType"] = "PF_BIAS_TYPE_EXPONENTIAL";
            o["m_flBiasParameter"] = Math.Round(exp <= 1 ? 1 - exp : Math.Max(-1, (20 - exp) / 19 - 1), 6);
        }
        return o;
    }
    static JsonObject InitFloat(int field, JsonNode value) => new() { ["_class"] = "C_INIT_InitFloat", ["m_InputValue"] = value, ["m_nOutputField"] = field };
    static JsonObject Cp(int cp) => new() { ["m_nType"] = "PT_TYPE_CONTROL_POINT", ["m_nControlPoint"] = cp };

    /// The CS2 function for one Source 1 function, or null (unknown: reported through `skipped`)
    public static JsonObject? Convert(DmxElement op, Func<string, Material> material, string systemMaterial, List<string> skipped)
    {
        var raw = (op["functionName"] as string ?? op.Name).Trim();
        var name = Renamed.TryGetValue(raw, out var r) ? r : raw;
        var a = new A(op);
        var o = Function(name.ToLowerInvariant(), a, material, systemMaterial);
        if (o == null) { skipped.Add(name); return null; }
        // every function's time window (CParticleOperatorInstance), the same fields in CS2
        void Op(string k, string field, double d) { var v = a.F(k, d); if (v != d) o[field] = Math.Round(v, 6); }
        Op("operator start fadein", "m_flOpStartFadeInTime", 0);
        Op("operator end fadein", "m_flOpEndFadeInTime", 0);
        Op("operator start fadeout", "m_flOpStartFadeOutTime", 0);
        Op("operator end fadeout", "m_flOpEndFadeOutTime", 0);
        Op("operator fade oscillate", "m_flOpFadeOscillatePeriod", 0);
        Op("operator time offset min", "m_flOpTimeOffsetMin", 0);
        Op("operator time offset max", "m_flOpTimeOffsetMax", 0);
        Op("operator time scale min", "m_flOpTimeScaleMin", 1);
        Op("operator time scale max", "m_flOpTimeScaleMax", 1);
        var endcap = a.I("operator end cap state", -1);
        if (endcap is 0 or 1) o["m_nOpEndCapState"] = endcap == 0 ? "PARTICLE_ENDCAP_ENDCAP_OFF" : "PARTICLE_ENDCAP_ENDCAP_ON";
        return o;
    }

    static JsonObject? Function(string n, A a, Func<string, Material> material, string systemMaterial)
    {
        switch (n)
        {
            // ---- emitters
            case "emit_continuously":
                return new()
                {
                    ["_class"] = "C_OP_ContinuousEmitter", ["m_flEmitRate"] = a.F("emission_rate", 100), ["m_flStartTime"] = a.F("emission_start_time", 0),
                    ["m_flEmissionDuration"] = a.F("emission_duration", 0), ["m_flEmissionScale"] = a.F("scale emission to used control points", 0),
                    ["m_bInitFromKilledParentParticles"] = a.B("emit particles for killed parent particles", false),
                };
            case "emit_instantaneously":
                {
                    var num = a.I("num_to_emit", 100);
                    var min = a.I("num_to_emit_minimum", -1);
                    return new()
                    {
                        ["_class"] = "C_OP_InstantaneousEmitter", ["m_nParticlesToEmit"] = min >= 0 ? Rand(min, num, 1) : num,
                        ["m_flStartTime"] = a.F("emission_start_time", 0), ["m_nMaxEmittedPerFrame"] = a.I("maximum emission per frame", -1),
                    };
                }

            // ---- initializers
            case "lifetime random": return InitFloat(1, Rand(a.F("lifetime_min", 0), a.F("lifetime_max", 0), a.F("lifetime_random_exponent", 1)));
            case "radius random": return InitFloat(3, Rand(a.F("radius_min", 1), a.F("radius_max", 1), a.F("radius_random_exponent", 1)));
            case "alpha random": return InitFloat(7, Rand(a.I("alpha_min", 255) / 255.0, a.I("alpha_max", 255) / 255.0, a.F("alpha_random_exponent", 1)));
            case "trail length random": return InitFloat(10, Rand(a.F("length_min", 0.1), a.F("length_max", 0.1), a.F("length_random_exponent", 1)));
            case "rotation random":
            case "rotation speed random":
                {
                    var speed = n == "rotation speed random";
                    var c = speed ? a.F("rotation_speed_constant", 0) : a.F("rotation_initial", 0);
                    var lo = speed ? a.F("rotation_speed_random_min", 0) : a.F("rotation_offset_min", 0);
                    var hi = speed ? a.F("rotation_speed_random_max", 360) : a.F("rotation_offset_max", 360);
                    var exp = speed ? a.F("rotation_speed_random_exponent", 1) : a.F("rotation_random_exponent", 1);
                    var v = Rand((c + lo) * Deg, (c + hi) * Deg, exp);
                    if (a.B("randomly_flip_direction", speed))
                    {
                        // Source: negated when a second draw is over 0.5, the float input's sign flip
                        var obj = v as JsonObject ?? new JsonObject { ["m_nType"] = "PF_TYPE_RANDOM_UNIFORM", ["m_flRandomMin"] = v.GetValue<double>(), ["m_flRandomMax"] = v.GetValue<double>() };
                        obj["m_bHasRandomSignFlip"] = true;
                        v = obj;
                    }
                    return InitFloat(speed ? 5 : 4, v);
                }
            case "color random":
                return new()
                {
                    ["_class"] = "C_INIT_RandomColor", ["m_ColorMin"] = Rgb(a.C("color1", 255, 255, 255, 255)), ["m_ColorMax"] = Rgb(a.C("color2", 255, 255, 255, 255)),
                    ["m_TintMin"] = Rgb(a.C("tint clamp min", 0, 0, 0, 0)), ["m_TintMax"] = Rgb(a.C("tint clamp max", 255, 255, 255, 255)),
                    ["m_flTintPerc"] = a.F("tint_perc", 0), ["m_nTintCP"] = a.I("tint control point", 0),
                    ["m_flUpdateThreshold"] = a.F("tint update movement threshold", 32), ["m_flLightAmplification"] = a.F("light amplification amount", 1),
                };
            case "rotation yaw flip random": return new() { ["_class"] = "C_INIT_RandomYawFlip", ["m_flPercent"] = a.F("Flip Percentage", 0.5) };
            case "sequence random":
                return new() { ["_class"] = "C_INIT_RandomSequence", ["m_nSequenceMin"] = a.I("sequence_min", 0), ["m_nSequenceMax"] = a.I("sequence_max", 0), ["m_bShuffle"] = a.B("shuffle", false), ["m_bLinear"] = a.B("linear", false) };
            case "sequence two random":
                return new() { ["_class"] = "C_INIT_RandomSecondSequence", ["m_nSequenceMin"] = a.I("sequence_min", 0), ["m_nSequenceMax"] = a.I("sequence_max", 0) };
            case "lifetime from sequence": return new() { ["_class"] = "C_INIT_SequenceLifeTime", ["m_flFramerate"] = a.F("Frames Per Second", 30) };
            case "position within sphere random":
                {
                    var o = new JsonObject
                    {
                        ["_class"] = "C_INIT_CreateWithinSphereTransform", ["m_fRadiusMin"] = a.F("distance_min", 0), ["m_fRadiusMax"] = a.F("distance_max", 0),
                        ["m_vecDistanceBias"] = Arr(a.V("distance_bias", 1, 1, 1)), ["m_vecDistanceBiasAbs"] = Arr(a.V("distance_bias_absolute_value", 0, 0, 0)),
                        ["m_TransformInput"] = Cp(a.I("control_point_number", 0)), ["m_fSpeedMin"] = a.F("speed_min", 0), ["m_fSpeedMax"] = a.F("speed_max", 0),
                        ["m_fSpeedRandExp"] = a.F("speed_random_exponent", 1), ["m_bLocalCoords"] = a.B("bias in local system", false),
                        ["m_LocalCoordinateSystemSpeedMin"] = Arr(a.V("speed_in_local_coordinate_system_min", 0, 0, 0)),
                        ["m_LocalCoordinateSystemSpeedMax"] = Arr(a.V("speed_in_local_coordinate_system_max", 0, 0, 0)),
                    };
                    // "randomly distribute to highest supplied Control Point": CS2 spreads over the transform's CP range
                    if (a.B("randomly distribute to highest supplied Control Point", false))
                    {
                        var t = (JsonObject)o["m_TransformInput"]!;
                        t["m_nControlPointRangeMax"] = 63;
                        t["m_flEndCPGrowthTime"] = a.F("randomly distribution growth time", 0);
                    }
                    return o;
                }
            case "position within box random":
                return new() { ["_class"] = "C_INIT_CreateWithinBox", ["m_vecMin"] = Arr(a.V("min", 0, 0, 0)), ["m_vecMax"] = Arr(a.V("max", 0, 0, 0)), ["m_nControlPointNumber"] = a.I("control point number", 0), ["m_bLocalSpace"] = a.B("use local space", false) };
            case "position modify offset random":
                return new()
                {
                    ["_class"] = "C_INIT_PositionOffset", ["m_OffsetMin"] = Arr(a.V("offset min", 0, 0, 0)), ["m_OffsetMax"] = Arr(a.V("offset max", 0, 0, 0)),
                    ["m_TransformInput"] = Cp(a.I("control_point_number", 0)), ["m_bLocalCoords"] = a.B("offset in local space 0/1", false), ["m_bProportional"] = a.B("offset proportional to radius 0/1", false),
                };
            case "position modify warp random":
                return new()
                {
                    ["_class"] = "C_INIT_PositionWarp", ["m_vecWarpMin"] = Arr(a.V("warp min", 1, 1, 1)), ["m_vecWarpMax"] = Arr(a.V("warp max", 1, 1, 1)),
                    ["m_nControlPointNumber"] = a.I("control point number", 0), ["m_flWarpTime"] = a.F("warp transition time (treats min/max as start/end sizes)", 0),
                    ["m_flWarpStartTime"] = a.F("warp transition start time", 0), ["m_bInvertWarp"] = a.B("reverse warp (0/1)", false), ["m_bUseCount"] = a.B("use particle count instead of time", false),
                };
            case "velocity noise":
                {
                    var o = new JsonObject
                    {
                        ["_class"] = "C_INIT_InitialVelocityNoise", ["m_flNoiseScale"] = a.F("Time Noise Coordinate Scale", 1), ["m_flNoiseScaleLoc"] = a.F("Spatial Noise Coordinate Scale", 0.01),
                        ["m_flOffset"] = a.F("Time Coordinate Offset", 0), ["m_vecOffsetLoc"] = Arr(a.V("Spatial Coordinate Offset", 0, 0, 0)),
                        ["m_vecAbsVal"] = Arr(a.V("Absolute Value", 0, 0, 0)), ["m_vecAbsValInv"] = Arr(a.V("Invert Abs Value", 0, 0, 0)),
                        ["m_vecOutputMin"] = Arr(a.V("output minimum", 0, 0, 0)), ["m_vecOutputMax"] = Arr(a.V("output maximum", 1, 1, 1)),
                    };
                    if (a.B("Apply Velocity in Local Space (0/1)", false)) o["m_TransformInput"] = Cp(a.I("Control Point Number", 0));
                    return o;
                }
            case "velocity random":
                return new()
                {
                    ["_class"] = "C_INIT_VelocityRandom", ["m_nControlPointNumber"] = a.I("control_point_number", 0), ["m_fSpeedMin"] = a.F("random_speed_min", 0), ["m_fSpeedMax"] = a.F("random_speed_max", 0),
                    ["m_LocalCoordinateSystemSpeedMin"] = Arr(a.V("speed_in_local_coordinate_system_min", 0, 0, 0)), ["m_LocalCoordinateSystemSpeedMax"] = Arr(a.V("speed_in_local_coordinate_system_max", 0, 0, 0)),
                };
            case "lifetime pre-age noise":
                return new()
                {
                    ["_class"] = "C_INIT_AgeNoise", ["m_flAgeMin"] = a.F("start age minimum", 0), ["m_flAgeMax"] = a.F("start age maximum", 1), ["m_flNoiseScale"] = a.F("time noise coordinate scale", 1),
                    ["m_flNoiseScaleLoc"] = a.F("spatial noise coordinate scale", 1), ["m_flOffset"] = a.F("time coordinate offset", 0), ["m_vecOffsetLoc"] = Arr(a.V("spatial coordinate offset", 0, 0, 0)),
                    ["m_bAbsVal"] = a.B("absolute value", false), ["m_bAbsValInv"] = a.B("invert absolute value", false),
                };
            case "remap noise to scalar":
                return new()
                {
                    ["_class"] = "C_INIT_CreationNoise", ["m_nFieldOutput"] = a.I("output field", 3), ["m_flOutputMin"] = a.F("output minimum", 0), ["m_flOutputMax"] = a.F("output maximum", 1),
                    ["m_flNoiseScale"] = a.F("time noise coordinate scale", 0.1), ["m_flNoiseScaleLoc"] = a.F("spatial noise coordinate scale", 0.001), ["m_flOffset"] = a.F("time coordinate offset", 0),
                    ["m_vecOffsetLoc"] = Arr(a.V("spatial coordinate offset", 0, 0, 0)), ["m_bAbsVal"] = a.B("absolute value", false), ["m_bAbsValInv"] = a.B("invert absolute value", false),
                    ["m_flWorldTimeScale"] = a.F("world time noise coordinate scale", 0),
                };
            case "remap initial scalar":
                {
                    // Source 1's C_INIT_RemapScalar (CS2 dropped the class): the input field remapped, clamped, into the output
                    // field (multiplied in when "output is scalar of initial random range"). UNSETTLED: its emitter-lifetime
                    // window and "only active within specified input range" have no float-input equivalent and are dropped
                    var o = InitFloat(a.I("output field", 3), new JsonObject
                    {
                        ["m_nType"] = "PF_TYPE_PARTICLE_FLOAT", ["m_nScalarAttribute"] = a.I("input field", 8), ["m_nMapType"] = "PF_MAP_TYPE_REMAP",
                        ["m_flInput0"] = a.F("input minimum", 0), ["m_flInput1"] = a.F("input maximum", 1), ["m_flOutput0"] = a.F("output minimum", 0), ["m_flOutput1"] = a.F("output maximum", 1),
                    });
                    if (a.B("output is scalar of initial random range", false)) o["m_nSetMethod"] = "PARTICLE_SET_SCALE_INITIAL_VALUE";
                    return o;
                }
            case "position along path sequential":
                return new()
                {
                    ["_class"] = "C_INIT_CreateSequentialPathV2", ["m_fMaxDistance"] = a.F("maximum distance", 0), ["m_flNumToAssign"] = a.F("particles to map from start to end", 100),
                    ["m_bLoop"] = a.B("restart behavior (0 = bounce, 1 = loop )", true), ["m_bCPPairs"] = a.B("Use sequential CP pairs between start and end point", false), ["m_bSaveOffset"] = a.B("Save Offset", false),
                    ["m_PathParams"] = Path(a),
                };
            case "position along ring":
                return new()
                {
                    ["_class"] = "C_INIT_RingWave", ["m_TransformInput"] = Cp(a.I("control point number", 0)), ["m_flInitialRadius"] = a.F("initial radius", 0), ["m_flThickness"] = a.F("thickness", 0),
                    ["m_flInitialSpeedMin"] = a.F("min initial speed", 0), ["m_flInitialSpeedMax"] = a.F("max initial speed", 0), ["m_flRoll"] = a.F("roll", 0), ["m_flPitch"] = a.F("pitch", 0), ["m_flYaw"] = a.F("yaw", 0),
                    ["m_bEvenDistribution"] = a.B("even distribution", false), ["m_flParticlesPerOrbit"] = a.F("even distribution count", -1), ["m_bXYVelocityOnly"] = a.B("XY velocity only", true),
                };
            case "position from parent particles":
                return new() { ["_class"] = "C_INIT_CreateFromParentParticles", ["m_flVelocityScale"] = a.F("Inherited Velocity Scale", 0), ["m_bRandomDistribution"] = a.B("Random Parent Particle Distribution", false) };

            // ---- operators
            case "lifespan decay": return new() { ["_class"] = "C_OP_Decay" };
            case "movement basic":
                return new() { ["_class"] = "C_OP_BasicMovement", ["m_Gravity"] = Arr(a.V("gravity", 0, 0, 0)), ["m_fDrag"] = a.F("drag", 0), ["m_nMaxConstraintPasses"] = a.I("max constraint passes", 3) };
            case "alpha fade and decay":
                return new()
                {
                    ["_class"] = "C_OP_FadeAndKill", ["m_flStartAlpha"] = a.F("start_alpha", 1), ["m_flEndAlpha"] = a.F("end_alpha", 0), ["m_flStartFadeInTime"] = a.F("start_fade_in_time", 0),
                    ["m_flEndFadeInTime"] = a.F("end_fade_in_time", 0.5), ["m_flStartFadeOutTime"] = a.F("start_fade_out_time", 0.5), ["m_flEndFadeOutTime"] = a.F("end_fade_out_time", 1),
                    ["m_bForcePreserveParticleOrder"] = a.B("force preserving particle order", false),
                };
            case "alpha fade in random":
                return new() { ["_class"] = "C_OP_FadeIn", ["m_flFadeInTimeMin"] = a.F("fade in time min", 0.25), ["m_flFadeInTimeMax"] = a.F("fade in time max", 0.25), ["m_flFadeInTimeExp"] = a.F("fade in time exponent", 1), ["m_bProportional"] = a.B("proportional 0/1", true) };
            case "alpha fade out random":
                return new()
                {
                    ["_class"] = "C_OP_FadeOut", ["m_flFadeOutTimeMin"] = a.F("fade out time min", 0.25), ["m_flFadeOutTimeMax"] = a.F("fade out time max", 0.25), ["m_flFadeOutTimeExp"] = a.F("fade out time exponent", 1),
                    ["m_bProportional"] = a.B("proportional 0/1", true), ["m_bEaseInAndOut"] = a.B("ease in and out", true), ["m_flFadeBias"] = a.F("fade bias", 0.5),
                };
            case "color fade":
                return new()
                {
                    ["_class"] = "C_OP_ColorInterpolate", ["m_ColorFade"] = Rgb(a.C("color_fade", 255, 255, 255, 255)), ["m_flFadeStartTime"] = a.F("fade_start_time", 0), ["m_flFadeEndTime"] = a.F("fade_end_time", 1),
                    ["m_bEaseInOut"] = a.B("ease_in_and_out", true), ["m_nFieldOutput"] = a.I("output field", 6),
                };
            case "radius scale":
                return new()
                {
                    ["_class"] = "C_OP_InterpolateRadius", ["m_flStartTime"] = a.F("start_time", 0), ["m_flEndTime"] = a.F("end_time", 1), ["m_flStartScale"] = a.F("radius_start_scale", 1),
                    ["m_flEndScale"] = a.F("radius_end_scale", 1), ["m_bEaseInAndOut"] = a.B("ease_in_and_out", false), ["m_flBias"] = a.F("scale_bias", 0.5),
                };
            case "movement lock to control point":
                return new()
                {
                    ["_class"] = "C_OP_PositionLock", ["m_TransformInput"] = Cp(a.I("control_point_number", 0)),
                    ["m_flStartTime_min"] = a.F("start_fadeout_min", 1), ["m_flStartTime_max"] = a.F("start_fadeout_max", 1), ["m_flStartTime_exp"] = a.F("start_fadeout_exponent", 1),
                    ["m_flEndTime_min"] = a.F("end_fadeout_min", 1), ["m_flEndTime_max"] = a.F("end_fadeout_max", 1), ["m_flEndTime_exp"] = a.F("end_fadeout_exponent", 1),
                    ["m_flRange"] = a.F("distance fade range", 0), ["m_bLockRot"] = a.B("lock rotation", false),
                };
            case "movement dampen relative to control point":
                return new() { ["_class"] = "C_OP_DampenToCP", ["m_nControlPointNumber"] = a.I("control_point_number", 0), ["m_flRange"] = a.F("falloff range", 100), ["m_flScale"] = a.F("dampen scale", 1) };
            case "oscillate scalar":
                return new()
                {
                    ["_class"] = "C_OP_OscillateScalar", ["m_nField"] = a.I("oscillation field", 7), ["m_RateMin"] = a.F("oscillation rate min", 0), ["m_RateMax"] = a.F("oscillation rate max", 0),
                    ["m_FrequencyMin"] = a.F("oscillation frequency min", 1), ["m_FrequencyMax"] = a.F("oscillation frequency max", 1), ["m_bProportional"] = a.B("proportional 0/1", true),
                    ["m_flStartTime_min"] = a.F("start time min", 0), ["m_flStartTime_max"] = a.F("start time max", 0), ["m_flEndTime_min"] = a.F("end time min", 1), ["m_flEndTime_max"] = a.F("end time max", 1),
                    ["m_bProportionalOp"] = a.B("start/end proportional", true), ["m_flOscMult"] = a.F("oscillation multiplier", 2), ["m_flOscAdd"] = a.F("oscillation start phase", 0.5),
                };
            case "oscillate vector":
                return new()
                {
                    ["_class"] = "C_OP_OscillateVector", ["m_nField"] = a.I("oscillation field", 0), ["m_RateMin"] = Arr(a.V("oscillation rate min", 0, 0, 0)), ["m_RateMax"] = Arr(a.V("oscillation rate max", 0, 0, 0)),
                    ["m_FrequencyMin"] = Arr(a.V("oscillation frequency min", 1, 1, 1)), ["m_FrequencyMax"] = Arr(a.V("oscillation frequency max", 1, 1, 1)), ["m_bProportional"] = a.B("proportional 0/1", true),
                    ["m_flStartTime_min"] = a.F("start time min", 0), ["m_flStartTime_max"] = a.F("start time max", 0), ["m_flEndTime_min"] = a.F("end time min", 1), ["m_flEndTime_max"] = a.F("end time max", 1),
                    ["m_bProportionalOp"] = a.B("start/end proportional", true), ["m_flOscMult"] = a.F("oscillation multiplier", 2), ["m_flOscAdd"] = a.F("oscillation start phase", 0.5),
                    ["m_bOffset"] = a.B("offset instead of accelerate", false),
                };
            case "rotation spin roll":
                return new() { ["_class"] = "C_OP_Spin", ["m_nSpinRateDegrees"] = a.I("spin_rate_degrees", 0), ["m_nSpinRateMinDegrees"] = a.I("spin_rate_min", 0), ["m_fSpinRateStopTime"] = a.F("spin_stop_time", 0) };
            case "rotation basic": return new() { ["_class"] = "C_OP_SpinUpdate" };
            case "set child control points from particle positions":
                return new()
                {
                    ["_class"] = "C_OP_SetChildControlPoints", ["m_nChildGroupID"] = a.I("Group ID to affect", 0), ["m_nFirstControlPoint"] = a.I("First control point to set", 0),
                    ["m_nNumControlPoints"] = a.I("# of control points to set", 1), ["m_nFirstSourcePoint"] = a.I("first particle to copy", 0), ["m_bSetOrientation"] = a.B("set orientation", false),
                };
            case "set control point positions":
                return new()
                {
                    ["_class"] = "C_OP_SetControlPointPositions", ["m_bUseWorldLocation"] = a.B("Set positions in world space", false), ["m_bSetOnce"] = a.B("Set Once", false),
                    ["m_nCP1"] = a.I("First Control Point Number", 1), ["m_nCP2"] = a.I("Second Control Point Number", 2), ["m_nCP3"] = a.I("Third Control Point Number", 3), ["m_nCP4"] = a.I("Fourth Control Point Number", 4),
                    ["m_vecCP1Pos"] = Arr(a.V("First Control Point Location", 128, 0, 0)), ["m_vecCP2Pos"] = Arr(a.V("Second Control Point Location", 0, 128, 0)),
                    ["m_vecCP3Pos"] = Arr(a.V("Third Control Point Location", -128, 0, 0)), ["m_vecCP4Pos"] = Arr(a.V("Fourth Control Point Location", 0, -128, 0)),
                    ["m_nHeadLocation"] = a.I("Control Point to offset positions from", 0),
                };
            case "remap distance to control point to scalar":
                {
                    var o = new JsonObject
                    {
                        ["_class"] = "C_OP_DistanceToTransform", ["m_nFieldOutput"] = a.I("output field", 3), ["m_flInputMin"] = a.F("distance minimum", 0), ["m_flInputMax"] = a.F("distance maximum", 128),
                        ["m_flOutputMin"] = a.F("output minimum", 0), ["m_flOutputMax"] = a.F("output maximum", 1), ["m_TransformStart"] = Cp(a.I("control point", 0)),
                        ["m_bActiveRange"] = a.B("only active within specified distance", false), ["m_bLOS"] = a.B("ensure line of sight", false), ["m_flMaxTraceLength"] = a.F("Maximum Trace Length", -1),
                        ["m_flLOSScale"] = a.F("LOS Failure Scalar", 0),
                    };
                    if (a.B("output is scalar of initial random range", false)) o["m_nSetMethod"] = "PARTICLE_SET_SCALE_INITIAL_VALUE";
                    return o;
                }
            case "noise scalar":
                return new() { ["_class"] = "C_OP_Noise", ["m_nFieldOutput"] = a.I("output field", 3), ["m_flOutputMin"] = a.F("output minimum", 0), ["m_flOutputMax"] = a.F("output maximum", 1), ["m_fl4NoiseScale"] = a.F("noise coordinate scale", 0.1), ["m_bAdditive"] = a.B("additive", false) };
            case "noise vector":
                return new()
                {
                    ["_class"] = "C_OP_VectorNoise", ["m_nFieldOutput"] = a.I("output field", 6), ["m_vecOutputMin"] = Arr(a.V("output minimum", 0, 0, 0)), ["m_vecOutputMax"] = Arr(a.V("output maximum", 1, 1, 1)),
                    ["m_fl4NoiseScale"] = a.F("noise coordinate scale", 0.1), ["m_bAdditive"] = a.B("additive", false), ["m_bOffset"] = a.B("offset instead of accelerate", false),
                };
            case "movement rotate particle around axis":
                return new() { ["_class"] = "C_OP_MovementRotateParticleAroundAxis", ["m_vecRotAxis"] = Arr(a.V("Rotation Axis", 0, 0, 1)), ["m_flRotRate"] = a.F("Rotation Rate", 180), ["m_TransformInput"] = Cp(a.I("Control Point", 0)), ["m_bLocalSpace"] = a.B("Use Local Space", false) };

            // ---- forces
            case "pull towards control point":
                return new() { ["_class"] = "C_OP_AttractToControlPoint", ["m_fForceAmount"] = a.F("amount of force", 100), ["m_fFalloffPower"] = a.F("falloff power", 2), ["m_TransformInput"] = Cp(a.I("control point number", 0)) };
            case "random force": return new() { ["_class"] = "C_OP_RandomForce", ["m_MinForce"] = Arr(a.V("min force", 0, 0, 0)), ["m_MaxForce"] = Arr(a.V("max force", 0, 0, 0)) };
            case "twist around axis":
                return new() { ["_class"] = "C_OP_TwistAroundAxis", ["m_fForceAmount"] = a.F("amount of force", 0), ["m_TwistAxis"] = Arr(a.V("twist axis", 0, 0, 1)), ["m_bLocalSpace"] = a.B("object local space axis 0/1", false), ["m_nControlPointNumber"] = a.I("control point", 0) };

            // ---- constraints
            case "collision via traces":
                {
                    // Source 1's collision modes: 0 per-particle trace, 1 per-frame plane set, 2 initial trace down, 3 nearest trace
                    var mode = a.I("collision mode", 0) switch { 1 => "COLLISION_MODE_PER_FRAME_PLANESET", 2 => "COLLISION_MODE_INITIAL_TRACE_DOWN", 3 => "COLLISION_MODE_USE_NEAREST_TRACE", _ => "COLLISION_MODE_PER_PARTICLE_TRACE" };
                    return new()
                    {
                        ["_class"] = "C_OP_WorldTraceConstraint", ["m_nCollisionMode"] = mode, ["m_CollisionGroupName"] = a.S("collision group", "NONE"),
                        ["m_flBounceAmount"] = a.F("amount of bounce", 0), ["m_flSlideAmount"] = a.F("amount of slide", 0), ["m_flRadiusScale"] = a.F("radius scale", 1),
                        ["m_bBrushOnly"] = a.B("brush only", false), ["m_flTraceTolerance"] = a.F("trace accuracy tolerance", 24), ["m_vecCpOffset"] = Arr(a.V("control point offset for fast collisions", 0, 0, 0)),
                        ["m_flCpMovementTolerance"] = a.F("control point movement distance tolerance", 5), ["m_bKillonContact"] = a.B("kill particle on collision", false),
                        ["m_flMinSpeed"] = a.F("minimum speed to kill on collision", -1), ["m_nCP"] = a.I("control point", 0),
                    };
                }
            case "constrain distance to control point":
                return new() { ["_class"] = "C_OP_ConstrainDistance", ["m_fMinDistance"] = a.F("minimum distance", 0), ["m_fMaxDistance"] = a.F("maximum distance", 100), ["m_nControlPointNumber"] = Cp(a.I("control point number", 0)), ["m_CenterOffset"] = Arr(a.V("offset of center", 0, 0, 0)), ["m_bGlobalCenter"] = a.B("global center point", false) };
            case "constrain distance to path between two control points":
                return new()
                {
                    ["_class"] = "C_OP_ConstrainDistanceToPath", ["m_fMinDistance"] = a.F("minimum distance", 0), ["m_flMaxDistance0"] = a.F("maximum distance", 100),
                    ["m_flMaxDistanceMid"] = a.F("maximum distance middle", -1), ["m_flMaxDistance1"] = a.F("maximum distance end", -1), ["m_flTravelTime"] = a.F("travel time", 10), ["m_PathParameters"] = Path(a, "random bulge"),
                };

            // ---- renderers (the system's material: its texture and SpriteCard parameters)
            case "render_animated_sprites":
            case "render_sprite_trail":
            case "render_rope":
                {
                    var m = material(systemMaterial);
                    var cls = n == "render_animated_sprites" ? "C_OP_RenderSprites" : n == "render_sprite_trail" ? "C_OP_RenderTrails" : "C_OP_RenderRopes";
                    var o = new JsonObject { ["_class"] = cls, ["m_flAnimationRate"] = a.F("animation rate", 0.1) };
                    if (m.Texture != null) o["m_vecTexturesInput"] = new JsonArray(new JsonObject { ["m_hTexture"] = m.Texture });
                    if (m.Additive) o["m_nOutputBlendMode"] = "PARTICLE_OUTPUT_BLEND_MODE_ADD";
                    if (m.Overbright != 1) o["m_flOverbrightFactor"] = m.Overbright;
                    if (m.AddSelf != 0) o["m_flAddSelfAmount"] = m.AddSelf;
                    if (m.MinSize is { } mn) o["m_flMinSize"] = mn;
                    if (m.MaxSize is { } mx) o["m_flMaxSize"] = mx;
                    if (m.StartFade is { } sf) o["m_flStartFadeSize"] = sf;
                    if (m.EndFade is { } ef) o["m_flEndFadeSize"] = ef;
                    if (m.DepthBlend is { } db) { o["m_nFeatheringMode"] = "PARTICLE_DEPTH_FEATHERING_ON_OPTIONAL"; o["m_flFeatheringMaxDist"] = db; }
                    if (n == "render_animated_sprites")
                    {
                        if (a.B("animation_fit_lifetime", false)) o["m_nAnimationType"] = "ANIMATION_TYPE_FIT_LIFETIME";
                        o["m_bAnimateInFPS"] = a.B("use animation rate as FPS", false);
                        o["m_flAnimationRate2"] = a.F("second sequence animation rate", 0);
                        o["m_nOrientationType"] = a.I("orientation_type", 0) switch
                        {
                            1 => "PARTICLE_ORIENTATION_SCREEN_Z_ALIGNED", 2 => "PARTICLE_ORIENTATION_WORLD_Z_ALIGNED", 3 => "PARTICLE_ORIENTATION_ALIGN_TO_PARTICLE_NORMAL",
                            4 => "PARTICLE_ORIENTATION_SCREENALIGN_TO_PARTICLE_NORMAL", 5 => "PARTICLE_ORIENTATION_FULL_3AXIS_ROTATION", _ => "PARTICLE_ORIENTATION_SCREEN_ALIGNED",
                        };
                        o["m_nOrientationControlPoint"] = a.I("orientation control point", -1);
                    }
                    else if (n == "render_sprite_trail")
                    {
                        o["m_flMaxLength"] = a.F("max length", 2000);
                        o["m_flMinLength"] = a.F("min length", 0);
                        o["m_flLengthFadeInTime"] = a.F("length fade in time", 0);
                        o["m_bIgnoreDT"] = a.B("ignore delta time", false);
                    }
                    else
                    {
                        // Source's rope repeats its texture every (texture height x texel_size) units and scrolls at
                        // texture_scroll_rate units a second (the same rate over the same repeat)
                        o["m_nMaxTesselation"] = a.I("subdivision_count", 3);
                        o["m_nMinTesselation"] = a.I("subdivision_count", 3);
                        o["m_flTextureVWorldSize"] = Math.Round(Math.Max(1, m.Height) * a.F("texel_size", 4), 4);
                        o["m_flTextureVScrollRate"] = a.F("texture_scroll_rate", 0);
                    }
                    return o;
                }
        }
        return null;
    }

    static JsonObject Path(A a, string bulgeKey = "bulge") => new()
    {
        ["m_nStartControlPointNumber"] = a.I("start control point number", 0), ["m_nEndControlPointNumber"] = a.I("end control point number", 0),
        ["m_nBulgeControl"] = a.I("bulge control 0=random 1=orientation of start pnt 2=orientation of end point", 0),
        ["m_flBulge"] = a.F(bulgeKey, 0), ["m_flMidPoint"] = a.F("mid point position", 0.5),
    };
}
