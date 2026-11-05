// How fast the game runs here: the frame rate for the FPS / ping meter (ui/perf-meter.js), and the slow-PC check that
// moves a player to the Low preset (app/graphics.js) when frames are slow.
//
//   perfFrame(now, { live, throttled })   every drawn frame (app/loop.js); live: a run is being played (not paused,
//                          not loading, not spectating); throttled: the paused menu's slow redraws (not counted at all)
//   fps()                  frames a second over the last half second (0 before the first)
//   installPerf({ apply, presetChanged })   apply: main.js applySettings; presetChanged: the Video controls + pickers
//
// The check never changes anything mid-run: swapping graphics recompiles shaders and resizes the render target, a
// hitch in the middle of a laser. It only decides during play; the swap waits for a moment nothing is moving for you
// (paused, the run's end card, the menu, a round over) and says so in one line.
import { S } from './state.js';
import { settings } from './settings.js';
import { applyPreset } from './graphics.js';
import { toast } from '../ui/toast.js';

// a frame this long (ms) is a tab switch / a breakpoint / a load, not the game's pace: never counted
const GAP_MS = 250;
// slow: over SAMPLE_MS of live play the median frame is longer than SLOW_MS (below 40 FPS), or more than
// STUTTER_SHARE of frames take over STUTTER_MS (below 20 FPS: hitches a median hides)
const SAMPLE_MS = 8000, SLOW_MS = 25, STUTTER_MS = 50, STUTTER_SHARE = 0.12;
const WARMUP_MS = 3000; // a run's first seconds stream in the world and compile shaders: not counted

let lastAt = 0, rate = 0, windowAt = 0, windowFrames = 0;
let liveSince = 0;
let samples = [];
let sampledMs = 0;
let slowFps = 0; // the average rate when the check found it slow (the toast's number)
let verdict = null; // null | 'slow' (waiting for a safe moment) | 'done' (acted, or nothing to do: checks stop)

export const fps = () => rate;

export function perfFrame(now, { live, throttled }) {
  const dt = lastAt ? now - lastAt : 0;
  lastAt = now;
  // the meter keeps the last real rate behind the pause menu (its redraws there are throttled on purpose)
  if (throttled) { windowAt = 0; windowFrames = 0; liveSince = 0; return; }
  windowFrames++;
  if (!windowAt) { windowAt = now; windowFrames = 0; } else if (now - windowAt >= 500) { rate = Math.round(windowFrames * 1000 / (now - windowAt)); windowAt = now; windowFrames = 0; }
  if (!live || dt <= 0 || dt > GAP_MS || document.hidden || !document.hasFocus()) { liveSince = 0; return; }
  if (!liveSince) liveSince = now;
  if (verdict || now - liveSince < WARMUP_MS) return;
  samples.push(dt);
  sampledMs += dt;
  if (sampledMs < SAMPLE_MS) return;
  const sorted = samples.slice().sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const stutter = samples.filter((t) => t > STUTTER_MS).length / samples.length;
  if (median > SLOW_MS || stutter > STUTTER_SHARE) { verdict = 'slow'; slowFps = Math.round(samples.length * 1000 / sampledMs); }
  samples = []; sampledMs = 0;
}

// nothing is moving for you: no run, paused solo, the run's end, a round that's over
const safeMoment = () => !S.run || S.run.done || (S.paused && !S.mp) || !!S.mp?.ended;

export function installPerf({ apply, presetChanged }) {
  setInterval(() => {
    if (verdict !== 'slow' || !safeMoment()) return;
    verdict = 'done';
    const seen = ` (${slowFps} FPS)`;
    // a preset the player picked themselves is theirs: suggest, don't change it
    if (settings.graphics === 'low') toast(`Running slow${seen}. Close other games or lower Render resolution in Settings › Video.`, { ms: 7000, tone: 'warn' });
    else if (settings.graphicsChosen) toast(`Running slow${seen}. Graphics: Low would be smoother.`, { ms: 7000, tone: 'warn' });
    else {
      applyPreset('low');
      apply();
      presetChanged();
      toast(`Running slow${seen}: switched to Low graphics. Change it in Settings › Video.`, { ms: 7000, tone: 'warn' });
    }
  }, 500);
}
