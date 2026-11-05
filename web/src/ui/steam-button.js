// "Sign in through Steam": one button wherever the page offers it (ui/home.js's top bar, ui/home-history.js).
// A link, not a fetch: Steam's own sign-in page, then back to /?signin=ok (server/auth/routes.js). The Steam mark is
// a constant inline SVG (no third-party image: the CSP stays 'self').
import './steam-button.css';
import { SIGN_IN_URL } from '../app/account.js';

const MARK = '<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M16 1.5C8.4 1.5 2.2 7.4 1.6 14.8l7.8 3.2a4.1 4.1 0 0 1 2.6-.8l3.5-5v-.1a5.5 5.5 0 1 1 5.5 5.5h-.1l-5 3.6v.3a4.1 4.1 0 0 1-8.2.6L2.1 19.8A14.5 14.5 0 1 0 16 1.5zm-5.1 22.1-1.8-.7a3.1 3.1 0 1 0 1.7-4.2l1.8.8a2.3 2.3 0 1 1-1.7 4.1zm13.6-11.1a3.7 3.7 0 1 0-7.4 0 3.7 3.7 0 0 0 7.4 0zm-6.5 0a2.8 2.8 0 1 1 5.6 0 2.8 2.8 0 0 1-5.6 0z"/></svg>';

// size: 'small' (a top bar) | 'large' (a call to action)
export function steamButton({ size = 'small', label = 'Sign in through Steam' } = {}) {
  const a = document.createElement('a');
  a.className = `steam-btn steam-btn-${size}`;
  a.href = SIGN_IN_URL;
  const mark = document.createElement('span');
  mark.className = 'steam-btn-mark';
  mark.innerHTML = MARK; // a constant
  const text = document.createElement('span');
  text.className = 'steam-btn-text';
  const small = document.createElement('small');
  small.textContent = 'Sign in through';
  const big = document.createElement('b');
  big.textContent = 'STEAM';
  text.append(small, big);
  a.setAttribute('aria-label', label);
  a.append(mark, text);
  // the navigation takes a moment (Steam's page): show it's on its way, and don't send it twice
  a.addEventListener('click', (ev) => {
    if (a.classList.contains('going')) { ev.preventDefault(); return; }
    a.classList.add('going');
    small.textContent = 'Opening';
  });
  // back from Steam's page (the browser's back-forward cache keeps this page as it was): ready again
  window.addEventListener('pageshow', () => { a.classList.remove('going'); small.textContent = 'Sign in through'; });
  return a;
}
