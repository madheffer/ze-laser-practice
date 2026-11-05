// Text formatting shared by the HUD, the menu and the end cards.

// 12.34 s, or m:ss.ss from a minute up; '-' for no time.
export function formatTime(s) {
  if (!Number.isFinite(s)) return '-';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m ? `${m}:${r.toFixed(2).padStart(5, '0')}` : `${r.toFixed(2)} s`;
}

// "1 hit", "3 hits"
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// 16000 -> "16,000"
export const thousands = (n) => Math.round(n).toLocaleString('en-US');
