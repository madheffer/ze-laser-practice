// CS2's csgo_effects.vfx on the world and entity models: an unlit, translucent (or additive) surface whose opacity is
// the colour texture's alpha x three masks x a view-angle fresnel x a distance fade. VRF exports it as a lit, opaque
// glTF PBR material, so these came out as solid lit slabs: ze_ffxii_westersand_v8's comshieldwall_black areaportal
// walls (fade 0 -> 1 over 663 units: all but invisible up close in CS2) stood as black walls across the desert hall,
// vol_light001's additive light shafts as grey cones, ze_minecraft_sakura's boundary / sign planes as opaque cards.
//
// The maths is the vpkstuff previewer's (weapons/fp/cs2-material.js buildEffects, from the csgo_effects dumps): the
// GLSL helpers and parameter defaults are taken from weapons/fp/cs2-shade.js, not copied.
//   a   = vertexAlpha x colour.a x g_flOpacityScale x mask1 x mask2 x mask3 x fresnel x fade
//   rgb = colour.rgb x vertexColour x g_vColorTint x g_flColorBoost
//   fresnel = mix(min, max, sat(pow(sat(N.V), exponent) x falloff)); fade = pow(mix(min, max, sat(dist / distance)), falloff)
// UNSETTLED: the masks are taken as white (the bake does not export g_tMask1-3; most materials use the white
// default_mask, sakura's boundary / mapper planes and visualizer's light shafts do not); gradient fog and
// F_DEPTH_FEATHER are not drawn; DynamicParams expressions stay at their static values.
import * as THREE from 'three';
import '../weapons/fp/cs2-shade.js'; // window.CS2Shade: the effects GLSL and the shader's parameter defaults

export const EFFECTS_SHADER = 'csgo_effects.vfx';

const VS = `
varying vec2 vCs2FxUv;
varying vec3 vCs2FxWorld;
varying vec3 vCs2FxNormal;
varying vec4 vCs2FxColor;
void main() {
  vCs2FxUv = uv;
#if defined( USE_COLOR_ALPHA )
  vCs2FxColor = color;
#elif defined( USE_COLOR )
  vCs2FxColor = vec4( color, 1.0 );
#else
  vCs2FxColor = vec4( 1.0 );
#endif
  vec4 p = vec4( position, 1.0 );
  vec3 n = normal;
#ifdef USE_INSTANCING
  p = instanceMatrix * p;
  n = mat3( instanceMatrix ) * n;
#endif
  vec4 w = modelMatrix * p;
  vCs2FxWorld = w.xyz;
  vCs2FxNormal = mat3( modelMatrix ) * n;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// the scene is in Source units (world/render.js GLTF_TO_SOURCE), so the fade distance is measured as is
const FS = () => `
${window.CS2Shade.glsl.effects}
uniform sampler2D cs2FxColorMap;
uniform vec3 cs2FxBase;
uniform vec3 cs2FxTint;
uniform vec2 cs2FxScroll;
uniform float cs2FxTime, cs2FxBoost, cs2FxOpacity, cs2FxFlipBack;
uniform vec4 cs2FxFresnel; // min, max, exponent, falloff
uniform vec4 cs2FxFade;    // min, max, distance, falloff
varying vec2 vCs2FxUv;
varying vec3 vCs2FxWorld;
varying vec3 vCs2FxNormal;
varying vec4 vCs2FxColor;
void main() {
  vec4 c = texture2D( cs2FxColorMap, vCs2FxUv + cs2FxScroll * cs2FxTime );
  vec3 n = normalize( vCs2FxNormal );
  if ( cs2FxFlipBack > 0.5 && !gl_FrontFacing ) n = -n;
  vec3 rel = vCs2FxWorld - cameraPosition;
  float fres = cs2EffectsFresnel( dot( -normalize( rel ), n ), cs2FxFresnel );
  float fade = cs2EffectsFade( length( rel ), cs2FxFade );
  float a = vCs2FxColor.a * c.a * cs2FxOpacity * fres * fade;
  vec3 rgb = c.rgb * cs2FxBase * vCs2FxColor.rgb * cs2FxTint * cs2FxBoost;
  gl_FragColor = vec4( min( rgb, vec3( 64.0 ) ), clamp( a, 0.0, 1.0 ) );
  #include <colorspace_fragment>
}`;

const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;

const num = (v, d) => (Number.isFinite(v) ? v : d);
const vec = (v, n) => (Array.isArray(v) && v.length >= n && v.slice(0, n).every(Number.isFinite) ? v.slice(0, n) : null);

export class Effects {
  constructor() {
    this.time = { value: 0 }; // shared by every effects material: the scroll clock
    this.materials = new WeakMap(); // exported material -> its effects material (or itself)
  }

  // the effects replacement for an exported material, or the material itself (another shader)
  material(m) {
    if (!m || this.materials.has(m)) return this.materials.get(m) ?? m;
    const vmat = m.userData?.vmat;
    let out = m;
    if (String(vmat?.ShaderName || '').toLowerCase() === EFFECTS_SHADER) {
      const def = (n, d) => num(vmat.FloatParams?.[n], window.CS2Shade.def(EFFECTS_SHADER, n, d));
      const ints = vmat.IntParams || {};
      const tint = vec(vmat.VectorParams?.g_vColorTint, 3) || [1, 1, 1];
      const scroll = vec(vmat.VectorParams?.g_vTexCoordScrollSpeed, 2) || [0, 0];
      const backfaces = ints.F_RENDER_BACKFACES === 1;
      const additive = ints.F_ADDITIVE_BLEND === 1;
      out = new THREE.ShaderMaterial({
        name: m.name, vertexShader: VS, fragmentShader: FS(),
        uniforms: {
          cs2FxColorMap: { value: m.map || WHITE },
          cs2FxBase: { value: (m.color || new THREE.Color(1, 1, 1)).clone() }, // a constant colour (VRF's baseColorFactor)
          cs2FxTint: { value: new THREE.Color().setRGB(tint[0], tint[1], tint[2], THREE.SRGBColorSpace) },
          cs2FxScroll: { value: new THREE.Vector2(scroll[0], scroll[1]) },
          cs2FxTime: this.time,
          cs2FxBoost: { value: Math.min(48, def('g_flColorBoost', 1)) },
          cs2FxOpacity: { value: Math.min(1, Math.max(0, def('g_flOpacityScale', 1))) },
          cs2FxFlipBack: { value: window.CS2Shade.flipsBackfaceNormals(backfaces, ints.F_DONT_FLIP_BACKFACE_NORMALS === 1) ? 1 : 0 },
          cs2FxFresnel: { value: new THREE.Vector4(def('g_flFresnelMin', 0), def('g_flFresnelMax', 1), Math.max(0.001, def('g_flFresnelExponent', 0.001)), def('g_flFresnelFalloff', 1)) },
          cs2FxFade: { value: new THREE.Vector4(def('g_flFadeMin', 0), def('g_flFadeMax', 1), Math.max(1e-3, def('g_flFadeDistance', 1)), def('g_flFadeFalloff', 1)) },
        },
        transparent: true, depthWrite: false, vertexColors: !!m.vertexColors,
        side: backfaces ? THREE.DoubleSide : THREE.FrontSide,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      out.userData = { ...m.userData, cs2Effects: true };
    }
    this.materials.set(m, out);
    return out;
  }

  // a mesh's materials with every effects shader swapped in
  apply(mesh) {
    const one = (m) => this.material(m);
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
  }

  // every frame: the scroll clock (seconds)
  frame(time) { this.time.value = time; }
}
