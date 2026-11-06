// CS2's csgo_moondome.vfx: a surface that shows a cube texture (g_tCubeMap) along the view direction instead of its
// own colour. Mappers use it for fake skyboxes: ze_dreamin's fake_skybox models (materials/sky_fix.vmat) wall the
// arenas in with sky56_cube2, and drawn as the exported glTF material (its 1x1 white g_tColor, lit) they came out
// as blown-out white walls. The cube is baked with the skies (bake/SkyBake.cs, keyed by its vtex path).
//
// Params read from the vmat: g_tCubeMap, g_vColorTint, g_flCubeParallax, g_bFogEnabled.
// UNSETTLED: no dump of the shader's maths is in our references. Drawn as cube(view direction) x g_vColorTint,
// unlit; g_flCubeParallax (0 on every material baked so far) and fog (off on them) are not drawn; g_tColor
// (white on them) is not multiplied in.
import * as THREE from 'three';
import { skyCubeTexture } from './sky-cube.js';

export const MOONDOME_SHADER = 'csgo_moondome.vfx';

const VS = `
varying vec3 vCs2DomeWorld;
void main() {
  vec4 p = vec4( position, 1.0 );
#ifdef USE_INSTANCING
  p = instanceMatrix * p;
#endif
  vec4 w = modelMatrix * p;
  vCs2DomeWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
// the scene is in Source units (Z up): the same directions the env_sky cube is looked up with (world/lighting.js)
const FS = `
uniform samplerCube cs2DomeCube;
uniform vec3 cs2DomeTint;
uniform float cs2DomeDecodeSrgb;
uniform float cs2DomeRgbm;
varying vec3 vCs2DomeWorld;
void main() {
  vec4 t = textureCube( cs2DomeCube, normalize( vCs2DomeWorld - cameraPosition ) );
  vec3 c = cs2DomeRgbm > 0.0 ? t.rgb * t.a * cs2DomeRgbm : t.rgb;
  if ( cs2DomeDecodeSrgb > 0.5 ) c = pow( c, vec3( 2.2 ) );
  gl_FragColor = vec4( c * cs2DomeTint, 1.0 );
}`;

const cubeKey = (p) => String(p || '').replace(/\\/g, '/').toLowerCase().replace(/_c$/, '');

export class Moondome {
  // lighting: world/lighting.js MapLighting (its lightmaps.skies hold the baked cubes; set before the world loads)
  constructor(lighting) {
    this.lighting = lighting;
    this.skies = null;
    this.cubes = new Map(); // cube key -> skyCubeTexture result (null: not baked)
    this.materials = new Map(); // exported material -> its moondome material (or itself)
  }

  // a new map's skies: drop the old map's cubes and materials
  sync() {
    const skies = this.lighting?.lightmaps?.skies || null;
    if (skies === this.skies) return;
    for (const c of this.cubes.values()) c?.tex.dispose();
    for (const [src, m] of this.materials) if (m !== src) m.dispose();
    this.cubes.clear();
    this.materials.clear();
    this.skies = skies;
  }

  cube(key) {
    if (!this.cubes.has(key)) this.cubes.set(key, this.skies?.[key] ? skyCubeTexture(this.skies[key]) : null);
    return this.cubes.get(key);
  }

  // the moondome replacement for an exported material, or the material itself (another shader, or no baked cube)
  material(m) {
    if (!m || this.materials.has(m)) return this.materials.get(m) ?? m;
    const vmat = m.userData?.vmat;
    let out = m;
    if (String(vmat?.ShaderName || '').toLowerCase() === MOONDOME_SHADER) {
      const c = this.cube(cubeKey(vmat.TextureParams?.g_tCubeMap));
      if (c) {
        const t = vmat.VectorParams?.g_vColorTint;
        const tint = Array.isArray(t) && t.length >= 3 && t.slice(0, 3).every(Number.isFinite) ? new THREE.Color(t[0], t[1], t[2]) : new THREE.Color(1, 1, 1);
        out = new THREE.ShaderMaterial({
          name: m.name, vertexShader: VS, fragmentShader: FS, side: m.side,
          uniforms: { cs2DomeCube: { value: c.tex }, cs2DomeTint: { value: tint }, cs2DomeDecodeSrgb: { value: c.decodeSrgb }, cs2DomeRgbm: { value: c.rgbm } },
        });
        out.userData = { ...m.userData, cs2Moondome: true };
      }
    }
    this.materials.set(m, out);
    return out;
  }

  // a mesh's materials with every moondome shader swapped in
  apply(mesh) {
    this.sync();
    const one = (m) => this.material(m);
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
  }
}
