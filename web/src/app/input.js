// Keyboard, mouse, touch, pointer lock, fullscreen. CS2 bindings: WASD, Space / wheel down jump, Ctrl crouch,
// Shift walk, Mouse 1/2 attack, 1 / 3 / Q weapons, R reload, F inspect, Esc menu (a tap, like CS2 and cybo's site).
//
// "In game" = S.locked: player input is live. On desktop that is the pointer lock; on touch (ui/touch.js) there is
// no lock, so it is "a stage is running and not paused". loop.js reads input only while S.locked.
import { S, G } from './state.js';
import { settings, setToggle, M_YAW } from './settings.js';
import { clamp } from '../lib/math.js';
import { useItems } from './items.js';
import { TouchControls, touchQuery } from '../ui/touch.js';
import { freeLook } from './replay-view.js';
import { chatKey, chatOpen } from './chat.js';

const keys = new Set();
let wheelJump = 0;
let yawDelta = 0, pitchDelta = 0;
let act = null; // the actions installInput was given
let touch = null; // TouchControls, built on the first sign of a touch device
let touchMode = false;

const TOUCH_DEG_PER_PX = 0.25; // look speed at "Touch look speed" 1x (half a phone's width ~ 100 degrees)
const touchSens = () => settings.touchSens; // sanitised and range-clamped by settings.js

export function takeLookDelta() {
  const d = { yawDelta, pitchDelta };
  yawDelta = pitchDelta = 0;
  return d;
}
export function clearKeys() { keys.clear(); }
export const keyHeld = (code) => keys.has(code); // app/replay-view.js's free camera

export function readInput() {
  const k = (c) => keys.has(c);
  const t = touch?.input();
  const inp = {
    forward: clamp((k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0) + (t?.forward || 0), -1, 1),
    side: clamp((k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0) + (t?.side || 0), -1, 1),
    jump: k('Space') || wheelJump > 0 || !!t?.jump,
    duck: k('ControlLeft') || k('ControlRight') || k('KeyC') || !!t?.duck,
    walk: k('ShiftLeft') || k('ShiftRight'),
  };
  if (wheelJump > 0) wheelJump--;
  return inp;
}

// Turn the view by yaw / pitch degrees (mouse and touch both come through here).
function look(dy, dp) {
  if (S.replay) { if (S.replay.cam === 'free' && S.locked) freeLook(dy, dp); return; } // the recorded view is the replay's
  const p = S.player;
  if (!S.locked || !p || S.paused) return;
  p.yaw -= dy;
  p.pitch = clamp(p.pitch + dp, -89, 89);
  yawDelta += dy; pitchDelta += dp;
}

// Raw pointer lock: unadjustedMovement = mouse counts without OS pointer speed/acceleration, so CS2's
// sensitivity x m_yaw maps 1:1. Falls back to a plain lock where raw input isn't supported.
function lockPointer(canvas) {
  const p = canvas.requestPointerLock?.({ unadjustedMovement: true });
  if (p?.catch) p.catch(() => canvas.requestPointerLock?.()?.catch?.(() => {}));
}

// Fullscreen if the setting wants it. Resolves true once fullscreen is in (iPhones have no element fullscreen).
function goFullscreen() {
  if (document.fullscreenElement) return Promise.resolve(true);
  if (!settings.fullscreen || !document.documentElement.requestFullscreen) return Promise.resolve(false);
  return document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => true, () => false);
}

// Enter the game. Pointer lock and fullscreen both need the click's user activation, so both are requested
// SYNCHRONOUSLY here, before any await or heavy work (awaiting fullscreen first used up the activation and the
// lock was refused, leaving you on the Resume screen). The keyboard lock (so Ctrl+W can't close the tab and
// Esc arrives as a tap) follows once fullscreen is in.
// On touch there is no lock to wait for: fullscreen + landscape are asked for, and the game unpauses as soon as
// the caller has (re)built the run (G.play calls this, then startScenario, in the same click).
export function enterGame(canvas) {
  if (touchMode) {
    goFullscreen().then((fs) => { if (fs) screen.orientation?.lock?.('landscape')?.catch?.(() => {}); });
    queueMicrotask(() => {
      // a picked stage still loading (ui/loading.js) counts: its screen shows, not the menu
      if (((!S.run || S.run.done) && !G.loading?.isOpen) || G.overlay?.open) return;
      S.locked = true;
      act.unpause();
    });
    return;
  }
  lockPointer(canvas);
  goFullscreen().then((fs) => { if (fs) navigator.keyboard?.lock?.().catch(() => {}); });
}

// Called on every pause / unpause (Menu.update): on touch, input is live exactly while a run plays, and the
// controls show only then.
export function syncPlayState() {
  if (!touchMode) return;
  const playing = S.locked && !S.paused && !!S.run && !S.run.done && !G.overlay?.open;
  if (!playing) S.locked = false;
  if (touch) touch.crouchToggle = !!settings.touchCrouch;
  touch?.show(playing);
}

// Touch mode: a coarse primary pointer, the first touch anywhere, or ?touch=1 (?touch=0 keeps it off).
function setTouchMode(on) {
  if (on === touchMode) return;
  touchMode = on;
  document.body.classList.toggle('touch', on);
  if (on && !touch) {
    touch = new TouchControls({
      onLook: (dx, dy) => { const k = TOUCH_DEG_PER_PX * touchSens(); look(dx * k, dy * k); },
      onButton: touchButton,
    });
  }
  syncPlayState();
}

function touchButton(name, down) {
  if (!S.locked) return;
  switch (name) {
    case 'fire': G.vm.trigger(down); break;
    case 'swap': act.lastWeapon(); break;
    case 'reload': act.reload(); break;
    case 'pause': act.pause(); break;
  }
}

// Ctrl+W outside fullscreen can't be blocked; at least ask before the tab goes. The listener is there only while a run
// is live (the frame loop calls this): with a beforeunload listener Chrome can't close the tab at once, it waits for this
// page's main thread to run it, and that is a long wait behind a map load on a slow PC or a phone.
let leaveGuarded = false;
const runLive = () => !!(S.run && !S.run.done && !S.replay);
// checked again here: a hidden tab gets no frames, so the run may have ended since the last sync
const askBeforeLeaving = (ev) => { if (runLive()) { ev.preventDefault(); ev.returnValue = ''; } };
export function syncLeaveGuard() {
  const want = runLive();
  if (want === leaveGuarded) return;
  leaveGuarded = want;
  if (want) window.addEventListener('beforeunload', askBeforeLeaving);
  else window.removeEventListener('beforeunload', askBeforeLeaving);
}

export function installInput(canvas, actions) {
  act = actions;
  const force = new URLSearchParams(location.search).get('touch');
  if (force === '1' || (force !== '0' && touchQuery.matches)) setTouchMode(true);
  if (force !== '0') window.addEventListener('touchstart', () => setTouchMode(true), { capture: true, passive: true });

  document.addEventListener('pointerlockchange', () => {
    S.locked = document.pointerLockElement === canvas;
    if (S.replay) return; // a replay plays on with or without the mouse (it only steers the free camera)
    // a picked stage still loading (ui/loading.js) has no run yet: the menu stays away until you press Esc
    if (S.locked && ((S.run && !S.run.done) || G.loading?.isOpen)) actions.unpause();
    else actions.pause();
  });
  // leaving fullscreen any other way (F11, the browser's own Esc, Android's back gesture) also pauses
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) return;
    navigator.keyboard?.unlock?.();
    if (document.pointerLockElement) document.exitPointerLock?.();
    actions.pause();
  });
  canvas.addEventListener('click', () => {
    if (S.replay) { if (S.replay.cam === 'free' && !S.locked) lockPointer(canvas); return; } // mouse look for the free camera
    if (!S.locked && S.run && !S.run.done && !G.overlay.open) actions.resume();
  });

  document.addEventListener('mousedown', (ev) => {
    if (!S.locked || S.replay || chatOpen() || ev.sourceCapabilities?.firesTouchEvents) return; // a tap's emulated mouse is not Mouse 1
    if (ev.button === 0) G.vm.trigger(true);
    if (ev.button === 2) G.vm.trigger2(true);
  });
  document.addEventListener('mouseup', (ev) => {
    if (ev.button === 0) G.vm.trigger(false);
    if (ev.button === 2) G.vm.trigger2(false);
  });
  document.addEventListener('contextmenu', (ev) => { if (S.locked) ev.preventDefault(); });
  document.addEventListener('mousemove', (ev) => {
    if (!document.pointerLockElement || chatOpen()) return; // typing in the chat: no mouse look
    const k = settings.sens * M_YAW; // CS2: degrees per count = sensitivity * m_yaw (m_pitch = m_yaw)
    look(ev.movementX * k, ev.movementY * k);
  });
  // Wheel down jumps. Not passive, so it can cancel the browser's default: Ctrl + wheel (crouch + jump spam, and a
  // trackpad pinch) would zoom the page, anywhere on it, menus included; in a run the wheel never scrolls either.
  // Keyboard zoom (Ctrl +/-) is left alone for anyone who needs it.
  window.addEventListener('wheel', (ev) => {
    if (S.locked && ev.deltaY > 0) wheelJump = 2;
    if (ev.ctrlKey || S.locked) ev.preventDefault();
  }, { passive: false, capture: true });

  document.addEventListener('keydown', (ev) => {
    if (G.overlay.open) return; // the end card has its own keys
    // a replay has its own keys (app/replay.js); Esc gives the mouse back first. Held keys fly the free camera.
    if (S.replay) {
      if (ev.code === 'Escape' && document.pointerLockElement) { document.exitPointerLock?.(); return; }
      if (ev.target instanceof HTMLInputElement) return; // the replay bar's scrubber has its own arrow keys
      if (ev.code === 'Space' || ev.code === 'Tab' || ev.code.startsWith('Arrow')) ev.preventDefault();
      if (!ev.repeat) { keys.add(ev.code); act.replayKey?.(ev.code); }
      return;
    }
    // the chat (app/chat.js): Y / U open it while playing; open, it has the keyboard and Esc only closes it
    if (chatOpen()) { chatKey(ev); return; }
    if (S.locked && !S.paused && S.run && !S.run.done && chatKey(ev)) return;
    // Esc is a tap: in fullscreen the keyboard lock delivers it to us, so we release the mouse ourselves;
    // in the menu, a tap resumes.
    // One tap leaves the game completely: mouse released AND fullscreen exited, menu up (Resume goes back in).
    if (ev.code === 'Escape') {
      ev.preventDefault();
      if (S.locked || document.fullscreenElement) {
        navigator.keyboard?.unlock?.();
        if (document.pointerLockElement) document.exitPointerLock?.();
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
        actions.pause();
      } else if (S.run && !S.run.done && !ev.repeat) actions.resume();
      return;
    }
    if (!S.locked) return;
    // everything the game binds is ours while playing (Ctrl, Tab, Space, Ctrl+W/S/D... in fullscreen)
    if (ev.ctrlKey || ev.code === 'Space' || ev.code === 'Tab' || ev.code.startsWith('Control') || ev.code === 'F1') ev.preventDefault();
    if (ev.repeat) return;
    keys.add(ev.code);
    switch (ev.code) {
      case 'Digit1': actions.weapon('gun'); break;
      case 'Digit3': actions.weapon('knife'); break;
      case 'KeyQ': actions.lastWeapon(); break;
      case 'KeyR': actions.reload(); break;
      case 'KeyF': G.vm.inspect(); break;
      case 'KeyE': useItems(); break; // CS2 +use: the held map item's button (app/items.js)
      case 'Backspace': actions.restart(); break;
      // a co-op / versus round plays by the room's rules (app/rules.js): these are solo-only
      case 'KeyH': if (!S.mp) { setToggle('hitboxes', '#hitboxes', !settings.hitboxes); actions.applySettings(); } break;
      case 'KeyG': if (!S.mp) setToggle('god', '#god', !settings.god); break;
      case 'KeyT': if (!S.mp) settings.timescale = settings.timescale === 1 ? 0.25 : 1; break;
    }
  });
  document.addEventListener('keyup', (ev) => keys.delete(ev.code));
  window.addEventListener('blur', () => keys.clear());
}
