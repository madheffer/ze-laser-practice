// JSON in localStorage. What comes back is untrusted (anyone can edit it): always a plain object here, and
// callers validate the fields they read.

export function loadJson(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

export function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / quota */ }
}

// Own-property lookup, so a data-supplied key like "constructor" or "__proto__" never reaches the prototype.
export const own = (obj, key) => (obj != null && Object.hasOwn(obj, key) ? obj[key] : undefined);
