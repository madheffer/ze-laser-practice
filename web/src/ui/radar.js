// The minimap: CS2's own radar for the map (lasers-bake --overview -> maps/<map>/overview/), top left like CS2's.
// Rotates with you (your facing is up), you in the middle, teammates in a room as blue arrows, the stage's bosses as
// red diamonds. Maps with vertical sections (mist, gris) switch image by your height, as CS2 does.
//
// CS2's overview mapping: radar pixel = ((x - pos_x) / scale, (pos_y - y) / scale) on the 1024 px image.
import './radar.css';
import { S, G } from '../app/state.js';

const DEG = Math.PI / 180;
const VIEW = 1800; // world units from the centre to the edge (CS2's default radar zoom is about this)
const SIZE = 512; // canvas pixels

export class Radar {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.className = 'hud-radar';
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE;
    this.el.append(this.canvas);
    root.append(this.el);
    this.ctx = this.canvas.getContext('2d');
    this.info = null;
    this.images = new Map(); // src -> Image
  }

  // a map's radar (world/assets.js radarInfo), or null: no minimap
  setMap(info) {
    this.info = info;
    this.images.clear();
    for (const src of [info?.base, ...(info?.sections || []).map((s) => s.src)]) {
      if (!src || this.images.has(src)) continue;
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
      this.images.set(src, img);
    }
    document.getElementById('hud')?.classList.toggle('has-radar', !!info);
  }

  imageFor(z) {
    const sec = this.info.sections.find((s) => z >= s.min && z < s.max);
    const img = this.images.get(sec?.src || this.info.base);
    return img?.complete && img.naturalWidth ? img : null;
  }

  draw() {
    const { info, ctx } = this;
    const p = S.player;
    this.el.hidden = !info || !S.run || !p;
    if (this.el.hidden) return;
    const c = SIZE / 2;
    const k = c / (VIEW / info.scale); // canvas px per radar px
    const toRadar = (x, y) => [(x - info.posX) / info.scale, (info.posY - y) / info.scale];
    const [px, py] = toRadar(p.origin[0], p.origin[1]);
    const turn = (p.yaw - 90) * DEG; // your facing up

    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.beginPath(); ctx.arc(c, c, c - 2, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = 'rgba(4, 12, 8, 0.82)';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.translate(c, c);
    ctx.rotate(turn);
    const img = this.imageFor(p.origin[2]);
    if (img) ctx.drawImage(img, -px * k, -py * k, img.naturalWidth * k * (1024 / img.naturalWidth), img.naturalHeight * k * (1024 / img.naturalHeight));
    // a point in the world -> canvas (in the rotated frame)
    const at = (x, y) => { const [rx, ry] = toRadar(x, y); return [(rx - px) * k, (ry - py) * k]; };

    // bosses: red diamonds
    for (const b of S.scenario?.bosses || []) {
      for (const e of S.engine?.find(b.target) || []) {
        if (!e.alive) continue;
        const o = e.worldOrigin();
        const [x, y] = at(o[0], o[1]);
        diamond(ctx, x, y, 14, '#ff2a2a');
      }
    }
    // teammates in a room: blue arrows (drawn where the game draws them, interpInterval behind)
    if (G.peers && S.mp) {
      const t = S.run.t - (S.mp.interpDelay || 0);
      for (const [id, peer] of G.peers.list) {
        if (peer.alive === false) continue;
        const s = G.peers.sample(id, t);
        if (!s) continue;
        const [x, y] = at(s.o[0], s.o[1]);
        arrow(ctx, x, y, -s.yaw * DEG, 24, '#4fb4ff');
      }
    }
    ctx.restore();
    // you: a white arrow, always up
    arrow(ctx, c, c, -90 * DEG, 28, '#ffffff');
    ctx.beginPath(); ctx.arc(c, c, c - 2, 0, Math.PI * 2);
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(170, 200, 255, 0.85)'; ctx.stroke();
  }
}

function arrow(ctx, x, y, a, r, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(-r * 0.7, r * 0.7); ctx.lineTo(-r * 0.35, 0); ctx.lineTo(-r * 0.7, -r * 0.7); ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)'; ctx.stroke();
  ctx.restore();
}

function diamond(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'; ctx.stroke();
}
