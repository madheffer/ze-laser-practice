// The 3D view: the static world, entity models riding their entities, and the lasers.
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTF_TO_SOURCE } from './assets.js';
import { DEG, parseVec, angleForward } from './entities/index.js';
import { assetKey } from '../lib/paths.js';

// Particle systems one entity may draw (children included): a map's particles.json is data, and an effect
// listing many children, 4 levels deep, would otherwise multiply into millions of sprites.
const MAX_FX_PER_ENTITY = 64;

export class Renderer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8fa3b8);
    // CS uses a 4:3-based horizontal FOV; at 90 that is ~73.74 deg vertical.
    this.camera = new THREE.PerspectiveCamera(73.74, 1, 4, 60000);
    this.camera.up.set(0, 0, 1);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(new THREE.HemisphereLight(0xdde8ff, 0x3a3328, 1.1));
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.6);
    sun.position.set(0.4, 0.3, 1);
    this.scene.add(sun);

    this.worldRoot = new THREE.Group();
    this.worldRoot.matrixAutoUpdate = false;
    this.worldRoot.matrix.copy(GLTF_TO_SOURCE);
    this.scene.add(this.worldRoot);
    this.entRoot = new THREE.Group();
    this.scene.add(this.entRoot);
    this.visuals = new Map(); // entity -> Object3D
    this.hullGeo = new Map(); // model -> [BufferGeometry]
    this.fxGeo = new Map(); // effect summary -> BufferGeometry
    this.showHitboxes = false;
    this.laserMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.laserCore = new THREE.MeshBasicMaterial({ color: 0xffd0d0, transparent: true, opacity: 0.9, depthWrite: false });
    this.hitboxMat = new THREE.MeshBasicMaterial({ color: 0x30ff90, wireframe: true, transparent: true, opacity: 0.6, depthWrite: false });
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setFov(hfov43) {
    // horizontal FOV defined at 4:3 (CS's convention) -> vertical
    const v = 2 * Math.atan(Math.tan((hfov43 * DEG) / 2) * 0.75) / DEG;
    this.camera.fov = v;
    this.camera.updateProjectionMatrix();
  }

  setWorld(scene) {
    this.worldRoot.clear();
    scene.traverse((o) => {
      if (o.isMesh) {
        // VRF names tool-texture meshes after their material; hide the editor-only ones
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (mats.some((m) => /tools?(trigger|clip|nodraw|skip|invisible|playerclip|blocklight|areaportal|sky)/i.test(m?.name || ''))) o.visible = false;
        for (const m of mats) if (m && m.transparent === false && m.alphaTest === 0 && m.map && /grate|fence|leaf|foliage|chain/i.test(m.name)) m.alphaTest = 0.5;
      }
    });
    this.worldRoot.add(scene);
  }

  clearEntities() {
    for (const v of this.visuals.values()) this.entRoot.remove(v);
    this.visuals.clear();
  }

  // Build the visual for a freshly spawned entity.
  async addEntity(e, map) {
    const kv = e.kv;
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    let any = false;

    if (e.cls === 'info_particle_system') {
      const fx = map.particles?.[assetKey(kv.effect_name || '')];
      if (fx) {
        this.addParticle(group, fx, map, 0, { left: MAX_FX_PER_ENTITY });
        any = true;
      }
    } else if (e.cls === 'trigger_hurt') {
      // hitboxes, shown with H; what you see in game is the particles parented next to them
      const hulls = map.hulls[e.model];
      if (hulls) {
        // one geometry per model, shared by every spawned copy (a firestorm wave spawns hundreds)
        if (!this.hullGeo.has(e.model)) {
          const geos = [];
          for (const h of hulls) {
            const pts = [];
            for (let i = 0; i < h.verts.length; i += 3) pts.push(new THREE.Vector3(h.verts[i], h.verts[i + 1], h.verts[i + 2]));
            if (pts.length >= 4) geos.push(new ConvexGeometry(pts));
          }
          this.hullGeo.set(e.model, geos);
        }
        for (const geo of this.hullGeo.get(e.model)) {
          const glow = new THREE.Mesh(geo, this.laserMat);
          glow.userData.kind = 'hurt';
          group.add(glow);
          const wire = new THREE.Mesh(geo, this.hitboxMat);
          wire.userData.kind = 'hitbox';
          group.add(wire);
        }
        any = true;
      }
    } else if (!e.cls.startsWith('trigger_') && e.model) {
      const hidden = kv.rendermode === 'kRenderNone' || kv.rendermode === '10' || kv.renderamt === '0';
      if (!hidden) {
        const p = map.getModel(e.model);
        if (p) {
          any = true;
          p.then((scene) => {
            if (!scene || !e.alive) return;
            const inst = scene.clone(true);
            const holder = new THREE.Group();
            holder.matrixAutoUpdate = false;
            holder.matrix.copy(GLTF_TO_SOURCE);
            holder.add(inst);
            const rc = kv.rendercolor ? parseVec(kv.rendercolor) : null;
            if (rc && (rc[0] !== 255 || rc[1] !== 255 || rc[2] !== 255)) {
              inst.traverse((o) => {
                if (o.isMesh) {
                  o.material = o.material.clone();
                  o.material.color?.multiply(new THREE.Color(rc[0] / 255, rc[1] / 255, rc[2] / 255));
                }
              });
            }
            group.add(holder);
          });
        }
      }
    }
    if (!any) return;
    group.userData.born = e.engine.time;
    this.visuals.set(e, group);
    this.entRoot.add(group);
  }

  // A sprite effect as a cloud of soft additive points inside its emit box (from particles.json).
  // Close to how these ZE laser strips render: many overlapping glow sprites along a line.
  addParticle(group, fx, map, depth, budget) {
    if (depth > 3 || budget.left <= 0 || (fx.renderer && fx.renderer !== 'C_OP_RenderSprites')) return;
    budget.left--;
    const pts = new THREE.Points(this.particleGeometry(fx), this.spriteMaterial());
    pts.userData.kind = 'fx';
    pts.frustumCulled = true;
    group.add(pts);
    for (const c of Array.isArray(fx.children) ? fx.children : []) {
      const child = map.particles[assetKey(c)];
      if (child) this.addParticle(group, child, map, depth + 1, budget);
    }
  }

  // One point cloud per effect summary, shared by every entity playing it.
  particleGeometry(fx) {
    if (this.fxGeo.has(fx)) return this.fxGeo.get(fx);
    const lo = fx.offsetMin?.length ? fx.offsetMin : fx.boxMin?.length ? fx.boxMin : [0, 0, 0];
    const hi = fx.offsetMax?.length ? fx.offsetMax : fx.boxMax?.length ? fx.boxMax : [0, 0, 0];
    const n = Math.max(8, Math.min(600, Math.round(fx.max || (fx.rate || 50))));
    const cmin = (fx.colorMin?.length ? fx.colorMin : fx.color?.length ? fx.color : [255, 255, 255]).map((v) => v / 255);
    const cmax = (fx.colorMax?.length ? fx.colorMax : cmin.map((v) => v * 255)).map((v) => v / 255);
    const rmin = fx.radiusMin ?? fx.radius ?? 5, rmax = fx.radiusMax ?? rmin;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < 3; a++) pos[i * 3 + a] = lo[a] + Math.random() * (hi[a] - lo[a]);
      const t = Math.random();
      for (let a = 0; a < 3; a++) col[i * 3 + a] = cmin[a] + (cmax[a] - cmin[a]) * t;
      size[i] = rmin + Math.random() * (rmax - rmin);
      seed[i] = Math.random() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.hypot(...hi.map((v, a) => Math.max(Math.abs(v), Math.abs(lo[a])))) + rmax);
    this.fxGeo.set(fx, geo);
    return geo;
  }

  spriteMaterial() {
    if (this._sprite) return this._sprite;
    this._sprite = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 1 } },
      vertexShader: `
        attribute float size; attribute float seed; attribute vec3 color;
        uniform float uTime; uniform float uScale;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          // each sprite lives ~1 s: drift a little, fade in and out, then respawn in place
          float life = fract(uTime * (0.8 + 0.4 * fract(seed * 7.13)) + seed);
          vec3 p = position + vec3(sin(seed * 3.1 + uTime), cos(seed * 1.7 + uTime), life * 6.0) * 2.0;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = size * 2.0 * (0.6 + 0.4 * (1.0 - life)) * uScale / -mv.z;
          vColor = color;
          vAlpha = smoothstep(0.0, 0.15, life) * (1.0 - smoothstep(0.6, 1.0, life));
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float g = exp(-dot(d, d) * 14.0);
          gl_FragColor = vec4(vColor * g * vAlpha * 0.45, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    return this._sprite;
  }

  removeEntity(e) {
    const v = this.visuals.get(e);
    if (!v) return;
    // with simulated ping the entity stays on screen until its death reaches you
    if (this.delay > 0) { v.userData.died = e.engine.time; return; }
    this.entRoot.remove(v); this.visuals.delete(e);
  }

  // ---- simulated ping -------------------------------------------------------------------------------
  // With client-side prediction your own movement is instant, but the server's entities reach your screen
  // about one round trip late, while hits are decided where they really are. So entities are drawn from a
  // short history `delay` seconds behind the simulation (record() every tick, updateEntities(time) per frame).
  record(time) {
    if (!(this.delay > 0)) return;
    const keep = time - this.delay - 0.25;
    for (const [e, g] of this.visuals) {
      const h = g.userData.hist || (g.userData.hist = []);
      h.push({ t: time, m: e.getWorld().clone(), vis: e.alive && e.visible, en: e.enabled, fx: !!e.state.active });
      while (h.length > 2 && h[1].t < keep) h.shift();
    }
  }

  // The snapshot to draw at `target`: interpolated between the two ticks around it.
  snapshot(g, target) {
    const h = g.userData.hist;
    if (!h?.length) return null;
    if (target <= h[0].t) return h[0];
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].t <= target) {
        const a = h[i], b = h[i + 1];
        if (!b) return a;
        const k = (target - a.t) / (b.t - a.t);
        const m = new THREE.Matrix4();
        const pa = new THREE.Vector3(), qa = new THREE.Quaternion(), sa = new THREE.Vector3();
        const pb = new THREE.Vector3(), qb = new THREE.Quaternion(), sb = new THREE.Vector3();
        a.m.decompose(pa, qa, sa); b.m.decompose(pb, qb, sb);
        m.compose(pa.lerp(pb, k), qa.slerp(qb, k), sa.lerp(sb, k));
        return { m, vis: a.vis, en: a.en, fx: a.fx };
      }
    }
    return h[0];
  }

  updateEntities(time = 0) {
    if (this._sprite) {
      this._sprite.uniforms.uTime.value = performance.now() / 1000;
      // point size in pixels per world unit at distance 1
      this._sprite.uniforms.uScale.value = this.renderer.domElement.height / (2 * Math.tan((this.camera.fov * DEG) / 2));
    }
    const delayed = this.delay > 0;
    const target = time - (this.delay || 0);
    for (const [e, g] of this.visuals) {
      if (delayed) {
        const born = g.userData.born ?? -Infinity, died = g.userData.died;
        if (died != null && target >= died) { this.entRoot.remove(g); this.visuals.delete(e); continue; }
        const s = target < born ? null : this.snapshot(g, target);
        g.visible = !!s && s.vis;
        if (!s) continue;
        g.matrix.copy(s.m);
        g.matrixWorldNeedsUpdate = true;
        for (const c of g.children) {
          const k = c.userData.kind;
          if (k === 'fx') c.visible = s.fx;
          else if (k === 'hurt' || k === 'hitbox') c.visible = s.en && this.showHitboxes;
        }
        continue;
      }
      g.matrix.copy(e.getWorld());
      g.matrixWorldNeedsUpdate = true;
      const on = e.alive && e.visible;
      g.visible = on;
      for (const c of g.children) {
        const k = c.userData.kind;
        if (k === 'fx') c.visible = !!e.state.active;
        else if (k === 'hurt') c.visible = e.enabled && this.showHitboxes;
        else if (k === 'hitbox') c.visible = e.enabled && this.showHitboxes;
      }
    }
  }

  setView(eye, yaw, pitch) {
    const cam = this.camera;
    cam.position.set(eye[0], eye[1], eye[2]);
    const f = new THREE.Vector3(...angleForward([pitch, yaw, 0]));
    cam.lookAt(cam.position.clone().add(f));
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
