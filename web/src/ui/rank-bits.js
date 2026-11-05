// The small pieces the leaderboards (ui/board.js, ui/stage-board.js) and profiles (ui/profile.js) are built from:
// avatars, player links, place medals, segmented switches, tabs, skeleton rows, map art. Pure DOM builders; every
// string goes in as text, every icon is a constant.
import { isAvatarUrl } from '../lib/steam.js';
import { account } from '../app/account.js';

export function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; }

export function button(cls, text, onClick, label) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export const KIND = { solo: 'Solo', coop: 'Online', versus: 'Versus' }; // versus: runs from before the one multiplayer mode
export const isMe = (steamId) => !!steamId && account.user?.steamId === steamId;

// a square avatar (Steam CDN only), or the name's first letter on a tinted tile
export function avatar(url, name, size = 32) {
  const box = el('span', 'rk-av');
  box.style.setProperty('--s', `${size}px`);
  box.style.setProperty('--h', String(hue(name)));
  box.setAttribute('aria-hidden', 'true');
  const letter = el('span', 'rk-av-l', (String(name).trim()[0] || '?').toUpperCase());
  box.append(letter);
  if (isAvatarUrl(url)) {
    const img = el('img');
    img.src = url; img.alt = ''; img.width = img.height = size; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
    img.addEventListener('load', () => letter.remove(), { once: true });
    img.addEventListener('error', () => img.remove(), { once: true });
    box.append(img);
  }
  return box;
}

function hue(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

// avatar + name as a button that opens their profile; "You" tag for whoever is signed in
export function playerLink(p, onPlayer, size = 28) {
  const b = el('button', 'rk-player');
  b.type = 'button';
  b.title = `${p.name}'s profile`;
  const name = el('span', 'rk-pname', p.name);
  b.append(avatar(p.avatar, p.name, size), name);
  if (isMe(p.steamId)) b.append(el('span', 'rk-you', 'You'));
  b.addEventListener('click', (ev) => { ev.stopPropagation(); onPlayer(p.steamId); });
  return b;
}

// 1 / 2 / 3 as a gold / silver / bronze medal, then plain numbers
export function place(n, cls = '') {
  const tier = n === 1 ? 'gold' : n === 2 ? 'silver' : n === 3 ? 'bronze' : '';
  const s = el('span', `rk-place ${tier ? `rk-${tier}` : ''} ${cls}`.trim(), Number.isInteger(n) ? String(n) : '–');
  if (Number.isInteger(n)) s.setAttribute('aria-label', `place ${n}`);
  return s;
}

// a segmented switch: options [[value, label]], onChange(value); returns { root, set(value) }
export function segmented(label, options, value, onChange) {
  const root = el('div', 'rk-seg');
  root.setAttribute('role', 'radiogroup');
  root.setAttribute('aria-label', label);
  const btns = options.map(([v, text]) => {
    const b = button('rk-seg-b', text, () => { if (v !== value) { set(v); onChange(v); } });
    b.setAttribute('role', 'radio');
    b.dataset.v = v;
    return b;
  });
  const set = (v) => { value = v; for (const b of btns) { const on = b.dataset.v === v; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; } };
  root.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    const i = options.findIndex(([v]) => v === value);
    const next = options[(i + (ev.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length][0];
    set(next); onChange(next);
    btns.find((b) => b.dataset.v === next)?.focus();
  });
  root.append(...btns);
  set(value);
  return { root, set };
}

// tabs: [[value, label, count?]], onChange(value) -> { root, set(value) }; the panel is the caller's
export function tabs(label, items, value, onChange) {
  const root = el('div', 'rk-tabs');
  root.setAttribute('role', 'tablist');
  root.setAttribute('aria-label', label);
  const btns = items.map(([v, text, count]) => {
    const b = button('rk-tab', text, () => { if (v !== value) { set(v); onChange(v); } });
    b.setAttribute('role', 'tab');
    b.dataset.v = v;
    if (count != null) b.append(el('span', 'rk-tab-n', String(count)));
    return b;
  });
  const set = (v) => { value = v; for (const b of btns) { const on = b.dataset.v === v; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; } };
  root.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    const i = items.findIndex(([v]) => v === value);
    const next = items[(i + (ev.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length][0];
    set(next); onChange(next);
    btns.find((b) => b.dataset.v === next)?.focus();
  });
  root.append(...btns);
  set(value);
  return { root, set };
}

// n grey placeholder rows while a board loads (they hold the layout, so nothing jumps when it arrives)
export function skeleton(n = 6) {
  const box = el('div', 'rk-skel');
  box.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < n; i++) box.append(el('div', 'rk-skel-row'));
  return box;
}

// an empty / error state: a line, and optionally a button
export function emptyState(text, action) {
  const box = el('div', 'rk-empty');
  box.append(el('p', null, text));
  if (action) box.append(action);
  return box;
}

// a map's art: a 16:9 box with its screenshot fading in over a hue of its own
export function mapArt(url, name, cls = '') {
  const box = el('span', `rk-art ${cls}`.trim());
  box.style.setProperty('--h', String(hue(name)));
  box.setAttribute('aria-hidden', 'true');
  if (url) {
    const img = el('img');
    img.src = url; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    img.addEventListener('load', () => box.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => img.remove(), { once: true });
    box.append(img);
  }
  return box;
}

// a thin progress bar (cleared stages of a map)
export function meter(value, max, label) {
  const m = el('span', 'rk-meter');
  m.setAttribute('role', 'img');
  m.setAttribute('aria-label', label);
  const fill = el('i');
  fill.style.width = `${max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0}%`;
  m.append(fill);
  return m;
}

// "Nov 2026" / "3 Nov" (this year) for a ms time
export function shortDate(ms) {
  const d = new Date(ms);
  return d.getFullYear() === new Date().getFullYear()
    ? d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' })
    : d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
