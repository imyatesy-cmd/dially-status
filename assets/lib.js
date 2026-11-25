/* Small pure helpers for the status page. Plain script (no modules, no build step) that also loads in Node for tests. */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.StatusLib = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SUPPORTED_SCHEMA = 1;
  const BASE_MS = 20000;
  const MAX_MS = 300000;

  // "just now", "12 s ago", "3 min ago", "5 h ago", "2 days ago"
  function formatAgo(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 5) return 'just now';
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    const days = Math.floor(s / 86400);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }

  // Event times are rounded to the hour, so they are described in hours, never in minutes.
  function formatAgoCoarse(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 3600) return 'within the last hour';
    return formatAgo(s);
  }

  // 'stale' when the data file is older than five hours (publishing runs every 2 hours and refreshes idle data after 3).
  const STALE_SECONDS = 5 * 3600;
  function staleHours(generated, nowMs) {
    const age = (nowMs - Date.parse(generated)) / 1000;
    return age > STALE_SECONDS ? Math.floor(age / 3600) : 0;
  }

  // Wait before the next poll: the normal interval after a success, doubling after each failure up to five minutes.
  function nextDelay(failures, base, max) {
    const b = base || BASE_MS;
    const cap = max || MAX_MS;
    return Math.min(cap, b * Math.pow(2, Math.max(0, failures)));
  }

  // 'connecting' until the first answer; 'connected' while the last poll worked; 'offline' after any failed poll or when the browser says so.
  function connectionState(input) {
    if (input.online === false) return 'offline';
    if (input.failures > 0) return 'offline';
    if (input.lastOk === null || input.lastOk === undefined) return 'connecting';
    return 'connected';
  }

  const isCount = v => Number.isInteger(v) && v >= 0 && v <= 1000000;
  const clamp = v => Math.min(100, Math.max(0, v));
  const KINDS = ['started', 'finished'];
  const MAX_ROWS = 40;
  const MAX_EVENTS = 60;
  const isRow = r => r && typeof r.id === 'string' && typeof r.name === 'string' && r.name.length < 200 && isCount(r.done) && isCount(r.total) && Number.isFinite(r.percent);
  const cleanRow = r => {
    const row = { id: r.id, name: r.name, done: r.done, total: r.total, percent: Math.round(clamp(r.percent)) };
    if (r.pieces && typeof r.pieces === 'object') row.pieces = { finished: 0, building: 0, review: 0, queued: 0 };
    if (row.pieces) for (const k of Object.keys(row.pieces)) row.pieces[k] = isCount(r.pieces[k]) ? r.pieces[k] : 0;
    return row;
  };
  const validEvent = e => e && typeof e === 'object' && typeof e.at === 'string' && Number.isFinite(Date.parse(e.at)) && KINDS.includes(e.kind) && typeof e.text === 'string' && e.text.length > 0 && e.text.length <= 300;
  const COUNT_KEYS = ['building', 'review', 'finished_7d'];

  // Checks a downloaded document and returns a CLEAN copy: { ok: true, data } or { ok: false, newer, reason }.
  // Bad events are dropped, percentages are clamped to 0-100, lists are capped, counts are whole numbers.
  function checkShape(data) {
    if (!data || typeof data !== 'object') return { ok: false, newer: false, reason: 'not an object' };
    if (typeof data.schema === 'number' && data.schema > SUPPORTED_SCHEMA) return { ok: false, newer: true, reason: 'newer schema' };
    if (data.schema !== SUPPORTED_SCHEMA) return { ok: false, newer: false, reason: 'unknown schema' };
    if (!data.overall || !isCount(data.overall.done) || !isCount(data.overall.total) || !Number.isFinite(data.overall.percent)) return { ok: false, newer: false, reason: 'bad overall' };
    if (!Array.isArray(data.waves) || !data.waves.every(isRow)) return { ok: false, newer: false, reason: 'bad waves' };
    if (!Array.isArray(data.areas) || !data.areas.every(isRow)) return { ok: false, newer: false, reason: 'bad areas' };
    if (!data.counts || typeof data.counts !== 'object') return { ok: false, newer: false, reason: 'bad counts' };
    if (!Array.isArray(data.events)) return { ok: false, newer: false, reason: 'bad events' };
    const counts = {};
    for (const k of COUNT_KEYS) counts[k] = isCount(data.counts[k]) ? data.counts[k] : 0;
    return {
      ok: true,
      data: {
        schema: data.schema,
        generated: typeof data.generated === 'string' && Number.isFinite(Date.parse(data.generated)) ? data.generated : null,
        overall: { done: data.overall.done, total: data.overall.total, percent: Math.round(clamp(data.overall.percent)) },
        waves: data.waves.slice(0, MAX_ROWS).map(cleanRow),
        areas: data.areas.slice(0, MAX_ROWS).map(cleanRow),
        counts,
        events: data.events.filter(validEvent).slice(0, MAX_EVENTS).map(e => ({ at: e.at, kind: e.kind, area: typeof e.area === 'string' ? e.area : null, text: e.text, highlight: e.highlight === true })),
      },
    };
  }

  // One key per event; identical events (same second, same wording) get a counter so each keeps its own row.
  function eventKeys(events) {
    const seen = new Map();
    return events.map(e => {
      const base = e.at + '|' + e.kind + '|' + e.text;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      return n === 1 ? base : base + '|' + n;
    });
  }

  // Keys of events that were not in the previous list.
  function newEventKeys(previousKeys, events) {
    const seen = new Set(previousKeys);
    return eventKeys(events).filter(key => !seen.has(key));
  }

  return { SUPPORTED_SCHEMA, BASE_MS, MAX_MS, formatAgo, formatAgoCoarse, staleHours, nextDelay, connectionState, checkShape, eventKeys, newEventKeys };
}));
