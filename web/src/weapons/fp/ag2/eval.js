import * as THREE from 'three';
import { ClipSource, Pose } from './clip.js';

// ── AG2 graph evaluator (P4) ─────────────────────────────────────────────────
// Evaluates a compiled CS2 viewmodel AnimGraph2 (Esoterica-derived) from control
// parameters + time, producing a per-bone pose each frame. This replaces the
// hand-written clip state machine: transitions, lockouts, hold-inspect, ammo-
// driven reload etc. all emerge from the real graph data.
//
// Pull-based: to get the root pose we evaluate the root node, which recursively
// pulls its inputs. Value nodes (params/const/math/compare/logic) are memoized
// per frame; pose nodes hold time state and only advance while ACTIVE (a clip
// re-entered after being inactive restarts at 0, exactly like the engine).

const cls = n => n._class.slice(3, -17);   // "CNmClipNode::CDefinition" -> "Clip"

function blendPose(out, a, b, w) {          // interpolate a->b by w into out
  const names = new Set([...a.bones.keys(), ...b.bones.keys()]);
  for (const name of names) {
    const pa = a.bones.get(name), pb = b.bones.get(name), o = out.get(name);
    if (pa && pb) { o.pos.lerpVectors(pa.pos, pb.pos, w); o.quat.copy(pa.quat).slerp(pb.quat, w); o.scale.lerpVectors(pa.scale, pb.scale, w); }
    else if (pa) { o.pos.copy(pa.pos); o.quat.copy(pa.quat); o.scale.copy(pa.scale); }
    else if (pb) { o.pos.copy(pb.pos); o.quat.copy(pb.quat); o.scale.copy(pb.scale); }
  }
  return out;
}
const _dq = new THREE.Quaternion(), _id = new THREE.Quaternion(), _rq = new THREE.Quaternion();
// Additive compose: out = out * (identity->delta by w); pos += delta*w.
//
// The delta must be RECOVERED first: the clips are additive in the compiled
// data (m_bIsAdditive), but VRF's glTF exporter resolves them to ABSOLUTE
// poses - the R8's chamber_position clips carry the full bind pose plus the
// rotated chamber, byte-for-byte bind on every other bone. Adding that raw at
// weight 1 doubles the whole skeleton (the R8's exploded-arm render). So each
// sampled bone is measured against the skeleton's reference pose when one is
// known: delta_q = bind_q^-1 * sample_q, delta_p = sample_p - bind_p. A bone
// with no reference falls back to the raw value.
function additiveInto(out, delta, w, ref, mask) {
  for (const [name, d] of delta.bones) {
    // A layer's bone mask gates the blend per bone (unlisted bones are 0).
    const bw = mask ? w * (mask[name] || 0) : w;
    if (bw <= 0.0001) continue;
    const o = out.get(name);
    const r = ref?.get(name);
    if (r) {
      _rq.copy(r.q).invert().multiply(d.quat);
      if (_rq.w < 0) _rq.set(-_rq.x, -_rq.y, -_rq.z, -_rq.w);   // shortest arc
      _dq.copy(_id).slerp(_rq, bw);
      o.quat.multiply(_dq);
      o.pos.x += (d.pos.x - r.p.x) * bw;
      o.pos.y += (d.pos.y - r.p.y) * bw;
      o.pos.z += (d.pos.z - r.p.z) * bw;
    } else {
      o.pos.addScaledVector(d.pos, bw);
      _dq.copy(_id).slerp(d.quat, bw);
      o.quat.multiply(_dq);
    }
  }
  return out;
}
function copyPose(out, src) {
  for (const [name, p] of src.bones) { const o = out.get(name); o.pos.copy(p.pos); o.quat.copy(p.quat); o.scale.copy(p.scale); }
  return out;
}

export class Graph {
  // json: the emitted graph. clips: Map<resourcePath, ClipSource>. subGraphs:
  // Map<resourcePath, Graph> for referenced graphs (inspects). refPose: the
  // skeleton bind (name -> {p, q}) additive layers recover their deltas from.
  // boneMasks: {maskId: {bone: weight}} from the skeleton's mask definitions;
  // a layer naming a mask blends only the bones the mask lists.
  constructor(json, clips, subGraphs = new Map(), refPose = null, boneMasks = null) {
    this.refPose = refPose;
    this.boneMasks = boneMasks;
    this.json = json;
    this.nodes = json.m_nodes;
    this.byIdx = new Map(this.nodes.map(n => [n.m_nNodeIdx, n]));
    this.clips = clips;
    this.subGraphs = subGraphs;
    this.resources = json.m_resources;
    this.rootIdx = json.m_nRootNodeIdx;
    this.controlIds = json.m_controlParameterIDs;
    this.params = new Map();                // name -> value (float | id-string | bool)
    this.controlIds.forEach((id, i) => this.params.set(id, defaultFor(id)));
    // per-node runtime state
    this.st = new Map();
    for (const n of this.nodes) this.st.set(n.m_nNodeIdx, { time: 0, wasActive: false, active: false, smState: n.m_nDefaultStateIndex ?? 0, trans: null });
    this._valCache = new Map();
    this._pool = [];                        // reusable Pose objects
    this._events = new Set();               // graph events raised this frame (WPN_STATE_IDLE, ...)
    this._seekSync = null;                  // pending targetSyncID for the next entering clip
  }

  setParam(name, value) { this.params.set(name, value); }
  getParam(name) { return this.params.get(name); }

  poolPose() { const p = this._pool.pop() || new Pose(); return p.clear(); }

  update(dt) {
    this._valCache.clear();
    for (const s of this.st.values()) s.active = false;
    this._events.clear();
    const out = new Pose();
    this.evalPose(this.rootIdx, dt, out);
    for (const [idx, s] of this.st) s.wasActive = s.active;
    return out;
  }

  // ── value nodes ────────────────────────────────────────────────────────────
  val(idx) {
    if (idx < 0) return undefined;
    if (this._valCache.has(idx)) return this._valCache.get(idx);
    const n = this.byIdx.get(idx); let v;
    switch (cls(n)) {
      case 'ControlParameterFloat': case 'ControlParameterID': case 'ControlParameterBool':
        v = this.params.get(this.controlIds[idx]); break;   // node index == control-param index
      case 'ConstFloat': v = n.m_flValue; break;
      case 'ConstID': v = n.m_value; break;
      case 'IDComparison': {
        const input = this.val(n.m_nInputValueNodeIdx);
        const match = n.m_comparisionIDs.includes(input);
        v = n.m_comparison === 'DoesntMatch' ? !match : match; break;
      }
      case 'FloatComparison': {
        const a = +this.val(n.m_nInputValueNodeIdx);
        const b = n.m_nComparandValueNodeIdx >= 0 ? +this.val(n.m_nComparandValueNodeIdx) : n.m_flComparisonValue;
        const e = n.m_flEpsilon || 0;
        v = compareFloat(n.m_comparison, a, b, e); break;
      }
      case 'And': v = n.m_conditionNodeIndices.every(i => !!this.val(i)); break;
      case 'Or': v = n.m_conditionNodeIndices.some(i => !!this.val(i)); break;
      case 'Not': v = !this.val(n.m_nInputValueNodeIdx); break;
      case 'FloatMath': {
        const a = +this.val(n.m_nInputValueNodeIdxA);
        const b = n.m_nInputValueNodeIdxB >= 0 ? +this.val(n.m_nInputValueNodeIdxB) : n.m_flValueB;
        v = floatMath(n.m_operator, a, b); if (n.m_bReturnAbsoluteResult) v = Math.abs(v); if (n.m_bReturnNegatedResult) v = -v; break;
      }
      case 'FloatSwitch': v = this.val(n.m_nSwitchValueNodeIdx) ? this.val(n.m_nTrueValueNodeIdx) : this.val(n.m_nFalseValueNodeIdx); break;
      case 'IDSwitch': v = this.val(n.m_nSwitchValueNodeIdx) ? this.val(n.m_nTrueValueNodeIdx) : this.val(n.m_nFalseValueNodeIdx); break;
      case 'GraphEventCondition': v = n.m_conditions.some(c => this._events.has(c.m_eventID)); break;
      case 'IDEventCondition': {
        // "Is the named clip-event window active right now?" - tested against
        // the SOURCE STATE's currently-playing clip and its CNmIDEvent track
        // (clip-events.json). This is the gate of the hold-to-inspect loop:
        // while inspect_extra_info matches, the graph jumps back to the LOOP
        // section every time the OUTRO window opens. A node with no source
        // state (m_nSourceStateNodeIdx = -1, the entry-override variants)
        // keeps the old always-false answer - no behaviour change there.
        const src = n.m_nSourceStateNodeIdx;
        v = src >= 0 ? this.stateEventActive(src, n.m_eventIDs) : false;
        break;
      }
      case 'StateCompletedCondition': {
        const s = this.st.get(n.m_nSourceStateNodeIdx);         // source STATE node's child clip finished?
        v = s ? !!s.completed : false; break;
      }
      case 'CurrentSyncEventID': v = ''; break;                 // sync tracks: later
      default: v = 0;
    }
    this._valCache.set(idx, v);
    return v;
  }

  // ── pose nodes ─────────────────────────────────────────────────────────────
  // Evaluate node `idx` into `out` (a Pose), advancing its time by dt if active.
  evalPose(idx, dt, out) {
    if (idx < 0) return out;
    const n = this.byIdx.get(idx), s = this.st.get(idx);
    s.active = true;
    const entering = !s.wasActive;
    switch (cls(n)) {
      case 'Scale':                                            // pass child pose through
        return this.evalPose(n.m_nChildNodeIdx, dt, out);
      case 'State':
        return this.evalPose(n.m_nChildNodeIdx, dt, out);
      case 'Clip': {
        if (entering) {
          s.time = 0; s.completed = false;
          // A transition that carried a targetSyncID starts the target's clip
          // at that section instead of 0 - the hold-inspect ping-pong re-enters
          // its twin state AT the loop point, not at the intro. The pending
          // seek is consumed by the first clip that enters (the selector only
          // ever evaluates the one it picked).
          if (this._seekSync) {
            const clip0 = this.clipFor(n.m_nDataSlotIdx);
            const ev = clip0?.events?.find(e => e.sync === this._seekSync || e.id === this._seekSync);
            if (ev) s.time = ev.t;
            this._seekSync = null;
          }
        }
        const clip = this.clipFor(n.m_nDataSlotIdx);
        const dur = clip ? clip.duration : 0;
        s.time += dt * (n.m_flSpeedMultiplier || 1);
        if (n.m_bAllowLooping && dur > 0) s.time %= dur;
        else if (s.time >= dur) { s.time = dur; s.completed = true; }
        if (clip) clip.sample(s.time, out);
        return out;
      }
      case 'AnimationPose': {
        const clip = this.clipFor(n.m_nDataSlotIdx);
        let t = n.m_nPoseTimeValueNodeIdx >= 0 ? +this.val(n.m_nPoseTimeValueNodeIdx) : n.m_flUserSpecifiedTime;
        if (clip) clip.sample(clampToClip(t, clip, n.m_bUseFramesAsInput), out);
        return out;
      }
      case 'Blend1D': return this.evalBlend1D(n, dt, out, entering);
      case 'LayerBlend': return this.evalLayerBlend(n, dt, out);
      case 'Selector': case 'ClipSelector': {
        const pick = n.m_conditionNodeIndices.findIndex(c => !!this.val(c));
        const opt = n.m_optionNodeIndices[pick >= 0 ? pick : n.m_optionNodeIndices.length - 1];
        return this.evalPose(opt, dt, out);
      }
      // A variation picker. ParameterizedSelector is the one a KNIFE's three
      // LIGHT attacks are built from - each has two authored swings, where the
      // three HEAVY attacks have one clip each and are a bare Clip node. With
      // this case missing the light states fell through to the empty pose, so
      // every knife's left click set the graph attacking and then drew the bind
      // pose for the whole swing: LMB dead, RMB fine. It was never in the node
      // inventory because that was taken off the AK graph, which has no knife.
      case 'ParameterizedSelector': case 'ParameterizedClipSelector': {
        // The engine picks ONCE, in the node's Initialize, so latch it on entry:
        // a parameter that moves mid-swing must not swap the clip halfway.
        if (entering || s.pick == null) s.pick = this.pickOption(n);
        return this.evalPose(n.m_optionNodeIndices[s.pick], dt, out);
      }
      case 'StateMachine': return this.evalStateMachine(n, dt, out, entering);
      case 'ReferencedGraph': {
        const sub = this.subGraphFor(n.m_nReferencedGraphIdx);
        if (sub) { if (entering) sub.reset(); syncParams(this, sub); return copyPose(out, sub.update(dt)); }
        return n.m_nFallbackNodeIdx >= 0 ? this.evalPose(n.m_nFallbackNodeIdx, dt, out) : out;
      }
      default: return out;   // unimplemented pose node -> empty (bind) pose
    }
  }

  evalBlend1D(n, dt, out, entering) {
    const param = +this.val(n.m_nInputParameterValueNodeIdx);
    const ranges = n.m_parameterization.m_blendRanges;
    let range = ranges[0];
    for (const r of ranges) { if (param >= r.m_parameterValueRange.m_flMin && param <= r.m_parameterValueRange.m_flMax) { range = r; break; } }
    const lo = range.m_parameterValueRange.m_flMin, hi = range.m_parameterValueRange.m_flMax;
    const w = hi > lo ? THREE.MathUtils.clamp((param - lo) / (hi - lo), 0, 1) : 0;
    const a = this.poolPose(), b = this.poolPose();
    this.evalPose(n.m_sourceNodeIndices[range.m_nInputIdx0], dt, a);
    this.evalPose(n.m_sourceNodeIndices[range.m_nInputIdx1], dt, b);
    blendPose(out, a, b, w);
    this._pool.push(a, b);
    return out;
  }

  evalLayerBlend(n, dt, out) {
    this.evalPose(n.m_nBaseNodeIdx, dt, out);                  // base pose
    for (const layer of n.m_layerDefinition) {
      const w = layer.m_nWeightValueNodeIdx >= 0 ? THREE.MathUtils.clamp(+this.val(layer.m_nWeightValueNodeIdx), 0, 1) : 1;
      const lp = this.poolPose();
      this.evalPose(layer.m_nInputNodeIdx, dt, lp);            // always eval (keep state/timers)
      if (w > 0.0001 && lp.bones.size) {
        // A layer with a bone-mask node blends only the bones its mask lists
        // (the dualies' Elite_Right layer drives the right arm, the R8's
        // cylinder layer one weapon bone). The mask node is pure data - an ID
        // resolved against the skeleton's mask table.
        const maskNode = layer.m_nBoneMaskValueNodeIdx >= 0 ? this.byIdx.get(layer.m_nBoneMaskValueNodeIdx) : null;
        const mask = maskNode?.m_boneMaskID ? this.boneMasks?.[maskNode.m_boneMaskID] : null;
        // Additive layers (shoot recoil) compose a DELTA onto the base; Overlay
        // layers replace the bones they drive. Off-states produce an empty pose,
        // so an inactive layer is a no-op.
        if (layer.m_blendMode === 'Additive') additiveInto(out, lp, w, this.refPose, mask);
        else for (const [name, p] of lp.bones) {
          const bw = mask ? w * (mask[name] || 0) : w;
          if (bw <= 0.0001) continue;
          const o = out.get(name);
          o.pos.lerp(p.pos, bw); o.quat.slerp(p.quat, bw); o.scale.lerp(p.scale, bw);
        }
      }
      this._pool.push(lp);
    }
    return out;
  }

  // Hierarchical state machine. The gate for most transitions is a graph EVENT
  // raised by the active state (e.g. idle raises WPN_STATE_IDLE via its
  // m_executeEvents; deploy raises WPN_ACTION_COMPLETE near the clip end via a
  // timed event). So we must evaluate the active state FIRST (raising its
  // events) and only THEN test transitions — the conditions read those events.
  evalStateMachine(n, dt, out, entering = false) {
    const s = this.st.get(n.m_nNodeIdx);
    const states = n.m_stateDefinitions;
    if (typeof s.smState !== 'number') s.smState = n.m_nDefaultStateIndex || 0;
    // Entry-state overrides (Esoterica semantics): when the machine ACTIVATES,
    // the first state whose entry condition holds becomes the initial state;
    // otherwise the default. Entry conditions are NOT transition gates.
    if (entering) {
      s.trans = null;
      let init = n.m_nDefaultStateIndex || 0;
      for (let i = 0; i < states.length; i++) {
        const ec = states[i].m_nEntryConditionNodeIdx;
        if (ec >= 0 && this.val(ec)) { init = i; break; }
      }
      s.smState = init;
    }

    if (s.trans) {                                            // mid-transition (no "fully-in" events)
      s.trans.t += dt;
      const w = s.trans.dur > 0 ? Math.min(s.trans.t / s.trans.dur, 1) : 1;
      const a = this.poolPose(), b = this.poolPose();
      this.evalState(states[s.trans.from], dt, a, false);
      this.evalState(states[s.trans.to], dt, b, false);
      blendPose(out, a, b, w);
      this._pool.push(a, b);
      if (w >= 1) { s.smState = s.trans.to; s.trans = null; }
      // A transition can be INTERRUPTED. While blending A->B, a transition out of
      // B may already be valid again, and the engine does not make you sit
      // through the rest of the fade to take it.
      //
      // Returning early here regardless is what tore a held stab apart. The
      // authored hand-off from attack to idle is 0.2s (12 frames), and a knife's
      // heavy refire is 1.0s against a ~0.92s clip - so the next stab always
      // arrived INSIDE that fade. The twin flip-flop restarted the attack clip on
      // the spot, but the root machine went on blending that same state OUT for
      // another seven frames, so the new swing was dragged back toward idle as it
      // began: one frame of lurch, then a torn pose with the knife separated from
      // the hand, and only then the real stab. Measured on a bayonet at 60fps -
      // the hand jumped 0.21 units at the restart and was back at its idle
      // position four frames later.
      //
      // Cut the fade short and let the next update take the new transition. One
      // frame, not seven, and only when something is actually waiting.
      else if (states[s.trans.to].m_transitionDefinitions.some(
                 tr => this.val(tr.m_nConditionNodeIdx))) {
        s.smState = s.trans.to;
        s.trans = null;
      }
      return out;
    }

    // ONE transition per machine per update, and an instant one still ENTERS
    // its target inside this update rather than costing a frame.
    //
    // Both halves matter. Costing a frame per hop made an attack begin as
    // snap / dead frame / snap. But taking more than one hop is worse: the
    // shoot machine is a twin flip-flop gated on action_reset, and that
    // parameter is true for the whole update, so re-testing the new state's
    // transitions immediately flipped it straight back, and again, restarting
    // the clip up to four times in a single frame. That is what threw the
    // knife around the screen on a retrigger. The engine enters the target and
    // stops; the target's own transitions get looked at next update.
    const active = states[s.smState];
    this.evalState(active, dt, out, true);                    // settled -> raise its events
    for (const tr of active.m_transitionDefinitions) {
      if (!this.val(tr.m_nConditionNodeIdx)) continue;        // condition is the ONLY gate
      const tn = this.byIdx.get(tr.m_nTransitionNodeIdx);
      const dur = tn ? (tn.m_flDuration || 0) : 0;
      // A sync-ID transition seeds the target's clip time at the named
      // section (see the Clip node's entering path). Resolved NOW - the ID
      // node is part of this graph - and held until a clip consumes it.
      if (tn && tn.m_targetSyncIDNodeIdx >= 0) {
        const id = this.val(tn.m_targetSyncIDNodeIdx);
        if (id) this._seekSync = id;
      }
      if (dur > 0) { s.trans = { from: s.smState, to: tr.m_nTargetStateIdx, t: 0, dur }; break; }
      s.smState = tr.m_nTargetStateIdx;
      this.evalState(states[s.smState], dt, out, true);       // instant: the target draws THIS frame
      break;
    }
    return out;
  }

  // Is one of `ids` an ACTIVE clip-event window on the state's currently
  // playing clip? Walks the state's subtree for the active Clip node - the
  // selectors only ever evaluate the option they picked, so the first active
  // clip found is the one on screen.
  stateEventActive(stateNodeIdx, ids) {
    const found = this.activeClipUnder(stateNodeIdx);
    if (!found || !found.clip.events) return false;
    const t = found.time;
    return found.clip.events.some(e =>
      (ids.includes(e.id) || ids.includes(e.sync)) && t >= e.t && t < e.t + Math.max(e.d, 1e-4));
  }

  activeClipUnder(idx) {
    if (idx == null || idx < 0) return null;
    const n = this.byIdx.get(idx);
    if (!n) return null;
    if (cls(n) === 'Clip') {
      const s = this.st.get(idx);
      if (!s.active && !s.wasActive) return null;
      const clip = this.clipFor(n.m_nDataSlotIdx);
      return clip ? { clip, time: s.time, completed: !!s.completed } : null;
    }
    const kids = [];
    if (n.m_nChildNodeIdx >= 0) kids.push(n.m_nChildNodeIdx);
    if (n.m_nBaseNodeIdx >= 0) kids.push(n.m_nBaseNodeIdx);
    if (n.m_optionNodeIndices) kids.push(...n.m_optionNodeIndices);
    if (n.m_sourceNodeIndices) kids.push(...n.m_sourceNodeIndices);
    if (n.m_stateDefinitions) kids.push(...n.m_stateDefinitions.map(sd => sd.m_nStateNodeIdx));
    for (const k of kids) {
      const r = this.activeClipUnder(k);
      if (r) return r;
    }
    return null;
  }

  evalState(stateDef, dt, out, settled) {
    const stNode = this.byIdx.get(stateDef.m_nStateNodeIdx);
    this.evalPose(stateDef.m_nStateNodeIdx, dt, out);         // State -> child pose
    const stState = this.st.get(stateDef.m_nStateNodeIdx);
    // The state's timed events are measured against the clip that is actually
    // PLAYING under it, which is rarely the state's direct child. Of the four
    // states that raise a timed event in a knife graph, three (both attack
    // twins and deploy) hold a nested state machine; in a gun graph four of six
    // are a machine or a selector. Reading only a direct Clip child therefore
    // meant WPN_ACTION_COMPLETE never fired for an attack or a deploy on ANY
    // weapon, and the controller had nothing to end the action with but its own
    // duration backstop - which cut a 1.13s knife swing off at 0.35s. Resolving
    // the clip through the subtree is what restores the authored hand-off: the
    // event fires with 0.2s left, and the attack->idle transition is 0.2s long,
    // so the cross-fade rides the tail of the swing instead of truncating it.
    const playing = this.activeClipUnder(stNode.m_nChildNodeIdx);
    if (playing) stState.completed = playing.completed;
    if (settled) {
      for (const e of stNode.m_executeEvents) this._events.add(e);
      if (playing) {
        const clip = playing.clip;
        const remaining = clip.duration - playing.time, elapsed = playing.time;
        for (const te of stNode.m_timedRemainingEvents) if (cmpTimed(te.m_comparisionOperator, remaining, te.m_flTimeValueSeconds)) this._events.add(te.m_ID);
        for (const te of stNode.m_timedElapsedEvents) if (cmpTimed(te.m_comparisionOperator, elapsed, te.m_flTimeValueSeconds)) this._events.add(te.m_ID);
      }
    }
    return out;
  }

  // Which option a parameterized selector plays, by the engine's own rule
  // (Esoterica ParameterizedSelectorNode::SelectOption -> PickOption): build a
  // VIRTUAL option list in which option i appears `weight[i]` times - 1 each
  // when the graph set no weights - then index it with the parameter's integer
  // part, modulo the list's length:
  //
  //     seed = floor(abs(parameterValue));   virtual[seed % virtual.length]
  //
  // Not a rounded index into the options. The gun graphs weight their deploy
  // variations [1, 8, 1], which is a virtual list of TEN: rounding would pick
  // option 0 where the engine picks option 1 nine times out of ten.
  pickOption(n) {
    const opts = n.m_optionNodeIndices || [];
    if (!opts.length) return 0;
    const weights = n.m_bHasWeightsSet ? n.m_optionWeights : null;
    const virt = [];
    for (let i = 0; i < opts.length; i++) {
      // The graph asks for this filter itself, and honouring it means a
      // variation whose clip never baked costs us the OTHER variation rather
      // than a frozen weapon.
      if (n.m_bIgnoreInvalidOptions && !this.optionHasAnimation(opts[i])) continue;
      const w = weights ? (weights[i] | 0) : 1;
      for (let j = 0; j < w; j++) virt.push(i);
    }
    if (!virt.length) return 0;
    const seed = Math.floor(Math.abs(+this.val(n.m_parameterNodeIdx) || 0));
    return virt[seed % virt.length];
  }

  // The engine's IsValid()/HasAnimation() gate, as far as it reaches here: an
  // option that IS a clip needs that clip to have been baked.
  optionHasAnimation(idx) {
    const n = this.byIdx.get(idx);
    if (!n) return false;
    return cls(n) === 'Clip' ? !!this.clipFor(n.m_nDataSlotIdx) : true;
  }

  clipOfNode(idx) {                                           // ClipSource if node is a Clip, else null
    const n = this.byIdx.get(idx);
    return n && cls(n) === 'Clip' ? this.clipFor(n.m_nDataSlotIdx) : null;
  }

  clipFor(dataSlotIdx) {
    const path = this.resources[dataSlotIdx];
    return path ? this.clips.get(path) : null;
  }
  subGraphFor(refIdx) {
    const slot = this.json.m_referencedGraphSlots?.[refIdx];
    const dataSlot = slot ? slot.m_dataSlotIdx : undefined;
    const path = dataSlot != null ? this.resources[dataSlot] : this.resources.find(r => r.endsWith('.vnmgraph'));
    return path ? this.subGraphs.get(path) : null;
  }

  reset() {
    this._seekSync = null;
    for (const s of this.st.values()) { s.time = 0; s.wasActive = false; s.active = false; s.trans = null; s.completed = false; s.pick = null; }
    for (const n of this.nodes) { const s = this.st.get(n.m_nNodeIdx); s.smState = n.m_nDefaultStateIndex ?? 0; }
  }
}

function syncParams(parent, sub) {
  for (const id of sub.controlIds) if (parent.params.has(id)) sub.params.set(id, parent.params.get(id));
}

function defaultFor(id) {
  if (id === 'action') return 'action_idle';
  if (id === 'weapon_type') return 'WEAPONTYPE_RIFLE';
  if (id === 'weapon_category') return 'weapon_category_rifle';
  if (id.endsWith('_variation')) return 0;
  if (id === 'weapon_ammo' || id === 'weapon_ammo_max' || id === 'weapon_ammo_reserve') return 30;
  if (id === 'weapon_is_gun') return true;
  if (id === 'weapon_is_silenced') return false;
  return 0;
}
function compareFloat(op, a, b, e) {
  switch (op) {
    case 'GreaterThan': return a > b; case 'GreaterThanEqual': return a >= b - e;
    case 'LessThan': return a < b; case 'LessThanEqual': return a <= b + e;
    case 'Equal': case 'NearEqual': return Math.abs(a - b) <= (e || 1e-4);
    case 'NotEqual': return Math.abs(a - b) > (e || 1e-4);
    default: return false;
  }
}
function cmpTimed(op, value, threshold) {   // timed graph events (remaining/elapsed vs threshold)
  switch (op) {
    case 'LessThanEqual': return value <= threshold; case 'LessThan': return value < threshold;
    case 'GreaterThanEqual': return value >= threshold; case 'GreaterThan': return value > threshold;
    default: return value <= threshold;
  }
}
function floatMath(op, a, b) {
  switch (op) { case 'Add': return a + b; case 'Sub': return a - b; case 'Mul': return a * b; case 'Div': return b !== 0 ? a / b : 0; default: return a; }
}
function clampToClip(t, clip, useFrames) {
  if (useFrames) return t;   // frames-as-input: caller supplies frame; approx as seconds for now
  return THREE.MathUtils.clamp(t, 0, clip.duration || 0);
}
