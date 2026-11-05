// The boot screen (#boot in index.html, styled by style.css): the page's markup stays hidden under it (html.booting)
// until main.js has built and drawn its first view, then it fades out; a boot that fails says why, with a reload.
const FRAME_TIMEOUT_MS = 300; // a hidden tab gets no animation frames
const FADE_MS = 300;

const frame = () => new Promise((resolve) => {
  const t = setTimeout(resolve, FRAME_TIMEOUT_MS);
  requestAnimationFrame(() => { clearTimeout(t); resolve(); });
});

// the first view is in place: show the page, fade the boot screen away once the view has had a frame to draw
export async function bootDone() {
  const boot = document.getElementById('boot');
  await frame();
  document.documentElement.classList.remove('booting');
  if (!boot) return;
  boot.classList.add('out');
  setTimeout(() => boot.remove(), FADE_MS);
}

export function bootFailed(err) {
  const boot = document.getElementById('boot');
  if (!boot?.isConnected || !document.documentElement.classList.contains('booting')) return false;
  boot.classList.add('failed');
  boot.querySelector('.boot-msg').textContent = `Could not start: ${err?.message || err}`;
  if (!boot.querySelector('.boot-retry')) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'boot-retry'; b.textContent = 'Reload';
    b.addEventListener('click', () => location.reload());
    boot.append(b);
  }
  return true;
}

// an error before init runs (main.js wiring, no WebGL): said on the boot screen too, not a spinner for ever
window.addEventListener('error', (e) => { bootFailed(e.error || e.message); });
