import * as THREE from 'three';
import { chainBeforeCompile } from '../../../lib/shader.js';
import { MAX_BARNS, BARN_GLSL } from './spritecard.js';

// GPU side of C_OP_RenderStandardLight: packs lights.js's per-frame light list (MapEffects.lights, the contract is at the
// top of lights.js) into BARN_GLSL's uniforms. World materials get them through onBeforeCompile (patchWorldMaterial),
// never a global ShaderChunk edit, because other viewers share this three module.

const _v = new THREE.Vector3(), _m3 = new THREE.Matrix3();

/**
* Pack barns into BARN_GLSL's uniforms. `toSpace` maps Source space to the shader's: identity for particles,
* view x stage group for world materials (three lights in view space); the group is unscaled, so inches stay.
*/
export function packBarns(u, barns, toSpace = null, colourScale = 1) {
  const n = Math.min(MAX_BARNS, barns.length);
  u.uBarnCount.value = n;
  if (toSpace) _m3.setFromMatrix4(toSpace);
  for (let i = 0; i < n; i++) {
    const b = barns[i];
    _v.fromArray(b.position);
    if (toSpace) _v.applyMatrix4(toSpace);
    u.uBarnPos.value[i].copy(_v);
    _v.fromArray(b.direction);
    if (toSpace) _v.applyMatrix3(_m3);
    u.uBarnAxis.value[i].copy(_v.normalize());
    u.uBarnColor.value[i].set(b.color[0] * colourScale, b.color[1] * colourScale, b.color[2] * colourScale);
    u.uBarnShape.value[i].set(b.radius, b.cone ? b.cone.innerT : 1, b.cone ? b.cone.tanPhi : -1, b.specular ? 1 : 0);
    u.uBarnFade.value[i].set(b.fade[0], b.fade[1]);
  }
}

/**
* Light a MeshStandardMaterial with the barn lights; colour is scaled by pi against RE_Direct's diffuse / pi.
* UNSETTLED: csgo_complex's normalisation is not in the notes (RE §8 covers the gather). Diffuse-only lights
* (m_bRenderSpecular false, shape.w = 0) skip specular.
*/
export function patchWorldMaterial(mat, uniforms) {
  chainBeforeCompile(mat, (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${BARN_GLSL}`)
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
#if defined( RE_Direct )
for (int bi = 0; bi < ${MAX_BARNS}; bi++) {
  if (bi >= uBarnCount) break;
  vec3 tl;
  vec3 I = efxBarn(bi, geometryPosition, tl) * PI;
  if (dot(I, I) <= 0.0) continue;
  directLight.color = I; directLight.direction = tl; directLight.visible = true;
  if (uBarnShape[bi].w > 0.5) RE_Direct(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  else reflectedLight.directDiffuse += saturate(dot(geometryNormal, tl)) * I * BRDF_Lambert(material.diffuseColor);
}
#endif`);
  }, 'efx-barn');
  mat.needsUpdate = true;
}
