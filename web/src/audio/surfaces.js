// A map's surface sounds: lasers-bake's maps/<map>/surfaces.json (bake/SurfaceBake.cs) from CS2's surface properties.
//   { surfaces: { "<hash>": { name, bulletImpact?, break?, impactHard?, impactSoft? } }, models: { "<model>": "<hash>" } }
// A map's data: only plain strings are kept, looked up without the prototype.
import { FRESH } from '../lib/fetch.js';
import { versioned } from '../lib/paths.js';

const str = (v) => (typeof v === 'string' && v.length <= 200 ? v : '');

export class SurfaceSounds {
  constructor() { this.clear(); }

  clear() {
    this.byHash = new Map();
    this.byModel = new Map();
  }

  async load(base, version) {
    this.clear();
    try {
      const r = await fetch(versioned(base + 'surfaces.json', version), version ? undefined : FRESH);
      if (!r.ok) return; // an older bake has none: no surface sounds
      const j = await r.json();
      for (const [h, s] of Object.entries(j?.surfaces && typeof j.surfaces === 'object' ? j.surfaces : {})) {
        if (s && typeof s === 'object') this.byHash.set(String(h), { name: str(s.name), bulletImpact: str(s.bulletImpact), break: str(s.break) });
      }
      for (const [m, h] of Object.entries(j?.models && typeof j.models === 'object' ? j.models : {})) this.byModel.set(m.toLowerCase(), String(h));
    } catch { /* none */ }
  }

  // the sound a bullet makes hitting a surface (by its hash), '' when none
  // (a hash no surfaceproperties file defines reads as "default", hash 1977497166: UNSETTLED, CS2's fallback not read)
  bulletImpact(hash) {
    const s = this.byHash.get(String(hash >>> 0)) || this.byHash.get('1977497166');
    return s?.bulletImpact || '';
  }
  // the sound a prop model makes breaking, '' when none
  breakOf(model) {
    const h = this.byModel.get(String(model || '').toLowerCase());
    return (h && this.byHash.get(h)?.break) || '';
  }
}
