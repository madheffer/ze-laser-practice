// The room screen's map + stage picker (ui/room.js): the maps as a compact grid of screenshot cards, then the picked map's
// stages as the stage list's own cards (ui/stage-list.js: thumbnail, one-line summary, badge, ∞ for endless), grouped
// the same way (lib/stage-groups.js; a boss's single attacks in a drawer under it), free roam last. The room owner
// picks; everyone else sees the same cards read-only with the owner's pick marked.
// Map and scenario text goes in through textContent only.
import { loadScenarios } from '../world/assets.js';
import { shotsOf } from './home-hero.js';
import { displayName } from './maps.js';
import { stageCard, shotUrls, personalBest, FREE_ROAM } from './stage-list.js';
import { groupStages } from '../lib/stage-groups.js';

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; }

export class RoomPicker {
  // maps(): S.mapIndex; onPick(map, stageId | null, mode): the owner picked a stage (mode: 'normal' | 'endless')
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
      cap.append(el('b', null, displayName(m.title || m.name)), el('small', null, `${m.scenarios || 0} stage${m.scenarios === 1 ? '' : 's'}`));
      b.append(cap);
      b.addEventListener('click', () => { this.map = m.name; this.render(); });
      return b;
    }));
    this.renderStages();
  }

  async renderStages() {
    const map = this.map;
    const info = this.maps().find((m) => m.name === map);
    this.stageLabel.textContent = map ? `Stage · ${displayName(info?.title || map)}` : 'Stage';
    if (!map) { this.stages.replaceChildren(el('p', 'rp-empty', 'No maps on this server yet.')); return; }
    const list = await this.scenarios(map);
    if (this.map !== map) return;
    const thumb = shotUrls(info);
    const byParent = new Map();
    list.forEach((s, i) => { if (s?.parent) { if (!byParent.has(s.parent)) byParent.set(s.parent, []); byParent.get(s.parent).push(i); } });
    const parts = groupStages(list);
    parts.push({ name: 'Explore', items: [-1] });
    // the owner picks (a card plays it, its ∞ plays it endless); everyone else only looks, so no details to play from
    const onPick = (i, mode) => { if (this.editable) this.onPick(map, i >= 0 ? list[i].id : null, mode); };
    const onDetails = this.editable ? undefined : () => {};
    const card = (i, extra = {}) => {
      const s = i >= 0 ? list[i] : FREE_ROAM;
      const c = stageCard(s, { index: i, onPick, onDetails, shotUrl: i >= 0 && !extra.mini ? thumb(s.id) : null, best: i >= 0 ? personalBest(map, s.id) : '', ...extra });
      const picked = this.isPicked(map, i >= 0 ? s.id : null);
      c.classList.toggle('picked', picked);
      c.querySelector('.sl-main')?.setAttribute('aria-pressed', String(picked));
      return c;
    };
    const out = parts.map((p) => {
      const sec = el('section', 'rp-group');
      sec.append(el('h4', null, p.name));
      const grid = el('div', 'sl-grid');
      const drawers = [];
      for (const i of p.items) {
        const kids = i >= 0 ? byParent.get(list[i].id) || [] : [];
        let drawer = null;
        if (kids.length) {
          drawer = el('details', 'sl-drills');
          const sum = el('summary');
          sum.append(el('span', null, `${list[i].name}: ${list[i].childrenTitle || 'single attacks'}`), el('span', 'count', String(kids.length)));
          const mini = el('div', 'sl-grid mini');
          for (const k of kids) mini.append(card(k, { mini: true }));
          drawer.append(sum, mini);
          if (kids.some((k) => this.isPicked(map, list[k].id))) drawer.open = true;
          drawers.push(drawer);
        }
        grid.append(card(i, drawer ? { drills: { count: kids.length, open: () => { drawer.open = true; drawer.scrollIntoView({ block: 'nearest' }); } } } : {}));
      }
      sec.append(grid, ...drawers);
      return sec;
    });
    this.stages.replaceChildren(...out);
    this.stages.classList.add('sl');
    this.stages.querySelector('.sl-card.picked')?.scrollIntoView({ block: 'nearest' });
  }

  isPicked(map, id) { return this.pick?.map === map && (this.pick.stage ?? null) === (id ?? null); }
}
