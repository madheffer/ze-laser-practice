// Settings > Game: "GFL map edits". GFL's servers change some maps' entities as they load (StripperCS2; lib/stripper.js,
// BAKING.md "GFL's entity edits"); every edit plays by default, as on GFL. Here each can be turned off per map, solo:
// one switch per edit with a one-line summary, and an (i) for the long version (the scenario file's `stripper` words
// and GFL's own comment, both in maps/index.json via tools/index-maps.mjs). A co-op round always plays all of them
// (app/rules.js stripperOff). The choice is settings.stripperOff = { map: [edit ids off] }; it applies from the next
// stage start (app/session.js -> world/assets.js mapEdits). Map text goes in through textContent only.
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

function setOff(map, id, off) {
  const now = new Set(settings.stripperOff[map] || []);
  if (off) now.add(id); else now.delete(id);
  const next = { ...settings.stripperOff };
  if (now.size) next[map] = [...now].sort(); else delete next[map];
  settings.stripperOff = next;
  saveSettings();
}

// maps: S.mapIndex (index.json entries); the card goes into `column`, only if a map has edits
export function installStripperSettings(column, maps) {
  const withEdits = maps.filter((m) => Array.isArray(m.edits) && m.edits.some((e) => isEditId(e?.id)));
  if (!column || !withEdits.length) return;
  const card = el('fieldset', 'card se-card');
  card.append(el('legend', '', {}, 'GFL map edits'));
  card.append(el('p', 'se-note', {}, 'Fixes GFL\'s servers make to these maps. Solo only, from your next stage.'));
  for (const m of withEdits) {
    card.append(el('div', 'card-sub', {}, m.title || m.name));
    for (const e of m.edits) {
      if (!isEditId(e?.id)) continue;
      const edit = { id: e.id, name: String(e.name || e.id), summary: String(e.summary || ''), detail: String(e.detail || ''), gfl: String(e.gfl || '') };
      const row = el('div', 'se-row');
      const label = el('label', 'chk');
      const box = el('input', '', { type: 'checkbox' });
      box.checked = !(settings.stripperOff[m.name] || []).includes(edit.id);
      box.addEventListener('input', () => setOff(m.name, edit.id, !box.checked));
      const text = el('span', '', {}, edit.name);
      if (edit.summary) text.append(el('small', '', {}, edit.summary));
      label.append(box, text);
      const info = el('button', 'sl-tool info', { type: 'button', title: 'Details', 'aria-label': `${edit.name}: details`, 'aria-haspopup': 'dialog' }, 'i');
      info.addEventListener('click', () => showDetail(edit, info));
      row.append(label, info);
      card.append(row);
    }
  }
  column.append(card);
}
