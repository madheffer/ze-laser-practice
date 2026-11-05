// Every simulated particle function by class. `evidence` is 'RE' (reversed, cited in the
// function), 'VRF' (VRF cross-check, UNSETTLED) or 'none' (a reported no-op). Renderers are not
// simulated: render/* draws them from the collection's streams.
import { constraints } from './constraints.js';
import { initializers } from './initializers.js';
import { operators } from './operators.js';
import { preemission } from './preemission.js';
import { ported_movement } from './ported_movement.js';
import { ported_motion } from './ported_motion.js';
import { ported_forces } from './ported_forces.js';
import { ported_children } from './ported_children.js';
import { ported_collision } from './ported_collision.js';
import { ported_vecnoise } from './ported_vecnoise.js';
import { ported_pin } from './ported_pin.js';
import { ported_contact } from './ported_contact.js';
import { ported_cp_initializers } from './ported_cp_initializers.js';
import { ported_emitters } from './ported_emitters.js';
import { ported_snapshot } from './ported_snapshot.js';

const renderer = { evidence: 'render', renderer: true };
export const FUNCTIONS = {
  ...preemission, ...initializers, ...operators, ...constraints,
  // ported straight from particles.dll (tools/particles/PORTING.md); a port replaces an older entry of the same class
  ...ported_movement, ...ported_motion, ...ported_forces, ...ported_children, ...ported_collision, ...ported_vecnoise,
  ...ported_pin, ...ported_contact, ...ported_cp_initializers, ...ported_emitters, ...ported_snapshot,
  C_OP_RenderSprites: renderer, C_OP_RenderRopes: renderer, C_OP_RenderStandardLight: renderer,
};
