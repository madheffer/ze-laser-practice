// Settings > Game: "Map edits". GFL's servers change some maps' entities as they load (StripperCS2), and we add a few
// edits players asked for that no server ships (stripper/<map>/ in this repo; lib/stripper.js, BAKING.md "GFL's
// entity edits"). Every edit plays by default. Here each can be turned off per map, solo: one switch per edit with a
// one-line summary, a number for an edit that takes one (cosmo's lasers per wave), and an (i) for the long version
// (maps/index.json via tools/index-maps.mjs). A co-op round always plays all of them at their defaults
// (app/rules.js stripperChoice). The choice is settings.stripperOff = { map: [edit ids off] } and
// settings.stripperCount = { map: { id: n } }; it applies from the next stage start (app/session.js ->
// world/assets.js mapEdits). Map text goes in through textContent only.
import { el } from './stage-card.js';
import { settings, saveSettings } from '../app/settings.js';
import { isEditId } from '../lib/stripper.js';

let panel = null;

// the long version: the shared stage-details popover's look (ui/stage-list.css .sl-details*), no play buttons
function showDetail(edit, from) {
  if (!panel) panel = el('div', 'sl-details', { popover: 'auto', role: 'dialog', 'aria-labelledby': 'se-details-h' });
  const host = from.closest('#menu .panel, .sheet') || document.body;
  if (panel.parentNode !== host) host.append(panel);
  const head = el('div', 'sl-details-head');
  head.append(el('h3', '', { id: 'se-details-h' }, edit.name));
  head.append(el('span', `sl-badge ${edit.ours ? 'endless' : 'full'}`, {}, edit.ours ? 'Ours' : 'GFL'));
  const close = el('button', 'sl-details-x', { type: 'button', 'aria-label': 'Close' }, '×');
  close.addEventListener('click', () => panel.hidePopover());
  head.append(close);
  const parts = [head, el('p', 'sl-details-sum', {}, edit.summary)];
  if (edit.detail) parts.push(el('p', 'sl-details-desc', {}, edit.detail));
  if (edit.gfl) parts.push(el('p', 'sl-details-desc', {}, `GFL's note: "${edit.gfl}"`));
  panel.replaceChildren(...parts);
  panel.addEventListener('toggle', (ev) => { if (ev.newState === 'closed' && from.isConnected) from.focus({ preventScroll: true }); }, { once: true });
  if (!panel.matches(':popover-open')) panel.showPopover();
  close.focus({ preventScroll: true });
}

// settings[key] = { map: value } with this map's value replaced (dropped when empty), then saved
function setFor(key, map, value, empty) {
  const next = { ...settings[key] };
  if (empty(value)) delete next[map]; else next[map] = value;
  settings[key] = next;
  saveSettings();
}

function setOff(map, id, off) {
  const now = new Set(settings.stripperOff[map] || []);
  if (off) now.add(id); else now.delete(id);
  setFor('stripperOff', map, [...now].sort(), (l) => !l.length);
}

function setCount(map, id, n, def) {
  const now = { ...(settings.stripperCount[map] || {}) };
  if (n === def) delete now[id]; else now[id] = n;
  setFor('stripperCount', map, now, (o) => !Object.keys(o).length);
}

// a number for an edit that takes one: a select over its range, the default marked
function countPicker(m, edit, box) {
  const c = edit.count;
  const sel = el('select', 'se-count', { 'aria-label': `${edit.name}: ${c.label}`, title: c.label });
  for (let n = c.min; n <= c.max; n++) sel.append(el('option', '', { value: String(n) }, n === c.default ? `${n} (default)` : String(n)));
  const saved = Number(settings.stripperCount[m.name]?.[edit.id]);
  sel.value = String(Number.isInteger(saved) && saved >= c.min && saved <= c.max ? saved : c.default);
  sel.addEventListener('input', () => setCount(m.name, edit.id, Number(sel.value), c.default));
  const sync = () => { sel.disabled = !box.checked; };
  box.addEventListener('input', sync);
  sync();
  return sel;
}

// a validated copy of an index.json edit
function cleanEdit(e) {
  const c = e.count;
  const count = c && Number.isInteger(c.min) && Number.isInteger(c.max) && Number.isInteger(c.default) && c.min >= 1 && c.max <= 16 && c.min <= c.default && c.default <= c.max
    ? { min: c.min, max: c.max, default: c.default, label: String(c.label || 'Count').slice(0, 40) } : null;
  return { id: e.id, name: String(e.name || e.id), summary: String(e.summary || ''), detail: String(e.detail || ''), gfl: String(e.gfl || ''), ours: e.source === 'ours', count };
}

// maps: S.mapIndex (index.json entries); the card goes into `column`, only if a map has edits
export function installStripperSettings(column, maps) {
  const withEdits = maps.filter((m) => Array.isArray(m.edits) && m.edits.some((e) => isEditId(e?.id)));
  if (!column || !withEdits.length) return;
  const card = el('fieldset', 'card se-card');
  card.append(el('legend', '', {}, 'Map edits'));
  card.append(el('p', 'se-note', {}, 'GFL\'s server fixes, plus a few of ours. Solo only, from your next stage.'));
  for (const m of withEdits) {
    card.append(el('div', 'card-sub', {}, m.title || m.name));
    for (const raw of m.edits) {
      if (!isEditId(raw?.id)) continue;
      const edit = cleanEdit(raw);
      const row = el('div', 'se-row');
      const label = el('label', 'chk');
      const box = el('input', '', { type: 'checkbox' });
      box.checked = !(settings.stripperOff[m.name] || []).includes(edit.id);
      box.addEventListener('input', () => setOff(m.name, edit.id, !box.checked));
      const text = el('span', '', {}, edit.name);
      if (edit.summary) text.append(el('small', '', {}, edit.summary));
      label.append(box, text);
      row.append(label);
      if (edit.count) row.append(countPicker(m, edit, box));
      const info = el('button', 'sl-tool info', { type: 'button', title: 'Details', 'aria-label': `${edit.name}: details`, 'aria-haspopup': 'dialog' }, 'i');
      info.addEventListener('click', () => showDetail(edit, info));
      row.append(info);
      card.append(row);
    }
  }
  column.append(card);
}
