// The minimap: CS2's own radar (CCSGO_HudRadar, round mode), drawn the way client.dll + hudradar.vxml/vcss draw it.
// The map image is the map's own overview (lasers-bake --overview -> maps/<map>/overview/); vertical sections switch
// image by your height. The icons are CS2's (lasers-bake --panorama -> panorama/hud/radar, icons/ui).
//
// Numbers, all from CS2 (client.dll 2026-10-15 + hudradar.vcss), in panel units (the 300 px Radar_PanelSize):
//   - the round radar is Radar_VisSize_Round (250) across, centred; hud-blur-bg-color (#000000a0, the same 0.627 as
//     cl_hud_radar_background_alpha) under a gaussian(2) world blur, a 1 px border in the team colour
//   - the map panel is 2.4 x the radar size for the whole texture, x cl_radar_scale (0.7): a texture texW px wide
//     covering texW * scale world units shows texW * scale / (4.8 * 0.7) units from the centre to the edge
//   - the map is blended additively over the background (cl_hud_radar_map_additive 1)
//   - cl_radar_rotate 1 + cl_radar_always_centered 1: you in the middle, your facing up
//   - #DirectionArrow (hud/direction.png, 10 x 14, 2 px from the top) turns about the panel centre: the map's north
//   - player icons scale by cl_radar_scale * (1.25 - cl_radar_icon_scale_min) + min (0.6) = 1.055; an icon turns
//     90 - yaw + the radar's rotation; one farther than 0.98 of the radius is pinned to that edge as the off-map
//     arrow (map_enemy_offmap, 22 px, 0.8 opacity) pointing its way
//   - CT colour (.PI_Color_CT wash) #1ed2ff: icon-on-map (11 px, 0 0 1px #000000aa shadow) + the
//     #DirectionalIndicator (11 x 20 box, 32 px down a 100 px box centred on the player)
// Bosses are not on CS2's radar; we show them as CS2 shows an enemy (icon-enemy-on-map, 13 px, #ff1919).
import './radar.css';
import { S, G } from '../app/state.js';
import { settings } from '../app/settings.js';
import { loadImage, additive, tinted } from '../lib/sprites.js';

const DEG = Math.PI / 180;
const PANEL = 300; // Radar_PanelSize
const ROUND = 250; // Radar_VisSize_Round
const RADAR_SCALE = 0.7; // cl_radar_scale
const ICON_SCALE = RADAR_SCALE * (1.25 - 0.6) + 0.6; // cl_radar_icon_scale_min 0.6
const EDGE = ROUND * 0.98 * 0.5; // farther than this: the off-map arrow on the edge
const CT = '#1ed2ff', ENEMY = '#ff1919';
const PANO = '/panorama/';

export class Radar {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.className = 'hud-radar';
    this.el.innerHTML = '<div class="radar-bg"></div><canvas></canvas><div class="radar-border"></div>';
    root.append(this.el);
    this.canvas = this.el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.info = null;
    this.images = new Map(); // src -> additive canvas (null while loading)
    this.icons = null;
    loadIcons().then((icons) => { this.icons = icons; }, () => {});
  }

  // a map's radar (world/assets.js radarInfo), or null: no minimap
  setMap(info) {
    this.info = info;
    this.images.clear();
    for (const src of [info?.base, ...(info?.sections || []).map((s) => s.src)]) {
      if (!src || this.images.has(src)) continue;
      this.images.set(src, null);
      loadImage(src).then((img) => { if (this.images.has(src)) this.images.set(src, additive(img)); }, () => {});
    }
  }

  imageFor(z) {
    const sec = this.info.sections.find((s) => z >= s.min && z < s.max);
    return this.images.get(sec?.src || this.info.base) || null;
  }

  draw() {
    const { info, ctx } = this;
    const p = S.player;
    const show = !!info && settings.minimap;
    document.getElementById('hud')?.classList.toggle('has-radar', show);
    this.el.hidden = !show || !S.run || !p;
    if (this.el.hidden) return;

    // canvas pixels follow the element (300 panel units at the HUD's scale) and the screen's pixel ratio
    const w = Math.max(1, Math.round(this.el.clientWidth * Math.min(devicePixelRatio || 1, 2)));
    if (this.canvas.width !== w) this.canvas.width = this.canvas.height = w;
    const u = w / PANEL; // canvas px per panel unit
    const c = w / 2;
    const texW = info.size || 1024;
    const k = (RADAR_SCALE * ROUND * 2.4) / (texW * info.scale) * u; // canvas px per world unit
    const [px, py, pz] = p.origin;
    const turn = (p.yaw - 90) * DEG; // the radar's rotation: your facing up
    const cos = Math.cos(turn), sin = Math.sin(turn);
    // world -> canvas, rotated about you
    const at = (x, y) => {
      const dx = (x - px) * k, dy = (py - y) * k;
      return [c + dx * cos - dy * sin, c + dx * sin + dy * cos];
    };

    ctx.clearRect(0, 0, w, w);
    // the map, inside the round radar
    const img = this.imageFor(pz);
    if (img) {
      ctx.save();
      ctx.beginPath(); ctx.arc(c, c, (ROUND / 2) * u, 0, Math.PI * 2); ctx.clip();
      ctx.translate(c, c);
      ctx.rotate(turn);
      const size = texW * info.scale * k;
      ctx.drawImage(img, (info.posX - px) * k, (py - info.posY) * k, size, size);
      ctx.restore();
    }

    const icons = this.icons;
    if (icons) {
      // bosses: CS2's enemy icon
      for (const b of S.scenario?.bosses || []) {
        for (const e of S.engine?.find(b.target) || []) {
          if (!e.alive) continue;
          const o = e.worldOrigin();
          this.player(icons, at(o[0], o[1]), null, ENEMY, u);
        }
      }
      // teammates in a room, where the game draws them (interpInterval behind)
      if (G.peers && S.mp) {
        for (const [id, peer] of G.peers.list) {
          if (peer.alive === false) continue;
          const s = G.peers.sample(id); // this frame's, each player's own delay behind (world/peer-track.js)
          if (s) this.player(icons, at(s.o[0], s.o[1]), (90 - s.yaw) * DEG + turn, CT, u);
        }
      }
      // you: always in the middle, facing up
      this.player(icons, [c, c], 0, CT, u);
      // the north arrow: the top of the map, on the ring outside the radar
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(turn);
      ctx.drawImage(icons.north, -5 * u, (2 - PANEL / 2) * u, 10 * u, 14 * u);
      ctx.restore();
    }
  }

  // One player icon package (PI_FirstRotated). angle null = no facing (an enemy dot).
  player(icons, [x, y], angle, color, u) {
    const ctx = this.ctx;
    const c = this.canvas.width / 2;
    const dx = x - c, dy = y - c, d = Math.hypot(dx, dy);
    const s = ICON_SCALE * u;
    ctx.save();
    if (d > EDGE * u) {
      // off the radar: CS2's off-map arrow on the edge, pointing its way
      ctx.translate(c + (dx / d) * EDGE * u, c + (dy / d) * EDGE * u);
      ctx.rotate(Math.atan2(dy, dx) + 90 * DEG);
      ctx.globalAlpha = 0.8;
      ctx.drawImage(icons.offmap(color), -11 * s, -12 * s, 22 * s, 22 * s);
      ctx.restore();
      return;
    }
    ctx.translate(x, y);
    if (angle == null) {
      ctx.globalAlpha = 0.95;
      ctx.drawImage(icons.enemy(color), -6.5 * s, -6.5 * s, 13 * s, 13 * s);
      ctx.restore();
      return;
    }
    ctx.rotate(angle);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.667)';
    ctx.shadowBlur = 1 * s;
    ctx.drawImage(icons.dot(color), -5.5 * s, -5.5 * s, 11 * s, 11 * s);
    ctx.shadowColor = 'transparent';
    // the direction indicator: an 11 x 20 box 18 px ahead, the square svg fit inside it
    ctx.drawImage(icons.facing(color), -5.5 * s, -13.5 * s, 11 * s, 11 * s);
    ctx.restore();
  }
}

// CS2's radar images, tinted per colour on first use (Panorama's wash-color: white takes the colour, black stays)
async function loadIcons() {
  const [north, dot, facing, offmap, enemy] = await Promise.all([
    loadImage(PANO + 'hud/direction.png'),
    loadImage(PANO + 'hud/radar/icon-on-map.png'),
    loadImage(PANO + 'hud/radar/icon_direction_indicator.svg'),
    loadImage(PANO + 'icons/ui/map_enemy_offmap.svg'),
    loadImage(PANO + 'hud/radar/icon-enemy-on-map.png'),
  ]);
  const cache = new Map();
  const tint = (img, px) => (color) => {
    const key = img.src + color;
    if (!cache.has(key)) cache.set(key, tinted(img, color, px));
    return cache.get(key);
  };
  return { north, dot: tint(dot, 64), facing: tint(facing, 64), offmap: tint(offmap, 96), enemy: tint(enemy, 64) };
}
