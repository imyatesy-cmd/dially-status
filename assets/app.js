/* Dially status page: polls data.json (same origin, no token, no third party) and animates what changed. */
(function () {
  'use strict';
  var L = window.StatusLib;
  var DATA_URL = 'data.json';
  var PAGE_SIZE = 12;
  var params = new URLSearchParams(location.search);
  // ?poll=5 changes the interval (2 to 300 seconds); it exists so the page can be tested quickly. Default 20.
  var pollMs = Math.min(300, Math.max(2, Number(params.get('poll')) || 20)) * 1000;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var KIND_LABEL = { started: 'Started', finished: 'Finished' };
  var PIECES = [['finished', 'finished'], ['building', 'being built'], ['review', 'in review'], ['queued', 'not started']];

  function $(id) { return document.getElementById(id); }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  var state = { data: null, text: null, lastOk: null, failures: 0, nextAt: 0, timer: null, inflight: false, rendered: false, showAll: false, keys: [] };
  var waveRows = new Map();
  var areaRows = new Map();
  var feedRows = new Map();

  // ---- small animation helpers ----
  function flash(node) {
    if (reduceMotion) return;
    node.classList.remove('bump');
    void node.offsetWidth;
    node.classList.add('bump');
    node.addEventListener('animationend', function () { node.classList.remove('bump'); }, { once: true });
  }
  function setNumber(node, to, format, animate) {
    var from = node._value;
    node._value = to;
    var show = function (n) { node.textContent = format(Math.round(n)); };
    if (from === undefined || from === to || !animate || reduceMotion) { show(to); return from !== undefined && from !== to; }
    var start = performance.now();
    var step = function (now) {
      var t = Math.min(1, (now - start) / 800);
      show(from + (to - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1 && node._value === to) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return true;
  }
  function setBar(bar, percent, animate) {
    var fill = bar.firstElementChild;
    bar.setAttribute('aria-valuenow', String(percent));
    var changed = bar._percent !== undefined && bar._percent !== percent;
    bar._percent = percent;
    if (!fill.style.width) { fill.style.width = '0%'; void fill.offsetWidth; }
    fill.style.width = percent + '%';
    if (changed && animate) flash(bar);
    return changed;
  }
  var pct = function (n) { return n + '%'; };
  var plain = function (n) { return String(n); };

  // ---- progress rows (waves and areas) ----
  function createRow(expandable) {
    var root = el(expandable ? 'details' : 'div', 'row');
    var head = el(expandable ? 'summary' : 'div', 'head');
    var name = el('span', 'name');
    var title = el('span');
    var tag = el('span', 'tag');
    name.append(title, tag);
    var pctEl = el('span', 'pct', '0%');
    var bar = el('div', 'bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.appendChild(el('span', 'fill'));
    var of = el('span', 'of');
    head.append(name, pctEl, bar, of);
    root.appendChild(head);
    var pieces = null;
    if (expandable) { pieces = el('ul', 'pieces'); root.appendChild(pieces); }
    return { root: root, title: title, tag: tag, pct: pctEl, bar: bar, of: of, pieces: pieces };
  }
  function updateRow(row, item, animate, tag) {
    row.title.textContent = item.name;
    row.tag.textContent = tag || '';
    row.bar.setAttribute('aria-label', item.name);
    setNumber(row.pct, item.percent, pct, animate);
    setBar(row.bar, item.percent, animate);
    row.of.textContent = item.done + ' of ' + item.total + (item.total === 1 ? ' piece finished' : ' pieces finished');
    if (row.pieces && item.pieces) {
      row.pieces.textContent = '';
      PIECES.forEach(function (p) {
        var li = el('li');
        li.append(el('b', '', String(item.pieces[p[0]] || 0)), document.createTextNode(' ' + p[1]));
        row.pieces.appendChild(li);
      });
    }
  }
  function syncRows(container, map, list, expandable, animate, tagFor) {
    var wanted = new Set(list.map(function (item) { return item.id; }));
    map.forEach(function (row, id) { if (!wanted.has(id)) { row.root.remove(); map.delete(id); } });
    list.forEach(function (item, index) {
      var row = map.get(item.id);
      if (!row) { row = createRow(expandable); map.set(item.id, row); }
      updateRow(row, item, animate, tagFor(item));
      if (container.children[index] !== row.root) container.insertBefore(row.root, container.children[index] || null);
    });
  }

  // ---- live feed ----
  function whenText(at) { return L.formatAgoCoarse((Date.now() - Date.parse(at)) / 1000); }
  function renderFeed(events, animate) {
    var feed = $('feed');
    var fresh = new Set(L.newEventKeys(state.keys, events));
    var shown = state.showAll ? events : events.slice(0, PAGE_SIZE);
    var keys = L.eventKeys(events);
    var wanted = new Set(keys.slice(0, shown.length));
    feedRows.forEach(function (li, key) { if (!wanted.has(key)) { li.remove(); feedRows.delete(key); } });
    shown.forEach(function (event, index) {
      var key = keys[index];
      var li = feedRows.get(key);
      if (!li) {
        li = el('li', 'event' + (event.highlight ? ' highlight' : ''));
        li.append(el('span', 'kind', KIND_LABEL[event.kind] || event.kind), el('span', 'text', event.text), el('time', 'when'));
        li.lastChild.dateTime = event.at;
        li.lastChild.title = new Date(event.at).toLocaleString();
        li.lastChild.dataset.at = event.at;
        if (animate && fresh.has(key) && !reduceMotion) li.classList.add('is-new');
        feedRows.set(key, li);
      }
      li.lastChild.textContent = whenText(event.at);
      if (feed.children[index] !== li) feed.insertBefore(li, feed.children[index] || null);
    });
    $('feed-empty').hidden = events.length > 0;
    var more = $('feed-more');
    more.hidden = events.length <= PAGE_SIZE;
    more.textContent = state.showAll ? 'Show fewer events' : 'Show older events';
    more.setAttribute('aria-expanded', String(state.showAll));
    state.keys = keys;
    return fresh.size;
  }

  // ---- whole page ----
  function render(data) {
    var animate = state.rendered;
    var announce = [];
    var overallChanged = setNumber($('overall-pct'), data.overall.percent, pct, animate);
    var bar = $('overall-bar');
    setBar(bar, data.overall.percent, animate);
    $('overall-sub').textContent = data.overall.done + ' of ' + data.overall.total + (data.overall.total === 1 ? ' piece of publicly tracked work finished' : ' pieces of publicly tracked work finished');
    if (overallChanged && animate) announce.push('Overall progress is now ' + data.overall.percent + ' percent.');
    document.title = data.overall.percent + '% · Dially build status';

    Object.keys(data.counts).forEach(function (key) {
      var card = $('c-' + key);
      if (!card) return;
      var changed = setNumber(card.firstElementChild, data.counts[key], plain, animate);
      if (changed && animate) { card.classList.remove('bump'); void card.offsetWidth; if (!reduceMotion) card.classList.add('bump'); }
    });

    syncRows($('waves'), waveRows, data.waves, true, animate, function (item) { return /^W\d+$/.test(item.id) ? item.id : ''; });
    syncRows($('areas'), areaRows, data.areas, false, animate, function () { return ''; });
    var added = renderFeed(data.events, animate);
    if (added && animate) announce.push(added + (added === 1 ? ' new event.' : ' new events.'));
    if (announce.length) $('announce').textContent = announce.join(' ');
    state.rendered = true;
    tick();
  }

  // ---- connection indicator and clocks ----
  function tick() {
    var now = Date.now();
    var mode = L.connectionState({ online: navigator.onLine, failures: state.failures, lastOk: state.lastOk });
    var conn = $('conn');
    conn.dataset.state = mode;
    $('conn-label').textContent = mode === 'connected' ? 'Connected' : mode === 'offline' ? 'Offline' : 'Connecting';
    var age = '';
    if (mode === 'connected') age = 'checked ' + L.formatAgo((now - state.lastOk) / 1000);
    else if (mode === 'offline') {
      var retry = Math.max(0, Math.round((state.nextAt - now) / 1000));
      age = (state.lastOk ? 'last update ' + L.formatAgo((now - state.lastOk) / 1000) + ', ' : '') + (state.timer ? 'retrying in ' + retry + ' s' : 'retrying');
    }
    $('conn-age').textContent = age;
    if (state.data) {
      var latest = state.data.events.length ? state.data.events[0].at : null;
      $('activity').textContent = latest
        ? 'Last recorded activity: ' + whenText(latest) + ' (times are shown to the hour).'
        : 'No recent activity recorded.';
      var clock = $('clock-value');
      clock.textContent = state.data.generated ? L.formatUtc(state.data.generated) : 'unknown';
      if (state.data.generated) clock.dateTime = state.data.generated;
      var stale = state.data.generated ? L.staleHours(state.data.generated, now) : 0;
      $('stale').hidden = !stale;
      if (stale) $('stale').textContent = 'The data is ' + stale + ' hours old. Updates may have paused; this page catches up by itself when they resume.';
    }
    $('feed').querySelectorAll('time').forEach(function (t) { t.textContent = whenText(t.dataset.at); });
  }

  // ---- polling: conditional GET every 20 s, exponential backoff while it fails ----
  function schedule() {
    clearTimeout(state.timer);
    var delay = L.nextDelay(state.failures, pollMs) + Math.random() * 1000;
    state.nextAt = Date.now() + delay;
    state.timer = setTimeout(function () { if (document.hidden) { schedule(); } else { poll(); } }, delay);
  }
  function poll() {
    if (state.inflight) return Promise.resolve();
    state.inflight = true;
    clearTimeout(state.timer);
    state.timer = null;
    var controller = new AbortController();
    var abort = setTimeout(function () { controller.abort(); }, 10000);
    // cache:'no-cache' makes the browser revalidate with If-None-Match / If-Modified-Since: an unchanged file costs a tiny 304.
    return fetch(DATA_URL, { cache: 'no-cache', credentials: 'omit', headers: { accept: 'application/json' }, signal: controller.signal })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.text();
      })
      .then(function (text) {
        var data = JSON.parse(text);
        var shape = L.checkShape(data);
        $('notice').hidden = !shape.newer;
        if (shape.newer) $('notice').textContent = 'This page is out of date. Please reload it to see the latest layout.';
        if (!shape.ok) throw new Error('unusable data: ' + shape.reason);
        state.failures = 0;
        state.lastOk = Date.now();
        if (text !== state.text) { state.text = text; state.data = shape.data; render(shape.data); }
      })
      .catch(function () { state.failures += 1; })
      .then(function () { clearTimeout(abort); state.inflight = false; schedule(); tick(); });
  }

  $('feed-more').addEventListener('click', function () {
    state.showAll = !state.showAll;
    if (state.data) renderFeed(state.data.events, false);
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && (state.lastOk === null || Date.now() - state.lastOk > pollMs)) poll();
  });
  window.addEventListener('online', function () { poll(); });
  window.addEventListener('offline', tick);
  setInterval(tick, 1000);
  tick();
  poll();
}());
