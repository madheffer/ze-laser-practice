// The small round buttons a run row carries (ui/home-feed.js, ui/home-history.js): play its replay, share its link,
// and the views count beside them. Icons are constant SVG; labels go in as text.

const SVG = { // constant SVG, never data
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L6.4 3.1a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>',
  link: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  eye: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
};

function iconButton(cls, icon, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `rbtn ${cls}`;
  b.innerHTML = SVG[icon]; // a constant
  b.setAttribute('aria-label', label);
  b.title = label;
  b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(b); });
  return b;
}

export const playButton = (label, onClick) => iconButton('rbtn-play', 'play', label, onClick);

// share: (button) => Promise<boolean> (made public + link copied); shared: already public
export function shareButton(shared, share) {
  const set = (b, on) => { b.classList.toggle('on', on); const l = on ? 'Copy link' : 'Share: make a link anyone can watch'; b.setAttribute('aria-label', l); b.title = l; };
  const b = iconButton('rbtn-share', 'link', '', async () => {
    if (b.disabled) return;
    b.disabled = true;
    const ok = await share(b);
    b.disabled = false;
    if (!ok) return;
    set(b, true);
    b.innerHTML = SVG.check;
    b.classList.add('done');
    setTimeout(() => { b.innerHTML = SVG.link; b.classList.remove('done'); }, 1400);
  });
  set(b, shared);
  return b;
}

// "12" with an eye, or nothing for none
export function viewsBadge(n) {
  const s = document.createElement('span');
  s.className = 'rviews';
  if (!(n > 0)) { s.hidden = true; return s; }
  s.innerHTML = SVG.eye; // a constant
  s.append(n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  s.title = `${n} view${n === 1 ? '' : 's'}`;
  return s;
}
