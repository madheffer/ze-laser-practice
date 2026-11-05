// The map's own runtime lights: every light_omni2 with directlight 3 ("baked shadows, dynamic light"). Its bounce is
// in the irradiance lightmap and the probes, its direct light is not: CS2 adds it per pixel, on the lightmapped world
// masked by its channel of the baked shadow mask (bakedshadowindex 0 R .. 3 A, as the sun's). Without it a room lit
// only by such lights renders with just its bounce (ze_dreamin's Level 3 arena: irradiance ~0.02, 1/10 of what the
// two omnis above it give). Probe-lit meshes (world props, brush entities such as that arena's floor) take them
// unshadowed: the bake keeps only the sun's channel of the probes' shadow masks (bake/ProbeBake.cs).
//
// Truth sources (source2-compiler, the CS2 compiler's lighting reimplemented from its binary):
//   - colour (SceneLights.Record, 180eea510): colormode 0's "color" made linear (1 Kelvin colortemperature) x the
//     intensity its brightness_units give (LightUnits.FromUnits, 180eed3c0; omni scale 100^2, factor = cone solid
//     angle / (4 pi) / 10) x brightnessscale; 0: 2^brightness x 10000 (ze_dreamin's brightness 6 = 64000 lumens)
//   - distance fade (LightOmni.Frusta): full to (1 - skirt) x range, 0 at range; the runtime barn shader (as the
//     particle lights', world/lighting.js cs2Barn) gives I = colour x smoothstep(fade) / max(d^2, 1), diffuse x N.L
//     (x pi against three's Lambert, as the sun), specular through three's BRDF
// Not yet: light_barn / light_rect (frustum shapes), directlight 2 (dynamic shadows: needs shadow maps), lights
// toggled by I/O, the cone of an omni narrower than 180 (no baked map here has one), the probes' per-light shadow
// channels, models outside every probe volume / particles / the viewmodel (they keep the particle-light set only).
import * as THREE from 'three';
import { parseVec, num } from './entities/math.js';

export const MAX_MAP_LIGHTS = 16;

// 181007c90 (SceneLights.ColorTemperature): Tanner Helland's fit, each channel made linear
function colorTemperature(kelvin) {
  const t = kelvin / 100;
  let r = 255, b = 255, g;
  if (t > 66) { r = 329.69873 * (t - 60) ** -0.13320476; g = 288.12216 * (t - 60) ** -0.075514846; } else g = 99.4708 * Math.log(t) - 161.11957;
  if (t < 66) b = 138.51773 * Math.log(t - 10) - 305.0448;
  const c = (v) => Math.min(255, Math.max(0, Number.isFinite(v) ? v : 0)) / 255;
  return new THREE.Color().setRGB(c(r), c(g), c(b), THREE.SRGBColorSpace);
}

// one light_omni2's runtime record, or null (not a directlight 3 omni, off, black, or a shape we don't draw)
export function omniRecord(kv) {
  if (kv?.classname !== 'light_omni2' || String(kv.directlight) !== '3' || String(kv.enabled ?? 'true') === 'false') return null;
  const idx = parseInt(kv.bakedshadowindex ?? '-1', 10);
  const outer = Math.min(180, Math.max(1, num(kv.outer_angle, 180))), inner = Math.min(outer, Math.max(0, num(kv.inner_angle, 180)));
  if (outer < 180) return null; // a cone: not drawn yet (see the top)
  const solid = (1 - (Math.cos(inner * Math.PI / 180) + Math.cos(outer * Math.PI / 180)) / 2) * 2 * Math.PI;
  const factor = solid * 0.007957747, scale = 100 * 100;
  let intensity;
  switch (parseInt(kv.brightness_units ?? '0', 10)) {
    case 0: intensity = 2 ** num(kv.brightness, 0) * scale; break;
    case 1: intensity = num(kv.brightness_lumens, 0) / factor; break;
    case 3: intensity = num(kv.brightness_legacy, 0) * scale; break;
    case 4: intensity = num(kv.brightness_candelas, 0) * solid / factor; break;
    default: intensity = 0; // 2 (nits) needs the luminaire's area
  }
  const cm = parseInt(kv.colormode ?? '0', 10);
  const rgb = parseVec(kv.color, [255, 255, 255]);
  const color = cm === 1 ? colorTemperature(num(kv.colortemperature, 6600))
    : cm === 0 ? new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace) : new THREE.Color(0, 0, 0);
  color.multiplyScalar(intensity * num(kv.brightnessscale, 1));
  if (!(color.r + color.g + color.b > 0)) return null;
  const range = Math.max(1, num(kv.range, 256));
  const skirt = num(kv.skirt, 0);
  return {
    position: new THREE.Vector3(...parseVec(kv.origin)), color, range, near: Math.min(range, (1 - skirt) * range),
    channel: idx >= 0 && idx <= 3 ? idx : -1,
  };
}

export class MapLights {
  constructor() {
    this.list = [];
    this.uniforms = {
      cs2MapCount: { value: 0 },
      cs2MapPos: { value: Array.from({ length: MAX_MAP_LIGHTS }, () => new THREE.Vector3()) },
      cs2MapColor: { value: Array.from({ length: MAX_MAP_LIGHTS }, () => new THREE.Vector3()) },
      cs2MapFade: { value: Array.from({ length: MAX_MAP_LIGHTS }, () => new THREE.Vector2()) }, // range, fade start
      cs2MapMask: { value: Array.from({ length: MAX_MAP_LIGHTS }, () => new THREE.Vector4()) }, // its shadow channel
    };
    this._frustum = new THREE.Frustum(); this._m = new THREE.Matrix4(); this._s = new THREE.Sphere(); this._pick = [];
  }

  // per map. channels: how many channels the baked shadow mask has (BC4: 1); a light past them is unshadowed
  set(ents, channels = 4) {
    this.list = [];
    for (const e of ents) {
      const r = omniRecord(e?.kv);
      if (!r) continue;
      r.mask = new THREE.Vector4(r.channel === 0 ? 1 : 0, r.channel === 1 ? 1 : 0, r.channel === 2 ? 1 : 0, r.channel === 3 ? 1 : 0);
      if (r.channel >= channels) r.mask.set(0, 0, 0, 0);
      this.list.push(r);
    }
    this.uniforms.cs2MapCount.value = 0;
  }

  // every frame: the lights whose sphere the camera can see, nearest first (a pixel outside a light's range gets
  // nothing from it, so only a view with more than 16 in reach drops any)
  update(camera) {
    const u = this.uniforms;
    if (!this.list.length) { u.cs2MapCount.value = 0; return; }
    camera.updateMatrixWorld();
    this._frustum.setFromProjectionMatrix(this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const p = camera.position, pick = this._pick;
    pick.length = 0;
    for (const l of this.list) {
      this._s.set(l.position, l.range);
      if (!this._frustum.intersectsSphere(this._s)) continue;
      l.rank = Math.max(0, l.position.distanceTo(p) - l.range);
      pick.push(l);
    }
    pick.sort((a, b) => a.rank - b.rank);
    const n = Math.min(MAX_MAP_LIGHTS, pick.length);
    for (let i = 0; i < n; i++) {
      const l = pick[i];
      u.cs2MapPos.value[i].copy(l.position);
      u.cs2MapColor.value[i].set(l.color.r, l.color.g, l.color.b);
      u.cs2MapFade.value[i].set(l.range, l.near);
      u.cs2MapMask.value[i].copy(l.mask);
    }
    u.cs2MapCount.value = n;
  }
}

// GLSL for the lightmapped world's fragment shader (after lights_fragment_begin; needs vCs2World, vLightMapUv and,
// with CS2_SHADOWS, the cs2Shadows mask)
export const MAP_LIGHTS_PARS = `
uniform int cs2MapCount;
uniform vec3 cs2MapPos[ ${MAX_MAP_LIGHTS} ];
uniform vec3 cs2MapColor[ ${MAX_MAP_LIGHTS} ];
uniform vec2 cs2MapFade[ ${MAX_MAP_LIGHTS} ];
uniform vec4 cs2MapMask[ ${MAX_MAP_LIGHTS} ];
`;
export const MAP_LIGHTS_GATHER = `
#if defined( RE_Direct )
#ifdef CS2_SHADOWS
vec4 cs2MapShadow = texture2D( cs2Shadows, vLightMapUv );
#else
vec4 cs2MapShadow = vec4( 0.0 );
#endif
for ( int mi = 0; mi < ${MAX_MAP_LIGHTS}; mi ++ ) {
  if ( mi >= cs2MapCount ) break;
  vec3 cs2Mv = cs2MapPos[ mi ] - vCs2World;
  float cs2Md = length( cs2Mv );
  vec2 cs2Mf = cs2MapFade[ mi ];
  if ( cs2Md >= cs2Mf.x ) continue;
  float cs2Mt = clamp( ( cs2Mf.x - cs2Md ) / max( cs2Mf.x - cs2Mf.y, 1e-3 ), 0.0, 1.0 );
  float cs2Mvis = clamp( 1.0 - dot( cs2MapShadow, cs2MapMask[ mi ] ), 0.0, 1.0 );
  IncidentLight cs2ML;
  cs2ML.color = cs2MapColor[ mi ] * ( cs2Mt * cs2Mt * ( 3.0 - 2.0 * cs2Mt ) / max( cs2Md * cs2Md, 1.0 ) * cs2Mvis * PI );
  cs2ML.direction = normalize( ( viewMatrix * vec4( cs2Mv / max( cs2Md, 1e-6 ), 0.0 ) ).xyz );
  cs2ML.visible = true;
  RE_Direct( cs2ML, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
}
#endif
`;
