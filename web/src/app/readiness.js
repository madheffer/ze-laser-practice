// A stage starts only when it is loaded and drawn: the world around you (world/stream.js), every entity model and
// particle effect the map shows from the start (world/render.js track), their textures, the shaders compiled, and
// two frames on screen. Solo: the stage's clock waits for it (app/loop.js, run.ready). A co-op / versus round: the
// client says 'ready' and the server starts everyone's clock together once all are (server/coop-round.js), so a
// slow device never meets the lasers on a black screen.
import { G, S } from './state.js';

const FRAME_TIMEOUT_MS = 500; // a hidden tab gets no animation frames: don't wait for one forever
const LIMIT_MS = 120_000; // something that never settles must not hold a solo stage for ever (a round has its own)

const nextFrame = () => new Promise((resolve) => {
  const t = setTimeout(resolve, FRAME_TIMEOUT_MS);
  requestAnimationFrame(() => { clearTimeout(t); resolve(); });
});

// Wait until everything in render.loading has settled, including loads started while waiting (a model's own
// children, effects that spawn on the first ticks).
async function drain(set) {
  for (let i = 0; i < 20 && set.size; i++) await Promise.allSettled([...set]);
}

// a step that never settles (a request that hangs) gives up at the run's limit instead of holding it for ever
const within = (p, until) => new Promise((resolve) => {
  const t = setTimeout(resolve, Math.max(0, until - Date.now()));
  const done = () => { clearTimeout(t); resolve(); };
  Promise.resolve(p).then(done, done);
});

// Resolves when the run's stage is ready to play. onStep(text) reports what it is waiting for (HUD).
export async function prepareStage(run, onStep = () => {}) {
  const until = Date.now() + LIMIT_MS;
  const stillRun = () => S.run === run && Date.now() < until;
  try {
    const r = G.renderer;
    // one frame at the spawn first: the camera, the fog and so the view distance the stream gates on are the stage's
    await nextFrame();
    if (G.stream && stillRun()) {
      onStep('loading the area');
      await within(G.stream.whenReady(S.player.origin), until);
    }
    // the entities' visuals are created by the frame loop (render.updateEntities): let it run, then wait for them
    await nextFrame();
    if (stillRun() && r.loading?.size) { onStep('loading models and effects'); await within(drain(r.loading), until); }
    if (stillRun() && S.map?.effects) { onStep('loading effect textures'); await within(S.map.effects.texturesLoaded(), until); }
    // the map's sound table (audio.js): no sound of the stage is asked for before it is in
    if (stillRun() && G.audio?.ready) { onStep('loading sounds'); await within(G.audio.ready(), until); }
    // build every shader the scene needs now, not on the first frame that meets a laser
    if (stillRun() && r.renderer.compileAsync) { onStep('preparing shaders'); await within(r.renderer.compileAsync(r.scene, r.camera), until); }
    await nextFrame();
    await nextFrame();
  } catch (e) {
    console.warn('stage preparation:', e);
  }
}

// ---- how far along it is, for the loading screen (ui/loading.js): main.js loadStage's steps (the map's files,
// world/assets.js loadMap onProgress), then prepareStage's. [step, where the bar starts, where it ends, label]
const STEPS = [
  ['starting', 0, 0.02, 'Starting'],
  ['manifest', 0.02, 0.04, 'Reading the map'],
  ['entities', 0.04, 0.3, 'Loading the map'],
  ['world', 0.3, 0.36, 'Loading the world'],
  ['lighting', 0.3, 0.38, 'Loading the lighting'],
  ['loading', 0.38, 0.38, 'Loading the stage'],
  ['loading the area', 0.38, 0.7, 'Loading the area'],
  ['loading models and effects', 0.7, 0.8, 'Loading models and effects'],
  ['loading effect textures', 0.8, 0.85, 'Loading effect textures'],
  ['loading sounds', 0.85, 0.9, 'Loading sounds'],
  ['preparing shaders', 0.9, 0.96, 'Preparing shaders'],
];

// step: a loadMap / prepareStage step ('world 45%', 'entities 30%' carry their own share); part: [have, need]
export function stepProgress(step, part = null) {
  const s = String(step || 'starting');
  const pct = /^(world|entities) (\d{1,3})%$/.exec(s);
  const row = STEPS.find(([k]) => k === (pct ? pct[1] : s)) || STEPS[0];
  const [, a, b, label] = row;
  const f = pct ? Math.min(1, Number(pct[2]) / 100) : part && part[1] > 0 ? part[0] / part[1] : 0;
  const text = part && part[1] > 0 && part[0] < part[1] ? `${label} ${part[0]}/${part[1]}` : label;
  return { text, frac: a + (b - a) * f };
}

// a run's loading state: null once it isn't the current run, done when its clock starts (solo: run.ready, a round:
// the server's go), else the step and the bar
export function stageStatus(run) {
  if (!run || S.run !== run) return null;
  // the run is over before its clock started (a round that ended while we loaded: everyone left out, the owner gave
  // up): its end card shows, not a loading screen that never finishes
  if (run.done) return { done: true };
  // a round: the go and our own stage drawn (a player the round started without finishes loading, then watches)
  if (run.ready && (!S.mp || run.go)) return { done: true };
  if (run.ready) {
    const line = S.mp?.waitLine?.() || 'waiting for players';
    return { text: line[0].toUpperCase() + line.slice(1), frac: 0.98 };
  }
  const area = G.stream && run.loading === 'loading the area' && S.player ? G.stream.progress(S.player.origin) : null;
  const s = stepProgress(run.loading || 'loading', area);
  if (S.mp && run.go) s.text = `Started without you (you will watch): ${s.text}`;
  return s;
}
