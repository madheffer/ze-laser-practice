// CS2's voice management for a sound event, as the csgo_mega sound stack runs it (pak01
// soundstacks/soundstacks_csgo_mega.vsndstck_c; lasers-bake copies each event's own values into soundevents.json):
//  - block (soundevent_block_test / soundevent_block, block_matching_events default true): a start of the same event
//    within blockDuration s (default 0.01) and blockDistance units (default 12) of an earlier one is dropped; matched
//    per entity unless block_match_entity is false (default true).
//  - instance limit (soundevent_limiter, match_entity + match_this_event, stop_oldest): at most instanceLimit voices
//    of the event per entity; a new one stops the oldest. 0 = no limit (the default).
// Other event types (src1_3d, csgo_music, ...) run other stacks: only the values an event sets itself apply to them.

const MAX_BLOCKS = 256;

export class VoiceLimits {
  constructor() {
    this.blocks = []; // { name, ent, pos, until }
  }

  // def: the event; o: { entId, pos }; now: seconds. True if this start may play (and records its block).
  allow(def, o, now) {
    const mega = def.type === 'csgo_mega';
    const matching = def.blockMatching ?? mega;
    const duration = def.blockDuration ?? (mega ? 0.01 : 0);
    if (!matching || !(duration > 0)) return true;
    const distance = def.blockDistance ?? 12;
    const byEnt = def.blockMatchEntity ?? true;
    const name = def.name.toLowerCase();
    const ent = byEnt ? (o.entId ?? null) : null;
    this.blocks = this.blocks.filter((b) => b.until > now);
    for (const b of this.blocks) {
      if (b.name !== name || (byEnt && b.ent !== ent)) continue;
      if (!b.pos || !o.pos || Math.hypot(b.pos[0] - o.pos[0], b.pos[1] - o.pos[1], b.pos[2] - o.pos[2]) <= distance) return false;
    }
    if (this.blocks.length < MAX_BLOCKS) this.blocks.push({ name, ent, pos: o.pos ? [...o.pos] : null, until: now + duration });
    return true;
  }

  // the voices to stop so a new voice of def on entId stays within the instance limit
  overLimit(def, entId, voices) {
    const limit = def.instanceLimit | 0;
    if (limit <= 0) return [];
    const same = [...voices].filter((v) => !v.stopped && v.def === def && v.entId === entId);
    return same.slice(0, Math.max(0, same.length - limit + 1));
  }

  clear() { this.blocks = []; }
}
