// The home page's pictures, all of them the maps' own loading-screen screenshots (lasers-bake writes
// maps/<name>/shots/N.jpg; tools/index-maps.mjs lists them in index.json):
//   Backdrop  one screenshot at a time behind the page, dim and soft, crossfading every few seconds
//   Strip     every screenshot in a row that drifts sideways forever; its edges fade out (home.css). It is a real
//             scroll box: swipe it on a phone, drag-scroll / wheel on a desktop, Tab through its tiles. The
//             drift pauses while you hover, touch or focus it, and is off with prefers-reduced-motion.
import { isMapName, versioned } from '../lib/paths.js';
import { displayName } from './maps.js';

const SHOT = /^\d{1,2}\.jpg$/;
const FADE_MS = 8000;
const SPEED = 28; // px per second
const RESUME_MS = 2500; // after a touch / wheel / focus leaves

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; }
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// every (map, screenshot) pair, maps interleaved so one map's shots don't all sit together
export function shotsOf(maps) {
  const per = maps.filter((m) => isMapName(m.name)).map((m) => (Array.isArray(m.shots) ? m.shots.filter((f) => typeof f === 'string' && SHOT.test(f)) : [])
    .map((f) => ({ map: m, url: versioned(`maps/${m.name}/shots/${f}`, m.version) })));
  const out = [];
  for (let i = 0; per.some((l) => i < l.length); i++) for (const l of per) if (l[i]) out.push(l[i]);
  return out;
}

export class Backdrop {
  constructor(root) {
    this.root = root;
    this.layers = [el('div', 'hb-layer'), el('div', 'hb-layer')];
    root.append(...this.layers);
    this.shots = [];
    this.i = 0;
    this.front = 0;
  }
  set(shots) { this.shots = shots; this.i = Math.floor(Math.random() * Math.max(1, shots.length)); this.next(); }
  next() {
    if (!this.shots.length) return;
    const url = this.shots[this.i++ % this.shots.length].url;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      this.front ^= 1;
      const [on, off] = [this.layers[this.front], this.layers[this.front ^ 1]];
      on.replaceChildren(img);
      on.classList.add('on');
      off.classList.remove('on');
    };
    img.src = url; // a same-origin path built from a checked map name + file name
    img.alt = '';
  }
  start() { this.stop(); if (this.shots.length > 1 && !reducedMotion()) this.timer = setInterval(() => { if (!document.hidden) this.next(); }, FADE_MS); }
  stop() { clearInterval(this.timer); }
}

export class Strip {
  // onPick(mapName)
  constructor(root, { onPick, mapTitle }) {
    this.root = root;
    this.onPick = onPick;
    this.mapTitle = mapTitle;
    this.track = el('div', 'hs-track');
    root.append(this.track);
    this.hold = 0; // the drift waits until this time (ms)
    this.hovered = false;
    this.pos = 0;
    root.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') this.hovered = true; });
    root.addEventListener('pointerleave', () => { this.hovered = false; });
    const wait = () => { this.hold = performance.now() + RESUME_MS; };
    for (const ev of ['touchstart', 'touchmove', 'wheel', 'pointerdown', 'focusin']) root.addEventListener(ev, wait, { passive: true });
    root.addEventListener('scroll', () => { if (Math.abs(root.scrollLeft - this.pos) > 2) { this.pos = root.scrollLeft; wait(); } this.wrap(); }, { passive: true });
    new ResizeObserver(() => this.fillOut()).observe(root);
  }

  set(shots) {
    this.shots = shots;
    this.track.replaceChildren();
    this.copies = 0;
    this.fillOut();
  }

  tile(s, copy) {
    const b = el('button', 'hs-tile');
    b.type = 'button';
    const title = displayName(this.mapTitle(s.map.name));
    const img = el('img');
    img.src = s.url;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    const cap = el('span', 'hs-cap');
    cap.append(el('b', null, title), el('i', null, s.map.scenarios ? `${s.map.scenarios} stages` : 'Free roam'));
    b.append(img, cap);
    b.addEventListener('click', () => this.onPick(s.map.name));
    if (copy) { b.tabIndex = -1; b.setAttribute('aria-hidden', 'true'); } else b.setAttribute('aria-label', `Play ${title}`);
    return b;
  }

  // one set of tiles, then copies: past the first set there must always be a box's width of tiles to show while
  // the scroll wraps back (wrap())
  fillOut() {
    if (!this.shots?.length) return;
    const add = (copy) => { for (const s of this.shots) this.track.append(this.tile(s, copy)); this.copies++; };
    if (!this.copies) { add(false); add(true); }
    if (!this.root.clientWidth || !this.setWidth()) return; // hidden: the ResizeObserver comes back once it shows
    let guard = 0;
    while ((this.copies - 1) * this.setWidth() < this.root.clientWidth + 1 && guard++ < 20) add(true);
  }
  setWidth() {
    const first = this.track.children[0], next = this.track.children[this.shots.length];
    return first && next ? next.offsetLeft - first.offsetLeft : 0;
  }
  // keep the scroll inside the first set: past it, jump back one set (the tiles there look the same)
  wrap() {
    const w = this.setWidth();
    if (w > 0 && this.root.scrollLeft >= w) { this.root.scrollLeft -= w; this.pos = this.root.scrollLeft; }
  }

  start() {
    this.stop();
    if (reducedMotion()) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!this.hovered && now > this.hold && this.copies > 1) {
        this.pos += SPEED * dt;
        this.root.scrollLeft = this.pos;
        this.wrap();
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
  stop() { cancelAnimationFrame(this.raf); }
}
