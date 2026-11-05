// CS2's csgo_water.vfx as GLSL for three.js (world/water-basic.js builds the material). Source of truth: CS2's own
// compiled shader (game/csgo/shaders_vulkan_dir.vpk, csgo_water_vulkan_50_{vs,ps}.vcs), decompiled with VRF 20.1's
// SPIR-V reflection for the static combo S_ANIMATED_NORMALS + S_FRESNEL + S_SHADER_QUALITY 1 (ps combo 328), its
// defaults and parameter expressions read from the same files. Unlit: the frame behind the water (refraction, tinted
// and fogged by the depth of water under the surface), the cubemaps (Fresnel), a directional highlight, then fog.
// What differs, and why:
//   - the cubemaps: world/lighting.js cs2EnvGather (the same box-parallax gather; CS2 also scales each cubemap by a
//     per-volume colour this bake doesn't carry). g_tFogCubeTexture (cubemap fog) isn't drawn; the map's fog is.
//   - g_tNormal is a texture array whose slices are animation frames; the bake writes each slice's (A, G) - CS2
//     reads .wy - as (R, G) with A = 1, so the frames upload unpremultiplied (WaterBake.cs).

export const BASIC_VS = `
uniform vec2 uNormalTexCoordScale, uNormalTexCoordOffset;
uniform vec4 g_vExtraTexCoordScroll;
uniform float g_flTime;
varying vec2 vUv0;
varying vec4 vUv1;
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  vWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  vNormalW = normalize( mat3( modelMatrix ) * normal );
  vUv0 = uv * uNormalTexCoordScale + uNormalTexCoordOffset;
  vUv1 = vec4( ( uv.x + uv.y ) * 0.1 + g_vExtraTexCoordScroll.x * g_flTime, ( uv.y - uv.x ) * 0.1 + g_vExtraTexCoordScroll.y * g_flTime,
    uv.y * 0.45 + g_vExtraTexCoordScroll.z * g_flTime, uv.x * 0.45 + g_vExtraTexCoordScroll.w * g_flTime );
  gl_Position = projectionMatrix * viewMatrix * vec4( vWorld, 1.0 );
}`;

export const BASIC_FS = (pars) => `
${pars}
uniform float g_flBumpStrength, g_flNormalMapAnimationTimePerFrame, g_flNormalMapAnimationTimeOffset, g_flRefractionAmount;
uniform float g_flWaterDepth, g_flWaterStart, g_flReflectance, g_flReflectionPower, g_flRefractionClipPlaneAdjust, uRoughness;
uniform vec3 g_vRefractionTint, g_vWaterFogColor, g_vReflectionDir, g_vReflectionColor;
uniform highp sampler2DArray g_tNormal;
uniform float g_flTime;
uniform vec3 uCamDir;
uniform sampler2D uSceneColor;
uniform highp sampler2D uSceneDepth;
uniform vec2 uViewport, uNearFar;
varying vec2 vUv0;
varying vec4 vUv1;
varying vec3 vWorld;
varying vec3 vNormalW;
#ifndef saturate
#define saturate(x) clamp(x, 0.0, 1.0) // three's prefix may already define it
#endif
float cs2InvViewZ( float d ) { float n = uNearFar.x, f = uNearFar.y; return ( f - d * ( f - n ) ) / ( n * f ); }
// one uv set, blended between the two animation frames around t
vec4 animatedNormal( vec2 uv, float t, float frames ) {
  float f0 = floor( t ), f1 = ceil( t );
  return mix( texture( g_tNormal, vec3( uv, f0 ) ), texture( g_tNormal, vec3( uv, mod( f1, frames ) ) ), vec4( t - f0 ) );
}
void main() {
  // normal: three uv sets, each between two frames, averaged
  float frames = float( textureSize( g_tNormal, 0 ).z );
  float tf = ( g_flTime + g_flNormalMapAnimationTimeOffset ) / g_flNormalMapAnimationTimePerFrame;
  float t = mod( tf, frames );
  vec2 n2 = ( ( animatedNormal( vUv0, t, frames ) + animatedNormal( vUv1.xy, t, frames ) + animatedNormal( vUv1.zw, t, frames ) ) * 0.33 ).xy * 2.0 - 1.0;
  vec3 n = vec3( n2.x, -n2.y, sqrt( saturate( 1.0 - dot( n2, n2 ) ) ) );
  n.xy *= g_flBumpStrength;
  n = normalize( n );
  // world X / Y and the surface normal (CS2 doesn't use the tangent here)
  vec3 N = normalize( vec3( 1.0, 0.0, 0.0 ) * n.x + vec3( 0.0, 1.0, 0.0 ) * n.y + normalize( vNormalW ) * n.z );
  vec3 V = normalize( vWorld - cameraPosition ); // camera -> surface
  vec3 toCam = -V;
  vec2 uv = gl_FragCoord.xy / uViewport;
  // the depth of water under the surface: the scene behind it, put back in the world, against the surface height
  float sceneZ = 1.0 / max( cs2InvViewZ( textureLod( uSceneDepth, uv, 0.0 ).x ), 1e-7 );
  vec3 hit = cameraPosition + V * ( sceneZ / dot( uCamDir, V ) );
  float depthFrac = saturate( ( 1.0 / ( g_flWaterDepth - g_flWaterStart ) ) * ( ( vWorld.z - g_flRefractionClipPlaneAdjust ) - hit.z + g_flWaterStart ) );
  // the reflection: the cubemaps along the bent reflection
  float r = uRoughness, r2 = r * r, s = saturate( 1.0 - r2 );
  vec3 R = normalize( mix( N, reflect( V, N ), vec3( s * ( sqrt( s ) + r2 ) ) ) );
  vec3 env = vec3( 0.0 );
#ifdef CS2_CUBEMAPS
  if ( cs2CubeVisible > 0 ) env = cs2EnvGather( vWorld, N, R, r, max( 0.0, sqrt( r ) * ( cs2CubeMips.x - 2.0 ) - cs2CubeMips.y ) ).rgb;
#endif
  // the refraction: offset by the normal, unless what's there is in front of the water
  vec2 ruv = uv - N.xy * ( g_flRefractionAmount * depthFrac );
  if ( textureLod( uSceneDepth, ruv, 0.0 ).x < gl_FragCoord.z ) ruv = uv;
  vec3 refr = texture( uSceneColor, ruv ).rgb;
  vec3 c = mix( mix( refr, refr * g_vRefractionTint, vec3( saturate( 3.5 * depthFrac ) ) ), g_vWaterFogColor, vec3( depthFrac ) )
    + env * saturate( 2.0 * depthFrac ) * ( ( g_flReflectance + ( 1.0 - g_flReflectance ) * pow( 1.0 - saturate( dot( toCam, N ) ), 5.0 ) ) * saturate( ( depthFrac - 0.05 ) * 20.0 ) );
  c += g_vReflectionColor * pow( saturate( dot( g_vReflectionDir, reflect( toCam, N ) ) ), g_flReflectionPower );
  gl_FragColor = vec4( cs2ApplyFog( saturate( c ), vWorld ), 1.0 );
}`;
