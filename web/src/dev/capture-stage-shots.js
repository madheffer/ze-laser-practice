// Dev only (never imported by the game, so never in a build): captures each stage's thumbnail for the stage list
// from the stage's own spawn view. Run it in the page on the dev server (BAKING.md "Stage thumbnails"):
//   const cap = await import('/src/dev/capture-stage-shots.js');
//   await cap.captureStages([0, 1, 2]);          // or cap.captureStages() for every top-level stage of the open map
// Each stage: start it, wait for app/readiness.js (run.ready), draw one frame of the world (no HUD, no viewmodel:
// the HUD is HTML and the viewmodel is its own pass), scale it into a 320x180 webp (quality 0.6, a few KB) and POST it
// to the dev server (server/stage-shots-dev.js writes maps/<map>/stages/<id>.webp). Audio stays silent throughout,
// and nothing is written to the saved settings. Then `node tools/index-maps.mjs` lists the new thumbnails.
// A stage whose spawn view says little (the shifting pool's tube before any wall) passes `prepare`: an async (L) => {}
// run after the stage is ready, which may advance the paused simulation to the moment worth showing.
// captureCard(i, opts): the same, as the map picker card's picture (maps/<map>/card.webp, CARD_W x CARD_H).
export const W = 320;
export const H = 180;
export const QUALITY = 0.6;
export const CARD_W = 640;
export const CARD_H = 240;
export const CARD_QUALITY = 0.7;
const READY_MS = 25000;
const DARK = 4; // mean channel value (0-255) under which a frame counts as black

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// one frame of the world, cover-cropped to W x H, as a webp Blob
export function grab(L = window.__lasers, { w = W, h = H, quality = QUALITY } = {}) {
  const W = w, H = h, QUALITY = quality;
  const r = L.renderer;
  r.render(); // right before reading the canvas: the drawing buffer is still intact within this task
  const src = r.renderer.domElement;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const scale = Math.max(W / src.width, H / src.height);
  const sw = W / scale;
  const sh = H / scale;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, W, H);
  // a black frame (the world not drawn yet, or a frame that threw) is no thumbnail: the card keeps its placeholder
  const px = g.getImageData(0, 0, W, H).data;
  let sum = 0;
  for (let k = 0; k < px.length; k += 4) sum += px[k] + px[k + 1] + px[k + 2];
  if (sum / (W * H * 3) < DARK) return Promise.reject(new Error('black frame, not saved'));
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/webp', QUALITY));
}

export async function upload(map, id, blob, kind = 'stage') {
  const res = await fetch(`/__dev/stage-shot?map=${encodeURIComponent(map)}&id=${encodeURIComponent(id)}&kind=${kind}`, {
    method: 'POST', headers: { 'Content-Type': 'image/webp' }, body: blob,
  });
  if (!res.ok) throw new Error(`${id}: ${res.status} ${await res.text()}`);
  return res.json();
}

// Capture one stage (index into __lasers.scenarios()). Returns { id, bytes }.
export async function captureStage(i, { settle = 300, maxPitch = 12, prepare = null, card = false } = {}) {
  const L = window.__lasers;
  const s = L.scenarios()[i];
  if (!s) throw new Error(`no stage ${i}`);
  const audio = L.audio;
  const resume = audio.resume;
  audio.resume = () => {}; // silent: the stage start would fade audio in
  try {
    audio.pause();
    await L.startScenario(i, 'normal');
    const t0 = performance.now();
    while (!L.run?.ready) {
      if (performance.now() - t0 > READY_MS) throw new Error(`${s.id}: not ready after ${READY_MS} ms`);
      await sleep(100);
    }
    // the spawn's facing, its pitch levelled into [-maxPitch, maxPitch]: a stage that starts looking straight up at
    // the sky (mist's throne: -40) still shows where you are
    const p = L.player;
    if (p && Number.isFinite(p.pitch)) p.pitch = Math.max(-maxPitch, Math.min(maxPitch, p.pitch));
    if (prepare) { if (!L.paused) L.pause(); await prepare(L); }
    await sleep(settle); // a couple of frames at the spawn: the camera is the player's view
    const blob = await grab(L, card ? { w: CARD_W, h: CARD_H, quality: CARD_QUALITY } : {});
    const out = await upload(L.map.name, s.id, blob, card ? 'card' : 'stage');
    return { id: s.id, bytes: out.bytes };
  } finally {
    if (L.run) L.run.done = true; // end it: no clock, no prompt on leaving
    audio.resume = resume;
  }
}

// The map picker card's picture, from stage i (posed as captureStage does)
export function captureCard(i, opts = {}) { return captureStage(i, { ...opts, card: true }); }

// Capture several stages (default: every top-level stage of the open map, the cards that show a thumbnail).
export async function captureStages(list) {
  const L = window.__lasers;
  const all = L.scenarios();
  const which = list || all.map((s, i) => (s.parent ? -1 : i)).filter((i) => i >= 0);
  const done = [];
  for (const i of which) {
    try { done.push(await captureStage(i)); } catch (e) { done.push({ id: all[i]?.id, error: String(e.message || e) }); }
  }
  return done;
}
