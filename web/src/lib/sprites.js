// 2D canvas sprites: load an image, and the two Panorama blends the HUD needs (ui/radar.js).

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image ${src}`));
    img.src = src;
  });
}

// An additive layer as a normal one: alpha = the brightest channel, colour divided by it. Drawn over a dark
// background with source-over that is bg * (1 - a) + colour, i.e. black is see-through and light adds.
export function additive(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const im = ctx.getImageData(0, 0, w, h), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    const r = d[i] * a, g = d[i + 1] * a, b = d[i + 2] * a;
    const m = Math.max(r, g, b);
    if (m <= 0) { d[i + 3] = 0; continue; }
    const s = 255 / m;
    d[i] = r * s; d[i + 1] = g * s; d[i + 2] = b * s; d[i + 3] = m;
  }
  ctx.putImageData(im, 0, 0);
  return cv;
}

// Panorama's wash-color on an icon: multiply by the colour (white takes it, black outlines stay), alpha kept.
// Rasterised square at px x px (SVGs too).
export function tinted(img, color, px) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0, px, px);
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, px, px);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(img, 0, 0, px, px);
  return cv;
}
