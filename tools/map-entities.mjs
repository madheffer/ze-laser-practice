// A baked map's entities as the game runs them: entities.json with GFL's StripperCS2 edits applied (stripper.json,
// tools/stripper.mjs; lib/stripper.js), the same as the client (world/assets.js) and the co-op server
// (server/map-store.js) load them. For the tools (sim, teleports, io-graph, index-maps).
import fs from 'node:fs';
import path from 'node:path';
import { applyStripper } from '../web/src/lib/stripper.js';

export function readMapEntities(dir) {
  const entities = JSON.parse(fs.readFileSync(path.join(dir, 'entities.json'), 'utf8'));
  const sf = path.join(dir, 'stripper.json');
  const stripper = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : null;
  return applyStripper(entities, stripper, path.basename(path.resolve(dir)));
}
