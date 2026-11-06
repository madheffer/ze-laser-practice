// The co-op server's event log: one line per event on stdout (`docker logs`, Helm's live logs), so a round that went
// wrong on the live server can be followed afterwards: who joined, what started, who died of what, why a round
// ended, why a socket closed, and what the clients themselves report (their 'diag' messages, coop-relay.js).
//
//   coop <event> room=ABCD r=123456 id=#7 name=Bob k=v ...
//
// Names and client text are untrusted: every value that isn't a plain token is JSON-quoted (no newlines or control
// characters reach the log) and capped. No address is ever logged (coop-relay.js).
const PLAIN = /^[\w.:/@#+-]{1,80}$/;
const MAX_VALUE = 300;

function value(v) {
  if (v == null) return '-';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '-';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.length ? v.map(value).join(',') : '-';
  const s = String(v).slice(0, MAX_VALUE);
  return PLAIN.test(s) ? s : JSON.stringify(s);
}

// fields: { key: value }; undefined values are left out
export function format(event, fields = {}) {
  let line = `coop ${event}`;
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) line += ` ${k}=${value(v)}`;
  return line;
}

// a player as the log names them (spread into the fields): their connection id and name
export const who = (c) => (c ? { id: `#${c.id}`, name: c.name } : {});

// log: (line) => void (console.log on the standalone server, Vite's logger on dev)
export function coopLog(log) {
  return (event, fields) => { try { log(format(event, fields)); } catch { /* logging never breaks the relay */ } };
}
