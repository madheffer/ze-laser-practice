// CS2's unlit material shaders, for the world and entity models. VRF exports every vmat as a glTF PBR material
// (its vmat in extras -> userData.vmat), and three lights that like a lit surface: lightmap or probes on top of
// the texture. CS2 does not light these:
//   - csgo_black_unlit.vfx: solid black (ze_alien_shooter's arena_black walls; lit, they turned the warm light's
//     yellow and showed every face of a room built to read as a void)
//   - csgo_unlitgeneric.vfx: g_tColor x TextureColor, no lighting (F_UNLIT). A brush entity's rendercolor tints it:
//     ze_alien_shooter's lasers are cs_havana/white.vmat x rendercolor [0 0 255], a fullbright blue bar. Probe-lit,
//     they came out dark navy.
//     Their rendermode 3 changes nothing: CS2's RenderMode_t is kRenderNormal 0 / kRenderTransAlpha 1 / kRenderNone 2
//     (server schema), the keyvalue is stored as is, and client.dll (20261015) only acts on 2 (SetRenderMode
//     FUN_1809650c0 hides the scene object) and 0 (a fade switches it to 1); CClientAlphaProperty (FUN_180b80d00)
//     keeps mode & 7 but nothing reads it back. Translucency comes from alpha alone (renderamt, here 255): opaque.
// Blend modes other than opaque keep the exported material's transparency / alpha test.
import * as THREE from 'three';

const BLACK = new THREE.MeshBasicMaterial({ color: 0x000000, name: 'csgo_black_unlit' });

function shaderOf(m) {
  return String(m?.userData?.vmat?.ShaderName || '').toLowerCase();
}

// the unlit replacement for an exported material, or null when its shader is lit
export function unlitMaterial(m) {
  if (!m || m.userData?.cs2Unlit) return null;
  const shader = shaderOf(m);
  if (shader === 'csgo_black_unlit.vfx') return BLACK;
  if (shader !== 'csgo_unlitgeneric.vfx') return null;
  const tc = m.userData.vmat.VectorParams?.TextureColor;
  const color = new THREE.Color(1, 1, 1);
  // TextureColor is a linear colour (VRF writes vmat vectors as stored)
  if (Array.isArray(tc) && tc.length >= 3 && tc.slice(0, 3).every(Number.isFinite)) color.setRGB(tc[0], tc[1], tc[2]);
  const u = new THREE.MeshBasicMaterial({
    name: m.name, map: m.map || null, color, transparent: m.transparent, opacity: m.opacity, alphaTest: m.alphaTest,
    side: m.side, depthWrite: m.depthWrite, vertexColors: m.vertexColors,
  });
  u.userData = { ...m.userData, cs2Unlit: true };
  return u;
}

// a mesh's materials with every unlit shader swapped in (one replacement per source material, through `cache`)
export function applyUnlit(mesh, cache) {
  const one = (m) => {
    if (cache.has(m)) return cache.get(m);
    const u = unlitMaterial(m) || m;
    cache.set(m, u);
    return u;
  };
  mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
}
