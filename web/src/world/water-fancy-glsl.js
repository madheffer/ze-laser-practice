// CS2's csgo_water_fancy.vfx as GLSL for three.js (world/water-fancy.js builds the material). Source of truth: CS2's own
// compiled shader, as decompiled and translated line by line by ValveResourceFormat (Renderer/Shaders/
// water_csgo.vert.slang + water_csgo.frag.slang); names and constants are kept so the two read side by side.
// Everything runs in Source world space (the world root carries glTF -> Source). What differs, and why:
//   - g_tWaterEffectsMap (the screen-space ripple / foam buffer players and bullets write in CS2) does not exist here:
//     every term read from it is folded to its neutral value (0.5 in the map = no disturbance), so those branches
//     drop out. g_bIsSkybox is always false (the 3D skybox is not drawn apart).
//   - CS2's depth reconstruction (1 / normalised depth = view Z) reads three's standard depth through cs2InvViewZ.
//   - g_tBlueNoise: interleaved gradient noise in place of CS2's blue-noise texture (same 0..1 dither role).
//   - DiffuseDirect: the runtime sun (directlight 2 / 3) x N.L x its baked lightmap visibility; DiffuseIndirect: the
//     lightmap (world/lighting.js). The environment: the map's cubemaps (cs2EnvSpecular), the lightmap light without.
//   - SSR marches three's view space (camera looks down -Z) with CS2's step growth, thickness, filter and fade.
//   - VRF's second caustics loop turns currWaveDir (the first loop's angle); here it turns its own, currWaveDir1.

export const WATER_VS = `
attribute vec4 tangent;
attribute vec2 uv1;
attribute vec4 _texcoord_4;
uniform float g_flWaterPlaneOffset;
uniform mat3 uLightmapUvTransform;
varying vec3 vFragPosition;
varying vec3 vNormalOut;
varying vec3 vTangentOut;
varying vec3 vBitangentOut;
varying vec4 vColorBlendValues;
varying vec2 vLightmapUV;
void main() {
  vec3 vPositionWs = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  vNormalOut = normalize( mat3( modelMatrix ) * normal );
  vTangentOut = normalize( mat3( modelMatrix ) * tangent.xyz );
  vBitangentOut = tangent.w * cross( vNormalOut, vTangentOut );
  vec3 vertDir = normalize( vPositionWs - cameraPosition );
  vec2 parallaxOffset = vertDir.xy / ( abs( vertDir.z ) > 1e-4 ? -vertDir.z : 1e-4 ) * 0.7;
  vPositionWs += vNormalOut * g_flWaterPlaneOffset;
  float pl = length( parallaxOffset );
  if ( pl > 1e-6 ) vPositionWs.xy += -( parallaxOffset / pl * clamp( pl, 0.0, 20.0 ) ) * g_flWaterPlaneOffset;
  vFragPosition = vPositionWs;
  vLightmapUV = ( uLightmapUvTransform * vec3( uv1, 1.0 ) ).xy;
  vColorBlendValues = _texcoord_4;
  gl_Position = projectionMatrix * viewMatrix * vec4( vPositionWs, 1.0 );
}`;

// the material's parameters (world/water.js PARAMS sets every one)
const UNIFORMS = `
uniform float g_flWaterPlaneOffset, g_flSkyBoxFadeRange, g_flWaterRoughnessMin, g_flWaterRoughnessMax, g_flFoamMin, g_flFoamMax;
uniform float g_flDebrisMin, g_flDebrisMax, g_flDebrisReflectance, g_flDebrisOilyness, g_flDebrisNormalStrength, g_flDebrisEdgeSharpness;
uniform float g_flDebrisScale, g_flDebrisWobble, g_flFoamScale, g_flFoamWobble, g_flWavesHeightOffset, g_flWavesSharpness;
uniform float g_flFresnelExponent, g_flWavesNormalStrength, g_flWavesNormalJitter, g_flWaterInitialDirection, g_flWavesSpeed;
uniform float g_flLowFreqWeight, g_flMedFreqWeight, g_flHighFreqWeight, g_flWavesPhaseOffset, g_flEdgeHardness, g_flEdgeShapeEffect;
uniform float g_flRefractionLimit, g_flWaterFogStrength, g_flRefractSampleOffset, g_flRefractChromaticSeparation;
uniform float g_flWaterDecayStrength, g_flWaterMaxDepth, g_flWaterFogShadowStrength, g_flUnderwaterDarkening;
uniform float g_flSpecularPower, g_flSpecularNormalMultiple, g_flSpecularBloomBoostStrength, g_flSpecularBloomBoostThreshold;
uniform float g_flCausticUVScaleMultiple, g_flCausticDistortion, g_flCausticsStrength, g_flCausticSharpness;
uniform float g_flCausticDepthFallOffDistance, g_flCausticShadowCutOff, g_flReflectance, g_flReflectionDistanceEffect;
uniform highp sampler2DArray g_tLowEndCubeMap; // the vmat's TextureLowEndCubeMap, six faces (world/water.js)
uniform float g_flLowEndCubeMapIntensity, uLowEndCube; // uLowEndCube: 1 when the bake has the material's cube
uniform float g_flEnvironmentMapBrightness, g_flGlossiness, g_flSSRStepSize, g_flSSRSampleJitter, g_flSSRBoostThreshold;
uniform float g_flSSRBoost, g_flSSRBrightness, g_flSSRMaxThickness;
uniform int g_nWaveIterations, g_nSSRMaxForwardSteps, g_bUseTriplanarCaustics;
uniform vec2 g_vMapUVMin, g_vMapUVMax, g_vWaveScale;
uniform vec3 g_vDebrisTint, g_vWaterFogColor, g_vWaterDecayColor, g_vCausticsTint;
uniform vec4 g_vFoamColor;
uniform sampler2D g_tFoam, g_tDebris, g_tDebrisNormal, g_tWavesNormalHeight;
uniform float g_flTime;
`;

export const WATER_FS = (pars) => `
${pars}
${UNIFORMS}
// the frame after the opaque pass (world/scenecopy.js)
uniform sampler2D uSceneColor;
uniform highp sampler2D uSceneDepth;
uniform vec2 uViewport, uNearFar;
// the light (world/water.js from world/lighting.js)
uniform sampler2D uLightmap;
uniform vec3 uSunColor;     // GetSunColor(): the light_environment's colour x brightness
uniform vec3 uSunDiffuse;   // the same while the sun is runtime (directlight 2 / 3), 0 when baked into the lightmap
uniform vec3 uSunDir;       // toward the sun
uniform vec3 uAmbient;      // the sky's ambient (lighting.ambient): the indirect light without a lightmap
uniform vec3 uCamDir, uCamUp;
uniform mat4 uProjection; // the camera's (three gives the fragment stage none)
varying vec3 vFragPosition;
varying vec3 vNormalOut;
varying vec3 vTangentOut;
varying vec3 vBitangentOut;
varying vec4 vColorBlendValues;
varying vec2 vLightmapUV;

#ifndef saturate
#define saturate(x) clamp(x, 0.0, 1.0) // three's prefix may already define it
#endif
float ClampToPositive( float x ) { return max( x, 0.0 ); }
float GetLuma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
float SafePow( float b, float e ) { return pow( max( b, 1e-6 ), e ); }
vec3 SafePow( vec3 b, vec3 e ) { return pow( max( b, vec3( 1e-6 ) ), e ); }
// 1 / view Z of a depth sample: CS2's sceneNormalizedDepth (its 1 / x is the view Z)
float cs2InvViewZ( float d ) { float n = uNearFar.x, f = uNearFar.y; return ( f - d * ( f - n ) ) / ( n * f ); }
float sceneInvZ( vec2 uv ) { return max( cs2InvViewZ( textureLod( uSceneDepth, uv, 0.0 ).x ), 0.0000001 ); }
vec3 cs2CalculateIridescence( float hue, float sat ) {
  vec3 c = clamp( abs( mod( hue * 6.0 + vec3( 0.0, 4.0, 2.0 ), 6.0 ) - 3.0 ) - 1.0, 0.0, 1.0 );
  return mix( vec3( 1.0 ), c, sat );
}

void main() {
  vec3 PositionWS = vFragPosition;
  vec3 GeometricNormal = normalize( vNormalOut );
  // g_tBlueNoise
  vec2 fc = gl_FragCoord.xy;
  vec4 blueNoiseZeroToOne = vec4( fract( 52.9829189 * fract( dot( fc, vec2( 0.06711056, 0.00583715 ) ) ) ),
    fract( 52.9829189 * fract( dot( fc + 17.0, vec2( 0.00583715, 0.06711056 ) ) ) ), 0.0, 0.0 );
  vec2 blueNoiseNegHalfToHalf = blueNoiseZeroToOne.xy - 0.5;
  float blueNoiseNegOneToOne = blueNoiseNegHalfToHalf.x * 2.0;

  vec2 gbufferUV = gl_FragCoord.xy / uViewport;
  vec2 unbiasedUV = ( PositionWS.xy - g_vMapUVMin ) / ( g_vMapUVMax - g_vMapUVMin );
  unbiasedUV.y = 1.0 - unbiasedUV.y;
  vec3 vPositionViewSpace = PositionWS - cameraPosition;
  vec3 viewDir = normalize( vPositionViewSpace );
  vec3 viewDirInv = -viewDir;
  vec2 viewParallaxFactor = viewDir.xy / ( viewDirInv.z + 0.25 );
  float distanceToFrag = length( vPositionViewSpace );
  vec3 viewDepOffsetFactor = vec3( viewDir.xy / viewDir.z, sqrt( ClampToPositive( viewDirInv.z ) ) );

  // INITIAL SCENE COLOR / DEPTH SAMPLE
  float sceneNormalizedDepth = sceneInvZ( gbufferUV );
  vec4 refractionColorSample = textureLod( uSceneColor, gbufferUV, 0.0 );
  float refractionDistortionFactor = clamp( GetLuma( refractionColorSample.rgb ), 0.0, 0.4 ) * -0.03;
  float sceneViewDistance = 1.0 / ( sceneNormalizedDepth * dot( uCamDir, viewDir ) );
  vec3 sceneHitPositionWs = cameraPosition + viewDir * sceneViewDistance;
  float waterSurfaceViewZ = -( viewMatrix * vec4( PositionWS, 1.0 ) ).z;
  float waterColumnOpticalDepthFactor = refractionDistortionFactor + ClampToPositive( 1.0 / sceneNormalizedDepth - waterSurfaceViewZ ) * 0.01;
  float adjustedWaterColumnDepth = ClampToPositive( waterColumnOpticalDepthFactor - 0.02 );
  float refractedVerticalFactor = waterColumnOpticalDepthFactor * viewDirInv.z;

  float currentWaterRoughness = ClampToPositive( mix( g_flWaterRoughnessMin, g_flWaterRoughnessMax, vColorBlendValues.x ) );
  float currentFoamAmount = ClampToPositive( mix( g_flFoamMin, g_flFoamMax, vColorBlendValues.y ) );
  float currentDebrisVisibility = ClampToPositive( mix( g_flDebrisMin, g_flDebrisMax, vColorBlendValues.z ) );

  vec2 baseWaveUV = ( PositionWS.xy + viewDepOffsetFactor.xy * ( 0.5 - g_flWaterPlaneOffset ) ) / 30.0;
  vec2 baseWaveUVDx = dFdx( baseWaveUV ), baseWaveUVDy = -dFdy( baseWaveUV );
  float reflectionsLodFactor = 0.5 * pow( max( dot( baseWaveUVDx, baseWaveUVDx ), dot( baseWaveUVDy, baseWaveUVDy ) ), 0.1 ) * g_flReflectionDistanceEffect;
  float clampedLodFactor = clamp( reflectionsLodFactor, 0.0, 0.5 );

  vec3 refractShiftedPos = sceneHitPositionWs + viewDepOffsetFactor * clamp( GetLuma( refractionColorSample.rgb ), 0.0, 0.4 );
  vec3 reconstructedWorldNormal = -normalize( cross( dFdx( refractShiftedPos ), -dFdy( refractShiftedPos ) ) );
  float timeAnim = g_flTime * 3.0 + sin( g_flTime * 0.5 ) * 0.1;
  vec2 depthFactorFine = vec2( saturate( adjustedWaterColumnDepth * 10.0 ) );
  vec2 depthFactorCoarse = vec2( saturate( adjustedWaterColumnDepth * 4.0 ) );
  float sceneDepthChangeMagnitude = fwidth( sceneNormalizedDepth );
  vec2 ditheredRefractShiftNormalXY = reconstructedWorldNormal.xy + blueNoiseNegHalfToHalf * 0.05;

  // WAVES (no effects map: totalDisturbanceStrength = disturbanceWeightedFoamAmount = 0)
  vec2 accumulatedWaveUVOffset = vec2( 0.0 );
  vec2 currentWaveTexScale = g_vWaveScale;
  vec3 accumulatedWaveNormal = vec3( 0.0, 0.0, 1.0 );
  float accumulatedWaveHeight = 0.0;
  vec2 accumulatedPhaseOffset = vec2( 0.0 );
  float currentWaveAngle = g_flWaterInitialDirection;
  for ( int i = 0; i < 16; i++ ) {
    if ( i >= g_nWaveIterations ) break;
    float iterProgress = float( i ) / max( float( g_nWaveIterations ) - 1.0, 1.0 );
    float lowMedBlend = saturate( iterProgress * 2.0 ), medHighBlend = saturate( iterProgress * 2.0 - 1.0 );
    float freqWeight = mix( mix( g_flLowFreqWeight, g_flMedFreqWeight, lowMedBlend ), g_flHighFreqWeight * currentWaterRoughness, medHighBlend );
    vec2 waveAnimOffset = vec2( sin( currentWaveAngle ), cos( currentWaveAngle ) ) * ( g_flTime * g_flWavesSpeed ) * 0.5;
    vec2 anisoUV = waveAnimOffset * inversesqrt( currentWaveTexScale );
    vec2 waveSampleUV1 = anisoUV + ( baseWaveUV + accumulatedWaveUVOffset * 3.0 + accumulatedPhaseOffset ) / currentWaveTexScale;
    vec3 s1 = texture( g_tWavesNormalHeight, waveSampleUV1, -clampedLodFactor ).xyz - vec3( 0.5 );
    float waveHeightComponent1 = s1.z * freqWeight * length( currentWaveTexScale ) * 0.01;
    vec2 n1 = s1.xy * 2.0;
    n1.x *= min( 1.0, currentWaveTexScale.y / currentWaveTexScale.x );
    n1.y *= min( 1.0, currentWaveTexScale.x / currentWaveTexScale.y );
    n1 *= freqWeight * 0.1;
    vec2 gerstnerDisplacement = -viewParallaxFactor * waveHeightComponent1 * g_flWavesHeightOffset * currentWaterRoughness;
    vec2 waveNormalDisplacement = n1 * g_flWavesSharpness * currentWaveTexScale * g_flWavesPhaseOffset;
    vec2 waveSampleUV2 = anisoUV + ( baseWaveUV + ( accumulatedWaveUVOffset + gerstnerDisplacement ) * 3.0 + accumulatedPhaseOffset + waveNormalDisplacement ) / currentWaveTexScale;
    vec3 s2 = texture( g_tWavesNormalHeight, waveSampleUV2, -clampedLodFactor ).xyz - vec3( 0.5 );
    vec2 n2 = s2.xy * 2.0;
    n2.x *= min( 1.0, currentWaveTexScale.y / currentWaveTexScale.x );
    n2.y *= min( 1.0, currentWaveTexScale.x / currentWaveTexScale.y );
    n2 *= freqWeight * 0.1;
    accumulatedWaveUVOffset += gerstnerDisplacement;
    accumulatedWaveNormal.xy += n2;
    currentWaveTexScale *= g_flWavesPhaseOffset;
    accumulatedPhaseOffset += n1 * g_flWavesSharpness * currentWaveTexScale;
    accumulatedWaveHeight += s2.z * freqWeight * length( currentWaveTexScale ) * 0.01;
    currentWaveAngle += 3.5 / float( i + 1 );
  }
  vec2 finalWavePhaseOffset = accumulatedPhaseOffset * 0.1;
  vec3 roughedWaveNormal = accumulatedWaveNormal * currentWaterRoughness;
  float scaledAccumulatedWaveHeight = accumulatedWaveHeight * currentWaterRoughness * 60.0;

  vec3 ditheredNormal = vec3( 0.0, 0.0, 1.0 );
  float edgeFactorQ = g_flEdgeShapeEffect;
#if F_REFRACTION == 1
  ditheredNormal = vec3( ditheredRefractShiftNormalXY, reconstructedWorldNormal.z );
  edgeFactorQ = g_flEdgeShapeEffect * saturate( -reconstructedWorldNormal.z * ( 1.0 - saturate( refractedVerticalFactor * 8.0 ) ) + 1.2 );
#endif

  // effects map neutral: no ripple displacement, foam, silt or extra disturbance
  float finalFoamHeightContrib = scaledAccumulatedWaveHeight;
  float finalFoam = 0.0;
  float debrisDisturbanceForWaves = 0.0;
  vec3 effectsSamplePos = PositionWS + viewDepOffsetFactor * ( mix( 0.5, finalFoamHeightContrib, edgeFactorQ ) - g_flWaterPlaneOffset );
  vec3 worldPosForFoamAndDebrisBase = PositionWS + viewDepOffsetFactor * ( mix( 0.5, finalFoamHeightContrib, edgeFactorQ * 0.5 ) - g_flWaterPlaneOffset );

  // FOAM
  vec2 foamWobbleAnim = vec2( sin( effectsSamplePos.y * 0.07 + timeAnim ), cos( effectsSamplePos.x * 0.07 + timeAnim ) );
  vec2 foamBaseUV = worldPosForFoamAndDebrisBase.xy / g_flFoamScale;
  vec2 foamWobbleEffect = foamBaseUV + finalWavePhaseOffset * g_flFoamWobble * 0.5 * ( 1.0 - currentFoamAmount );
  float foamNoiseStrength = finalFoam + 0.05;
  vec4 foamSample1 = texture( g_tFoam, mix( foamBaseUV, foamWobbleEffect + foamWobbleAnim * foamNoiseStrength * 0.03, depthFactorFine ) );
  vec2 sample2Mix2 = foamWobbleEffect.yx * 0.731 + vec2( sin( effectsSamplePos.y * 0.06 + timeAnim ), cos( effectsSamplePos.x * 0.06 + timeAnim ) ) * foamNoiseStrength * 0.02;
  vec4 foamSample2 = texture( g_tFoam, mix( foamBaseUV.yx * 0.731, sample2Mix2, depthFactorFine ) );
  float combinedFoamTextureValue = sin( blueNoiseZeroToOne.x ) * 0.125 + max( foamSample1.z, foamSample2.z );
  float finalFoamIntensity = saturate( currentFoamAmount * ( finalFoamHeightContrib * 0.008 + 1.0 ) * ( 1.0 - saturate( debrisDisturbanceForWaves * 2.0 ) ) );
  float finalFoamPow1_5 = pow( finalFoam, 1.5 );

  // DEBRIS
  vec2 debrisBaseUV = worldPosForFoamAndDebrisBase.xy / g_flDebrisScale;
  vec2 debrisWobbleOffset = finalWavePhaseOffset * g_flDebrisWobble;
  vec2 debrisDistortedUV = debrisBaseUV + debrisWobbleOffset * ( 1.0 - currentDebrisVisibility );
  debrisDistortedUV += viewParallaxFactor * ( ( sin( finalFoam * 50.0 ) * 4.0 * saturate( 0.1 - finalFoamPow1_5 ) + 1.0 ) * finalFoamPow1_5 ) * 0.1;
  debrisDistortedUV += foamWobbleAnim * ( 0.1 + finalFoam ) * 0.02;
  vec2 debrisFinalUV = mix( debrisBaseUV, debrisDistortedUV, depthFactorCoarse );
  vec4 debrisColorHeightSample = texture( g_tDebris, debrisFinalUV, finalFoamPow1_5 * 3.0 );
  float debrisHeightVal = debrisColorHeightSample.a - 0.5;
  float finalDebrisVisibility = -currentDebrisVisibility * clamp( 1.4 - finalFoam / mix( 1.0, 0.4, debrisColorHeightSample.w ), 0.0, 1.0 ) + 1.0;
  float debrisEdgeFactor = saturate( ( debrisColorHeightSample.a - finalDebrisVisibility ) * g_flDebrisEdgeSharpness );
  float noClue = max( 0.0, 2.0 * finalFoamPow1_5 + debrisHeightVal * -2.0 );
  float debrisVisibilityMask = saturate( -noClue * 10.0 + 1.0 );
  float finalDebrisFactor = debrisVisibilityMask * debrisEdgeFactor;
  vec3 debrisNormalSample = texture( g_tDebrisNormal, debrisFinalUV ).xyz - vec3( 0.5 );
  debrisNormalSample.y *= -1.0;
  vec2 debrisNormalXY = debrisNormalSample.xy * g_flDebrisNormalStrength;
  float combinedfinalFoamIntensity = saturate( -debrisVisibilityMask * debrisEdgeFactor + ( finalFoamIntensity * combinedFoamTextureValue * 0.25 + saturate( finalFoamIntensity - ( 1.0 - combinedFoamTextureValue ) ) * 0.75 ) );
  float finalDebrisFoamHeightContrib = mix( finalFoamHeightContrib, finalFoamHeightContrib * 0.5 + debrisHeightVal * 2.0, finalDebrisFactor );
  float weirdMixVal = debrisEdgeFactor * saturate( max( 0.0, debrisHeightVal * -2.0 ) * 10.0 + 1.0 );
  float matHeight = mix( scaledAccumulatedWaveHeight, scaledAccumulatedWaveHeight * 0.5 + debrisHeightVal * 2.0, weirdMixVal );

  vec3 finalSurfacePos = PositionWS + viewDepOffsetFactor * ( mix( 0.5, matHeight, edgeFactorQ ) - g_flWaterPlaneOffset );
  float finalWaterColumnDepthForRefract = ClampToPositive( 1.0 / sceneNormalizedDepth - -( viewMatrix * vec4( finalSurfacePos, 1.0 ) ).z ) * 0.01 + refractionDistortionFactor;
  float surfaceCoverageAlpha = saturate( debrisEdgeFactor + combinedfinalFoamIntensity );

  // NORMAL
  vec2 finalWaveNormalXY = roughedWaveNormal.xy * 2.0 * g_flWavesNormalStrength * mix( 1.0, 2.0, reflectionsLodFactor );
  finalWaveNormalXY *= saturate( 0.2 - finalWaterColumnDepthForRefract ) * 8.0 + 1.0;
  finalWaveNormalXY += debrisNormalXY * finalDebrisFactor * 1.5;
  finalWaveNormalXY += mix( foamSample1.xy - vec2( 0.5 ), foamSample2.xy - vec2( 0.5 ), vec2( float( foamSample2.z > foamSample1.z ) ) ) * combinedfinalFoamIntensity;
  finalWaveNormalXY *= vec2( 1.0 ) + blueNoiseNegHalfToHalf * 2.0 * g_flWavesNormalJitter;
  vec3 NormalMap = vec3( finalWaveNormalXY, sqrt( 1.0 - saturate( dot( finalWaveNormalXY, finalWaveNormalXY ) ) ) );
  vec2 perturbedNormalXY = NormalMap.xy * 3.0;
  vec3 perturbedSurfaceNormal = vec3( perturbedNormalXY, sqrt( 1.0 - saturate( dot( perturbedNormalXY, perturbedNormalXY ) ) ) );
  vec3 finalPerturbedSurfaceNormal = perturbedSurfaceNormal;
#if F_REFRACTION == 1
  {
    float k = mix( 60.0, 120.0, ditheredNormal.z );
    vec3 edgeLimitFactor = vec3( clamp( -sceneDepthChangeMagnitude * 1000.0 + clamp( ( 1.0 / k - finalWaterColumnDepthForRefract ) * k, 0.0, 1.0 ) + saturate( ( 0.025 - finalWaterColumnDepthForRefract ) * 8.0 ), 0.0, 1.0 ) / ( distanceToFrag * 0.002 + 1.0 ) * 0.6 );
    NormalMap = normalize( mix( NormalMap, ditheredNormal, edgeLimitFactor ) );
    finalPerturbedSurfaceNormal = normalize( mix( perturbedSurfaceNormal, ditheredNormal, edgeLimitFactor ) );
  }
#endif
  vec3 sunColor = uSunColor, sunDir = uSunDir;
  float cosNormAngle = saturate( dot( viewDirInv, finalPerturbedSurfaceNormal ) );
  float fresnel = SafePow( 1.0 - cosNormAngle, g_flFresnelExponent );
  vec3 finalFoamColor = g_vFoamColor.rgb * ( combinedfinalFoamIntensity * 0.5 + 1.0 );

  // REFRACTION
  float foamSiltStrength = g_flWaterFogStrength;
  vec2 refractionUVOffsetRaw = ( vec2( dot( finalPerturbedSurfaceNormal.xy, cross( viewDirInv, vec3( 0.0, 0.0, -1.0 ) ).xy ), dot( finalPerturbedSurfaceNormal.xy, viewDirInv.xy ) ) + blueNoiseNegHalfToHalf * 0.002 * g_flWaterFogStrength ) * min( g_flRefractionLimit, finalWaterColumnDepthForRefract );
  float surfaceDepth = -( viewMatrix * vec4( finalSurfacePos, 1.0 ) ).z;
  float waterExtent = 1.0 / sceneInvZ( gbufferUV + refractionUVOffsetRaw ) - surfaceDepth;
  float refractionOffsetAttenuation = clamp( ( ClampToPositive( waterExtent ) * 0.01 + refractionDistortionFactor ) * 10.0, 0.0, 1.0 );
  vec2 finalRefractionUVOffset = refractionUVOffsetRaw * refractionOffsetAttenuation;
  float finalRefractedNormalizedDepth = sceneInvZ( gbufferUV + finalRefractionUVOffset );
#if F_BLUR_REFRACTION == 1
  float we = ClampToPositive( waterExtent ) * 0.01;
  float smallOffset = 0.001 * we;
  vec4 sample1 = textureLod( uSceneColor, clamp( gbufferUV + finalRefractionUVOffset + vec2( 0.0, smallOffset ), 0.0, 1.0 ), 0.0 );
  vec4 sample2 = textureLod( uSceneColor, clamp( gbufferUV + finalRefractionUVOffset * ( 1.0 + g_flRefractSampleOffset * we ), 0.0, 1.0 ), 0.0 );
  vec4 sample3 = textureLod( uSceneColor, clamp( gbufferUV + finalRefractionUVOffset * ( 1.0 + g_flRefractSampleOffset * we * 2.0 ) - vec2( 0.0, smallOffset ), 0.0, 1.0 ), 0.0 );
  vec4 sample4 = textureLod( uSceneColor, clamp( gbufferUV + finalRefractionUVOffset * ( 1.0 + g_flRefractSampleOffset * we * 3.0 ) + vec2( smallOffset, 0.0 ), 0.0, 1.0 ), 0.0 );
  vec4 sample5 = textureLod( uSceneColor, clamp( gbufferUV + finalRefractionUVOffset * ( 1.0 + g_flRefractSampleOffset * we * 4.0 ) - vec2( smallOffset, 0.0 ), 0.0, 1.0 ), 0.0 );
  vec4 finalRefractedColor = ( sample5 * mix( vec4( 1.0 ), vec4( 2.0, 0.0, 0.0, 1.0 ), g_flRefractChromaticSeparation )
    + sample4 * mix( vec4( 1.0 ), vec4( 2.0, 2.0, 0.0, 1.0 ), g_flRefractChromaticSeparation )
    + sample3 * mix( vec4( 1.0 ), vec4( 0.0, 3.0, 0.0, 1.0 ), g_flRefractChromaticSeparation )
    + sample2 * mix( vec4( 1.0 ), vec4( 1.0, 0.0, 2.0, 1.0 ), g_flRefractChromaticSeparation )
    + sample1 * mix( vec4( 1.0 ), vec4( 0.0, 0.0, 3.0, 1.0 ), g_flRefractChromaticSeparation ) ) * 0.2;
#else
  vec4 finalRefractedColor = textureLod( uSceneColor, saturate( gbufferUV + finalRefractionUVOffset ), 0.0 );
#endif
  vec3 darkenedRefractedColor = pow( max( finalRefractedColor.rgb, vec3( 0.0 ) ), vec3( 1.1 ) ) * g_flUnderwaterDarkening;
  vec3 combinedRefractedColor = darkenedRefractedColor;
  float causticDebrisCoverageW = 0.0;
#if F_CAUSTICS == 1
  float causticVisibility = clamp( ( GetLuma( darkenedRefractedColor ) - g_flCausticShadowCutOff ) * ( 2.0 + g_flCausticShadowCutOff ), 0.0, 1.0 );
  if ( causticVisibility > 0.0 ) {
    vec3 refractedViewDir = -normalize( viewDirInv + uCamUp * finalRefractionUVOffset.y * 2.0 + cross( uCamDir, uCamUp ) * -finalRefractionUVOffset.x * 2.0 );
    vec3 refractedSceneHitPosWs = cameraPosition + normalize( refractedViewDir ) * sceneViewDistance;
    vec3 causticsLightDir = sunDir;
    if ( g_bUseTriplanarCaustics == 1 ) {
      vec3 e = abs( ditheredNormal );
      causticsLightDir = mix( sunDir, e.z > max( e.x, e.y ) ? vec3( 0.0, 0.0, 1.0 ) : ( e.y < e.x ? vec3( 1.0, 0.0, 1.0 ) : vec3( 0.0, 1.0, 1.0 ) ), vec3( 0.65 ) );
    }
    float causticsDepth = worldPosForFoamAndDebrisBase.z - refractedSceneHitPosWs.z;
    vec3 causticRayTarget = mix( refractedSceneHitPosWs + causticsLightDir * causticsLightDir.z * causticsDepth, finalSurfacePos, vec3( clamp( pow( blueNoiseZeroToOne.x, 2.0 ) * foamSiltStrength * 0.0125, 0.0, 1.0 ) ) );
    float distToCausticTarget = distance( causticRayTarget, refractedSceneHitPosWs );
    vec2 causticDebrisUV = causticRayTarget.xy / g_flDebrisScale;
    vec4 causticDebrisSample = texture( g_tDebris, mix( causticDebrisUV, causticDebrisUV + debrisWobbleOffset * finalDebrisVisibility + viewParallaxFactor * noClue * 0.1 + foamWobbleAnim * 0.1 * 0.04, depthFactorCoarse ), causticsDepth * 0.05 );
    float causticDebrisCoverage = clamp( ( -finalDebrisVisibility * 0.9 + causticDebrisSample.w - debrisEdgeFactor ) * 1.1, 0.0, 1.0 );
    float causticDepthFalloffPre = distToCausticTarget / g_flCausticDepthFallOffDistance;
    float causticDepthFalloff = saturate( 1.0 - causticDepthFalloffPre );
    float causticBaseIntensity = causticVisibility * saturate( distToCausticTarget * 0.05 ) * causticDepthFalloff;
    if ( g_bUseTriplanarCaustics == 0 ) causticBaseIntensity *= saturate( dot( ditheredNormal, causticsLightDir ) );
    vec2 causticWaveUVBase = causticRayTarget.xy * ( 1.0 / 30.0 ) * g_flCausticUVScaleMultiple;
    float lodOffset = ( -g_flCausticSharpness * causticDepthFalloff + 1.0 ) * 6.0;
    vec2 currWaveScale = g_vWaveScale, currWaveNormalXY = vec2( 0.0 );
    float currWaveDir = g_flWaterInitialDirection;
    for ( int i = 0; i < 3; i++ ) {
      vec2 localUV = vec2( sin( currWaveDir ), cos( currWaveDir ) ) * ( g_flTime * g_flWavesSpeed * 0.5 ) * sqrt( vec2( 1.0 ) / currWaveScale ) + ( causticWaveUVBase + currWaveNormalXY ) / currWaveScale;
      vec3 rawSample = texture( g_tWavesNormalHeight, localUV, lodOffset ).xyz;
      currWaveNormalXY += ( rawSample - vec3( 0.5 ) ).xy * 0.5 * g_flCausticDistortion * ( vec2( 1.0 ) + currWaveScale ) * ( 0.25 + causticDepthFalloffPre );
      currWaveScale *= g_flWavesPhaseOffset;
      currWaveDir += 3.5 / float( i + 1 );
    }
    vec2 currWaveScale1 = g_vWaveScale;
    float currWaveDir1 = g_flWaterInitialDirection;
    vec3 currWaveSampleSum1 = vec3( 0.0 );
    for ( int i = 0; i < 3; i++ ) {
      float causticIterProgress = float( i ) / max( float( g_nWaveIterations ) - 1.0, 1.0 );
      vec2 uv = vec2( sin( currWaveDir1 ), cos( currWaveDir1 ) ) * ( g_flTime * g_flWavesSpeed * 0.5 ) * sqrt( vec2( 1.0 ) / currWaveScale1 ) + ( causticWaveUVBase + currWaveNormalXY ) / currWaveScale1;
      vec3 rawSample = vec3( texture( g_tWavesNormalHeight, uv, lodOffset ).z );
      vec3 exponent = vec3( causticDepthFalloff * g_flCausticSharpness * 5.0 );
      float factor = clamp( mix( mix( debrisDisturbanceForWaves * 0.1 + g_flLowFreqWeight, g_flMedFreqWeight + debrisDisturbanceForWaves, saturate( causticIterProgress * 2.0 ) ), g_flHighFreqWeight * currentWaterRoughness + debrisDisturbanceForWaves, saturate( causticIterProgress * 2.0 - 1.0 ) ), 0.1, 0.4 );
      currWaveSampleSum1 += SafePow( rawSample, exponent ) * factor * ( vec3( 1.0 ) + currWaveSampleSum1 * 2.0 ) * causticDepthFalloff * ( causticDepthFalloff * g_flCausticSharpness ) * 2.0;
      currWaveScale1 *= g_flWavesPhaseOffset;
      currWaveDir1 += 3.5 / float( i + 1 );
    }
    vec3 causticsModifier = currWaveSampleSum1 * mix( 1.0, 0.0, saturate( causticDebrisCoverage * 2.0 ) );
    float cmx = causticsModifier.x;
    vec3 powA = max( causticsModifier * ( vec3( 1.0 ) + vec3( 1.25, -0.25, -1.0 ) * ( clamp( dFdx( cmx ) * 200.0, -1.0, 1.0 ) * saturate( -cmx * 3.0 + 1.0 ) ) ), vec3( 0.001 ) ) * 8.0;
    vec3 modifiedCausticsRefractColor = darkenedRefractedColor * ( vec3( 1.0 ) + pow( powA, vec3( 2.5 ) ) * causticBaseIntensity * sunColor * g_vCausticsTint * g_flCausticsStrength * 0.1 );
    float l02 = pow( GetLuma( modifiedCausticsRefractColor ), 0.2 );
    float edge = clamp( dFdx( l02 ), -1.0, 1.0 ) + clamp( -dFdy( l02 ), -1.0, 1.0 );
    causticDebrisCoverageW = causticDebrisCoverage;
    combinedRefractedColor = mix( modifiedCausticsRefractColor, modifiedCausticsRefractColor * ( vec3( 1.0 ) + vec3( 2.5, 0.0, -2.0 ) * float( int( sign( edge * saturate( abs( edge ) - 0.1 ) ) ) ) ), vec3( saturate( 200.0 / distanceToFrag ) * 0.1 ) );
  }
#endif
  float postCausticsWaterColumnDepth = ClampToPositive( 1.0 / finalRefractedNormalizedDepth - surfaceDepth ) * 0.01 + refractionDistortionFactor;

  // WATER FOG
  float effectiveWaterDepthForFog = min( g_flWaterMaxDepth, postCausticsWaterColumnDepth );
  vec3 waterDecayColorFactor = exp( ( g_vWaterDecayColor - vec3( 1.0 ) ) * g_flWaterDecayStrength * effectiveWaterDepthForFog );
  float totalFogStrength = foamSiltStrength;
  float foamDebrisForFogMix = finalFoamIntensity;
  float waterFogAlpha = ( -saturate( blueNoiseZeroToOne.x ) * 0.25 + foamDebrisForFogMix ) * 0.1 + 1.0 - exp( -effectiveWaterDepthForFog * totalFogStrength );
  vec3 baseFogColor = mix( g_vWaterFogColor, finalFoamColor, vec3( foamDebrisForFogMix * 0.1 ) ) * mix( waterDecayColorFactor, vec3( 1.0 ), vec3( saturate( totalFogStrength * 0.04 ) ) );

  vec3 finalDirToCam = -normalize( finalSurfacePos - cameraPosition );
  float specularCosAlpha = clamp( dot( -sunDir, reflect( finalDirToCam, normalize( mix( GeometricNormal, finalPerturbedSurfaceNormal, vec3( g_flSpecularNormalMultiple * ( distanceToFrag * 0.0005 + 1.0 ) ) ) ) ) ), 0.0001, 1.0 );
  float specularExponent = mix( g_flSpecularPower, g_flDebrisReflectance * 8.0, debrisEdgeFactor ) * mix( 2.0, 0.2, saturate( currentWaterRoughness ) );
  float specularFactor = pow( specularCosAlpha, specularExponent ) * 0.1 + pow( specularCosAlpha, specularExponent * 10.0 );
  float inverseWaterFogAlpha = 1.0 - waterFogAlpha;
  float waterOpacity = saturate( 1.0 - debrisEdgeFactor + noClue ) * saturate( -combinedfinalFoamIntensity * 4.0 + 1.0 ) * inverseWaterFogAlpha;
  vec3 Albedo = mix( mix( baseFogColor * waterFogAlpha * g_flWaterFogShadowStrength, finalFoamColor, vec3( combinedfinalFoamIntensity ) ),
    debrisColorHeightSample.xyz * ( finalDebrisFactor * 0.5 + 0.5 ) * g_vDebrisTint, vec3( saturate( debrisEdgeFactor - noClue ) ) );
  vec3 Normal = normalize( mat3( normalize( vTangentOut ), normalize( vBitangentOut ), GeometricNormal ) * NormalMap );

  // LIGHT: the sun (runtime only) and the lightmap, its uv dithered as CS2 does
  float squaredWaterOpacity = waterOpacity * waterOpacity;
  float k12400 = mix( 1.0, effectiveWaterDepthForFog * 2.0, 0.75 );
  vec2 lmUv = vLightmapUV + fwidth( vLightmapUV ) * 1200.0 / distanceToFrag * cosNormAngle * -viewParallaxFactor * vec2( -1.0, 1.0 )
    * ( vec2( finalDebrisFoamHeightContrib * -2.0 ) + mix( blueNoiseZeroToOne.yy, blueNoiseZeroToOne.yx, vec2( 0.1 ) ) * 20.0 * squaredWaterOpacity ) * k12400;
#ifdef CS2_NO_LIGHTMAP
  // no lightmap (an entity's model, or baked lighting off): the sky's ambient, the sun unshadowed
  vec3 DiffuseIndirect = uAmbient;
#else
  vec4 lmTexel = texture( uLightmap, lmUv );
  vec3 DiffuseIndirect = cs2IrrRange > 0.0 ? lmTexel.rgb * lmTexel.a * cs2IrrRange : lmTexel.rgb;
#endif
#ifdef CS2_SHADOWS
  float sunVis = clamp( 1.0 - dot( texture( cs2Shadows, lmUv ), cs2SunMask ), 0.0, 1.0 );
#else
  float sunVis = 1.0;
#endif
  vec3 DiffuseDirect = uSunDiffuse * saturate( dot( Normal, sunDir ) ) * sunVis;
  // CS2 starts from a per-view term (PerViewLighting c18: scenesystem fills it from an int view attribute, so 0 here)
  // CS2 adds every light of the view's clusters here (g_BarnLights: N.L x colour x falloff x 1 - its baked shadow channel):
  // the map's light_omni2s, as the world draws them (world/maplights.js), each masked by its channel of the shadow lightmap
#ifndef CS2_NO_LIGHTMAP
#ifdef CS2_SHADOWS
  vec4 mapShadow = texture( cs2Shadows, lmUv );
#else
  vec4 mapShadow = vec4( 0.0 );
#endif
  for ( int mi = 0; mi < 16; mi++ ) {
    if ( mi >= cs2MapCount ) break;
    vec3 mv = cs2MapPos[ mi ] - finalSurfacePos;
    float md = length( mv );
    vec2 mf = cs2MapFade[ mi ];
    if ( md >= mf.x ) continue;
    float mt = clamp( ( mf.x - md ) / max( mf.x - mf.y, 1e-3 ), 0.0, 1.0 );
    float mvis = clamp( 1.0 - dot( mapShadow, cs2MapMask[ mi ] ), 0.0, 1.0 );
    DiffuseDirect += cs2MapColor[ mi ] * ( mt * mt * ( 3.0 - 2.0 * mt ) / max( md * md, 1.0 ) * mvis ) * max( 0.0, dot( Normal, mv / max( md, 1e-6 ) ) );
  }
#endif
  vec3 returnColor = mix( ( DiffuseDirect + DiffuseIndirect ) * Albedo, combinedRefractedColor * waterDecayColorFactor, vec3( waterOpacity ) );
  returnColor = mix( returnColor, baseFogColor * 4.0 * DiffuseIndirect, vec3( waterFogAlpha * saturate( 1.0 - surfaceCoverageAlpha + noClue ) * ( 1.0 - g_flWaterFogShadowStrength ) ) );

  // REFLECTION
  vec2 roughV = vec2( max( 0.01, 1.0 - g_flGlossiness ) );
  float roughnessForCubemap = dot( mix( roughV, vec2( 1.0 ), vec2( clamp( reflectionsLodFactor, 0.0, 0.35 ) ) ), vec2( 0.5 ) );
  float matRoughness = sqrt( roughnessForCubemap );
  vec3 tempSurfNormal = NormalMap;
  tempSurfNormal.xy *= 6.0;
  tempSurfNormal = mat3( viewMatrix ) * normalize( tempSurfNormal );
  tempSurfNormal.yz *= 2.0;
  tempSurfNormal = transpose( mat3( viewMatrix ) ) * normalize( tempSurfNormal );
  // CS2's base reflection (the decompiled ps): the material's own low-end cube along the reflected view, x the lightmap's
  // luma x g_flLowEndCubeMapIntensity x g_flEnvironmentMapBrightness (not the map's cubemaps). Its lod (one mip in the
  // cubes seen so far) is sqrt(roughness) x 6. Without the cube baked: the lightmap light, as before
  vec3 finalReflectionColor = DiffuseIndirect;
  if ( uLowEndCube > 0.5 ) {
    vec3 lowEndDir = -reflect( finalDirToCam, Normal );
    vec3 lf = cs2CubeFace( lowEndDir );
    finalReflectionColor = textureLod( g_tLowEndCubeMap, lf, matRoughness * 6.0 ).rgb * ( GetLuma( DiffuseIndirect ) * g_flLowEndCubeMapIntensity ) * g_flEnvironmentMapBrightness;
  }
#if F_REFLECTION_TYPE == 2
  {
    // CS2: x (0.5 + 0.5 * !g_bIsSkybox): the full count for world water; none looking straight down
    float stepMul = saturate( ( uCamDir.z + 0.75 ) * 4.0 );
    int SSRStepCount = int( float( g_nSSRMaxForwardSteps ) * stepMul );
    if ( SSRStepCount > 0 ) {
      float SsrHitThickness = blueNoiseNegOneToOne * g_flSSRSampleJitter + g_flSSRMaxThickness;
      vec3 SSNormal = mat3( viewMatrix ) * normalize( vec3( NormalMap.xy * 3.0 * 2.0, NormalMap.z ) );
      SSNormal.yz *= 2.0;
      vec3 viewSpacePos = ( viewMatrix * vec4( finalSurfacePos, 1.0 ) ).xyz;
      float stepSize = ( blueNoiseNegOneToOne * g_flSSRSampleJitter + g_flSSRStepSize ) / ( reflectionsLodFactor * 2.0 + 1.0 ) * mix( 20.0, 1.0, cosNormAngle );
      vec3 dir = normalize( reflect( normalize( viewSpacePos ), normalize( SSNormal ) ) );
      vec3 prevPos = viewSpacePos;
      vec4 c0 = uProjection * vec4( viewSpacePos, 1.0 );
      vec2 prevUV = c0.xy / c0.w * 0.5 + 0.5, hitUV = prevUV;
      float prevGap = 0.0, frac = 0.0;
      int i = 1;
      for ( ; i <= 400; i++ ) {
        if ( i > SSRStepCount ) break;
        stepSize *= 1.15;
        vec3 p = prevPos + dir * stepSize;
        vec4 c = uProjection * vec4( p, 1.0 );
        vec2 uv = c.xy / c.w * 0.5 + 0.5;
        // > 0: the ray is behind what the depth buffer holds there
        float gap = -p.z - 1.0 / sceneInvZ( uv );
        float pf = saturate( gap / ( gap - prevGap ) );
        if ( gap >= 0.0 && gap < SsrHitThickness * stepSize ) { frac = pf; hitUV = mix( uv, prevUV, vec2( pf ) ); break; }
        prevUV = uv; prevGap = gap; prevPos = p;
      }
      float fracOfTotalSteps = ( float( i ) - frac ) / float( SSRStepCount );
      float o = fracOfTotalSteps * -0.00390625;
      vec3 ssr = textureLod( uSceneColor, clamp( hitUV + vec2( o ), 0.0, 1.0 ), 0.0 ).rgb * 0.444444
        + textureLod( uSceneColor, clamp( hitUV + vec2( 0.001953125, o ), 0.0, 1.0 ), 0.0 ).rgb * 0.222222
        + textureLod( uSceneColor, clamp( hitUV + vec2( o, 0.001953125 ), 0.0, 1.0 ), 0.0 ).rgb * 0.222222
        + textureLod( uSceneColor, clamp( hitUV + vec2( 0.001953125 ), 0.0, 1.0 ), 0.0 ).rgb * 0.111111;
      vec3 SsrReflectionResult = ( ssr + normalize( ssr + vec3( 0.001 ) ) * ClampToPositive( GetLuma( ssr ) - g_flSSRBoostThreshold ) * g_flSSRBoost ) * g_flSSRBrightness;
      // CS2: (1 - f^4) x saturate(v x 8) x saturate(stepMul x 2); its screen v runs downward, three's up (1 - v)
      finalReflectionColor = mix( finalReflectionColor, SsrReflectionResult, vec3( saturate( 1.0 - pow( fracOfTotalSteps, 4.0 ) ) * saturate( ( 1.0 - hitUV.y ) * 8.0 ) * saturate( stepMul * 2.0 ) ) );
    }
  }
#endif
  float localReflectance = mix( g_flReflectance, g_flDebrisReflectance, finalDebrisFactor );
  float reflectionModulation = ( fresnel * ( 1.0 - localReflectance ) + localReflectance ) * ( -combinedfinalFoamIntensity * 2.0 + ( -surfaceCoverageAlpha * 0.75 + 1.0 ) ) * 1.5;
  vec3 SpecularDirect = DiffuseDirect * ( ClampToPositive( specularFactor - ( 1.0 - g_flSpecularBloomBoostThreshold ) ) * g_flSpecularBloomBoostStrength + specularFactor ) * mix( 1.0, g_flDebrisReflectance * 0.05, debrisEdgeFactor ) * reflectionModulation;
  returnColor += SpecularDirect * sunColor;
  vec3 oilIridescence = cs2CalculateIridescence( fract( g_flTime * 0.1 + fresnel * 20.0 + debrisHeightVal * 8.0 ), 0.75 );
  returnColor *= mix( vec3( 1.0 ), DiffuseIndirect * 0.75, vec3( saturate( causticDebrisCoverageW * 4.0 ) * inverseWaterFogAlpha ) );
  vec3 oilSpecularFactor = vec3( saturate( noClue * 20.0 ) * g_flDebrisOilyness / ( distanceToFrag * 0.005 + 1.0 ) * saturate( -refractedVerticalFactor * 5.0 + 1.0 ) );
  returnColor = mix( returnColor, mix( finalReflectionColor, finalReflectionColor * oilIridescence, oilSpecularFactor ), vec3( saturate( reflectionModulation ) ) );

  returnColor = cs2ApplyFog( returnColor, finalSurfacePos );

  // DITHER INTO SKYBOX (only with a fade range: 0 means none)
  if ( g_flSkyBoxFadeRange > 0.0 ) {
    vec2 e = abs( vec2( 0.5 ) - unbiasedUV ) * 2.0;
    if ( saturate( 1.0 - saturate( ( max( e.x, e.y ) - ( 1.0 - g_flSkyBoxFadeRange ) ) / g_flSkyBoxFadeRange ) ) - blueNoiseZeroToOne.x < 0.0 ) discard;
  }
  float flEdgeBlend = saturate( g_flEdgeHardness * effectiveWaterDepthForFog + saturate( combinedfinalFoamIntensity ) + ( debrisHeightVal * 2.0 - 0.5 ) );
#if F_REFRACTION == 1
  returnColor = mix( refractionColorSample.rgb * mix( 1.0, 0.6, saturate( refractedVerticalFactor * 60.0 ) / ( distanceToFrag * 0.002 + 1.0 ) ), returnColor, vec3( flEdgeBlend ) );
#endif
  gl_FragColor = vec4( returnColor, 1.0 );
}`;
