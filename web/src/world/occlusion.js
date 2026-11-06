// Occlusion culling of the world's chunks: a chunk hidden behind walls is not drawn. The frustum already drops what is
// off screen; this drops what is on screen but behind something (westersand's dragon arena: 651 world draws in the
// view, 33 meshes actually seen, from 3 of its 19 chunks). Each frame, after the world pass, every chunk's box is drawn
// against that frame's depth (no colour, no depth written) inside a WebGL2 occlusion query; a box that showed no
// pixel hides its chunk from the next frames until a later query sees it again. Rendering only: nothing of the game
// reads it.
//
//   const occ = new ChunkOcclusion(gl)
//   occ.apply(chunks, camera)          before the world pass: read finished queries, show / hide each chunk
//   occ.query(chunks, camera, frustum, scratch, fbo, w, h)   after it: one query per chunk in view, against fbo's depth
//
// A query's answer arrives a frame or two later (never waited on), so a chunk is only hidden on a box that was in view
// when it was tested and showed nothing; a chunk without an answer yet, one the camera is in (its near faces are
// clipped) and one that just turned into view all draw. What can still happen: a chunk shows a frame or two late when a
// door opens in front of it or you step past a corner; boxes are padded by PAD to make that rarer. An answer stops
// counting once the camera has moved SAME_MOVE from where it was tested, and for a box only partly on screen then, once
// it has turned SAME_TURN (the part that was off screen was never tested).
// chunks: [{ object: THREE.Object3D, box: [min, max] (world space) }], each one ready to draw (render.js warmChunk)
// frustum: the camera's THREE.Frustum, scratch: a THREE.Box3 to reuse

const PAD = 64; // units the boxes grow by
const NEAR_PAD = 16; // the camera this close to a box counts as inside it
// how far an answer holds: the camera within SAME_MOVE of where it was tested, and (a box only partly on screen then)
// facing within SAME_TURN of the same way
const SAME_TURN = Math.cos(1.5 * Math.PI / 180); // view directions within 1.5 degrees
const SAME_MOVE = 24; // units

const VS = `#version 300 es
in vec3 corner; uniform mat4 viewProj; uniform vec3 lo, hi;
void main() { gl_Position = viewProj * vec4(mix(lo, hi, corner), 1.0); }`;
const FS = `#version 300 es
precision lowp float; out vec4 colour; void main() { colour = vec4(1.0); }`;
const CORNERS = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
const FACES = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);

export class ChunkOcclusion {
  constructor(gl) {
    this.gl = gl;
    this.state = new WeakMap(); // object -> { query, pending, occluded, tested, whole, at: [x, y, z, dx, dy, dz] }
    this.ok = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext && this._build();
    this._lo = new Float32Array(3);
    this._hi = new Float32Array(3);
  }

  _build() {
    const gl = this.gl;
    const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    this.prog = prog;
    this.uViewProj = gl.getUniformLocation(prog, 'viewProj');
    this.uLo = gl.getUniformLocation(prog, 'lo');
    this.uHi = gl.getUniformLocation(prog, 'hi');
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW);
    const at = gl.getAttribLocation(prog, 'corner');
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, FACES, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return true;
  }

  // the box wholly on screen (padded as it is drawn)
  static whollyInFrustum(box, frustum, scratch) {
    for (let i = 0; i < 8; i++) {
      scratch.set(i & 1 ? box[1][0] + PAD : box[0][0] - PAD, i & 2 ? box[1][1] + PAD : box[0][1] - PAD, i & 4 ? box[1][2] + PAD : box[0][2] - PAD);
      if (!frustum.containsPoint(scratch)) return false;
    }
    return true;
  }

  // the camera near where it was when the box was tested / facing the same way
  static near(s, camera) { const a = s.at, p = camera.position; return Math.hypot(p.x - a[0], p.y - a[1], p.z - a[2]) <= SAME_MOVE; }
  static facing(s, dir) { const a = s.at; return dir.x * a[3] + dir.y * a[4] + dir.z * a[5] >= SAME_TURN; }

  static inside(box, p) {
    const [lo, hi] = box, d = PAD + NEAR_PAD;
    return p.x > lo[0] - d && p.x < hi[0] + d && p.y > lo[1] - d && p.y < hi[1] + d && p.z > lo[2] - d && p.z < hi[2] + d;
  }

  // the chunk's box in view of the frustum (padded as it is drawn)
  static inFrustum(box, frustum, scratch) {
    scratch.min.set(box[0][0] - PAD, box[0][1] - PAD, box[0][2] - PAD);
    scratch.max.set(box[1][0] + PAD, box[1][1] + PAD, box[1][2] + PAD);
    return frustum.intersectsBox(scratch);
  }

  apply(chunks, camera) {
    const gl = this.gl;
    const dir = camera.getWorldDirection(this._dir ||= camera.position.clone());
    for (const c of chunks) {
      const s = this.state.get(c.object);
      if (s?.pending && gl.getQueryParameter(s.query, gl.QUERY_RESULT_AVAILABLE)) {
        s.pending = false;
        // only a box that was in view when tested tells anything (one off screen shows no pixel either)
        s.occluded = s.tested && !gl.getQueryParameter(s.query, gl.QUERY_RESULT);
      }
      c.object.visible = !this.hidden(s, c.box, camera, dir);
    }
  }

  // the last answer for a chunk hides it now
  hidden(s, box, camera, dir) {
    // a stale answer never outlives SAME_MOVE of movement (stepping past a corner); a box only partly on screen when
    // tested also needs the same view direction (turning uncovers its untested part)
    return !!(s?.occluded && !ChunkOcclusion.inside(box, camera.position) && ChunkOcclusion.near(s, camera) && (s.whole || ChunkOcclusion.facing(s, dir)));
  }

  // fbo: the framebuffer the world pass drew into (its depth is tested), w x h its size
  query(chunks, camera, frustum, scratch, fbo, w, h) {
    const gl = this.gl;
    camera.updateMatrixWorld();
    this._vp ||= camera.projectionMatrix.clone();
    this._vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    for (const cap of [gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.BLEND, gl.CULL_FACE, gl.POLYGON_OFFSET_FILL]) gl.disable(cap);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.colorMask(false, false, false, false);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(this.uViewProj, false, this._vp.elements);
    for (const c of chunks) {
      let s = this.state.get(c.object);
      if (!s) { s = { query: gl.createQuery(), pending: false, occluded: false, tested: false }; this.state.set(c.object, s); }
      if (s.pending) continue; // its last query is still out
      // tested: in view and not around the camera (a box the camera is in has its near faces clipped away)
      s.tested = ChunkOcclusion.inFrustum(c.box, frustum, scratch) && !ChunkOcclusion.inside(c.box, camera.position);
      if (!s.tested) { s.occluded = false; continue; }
      s.whole = ChunkOcclusion.whollyInFrustum(c.box, frustum, this._corner ||= camera.position.clone());
      const d = camera.getWorldDirection(this._qdir ||= camera.position.clone()), p = camera.position;
      s.at = [p.x, p.y, p.z, d.x, d.y, d.z];
      this._lo.set([c.box[0][0] - PAD, c.box[0][1] - PAD, c.box[0][2] - PAD]);
      this._hi.set([c.box[1][0] + PAD, c.box[1][1] + PAD, c.box[1][2] + PAD]);
      gl.uniform3fv(this.uLo, this._lo);
      gl.uniform3fv(this.uHi, this._hi);
      gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, s.query);
      gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0);
      gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      s.pending = true;
    }
    gl.bindVertexArray(null);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
  }

  // Is a world-space box (THREE.Box3) wholly inside a chunk the last queries found hidden? Then nothing of it can be
  // seen either: the camera is outside that chunk's box and no pixel of the box showed (render.js: entity models)
  hides(box, chunks, camera) {
    const dir = camera.getWorldDirection(this._edir ||= camera.position.clone());
    for (const c of chunks) {
      const s = this.state.get(c.object);
      if (!this.hidden(s, c.box, camera, dir)) continue;
      const [lo, hi] = c.box;
      if (box.min.x >= lo[0] && box.min.y >= lo[1] && box.min.z >= lo[2] && box.max.x <= hi[0] && box.max.y <= hi[1] && box.max.z <= hi[2]) return true;
    }
    return false;
  }

  forget(object) {
    const s = this.state.get(object);
    if (s) { this.gl.deleteQuery(s.query); this.state.delete(object); }
  }
}
