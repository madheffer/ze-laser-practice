// C_OP_RenderSound: a sound per particle. Ported from CS2's particles.dll (md5 63babcbf3245e56855a777134323e74a,
// class dump C_OP_RenderSound vtable 18052ad48; render slot 48 FUN_1802f7a60, stop-all slot 49 FUN_1802f7970):
//  - 16 voice slots, each keyed by a particle's ID. Every frame, each live particle keeps its slot or takes a free one;
//    a new slot starts m_pszSoundName (the sound system's slot-0x160 call), a kept one is updated with this frame's
//    position, pitch and volume (the same call with the slot's handle).
//  - position: the particle's (attribute 0), or control point m_nCPReference's when that is >= 0.
//  - pitch = m_flPitchScale x attribute m_nPitchField (default 100 x alpha2), volume = m_flVolumeScale x
//    m_nVolumeField (default 1 x alpha), sound level = m_flSndLvlScale x m_nSndLvlField, duration likewise; a field of
//    19 (PARTICLE_ATTRIBUTE_UNDEFINED) reads 1.
//  - a slot whose particle is gone stops its sound (slot-0x168 call), the effect's end stops them all (slot 49).
//    m_bSuppressStopSoundEvent rides along with every start: here, a suppressed stop leaves the sound to finish.
// UNSETTLED: the pitch's unit (taken as percent: 100 = normal); sound level and duration are not applied (the
// event's own distance curve is); what gates the render call (collection flag 4, context +0x100) is taken as "every
// frame the effect updates".
import { getCp } from '../functions/common.js';

const SLOTS = 16;
const UNDEFINED = 19;
let nextId = 1;

export class SoundRenderer {
  constructor(emit) {
    this.emit = emit; // (request) -> void: world/entities/sound.js's request shape, the voice's "entity" a stand-in
    this.slots = Array.from({ length: SLOTS }, () => ({ used: false, id: 0, live: false, voice: null }));
    this.mesh = null;
  }

  update(col, p) {
    const name = p.m_pszSoundName;
    if (!name || !this.emit) return { unsupported: [] };
    const A = col.attr || {};
    const n = col.count || 0;
    const field = (f, i) => (f === UNDEFINED || !A[f] ? 1 : A[f][i] ?? 1);
    for (const s of this.slots) s.live = false;
    for (let i = 0; i < n; i++) {
      const pid = A[11]?.[i] ?? i;
      let slot = this.slots.find((s) => s.used && s.id === pid);
      if (!slot) {
        slot = this.slots.find((s) => !s.used);
        if (!slot) continue; // all 16 taken: this particle is silent
        slot.used = true; slot.id = pid; slot.voice = null;
      }
      slot.live = true;
      const ref = p.m_nCPReference ?? -1;
      const pos = ref >= 0 ? [...getCp(col, ref | 0).position] : [A[0]?.[3 * i] ?? 0, A[0]?.[3 * i + 1] ?? 0, A[0]?.[3 * i + 2] ?? 0];
      const pitch = ((p.m_flPitchScale ?? 100) * field(p.m_nPitchField ?? 16, i)) / 100;
      const volume = (p.m_flVolumeScale ?? 1) * field(p.m_nVolumeField ?? 7, i);
      if (!slot.voice) {
        const v = slot.voice = { ent: { id: `fx${nextId++}`, alive: true, pos, worldOrigin: () => v.ent.pos }, pitch, volume };
        this.emit({ type: 'start', ent: v.ent, name, pos, pitch: pitch > 0 ? pitch : 1, volume: Math.max(0, volume) });
      } else {
        const v = slot.voice;
        v.ent.pos = pos;
        if (Math.abs(pitch - v.pitch) > 0.005 && pitch > 0) { v.pitch = pitch; this.emit({ type: 'pitch', ent: v.ent, value: pitch }); }
        if (Math.abs(volume - v.volume) > 0.005) { v.volume = volume; this.emit({ type: 'volume', ent: v.ent, value: Math.min(1, Math.max(0, volume)) }); }
      }
    }
    for (const s of this.slots) if (s.used && !s.live) this.release(s, p);
    return { unsupported: [] };
  }

  release(s, p) {
    if (s.voice) {
      s.voice.ent.alive = false;
      if (!p?.m_bSuppressStopSoundEvent) this.emit({ type: 'stop', ent: s.voice.ent });
    }
    s.used = false; s.id = 0; s.voice = null;
  }

  dispose() { for (const s of this.slots) if (s.used) this.release(s, null); }
}
