// Every simulated particle function by class. `evidence` is 'RE' (reversed, cited in the
// function), 'VRF' (VRF cross-check, UNSETTLED) or 'none' (a reported no-op). Renderers are not
// simulated: render/* draws them from the collection's streams.
import { constraints } from './constraints.js';
import { emitters } from './emitters.js';
import { initializers } from './initializers.js';
import { operators } from './operators.js';
import { preemission } from './preemission.js';
import { ported_motion } from './ported_motion.js';
import { ported_forces } from './ported_forces.js';
import { ported_children } from './ported_children.js';

const renderer = { evidence: 'render', renderer: true };
export const FUNCTIONS = {
  ...preemission, ...emitters, ...initializers, ...operators, ...constraints,
  // ported straight from particles.dll (tools/particles/PORTING.md); a port replaces an older entry of the same class
  ...ported_motion, ...ported_forces, ...ported_children,
  C_OP_RenderSprites: renderer, C_OP_RenderRopes: renderer, C_OP_RenderStandardLight: renderer,
};
