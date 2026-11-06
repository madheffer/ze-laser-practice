// The map picker: the first thing the Play tab shows. One card per baked map (maps/index.json, written by
// tools/index-maps.mjs): its title, a line about it, its parts (the scenario groups: Stage A, Bosses, ...) and
// your records on it. Picking a card loads the map (the card shows the progress) and opens its stage list.
//
// Everything on a card comes from index.json, which is built from map / scenario files: text goes in through
// textContent only.
import { mapRecordCounts } from '../app/records.js';
import { isMapName, versioned } from '../lib/paths.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// "ze_ffxii_westersand_v8" -> "ffxii westersand v8": the card's big title (the real name stays under it)
export function displayName(name) {
  return String(name).replace(/^ze_/i, '').replace(/_+/g, ' ').trim() || String(name);
}

// a stable hue per map, so each card has its own colour without any art
function hue(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

export class MapPicker {
  constructor(root, { onPick }) {
    this.root = root;
    this.onPick = onPick;
    this.cards = new Map();
  }

  build(maps, current) {
    this.root.replaceChildren();
    this.cards.clear();
    if (!maps.length) {
      const empty = el('p', 'maps-empty', 'No maps baked yet. Run lasers-bake, then node tools/index-maps.mjs (README: "Run it locally").');
      this.root.append(empty);
      return;
    }
    // maps with stages first, then the ones that only have free roam; each group in index order
    const sorted = [...maps].sort((a, b) => (b.scenarios > 0) - (a.scenarios > 0));
    for (const m of sorted) this.root.append(this.card(m, m.name === current));
  }

  card(m, current) {
    const btn = el('button', 'map-card' + (current ? ' current' : '') + (m.scenarios ? '' : ' bare'));
    btn.type = 'button';
    btn.style.setProperty('--hue', String(hue(m.name)));
    btn.setAttribute('aria-label', `${m.title || m.name}: ${m.scenarios || 'no'} stages`);

    const art = el('span', 'map-art');
    // a picture from the map (index.json `card`: its version; maps/<name>/card.webp), else the colour block
    if (isMapName(m.name) && typeof m.card === 'string' && /^[a-z0-9]{1,16}$/.test(m.card)) {
      const img = el('img', 'map-pic');
      img.alt = '';
      img.decoding = 'async';
      img.loading = 'lazy';
      img.src = versioned(`maps/${m.name}/card.webp`, [m.version, m.card].filter(Boolean).join('.'));
      art.classList.add('has-pic');
      art.append(img);
    }
    art.append(el('span', 'map-big', displayName(m.title || m.name)));
    if (current) art.append(el('span', 'map-badge', 'loaded'));

    const body = el('span', 'map-body');
    body.append(el('span', 'map-id', m.name));
    if (m.description) body.append(el('span', 'map-desc', m.description));

    const parts = el('span', 'map-parts');
    for (const p of Array.isArray(m.parts) ? m.parts : []) {
      const chip = el('span', 'part');
      chip.append(el('b', null, String(p.name)), el('i', null, String(p.stages)));
      if (p.bosses) chip.classList.add('has-boss');
      parts.append(chip);
    }
    if (!m.scenarios) parts.append(el('span', 'part free', 'Free roam only: no stages written yet'));
    body.append(parts);

    const foot = el('span', 'map-foot');
    const bosses = (m.parts || []).reduce((n, p) => n + (p.bosses || 0), 0);
    foot.append(el('span', null, [m.scenarios ? `${m.scenarios} stage${m.scenarios === 1 ? '' : 's'}` : '', bosses ? `${bosses} boss fights` : ''].filter(Boolean).join(' · ')));
    const rec = mapRecordCounts(m.name);
    if (rec.cleared || rec.endless) foot.append(el('span', 'map-pb', [rec.cleared && `${rec.cleared} cleared`, rec.endless && `${rec.endless} endless`].filter(Boolean).join(' · ')));
    body.append(foot);

    const progress = el('span', 'map-progress');
    progress.setAttribute('role', 'status');
    btn.append(art, body, progress);
    btn.addEventListener('click', () => this.onPick(m.name));
    this.cards.set(m.name, { btn, progress });
    return btn;
  }

  // loading: text shows on that card and every card is disabled until it's done (null clears)
  loading(name, text) {
    for (const [n, c] of this.cards) {
      c.btn.disabled = text != null;
      c.btn.classList.toggle('loading', n === name && text != null);
      c.progress.textContent = n === name && text != null ? text : '';
    }
  }

  focusCurrent() {
    const c = [...this.cards.values()].find((x) => x.btn.classList.contains('current')) || this.cards.values().next().value;
    c?.btn.focus({ preventScroll: true });
  }
}
