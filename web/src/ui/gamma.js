// CS2's r_fullscreen_gamma: "Screen Gamma (only in fullscreen modes)". The render system applies it when it presents a
// frame, as a hardware gamma ramp over the finished image (rendersystemdx11.dll: RenderSystem/UseHardwareGammaRamp),
// default 2.2. Like Source's mat_monitorgamma, a lower value is brighter: each channel goes to
// value ^ (gamma / 2.2), so 2.2 changes nothing and 2.0 lifts the midtones a little.
//
// Here that ramp is an SVG gamma filter (feComponentTransfer, on the sRGB values, as a ramp is) over the game's own
// layers: the 3D view, the HUD, the crosshair and the kill feed. The menu is the site's, so it stays as it is.
export const CS2_DEFAULT_GAMMA = 2.2;
const LAYERS = ['#view', '#hud', '#crosshair', '#hitmarker', '#killfeed', '#nametags', '#flash'];
const SVG_NS = 'http://www.w3.org/2000/svg';

let funcs = null;

function install() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'gamma-defs');
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.setAttribute('id', 'cs-gamma');
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const transfer = document.createElementNS(SVG_NS, 'feComponentTransfer');
  funcs = ['feFuncR', 'feFuncG', 'feFuncB'].map((tag) => {
    const f = document.createElementNS(SVG_NS, tag);
    f.setAttribute('type', 'gamma');
    f.setAttribute('amplitude', '1');
    f.setAttribute('offset', '0');
    transfer.append(f);
    return f;
  });
  filter.append(transfer);
  svg.append(filter);
  document.body.append(svg);
}

// gamma: r_fullscreen_gamma (the setting is range-checked in app/settings.js)
export function applyGamma(gamma) {
  if (!funcs) install();
  const exponent = gamma / CS2_DEFAULT_GAMMA;
  for (const f of funcs) f.setAttribute('exponent', exponent.toFixed(4));
  const on = Math.abs(exponent - 1) > 1e-4; // 2.2: the identity, so no filter at all
  for (const sel of LAYERS) document.querySelector(sel)?.classList.toggle('cs-gamma', on);
}
