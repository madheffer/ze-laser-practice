// The room screen's map + stage picker (ui/room.js): the maps as a strip of screenshot cards, then the picked map's
// stages, grouped as on the stage list (a scenario's group; a boss's single attacks folded under it), free roam
// last. The room owner picks; everyone else sees the same list read-only with the owner's pick marked.
// Map and scenario text goes in through textContent only.
import { loadScenarios } from '../world/assets.js';
import { shotsOf } from './home-hero.js';
import { displayName } from './maps.js';

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; }

export class RoomPicker {
  // maps(): S.mapIndex; onPick(map, stageId | null): the owner picked a stage
  constructor({ maps, onPick }) {
    this.maps = maps;
    this.onPick = onPick;
    this.cache = new Map(); // map -> Promise<scenarios>
    this.map = '';
    this.pick = null; // { map, stage }
    this.editable = false;
    this.root = el('div', 'rp');
    const mh = el('div', 'rp-label', 'Map');
    this.strip = el('div', 'rp-maps');
    this.strip.setAttribute('role', 'listbox');
    this.strip.setAttribute('aria-label', 'Maps');
    this.stageLabel = el('div', 'rp-label', 'Stage');
    this.stages = el('div', 'rp-stages');
    this.root.append(mh, this.strip, this.stageLabel, this.stages);
  }

  scenarios(map) {
    if (!this.cache.has(map)) this.cache.set(map, loadScenarios(map).then((f) => (Array.isArray(f?.scenarios) ? f.scenarios : [])));
    return this.cache.get(map);
  }

  // pick: the room's next ({ map, stage }) or null; editable: you own the room
  set(pick, editable) {
    const changed = editable !== this.editable || pick?.map !== this.pick?.map || pick?.stage !== this.pick?.stage;
    this.pick = pick;
    this.editable = editable;
    if (!this.map || (pick?.map && pick.map !== this.map && !editable) || (pick?.map && !this.built)) this.map = pick?.map || this.map || this.maps()[0]?.name || '';
    this.root.classList.toggle('readonly', !editable);
    if (changed || !this.built) this.render();
  }

  render() {
    this.built = true;
    const maps = this.maps();
    const shots = new Map();
    for (const s of shotsOf(maps)) if (!shots.has(s.map.name)) shots.set(s.map.name, s.url);
    this.strip.replaceChildren(...maps.map((m) => {
      const b = el('button', 'rp-map');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(m.name === this.map));
      if (this.pick?.map === m.name) b.classList.add('picked');
      const url = shots.get(m.name);
      if (url) b.style.backgroundImage = `url("${url}")`;
      const cap = el('span', 'rp-map-cap');
      cap.append(el('b', null, displayName(m.title || m.name)), el('small', null, `${m.scenarios || 0} stages`));
      b.append(cap);
      b.addEventListener('click', () => { this.map = m.name; this.render(); });
      return b;
    }));
    this.renderStages();
  }

  async renderStages() {
    const map = this.map;
    this.stageLabel.textContent = map ? `Stage · ${displayName(this.maps().find((m) => m.name === map)?.title || map)}` : 'Stage';
    if (!map) { this.stages.replaceChildren(el('p', 'rp-empty', 'No maps on this server yet.')); return; }
    const list = await this.scenarios(map);
    if (this.map !== map) return;
    const kids = new Map();
    for (const s of list) if (s?.parent) { if (!kids.has(s.parent)) kids.set(s.parent, []); kids.get(s.parent).push(s); }
    const groups = new Map();
    for (const s of list) {
      if (!s || typeof s.id !== 'string' || s.parent) continue;
      const g = String(s.group || 'Stages');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    }
    const out = [];
    for (const [g, items] of groups) {
      const sec = el('section', 'rp-group');
      sec.append(el('h4', null, g));
      const grid = el('div', 'rp-grid');
      for (const s of items) {
        grid.append(this.stageButton(map, s));
        const attacks = kids.get(s.id);
        if (attacks?.length) {
          const d = el('details', 'rp-attacks');
          d.append(el('summary', null, `${attacks.length} single attack${attacks.length === 1 ? '' : 's'}`));
          const inner = el('div', 'rp-grid');
          for (const a of attacks) inner.append(this.stageButton(map, a, true));
          d.append(inner);
          if (attacks.some((a) => this.isPicked(map, a.id))) d.open = true;
          grid.append(d);
        }
      }
      sec.append(grid);
      out.push(sec);
    }
    const free = el('section', 'rp-group');
    free.append(el('h4', null, 'Explore'));
    const fg = el('div', 'rp-grid');
    fg.append(this.stageButton(map, { id: null, name: 'Free roam', description: 'Walk the map with its logic idle.' }));
    free.append(fg);
    out.push(free);
    this.stages.replaceChildren(...out);
    this.stages.querySelector('.rp-stage.picked')?.scrollIntoView({ block: 'nearest' });
  }

  isPicked(map, id) { return this.pick?.map === map && (this.pick.stage ?? null) === (id ?? null); }

  stageButton(map, s, child = false) {
    const b = el('button', `rp-stage${child ? ' child' : ''}${s.featured ? ' featured' : ''}`);
    b.type = 'button';
    b.disabled = !this.editable;
    const picked = this.isPicked(map, s.id);
    b.classList.toggle('picked', picked);
    b.setAttribute('aria-pressed', String(picked));
    const top = el('span', 'rp-stage-top');
    top.append(el('b', null, String(s.name || s.id)));
    if (s.endless) top.append(el('i', 'rp-endless', '∞'));
    b.append(top);
    const desc = String(s.description || '');
    if (desc && !child) { const p = el('span', 'rp-desc', desc); b.title = desc; b.append(p); }
    b.addEventListener('click', () => { if (this.editable) this.onPick(map, s.id ?? null); });
    return b;
  }
}
