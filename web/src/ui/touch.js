// Touch controls for phones and tablets, laid out like a mobile FPS: a floating joystick wherever the left thumb
// lands, drag-to-look on the right half, thumb buttons on the right (jump + crouch big, fire, swap, reload) and
// pause in the corner. Pure UI: it reports gestures through callbacks and input(); app/input.js applies them.
import './touch.css';

const JOY_R = 56; // px of thumb travel for full deflection
const DEAD = 0.12; // joystick dead zone (fraction of JOY_R)
const RUN = 0.8; // past this the stick counts as fully pushed (run); below it moves slower, analog

// Static icons (no data in them). 24x24 viewBox, stroked with currentColor.
const ICON = {
  jump: '<path d="M12 19V6M6 11l6-6 6 6"/>',
  crouch: '<path d="M12 5v13M6 13l6 6 6-6"/>',
  fire: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  reload: '<path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

// name, label, hold (reports up as well as down), look (dragging it also turns the view, like PUBG's fire button)
const BUTTONS = [
  { name: 'jump', label: 'Jump', hold: true },
  { name: 'crouch', label: 'Crouch', hold: true },
  { name: 'fire', label: 'Fire', hold: true, look: true },
  { name: 'swap', label: 'Swap weapon' },
  { name: 'reload', label: 'Reload' },
  { name: 'pause', label: 'Pause' },
];

export const touchQuery = matchMedia('(pointer: coarse)');

// Follow one touch on an element: start / move / end get the Touch. Returns release(), which ends it early.
// preventDefault on touchstart stops the browser's emulated mouse events (no stray Mouse 1) and scrolling/zoom.
function track(el, h) {
  let id = null;
  const mine = (ev) => [...ev.changedTouches].find((t) => t.identifier === id);
  el.addEventListener('touchstart', (ev) => {
    ev.preventDefault();
    if (id !== null) return;
    const t = ev.changedTouches[0];
    id = t.identifier;
    h.start(t);
  }, { passive: false });
  el.addEventListener('touchmove', (ev) => {
    ev.preventDefault();
    const t = mine(ev);
    if (t) h.move?.(t);
  }, { passive: false });
  const up = (ev) => { const t = mine(ev); if (t) { id = null; h.end?.(t); } };
  el.addEventListener('touchend', up);
  el.addEventListener('touchcancel', up);
  return () => { if (id !== null) { id = null; h.end?.(null); } };
}

export class TouchControls {
  // onLook(dxPx, dyPx): a look drag; onButton(name, down): a button press (and release, for hold buttons)
  constructor({ onLook, onButton }) {
    this.onLook = onLook;
    this.onButton = onButton;
    this.visible = false;
    this.crouchToggle = false;
    this.stick = { x: 0, y: 0 };
    this.held = new Set();
    this.crouchLatched = false;
    this.releases = [];

    const root = this.root = document.createElement('div');
    root.id = 'touch';
    root.className = 'hidden';
    root.innerHTML = '<div class="t-move"><div class="t-joy"><div class="t-knob"></div></div></div><div class="t-look"></div>';
    for (const b of BUTTONS) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `t-btn t-${b.name}`;
      el.setAttribute('aria-label', b.label);
      el.innerHTML = svg(b.name);
      root.append(el);
      this.releases.push(this.button(el, b));
    }
    document.body.append(root);
    this.releases.push(this.joystick(root.querySelector('.t-move')), this.lookZone(root.querySelector('.t-look')));
  }

  joystick(zone) {
    const joy = zone.querySelector('.t-joy'), knob = zone.querySelector('.t-knob');
    let ox = 0, oy = 0;
    const place = (dx, dy) => {
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const m = Math.hypot(dx, dy) / JOY_R;
      if (m < DEAD) { this.stick.x = this.stick.y = 0; return; }
      const k = (m >= RUN ? 1 : (m - DEAD) / (RUN - DEAD)) / m; // rescale magnitude, keep direction
      this.stick.x = (dx / JOY_R) * k;
      this.stick.y = (dy / JOY_R) * k;
    };
    return track(zone, {
      start: (t) => {
        const r = zone.getBoundingClientRect();
        ox = t.clientX; oy = t.clientY;
        joy.style.left = `${ox - r.left}px`; joy.style.top = `${oy - r.top}px`;
        joy.classList.add('on');
        place(0, 0);
      },
      move: (t) => {
        let dx = t.clientX - ox, dy = t.clientY - oy;
        const d = Math.hypot(dx, dy);
        if (d > JOY_R) { dx *= JOY_R / d; dy *= JOY_R / d; }
        place(dx, dy);
      },
      end: () => { joy.classList.remove('on'); joy.style.left = joy.style.top = ''; place(0, 0); },
    });
  }

  lookZone(zone) {
    let lx = 0, ly = 0;
    return track(zone, {
      start: (t) => { lx = t.clientX; ly = t.clientY; },
      move: (t) => { this.onLook(t.clientX - lx, t.clientY - ly); lx = t.clientX; ly = t.clientY; },
    });
  }

  button(el, b) {
    let lx = 0, ly = 0;
    const set = (down) => {
      el.classList.toggle('down', down);
      if (down) this.held.add(b.name); else this.held.delete(b.name);
      if (b.name === 'crouch') {
        if (down) this.crouchLatched = !this.crouchLatched;
        el.classList.toggle('latched', this.crouchToggle && this.crouchLatched);
      }
      if (down || b.hold) this.onButton(b.name, down);
    };
    return track(el, {
      start: (t) => { lx = t.clientX; ly = t.clientY; set(true); },
      move: (t) => { if (b.look) { this.onLook(t.clientX - lx, t.clientY - ly); lx = t.clientX; ly = t.clientY; } },
      end: () => set(false),
    });
  }

  // The touch part of the player's input, in readInput()'s shape.
  input() {
    if (!this.visible) return null;
    return {
      forward: -this.stick.y, side: this.stick.x,
      jump: this.held.has('jump'),
      duck: this.crouchToggle ? this.crouchLatched : this.held.has('crouch'),
    };
  }

  show(on) {
    if (on === this.visible) return;
    this.visible = on;
    this.root.classList.toggle('hidden', !on);
    document.body.classList.toggle('touch-playing', on);
    if (!on) { for (const r of this.releases) r(); this.crouchLatched = false; }
  }
}
