// The frame as it stands after the opaque pass, for the particles that read it: depth feathering samples its depth
// and refraction its colour (fx/particles/render/spritecard-ps.js FEATHER / REFRACT; CS2 binds the scene's depth and
// a frame copy the same way). A marker mesh drawn first among the transparents blits the HDR target's colour and
// depth (resolving MSAA) into a single-sample copy; only on frames where some particle material asks for it.
//
//   const copy = new SceneCopy(scene)          // adds its marker to the scene
//   copy.frame(renderer, hdrTarget, camera)    // before renderer.render(scene, camera) into hdrTarget
//   sceneCopyUniforms                          // uSceneColor, uSceneDepth, uViewport, uNearFar (fx/effects.js fxShared)
import * as THREE from 'three';

export const sceneCopyUniforms = {
  uSceneColor: { value: null }, uSceneDepth: { value: null },
  uViewport: { value: new THREE.Vector2(1, 1) }, uNearFar: { value: new THREE.Vector2(1, 1000) },
};

export class SceneCopy {
  // wanted(): does any material drawn this frame read the copy (spritecard.js sceneCopyWanted)
  constructor(scene, wanted = () => true) {
    this.wanted = wanted;
    this.target = null;
    this.source = null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)); // one degenerate triangle
    const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, depthTest: false, colorWrite: false });
    this.marker = new THREE.Mesh(geo, mat);
    this.marker.frustumCulled = false;
    this.marker.renderOrder = -1e9; // the first transparent drawn: everything opaque is in the target by then
    this.marker.onBeforeRender = (renderer) => this._blit(renderer);
    scene.add(this.marker);
  }

  frame(renderer, source, camera) {
    this.source = null;
    this.marker.visible = this.wanted();
    if (!this.marker.visible) return;
    const w = source.width, h = source.height;
    if (!this.target || this.target.width !== w || this.target.height !== h) {
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true });
      this.target.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
      // make three create its framebuffer now, outside the scene render
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(this.target);
      renderer.setRenderTarget(prev);
    }
    sceneCopyUniforms.uSceneColor.value = this.target.texture;
    sceneCopyUniforms.uSceneDepth.value = this.target.depthTexture;
    sceneCopyUniforms.uViewport.value.set(w, h);
    sceneCopyUniforms.uNearFar.value.set(camera.near, camera.far);
    this.source = source;
  }

  _blit(renderer) {
    if (!this.source || !this.target) return;
    const gl = renderer.getContext();
    const sp = renderer.properties.get(this.source), tp = renderer.properties.get(this.target);
    const read = sp.__webglMultisampledFramebuffer || sp.__webglFramebuffer;
    const draw = tp.__webglFramebuffer;
    if (!read || !draw) return;
    const w = this.target.width, h = this.target.height;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    // back to the target three is drawing into (its state cache still names it)
    gl.bindFramebuffer(gl.FRAMEBUFFER, read);
  }

  dispose() {
    this.target?.dispose();
    this.marker.removeFromParent();
    this.marker.geometry.dispose();
    this.marker.material.dispose();
  }
}
