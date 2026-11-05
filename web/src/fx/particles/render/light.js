import * as THREE from 'three';
import { chainBeforeCompile } from '../../../lib/shader.js';
import { particleLightToBarn, angleVectors } from './barn.js';
import { enumIndex, makeInputs } from './controls.js';
import { MAX_BARNS, BARN_GLSL } from './spritecard.js';

// C_OP_RenderStandardLight (RE §10): every live particle becomes a barn light, up to m_nMaxAllowed. World
// materials get them through onBeforeCompile (patchWorldMaterial), never a global ShaderChunk edit, because
// other viewers share this three module.

const deg = (r) => (r * 180) / Math.PI;
const LIGHT_TYPES = ['POINT', 'SPOT', 'FX', 'CAPSULE'];

/** The barn lights one light renderer contributes this frame, in Source space. */
export function barnsFor(col, p, report) {
  const ev = makeInputs(col);
  const A = col.attr || {};
  const n = col.count || 0;
  const max = Math.min(n, Math.max(0, (p.m_nMaxAllowed ?? 32) & 0xffff));       // u16 read, slot table 0x1802edef0
  const type = LIGHT_TYPES[enumIndex('lightType', p.m_nLightType ?? 0)];
  if (type === 'CAPSULE') report?.('capsule light (drawn as a point light)');
  if (p.m_lightCookie) report?.('light cookie');
  if (p.m_bCastShadows) report?.('light shadows');
  if (p.m_strLightStyle) report?.('light style');
  const fx = type === 'FX';
  const scale = ev.evalVec(p.m_vecColorScale, -1, [1, 1, 1]);                   // collection input
  const out = [];
  for (let i = 0; i < n && out.length < max; i++) {
    const at3 = (k) => [A[k]?.[3 * i] ?? 0, A[k]?.[3 * i + 1] ?? 0, A[k]?.[3 * i + 2] ?? 0];
    const b = particleLightToBarn({
      type: type === 'SPOT' ? 'SPOT' : 'POINT',
      radius: A[3]?.[i] ?? 0,
      alpha: A[7]?.[i] ?? 1,
      tint: A[6] ? at3(6) : [1, 1, 1],
      colorScale: scale,
      blendType: enumIndex('colorBlend', p.m_nColorBlendType ?? 0),
      intensity: ev.evalFloat(p.m_flIntensity, i, 1),
      theta: ev.evalFloat(p.m_flTheta, i, 45),
      phi: ev.evalFloat(p.m_flPhi, i, 60),
      radiusMultiplier: ev.evalFloat(p.m_flRadiusMultiplier, i, 8),
      attenuation: (p.m_nAttenuationStyle === 'LIGHT_STYLE_NEW' || p.m_nAttenuationStyle === 1) && !fx ? 'NEW' : 'OLD',
      linearity: fx ? 1 : ev.evalFloat(p.m_flFalloffLinearity, i, 0),
      fifty: ev.evalFloat(p.m_flFiftyPercentFalloff, i, 0.5),
      zero: ev.evalFloat(p.m_flZeroPercentFalloff, i, 1),
      diffuse: p.m_bRenderDiffuse !== false,
      specular: !fx && p.m_bRenderSpecular !== false,
    });
    if (!b) continue;
    // Direction from the particle's pitch / yaw / roll, radians to degrees (RE §10 "Fields").
    const v = angleVectors(deg(A[20]?.[i] ?? 0), deg(A[12]?.[i] ?? 0), deg(A[4]?.[i] ?? 0));
    b.position = at3(0);
    b.axis = v.forward;
    b.intensity = ev.evalFloat(p.m_flIntensity, i, 1) * (A[7]?.[i] ?? 1);
    out.push(b);
  }
  return out;
}

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
    _v.fromArray(b.axis);
    if (toSpace) _v.applyMatrix3(_m3);
    u.uBarnAxis.value[i].copy(_v.normalize());
    u.uBarnColor.value[i].set(b.color[0] * colourScale, b.color[1] * colourScale, b.color[2] * colourScale);
    u.uBarnShape.value[i].set(b.range, b.innerT, b.type === 'SPOT' ? b.tanPhi : -1, b.specular ? 1 : 0);
    u.uBarnFade.value[i].set(b.distanceFade[0], b.distanceFade[1]);
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
