// The room settings form: used to create a room and, for its owner, to change it later. What it edits is
// lib/room-rules.js's shape ({ name, public, kind, max, rules }); the server cleans it again and owns it.
// Cheats sit in their own group, off by default, with a warning that everyone in the room sees them.
import { RULE_DEFAULTS, SETTINGS_DEFAULTS, ROOM_MAX, cleanSettings } from '../lib/room-rules.js';

let uid = 0;
function el(tag, cls, attrs = {}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
const text = (tag, cls, t) => { const e = el(tag, cls); e.textContent = t; return e; };

// segmented radio group: [{ id, label, hint }]
function seg(name, options, value) {
  const box = el('div', 'seg', { role: 'radiogroup', 'aria-label': name });
  const btns = options.map((o) => {
    const b = el('button', '', { type: 'button', role: 'radio', 'data-id': o.id, title: o.hint || '' });
    b.textContent = o.label;
    b.addEventListener('click', () => set(o.id));
    box.append(b);
    return b;
  });
  let cur = value;
  const set = (v) => { cur = v; for (const b of btns) b.setAttribute('aria-checked', String(b.dataset.id === v)); box.dispatchEvent(new Event('change')); };
  set(value);
  return { el: box, get value() { return cur; }, set };
}

function check(label, hint, value) {
  const id = `lf-${++uid}`;
  const wrap = el('label', 'chk', { for: id });
  const input = el('input', '', { type: 'checkbox', id });
  input.checked = !!value;
  const span = el('span');
  span.append(label);
  if (hint) span.append(' ', text('small', '', hint));
  wrap.append(input, span);
  return { el: wrap, get value() { return input.checked; } };
}

function range(label, min, max, step, value, fmt = (v) => String(v)) {
  const id = `lf-${++uid}`;
  const wrap = el('label', 'field', { for: id });
  const out = el('output');
  const input = el('input', '', { type: 'range', id, min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  const show = () => { out.textContent = fmt(Number(input.value)); };
  input.addEventListener('input', show);
  show();
  wrap.append(label, ' ', out, input);
  return { el: wrap, get value() { return Number(input.value); } };
}

// settings: the starting values; mode: 'create' | 'edit'; owner name for the placeholder; players: [{ id, name }] in
// the room (who can carry the heal; a new room picks a holder once people are in it)
export function roomForm(settings, { mode, ownerName, members = 1, players = [], onSubmit, onCancel }) {
  const s = cleanSettings(settings, members);
  const r = s.rules;
  const form = el('form', 'room-form', { novalidate: '' });
  form.append(text('h3', 'rf-title', mode === 'create' ? 'Create a room' : 'Room settings'));

  // ---- the room
  const general = el('fieldset', 'card');
  general.append(text('legend', '', 'Room'));
  const nameId = `lf-${++uid}`;
  const nameLabel = el('label', 'field', { for: nameId });
  const name = el('input', '', { type: 'text', id: nameId, maxlength: '32', placeholder: `${ownerName || 'Player'}'s room`, spellcheck: 'false', autocomplete: 'off' });
  name.value = s.name;
  nameLabel.append('Name', name);
  const vis = seg('Visibility', [
    { id: 'private', label: 'Private', hint: 'Only people with the code or invite link can join' },
    { id: 'public', label: 'Public', hint: 'Listed under Browse rooms, anyone can join' },
  ], s.public ? 'public' : 'private');
  const visHint = text('small', 'rf-hint', '');
  const syncVis = () => { visHint.textContent = vis.value === 'public' ? 'Anyone can find it under Browse rooms.' : 'Only people with the code or invite link can join.'; };
  vis.el.addEventListener('change', syncVis);
  syncVis();
  const kind = seg('Mode', [
    { id: 'coop', label: 'Co-op', hint: 'Survive together; the last one alive can still clear it' },
    { id: 'versus', label: 'Versus', hint: 'Same stage, last one alive wins' },
  ], s.kind);
  const kindHint = text('small', 'rf-hint', '');
  const syncKind = () => { kindHint.textContent = kind.value === 'versus' ? 'The same stage side by side: the last one alive wins (both clear it: fewer hits wins).' : 'Survive together. If your friends go down you can still clear it alone, as the last one alive.'; };
  kind.el.addEventListener('change', syncKind);
  syncKind();
  const maxId = `lf-${++uid}`;
  const maxLabel = el('label', 'field inline', { for: maxId });
  const max = el('select', '', { id: maxId });
  for (let n = Math.max(2, members); n <= ROOM_MAX; n++) { const o = el('option'); o.value = String(n); o.textContent = String(n); max.append(o); }
  max.value = String(s.max);
  maxLabel.append('Max players', max);
  const row = (label, ctl, hint) => { const d = el('div', 'rf-row'); d.append(text('span', 'rf-label', label), ctl, hint); return d; };
  general.append(nameLabel, row('Visibility', vis.el, visHint), row('Mode', kind.el, kindHint), maxLabel);

  // ---- bosses + damage
  const bosses = el('fieldset', 'card');
  bosses.append(text('legend', '', 'Bosses & damage'));
  const humans = range('Humans alive', 1, 64, 1, r.humans);
  const bossHp = range('Boss HP', 5, 100, 5, Math.max(5, r.bossHp), (v) => `${v}%`);
  const autoFire = check('Team shoots the boss', 'only while it is in sight', r.autoFire);
  const perfect = check('Perfect team', 'everyone fires nonstop (a fast kill)', r.perfectTeam);
  const fall = check('Fall damage', 'ZE servers run it off', r.fallDamage);
  // the map's heal item (mist's Cleansing Aura, westersand's Heal Magick...): who starts with it, E to use
  const healId = `lf-${++uid}`;
  const healLabel = el('label', 'field inline', { for: healId });
  const heal = el('select', '', { id: healId });
  const syncHeal = () => {
    const keep = heal.value || String(r.heal);
    const opts = [['none', 'Nobody'], ['all', kind.value === 'versus' ? 'Everyone (their own)' : 'Everyone']];
    if (kind.value !== 'versus') for (const p of players) opts.push([String(p.id), p.name]);
    heal.replaceChildren(...opts.map(([v, t]) => { const o = el('option'); o.value = v; o.textContent = t; return o; }));
    heal.value = opts.some(([v]) => v === keep) ? keep : 'none';
  };
  kind.el.addEventListener('change', syncHeal);
  syncHeal();
  healLabel.append('Heal item', heal);
  const healHint = text('small', 'rf-hint', mode === 'create' ? "The map's own heal, E to use. Pick one player for it once people have joined." : "The map's own heal (mist: Cleansing Aura), E to use. Versus: everyone or nobody.");
  bosses.append(humans.el, bossHp.el, autoFire.el, perfect.el, fall.el, healLabel, healHint);

  // ---- cheats
  const cheats = el('fieldset', 'card cheats');
  cheats.append(text('legend', '', 'Cheats'), text('p', 'rf-warn', 'Off on a real server. Everyone in the room (and the public list) sees which are on.'));
  const god = check('God mode', 'nobody takes damage', r.god);
  const hitboxes = check('Show laser hitboxes', '', r.hitboxes);
  const bhop = check('Auto bunnyhop', 'hold jump', r.autoBhop);
  cheats.append(god.el, hitboxes.el, bhop.el);

  const grid = el('div', 'rf-grid');
  grid.append(general, bosses, cheats);

  // ---- buttons
  const bar = el('div', 'rf-buttons');
  const submit = el('button', 'primary', { type: 'submit' });
  submit.textContent = mode === 'create' ? 'Create room' : 'Save';
  const reset = el('button', 'ghost', { type: 'button', title: 'A ZE server\'s defaults: 20 humans, full boss HP, team fire on, no cheats' });
  reset.textContent = 'Server defaults';
  const cancel = el('button', 'ghost', { type: 'button' });
  cancel.textContent = 'Cancel';
  bar.append(submit, reset, cancel);
  if (mode === 'edit') bar.append(text('small', 'rf-hint', 'Changes apply from the next round.'));
  form.append(grid, bar);

  const read = () => cleanSettings({
    name: name.value, public: vis.value === 'public', kind: kind.value, max: Number(max.value),
    rules: { humans: humans.value, bossHp: bossHp.value, autoFire: autoFire.value, perfectTeam: perfect.value, fallDamage: fall.value,
      heal: heal.value === 'none' || heal.value === 'all' ? heal.value : Number(heal.value), god: god.value, hitboxes: hitboxes.value, autoBhop: bhop.value },
  }, members);
  form.addEventListener('submit', (ev) => { ev.preventDefault(); onSubmit(read()); });
  cancel.addEventListener('click', () => onCancel());
  reset.addEventListener('click', () => {
    const fresh = roomForm({ ...SETTINGS_DEFAULTS, name: name.value, public: vis.value === 'public', kind: kind.value, max: Number(max.value), rules: RULE_DEFAULTS }, { mode, ownerName, members, players, onSubmit, onCancel });
    form.replaceWith(fresh);
    fresh.querySelector('button[type=submit]')?.focus();
  });
  return form;
}
