// A baked sky cube (world/lightmaps.js `skies` entry, bake/SkyBake.cs) as a three cube texture: the env_sky behind
// everything (world/lighting.js setSky) and the csgo_moondome surfaces that show a cube (world/moondome.js).
//   rgbm:       > 0 for a quality tier's RGBM faces (rgb x a x rgbm)
//   decodeSrgb: 1 when an 8-bit cube is sRGB but the GPU can't decode it (the shader does: pow 2.2)
import * as THREE from 'three';

export function skyCubeTexture(sky) {
  if (sky.rgbmFaces) {
    const t = new THREE.CubeTexture(sky.rgbmFaces);
    t.colorSpace = THREE.NoColorSpace; t.flipY = false; t.generateMipmaps = false; t.premultiplyAlpha = false;
    t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
    return { tex: t, rgbm: sky.range, decodeSrgb: 0 };
  }
  const faces = [];
  for (let f = 0; f < 6; f++) {
    faces.push({ width: sky.width, height: sky.height, mipmaps: sky.mips.map((m) => {
      const face = m.bytes / 6;
      return { data: sky.data.subarray(m.offset + f * face, m.offset + (f + 1) * face), width: m.width, height: m.height };
    }) });
  }
  const tex = new THREE.CompressedCubeTexture(faces, sky.format);
  tex.minFilter = sky.mips.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  // an 8-bit sky is sRGB (sky.vfx reads it SrgbRead): decoded by the GPU when it can, else in the shader
  const ldr = sky.kind !== 'bc6h';
  tex.colorSpace = ldr && sky.srgbOk ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return { tex, rgbm: 0, decodeSrgb: ldr && !sky.srgbOk ? 1 : 0 };
}
