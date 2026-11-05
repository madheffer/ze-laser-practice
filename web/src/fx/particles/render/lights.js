import { makeInputs, enumIndex } from './controls.js';
import { particleLightDesc, descToBarn, angleVectors, normalize, perpendicular, lightColorBytes } from './barn.js';

// C_OP_RenderStandardLight: every live particle becomes a light, ported from particles.dll md5
// 63babcbf3245e56855a777134323e74a (render 0x1802ee5f0 = vtable slot 48; slot table 0x1802edef0 = slot 50; unused
// slots freed at 0x1802ee4e0 = slot 67) and scenesystem.dll md5 243931a0d9a3cc7bd05984d9eda02c1f (0x1804a3ce0).
// No three.js, nothing is drawn: effects.js collects every renderer's list into MapEffects.lights each frame and the
// world renderer shades with it.
//
// ---- Light-list contract (MapEffects.lights, one frame) -------------------------------------------------------
//   {
//     type: 'point' | 'spot' | 'capsule',
//     position: [x, y, z],      Source units, world space, z up (the particle position)
//     direction: [x, y, z],     unit; spot axis (from the particle's pitch / yaw / roll), unused by a point light
//     capsule: [x, y, z]|null,  capsule only: the segment runs position -> position + capsule
//     color: [r, g, b],         LINEAR, everything folded in: blend(colour scale, particle colour) -> sRGB decode
//                               x intensity x alpha [x OLD factor q*10000 + l*100 + c] x k (the barn match below)
//     radius: R,                Source units: particle radius x m_flRadiusMultiplier, cut by the 0.001 luminance clamp
//     fade: [a, b],             distance fade = smoothstep(0, 1, a + b*d); = smoothstep(0, 1, 4 - 4d/R)
//     diffuse, specular: bool,  FX lights: diffuse only
//     cone: { innerT, tanPhi, theta, phi } | null   spot only (degrees, half angles)
//     fogMode, fogContribution, castShadows         handed over; fog only lights fog when fogMode != 0 (none here)
//     desc: { color, atten: {c, l, q}, range, rangeBeforeClamp, k, matchDistance }   the pre-conversion description
//   }
//
// ---- Attenuation: how CS2 shades it ---------------------------------------------------------------------------
// The vpcf curve (OLD q/l/c from m_flFalloffLinearity, NEW fitted through 50% / 0% distances) never reaches the GPU:
// scenesystem 0x1804a3ce0 converts every particle point / spot light into a barn light whose falloff is 1/d^2,
// matched to the description's 1/(c + l d + q d^2) at m = 0.15 R (convar lb_convert_to_barn_lights_falloff_match_point,
// 0.15f registered at 0x1800110d7; m = 100 when 0.15 R <= 0): k = m^2 / (c + l m + q m^2), record colour = k colour.
// The runtime shader (RE §8: VS0:3380-3646 / csgo_complex s5120 :626-669, g_BarnLights) then gives, per pixel at
// distance d (Source units) from `position`:
//
//     I(d) = color * 1 / max(d^2, 1) * smoothstep(0, 1, fade[0] + fade[1] * d)        (0 beyond R)
//
// i.e. full 1/d^2 to 0.75 R, smoothed to 0 at R. Diffuse: I * saturate(N.L) * albedo [* the BRDF normalisation, see
// UNSETTLED]; specular only when `specular`. Spot: times the cone (UNSETTLED form, no baked map uses one).
// Sources: particles 0x1803786f0 (OLD), 0x180378580 (NEW), 0x1803774b0 (range clamp), scenesystem 0x1804a3ce0
// (k, fade: s = R - 0.25 R, 0x1804a4b45), source2-compiler docs/PARTICLE_RENDERING.md §8 (shader) / §10.
//
// UNSETTLED: csgo_complex's diffuse normalisation of a barn colour (pi or not); the near / far projection-box fades
// of a point barn (taken as 1 inside R); the scene-system gate (vfunc 0x218) and collection flag 4 that skip a
// frame's lights; what feeds the renderer tint / desaturation (0x1802f0110 copies the caller's +0x50 / +0x38: taken
// as white / 0); light styles (scene vfunc 0x310: none in any baked map, reported); when slot 12 (0x1802f0130, frees
// every slot) runs, so a slot claimed by a particle that never lit stays claimed until the renderer is rebuilt.

const TYPES = ['point', 'spot', 'point', 'capsule'];  // POINT, SPOT, FX (a diffuse-only point), CAPSULE
const BEHAVIORS = ['PARTICLE_LIGHT_BEHAVIOR_FOLLOW_DIRECTION', 'PARTICLE_LIGHT_BEHAVIOR_ROPE', 'PARTICLE_LIGHT_BEHAVIOR_TRAILS'];
const RAD2DEG = 57.2957764;                          // 0x180534314
const clampLin = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x); // maxss 0 / minss 1.0 at 0x1802ee9d9

export class LightRenderer {
  constructor() {
    this.mesh = null;
    this.lights = [];
    this.slots = [];      // { id, used, live, lit }: particles keep their slot by particle ID (0x1802eed9c)
  }

  /** Fills this.lights for this frame; returns { unsupported } like the other renderers. */
  update(col, p, raw, ctx = {}) {
    const lights = this.lights;
    const unsupported = [];
    const A = col.attr || {};
    const n = col.count || 0;
    const ev = makeInputs(col);
    const type = enumIndex('lightType', p.m_nLightType ?? 0);
    if (p.m_strLightStyle) unsupported.push('light style (taken as 1)');
    if (p.m_lightCookie) unsupported.push('light cookie (handed over by name only)');
    if (type === 1) unsupported.push('spot cone form UNSETTLED');

    // Slot 50 (0x1802edef0): the table grows to min(count, m_nMaxAllowed) (u16) and never shrinks.
    const max = (p.m_nMaxAllowed ?? 32) & 0xffff;
    if (this.slots.length < n && this.slots.length < max) {
      while (this.slots.length < Math.min(n, max)) this.slots.push({ id: 0, used: false, live: false, lit: false });
    }
    for (const s of this.slots) s.live = false;                                // 0x1802ee5f0 head: +0xf = 0

    // Collection-level inputs, once (FUN_180036130 from 0x1802ee962): all but intensity and style time.
    const scale = ev.evalVec(p.m_vecColorScale, -1, [1, 1, 1]);
    const blendType = enumIndex('colorBlend', p.m_nColorBlendType ?? 0);
    const mult = ev.evalFloat(p.m_flRadiusMultiplier, -1, 8);
    const linearity = clampLin(ev.evalFloat(p.m_flFalloffLinearity, -1, 0));
    let fifty = Math.max(ev.evalFloat(p.m_flFiftyPercentFalloff, -1, 0.5), 1.1920929e-07); // 0x18053413c
    const zero = Math.max(ev.evalFloat(p.m_flZeroPercentFalloff, -1, 1), 2.3841858e-07);   // 0x180534140
    if (zero - 1.1920929e-07 <= fifty) fifty = zero - 1.1920929e-07;
    const fogContribution = Math.max(0, ev.evalFloat(p.m_flFogContribution, -1, 1));
    const phi = ev.evalFloat(p.m_flPhi, -1, 60), theta = ev.evalFloat(p.m_flTheta, -1, 45);
    const attenuation = p.m_nAttenuationStyle === 'LIGHT_STYLE_NEW' || p.m_nAttenuationStyle === 1 ? 1 : 0;
    const fogMode = typeof p.m_nFogLightingMode === 'number' ? p.m_nFogLightingMode
      : { PARTICLE_LIGHT_FOG_LIGHTING_MODE_DYNAMIC: 2, PARTICLE_LIGHT_FOG_LIGHTING_MODE_DYNAMIC_NOSHADOWS: 4 }[p.m_nFogLightingMode] ?? 0;
    const behavior = typeof p.m_nCapsuleLightBehavior === 'number' ? p.m_nCapsuleLightBehavior : BEHAVIORS.indexOf(p.m_nCapsuleLightBehavior);

    // A multiplier of 0 with live particles jumps past the end-of-frame cleanup (0x1802eeb36 -> 0x1802f000e skips the
    // slot 67 call at 0x1802f0003): no light is updated or destroyed, so the scene keeps last frame's lights.
    if (n > 0 && mult === 0) return { unsupported };
    lights.length = 0;
    if (n > 0 && this.slots.length > 0) {
      // trail length scale: 1/dt when the anchor source is PREV_POSITION (0x1802eebde)
      let lengthScale = (p.m_nPrevPntSource ?? 2) === 2 && !p.m_bIgnoreDT && col.dt ? 1 / col.dt : 1;
      lengthScale *= p.m_flLengthScale ?? 1;
      const fadeRate = 1 / Math.max(p.m_flLengthFadeInTime ?? 0, 1e-9);          // 0x180534138
      const v3 = (k, i) => [A[k]?.[3 * i] ?? 0, A[k]?.[3 * i + 1] ?? 0, A[k]?.[3 * i + 2] ?? 0];
      for (let i = 0; i < n; i++) {
        // the per-particle intensity stream (0x1802eec11) advances in loop order, before the reverse-order remap
        const intensity = ev.evalFloat(p.m_flIntensity, i, 1);
        if (!(intensity > 0)) continue;
        let next = i + 1 < n ? i + 1 : (p.m_bClosedLoop ? 0 : i);
        let pi = i;
        if (p.m_bReverseOrder) { pi = n - i - 1; next = n - next - 1; }
        const slot = this.claim(A[11]?.[pi] ?? pi);
        if (!slot) continue;                                                   // every slot taken: no light
        const radius = A[3]?.[pi] ?? 0, alpha = A[7]?.[pi] ?? 1;
        if (radius === 0 || alpha === 0) continue;                             // exact zeros only; the slot stays claimed
        slot.live = true;

        const position = v3(0, pi);
        const ang = angleVectors((A[20]?.[pi] ?? 0) * RAD2DEG, (A[12]?.[pi] ?? 0) * RAD2DEG, (A[4]?.[pi] ?? 0) * RAD2DEG);
        let forward = ang.forward, axis = ang.up, r = radius, color2 = null, capsule = null;
        if (type === 3) {
          [forward, axis] = [axis, forward];                                   // capsule: forward <-> up (0x1802ef270)
          if (behavior === 1) {                                                // ROPE: to the next particle
            r = (radius + (A[3]?.[next] ?? 0)) * 0.5;                          // 0x1805341b8
            const q = v3(0, next);
            capsule = [q[0] - position[0], q[1] - position[1], q[2] - position[2]];
            if (normalize(capsule) === 0) capsule = [0, 0, 1];                 // UNSETTLED: the DLL keeps it unit length
            forward = perpendicular(capsule);
            color2 = this.colourBytesOf(A, next, blendType, scale);
          } else if (behavior === 2) {                                         // TRAILS: back along the previous position
            const pp = v3(2, pi), d = [pp[0] - position[0], pp[1] - position[1], pp[2] - position[2]];
            const len = Math.max(Math.hypot(d[0], d[1], d[2]), 1.1920929e-07);
            const age = Math.min(1, ((col.time ?? 0) - (A[8]?.[pi] ?? 0)) * fadeRate);
            const L = Math.max(p.m_flMinLength ?? 0, Math.min(p.m_flMaxLength ?? 2000, age * lengthScale * (A[10]?.[pi] ?? 0) * len));
            capsule = d.map((x) => (x / len) * L);
            const u = capsule.slice(); normalize(u); forward = perpendicular(u);
          } else {                                                             // FOLLOW_DIRECTION
            capsule = axis.map((x) => x * (p.m_flCapsuleLength ?? 100));
          }
        }
        const desc = particleLightDesc({
          tint: v3(6, pi), alpha, intensity, radius: r, scale, blendType, radiusMultiplier: mult, lightType: type,
          attenuation, linearity, fifty, zero, theta, phi, diffuse: p.m_bRenderDiffuse, specular: p.m_bRenderSpecular,
          fogMode, fogContribution, castShadows: p.m_bCastShadows, dynamicBounce: p.m_bDynamicBounce,
          position, forward, capsule, color2,
        });
        slot.lit = true;                                                        // the scene light exists from here
        const barn = descToBarn(desc);
        if (!barn) continue;                                                    // range 0: lights nothing
        const tanPhi = Math.tan(Math.min(phi * 0.0174532924, 1.57069635));
        lights.push({
          type: TYPES[type], position, direction: forward, capsule,
          color: barn.color, radius: desc.range, fade: barn.fade,
          diffuse: desc.diffuse, specular: desc.specular,
          cone: type === 1 ? { theta, phi, tanPhi, innerT: Math.tan(theta * 0.0174532924) / tanPhi } : null,
          fogMode: desc.fogMode, fogContribution, castShadows: desc.castShadows,
          desc: { color: desc.color, atten: desc.atten, range: desc.range, rangeBeforeClamp: desc.rangeBeforeClamp, k: barn.k, matchDistance: barn.matchDistance },
        });
      }
    }
    // Slot 67 (0x1802ee4e0, called at the end of every render, 0x1802f0003): a slot no particle refreshed this frame,
    // whose light exists, is destroyed and freed.
    for (const s of this.slots) if (!s.live && s.used && s.lit) { s.used = false; s.lit = false; }
    if (p.m_bCastShadows && type !== 2) unsupported.push('light shadows (ignored)');
    return { unsupported };
  }

  // The slot holding this particle ID, else the first free one, else null (0x1802eed9c loop).
  claim(id) {
    let free = null;
    for (const s of this.slots) {
      if (s.used && s.id === id) return s;
      if (!free && !s.used) free = s;
    }
    if (free) { free.used = true; free.id = id; free.lit = false; }
    return free;
  }

  // a rope capsule's second colour: the next particle's colour through the same blend (0x1802ef3c4..0x1802ef62e)
  colourBytesOf(A, i, blendType, scale) {
    return lightColorBytes(blendType, scale, [A[6]?.[3 * i] ?? 1, A[6]?.[3 * i + 1] ?? 1, A[6]?.[3 * i + 2] ?? 1]);
  }

  dispose() { this.lights.length = 0; this.slots.length = 0; }
}
