/* Hanaro app. Plain JavaScript, no build step. The link and key live only in this device's storage. */
(function () {
  'use strict';
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    /** Returns false if the phone refused to store it (full). Old copies of data that can be fetched again are cleared to make room, once. */
    set: function (k, v) {
      try { localStorage.setItem(k, v); return true; } catch (e) {}
      try {
        ['hanaro.cache.payees', 'hanaro.cache.status', 'hanaro.hints', 'hanaro.places'].forEach(function (x) { if (x !== k) localStorage.removeItem(x); });
        localStorage.setItem(k, v); return true;
      } catch (e2) { return false; }
    },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var $ = function (id) { return document.getElementById(id); };
  var state = { pick: { held: false, selected: '', onPick: function () {} }, geo: null, photo: null, token: 0, busy: false, err: false, sync: null, view: 'home', filter: 'all', later: {}, cats: null, accounts: [], kind: 'spent', counts: { review: 0 } };
  /** Rows the person said are NOT the same place as the rest of a group. Kept on this device so a sync does not undo it. */
  /** "Later" on a card is remembered for the rest of the day, so a refresh does not bring it back. */
  state.later = (function () {
    var today = (function () { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); })(), o = {};
    try { var s = JSON.parse(LS.get('hanaro.later') || '{}') || {}; if (s.day === today) o = s.ids || {}; } catch (e) {}
    state.laterDay = today; return o;
  })();
  state.notSame = (function () { try { return JSON.parse(LS.get('hanaro.notsame') || '{}') || {}; } catch (e) { return {}; } })();

  /* ---------- helpers ---------- */
  /** Bank emails sometimes leave codes like &#x2F; in names. Turn them back into characters before showing. */
  function unent(s) { return s.replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); }).replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(Number(d)); }).replace(/&amp;/g, '&'); }
  function esc(s) { return unent(String(s === null || s === undefined ? '' : s)).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function rp(n) { return 'Rp ' + Math.round(n).toLocaleString('id-ID'); }
  function rpShort(n) {
    var a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e6) return s + 'Rp ' + (Math.round(a / 1e5) / 10).toLocaleString('id-ID') + 'M';
    return s + rp(a);
  }
  function bigParts(n) {
    var t = Math.round(n).toLocaleString('id-ID'), i = t.lastIndexOf('.');
    return i === -1 ? { n: t, z: '' } : { n: t.slice(0, i), z: t.slice(i) };
  }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function when(ts) { return dayLabel(ts.slice(0, 10)) + ', ' + ts.slice(11, 16); }
  function dayLabel(iso) { return Number(iso.slice(8, 10)) + ' ' + MON[Number(iso.slice(5, 7)) - 1]; }
  function ago(iso) {
    if (!iso) return null;
    var m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (isNaN(m)) return null;
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 1440) return Math.round(m / 60) + ' h ago';
    return Math.round(m / 1440) + ' days ago';
  }
  /**
   * Small messages that stack at the top and can be dismissed. Same text twice shows once.
   * ms: 0 stays until closed. act: { label, fn } adds a button (for example Undo).
   */
  function banner(msg, bad, ms, act) {
    var box = $('toasts'), kids = box.children, i, el;
    for (i = 0; i < kids.length; i++) if (kids[i].getAttribute('data-m') === msg) { clearTimeout(kids[i]._t); el = kids[i]; break; }
    if (!el) {
      el = document.createElement('div'); el.setAttribute('data-m', msg);
      var sp = document.createElement('span'); sp.className = 'tm'; sp.textContent = msg; el.appendChild(sp);
      if (act) { var ab = document.createElement('button'); ab.type = 'button'; ab.className = 'ta'; ab.textContent = act.label; ab.addEventListener('click', function () { el.remove(); act.fn(); }); el.appendChild(ab); }
      var x = document.createElement('button'); x.type = 'button'; x.className = 'tx'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×'; x.addEventListener('click', function () { clearTimeout(el._t); el.remove(); }); el.appendChild(x);
      box.appendChild(el);
      while (box.children.length > 3) box.removeChild(box.firstChild);
    }
    el.className = 'toast' + (bad ? ' bad' : '');
    if (ms !== 0) el._t = setTimeout(function () { el.remove(); }, ms || (bad ? 7000 : 2500));
  }
  function newId() { var a = new Uint8Array(6); (window.crypto || window.msCrypto).getRandomValues(a); return 't_' + [].map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }

  /* ---------- API ---------- */
  function conf() { return { url: LS.get('hanaro.url'), key: LS.get('hanaro.key') }; }
  /** Errors carry what the app should do next: net (no connection), retry (server hiccup, try again), auth (key refused). */
  function api(action, args) {
    var c = conf();
    if (!c.url || !c.key) { var e0 = new Error('This device is not connected yet.'); e0.auth = true; return Promise.reject(e0); }
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 30000);
    var body = JSON.stringify(Object.assign({ key: c.key, action: action, today: localIso().slice(0, 10) }, args || {}));
    return fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body, signal: ctl.signal, redirect: 'follow' })
      .then(function (r) { return r.json(); }, function () { var e = new Error('Cannot reach Hanaro. Check your internet connection.'); e.net = true; throw e; })
      .then(function (j) {
        clearTimeout(t);
        if (!j.ok) { var e = new Error(j.error || 'Something went wrong.'); e.retry = !!j.retry; e.auth = /not recognised/.test(e.message); throw e; }
        return j.data;
      }, function (e) {
        clearTimeout(t);
        if (e instanceof SyntaxError) { var e2 = new Error('Hanaro sent back something unreadable. Check the link is the latest one and that its access is set to Anyone.'); e2.retry = true; throw e2; }
        throw e;
      });
  }
  /* ---------- places: where purchases happened, to suggest payee and category by location ---------- */
  function readPlaces() { try { return JSON.parse(LS.get('hanaro.places') || '[]'); } catch (e) { return []; } }
  function addPlaces(list) {
    var a = readPlaces();
    list.forEach(function (p) {
      if (p.lat === null || p.lat === undefined || !p.payee) return;
      if (a.some(function (x) { return x.payee === p.payee && Math.abs(x.lat - p.lat) < 0.0003 && Math.abs(x.lng - p.lng) < 0.0003; })) return;
      a.unshift(p);
    });
    LS.set('hanaro.places', JSON.stringify(a.slice(0, 300)));
  }
  function distM(a, b) {
    var R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
  /** Shrinks a photo on the device so it uploads quickly. */
  function compress(file) {
    return new Promise(function (res, rej) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var k = Math.min(1, 1400 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        res({ data: c.toDataURL('image/jpeg', 0.72).split(',')[1], mime: 'image/jpeg' });
      };
      img.onerror = function () { rej(new Error('That photo could not be read. Try another one.')); };
      img.src = url;
    });
  }

  /* ---------- data: show the saved copy first, refresh behind it ---------- */
  var E = window.HanaroEngine, MEMK = { home: 1, review: 1, activity: 1, categories: 1, budget: 1, wealth: 1 }, mem = {};
  function snap(k) { if (MEMK[k]) { if (!mem[k] && E.ready()) mem[k] = { at: Date.now(), d: computeView(k) }; return mem[k] || null; } var raw = LS.get('hanaro.cache.' + k); try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
  function save(k, d) { if (MEMK[k]) { mem[k] = { at: Date.now(), d: d }; return; } LS.set('hanaro.cache.' + k, JSON.stringify({ at: Date.now(), d: d })); }
  function patch(k, fn) { var c = snap(k); if (!c) return; fn(c.d); save(k, c.d); }
  function readQueue() { try { return JSON.parse(LS.get('hanaro.queue') || '[]'); } catch (e) { return []; } }
  var queue = readQueue(), flushing = null, bootP = null, storageWarned = false;
  /** The waiting changes are kept on the phone. If the phone is full, receipt photos are dropped from the saved copy first. */
  function saveQueue() {
    if (!LS.set('hanaro.queue', JSON.stringify(queue))) {
      var lean = queue.map(function (q) { if (q.args && q.args.photo) { var a = Object.assign({}, q.args); delete a.photo; return Object.assign({}, q, { args: a, lost: 'photo' }); } return q; });
      if (!LS.set('hanaro.queue', JSON.stringify(lean)) && !storageWarned) { storageWarned = true; banner('This phone is out of storage. Waiting changes will be lost if you close the app before they send.', true, 0); }
      else if (!storageWarned) { storageWarned = true; banner('This phone is almost out of storage. A receipt photo will not survive closing the app until it is sent.', true, 0); }
    }
    setPill();
  }
  /** Changes are saved on this device first, then sent. If there is no connection they wait and retry. */
  function send(action, args, label) { applyLocal(action, args); queue.push({ action: action, args: args, label: label }); saveQueue(); return flush(); }
  /** The change shows on every screen at once, from the phone's own copy. The server's row replaces it at the next sync. */
  function applyLocal(action, args) {
    if (!E.ready()) return;
    var stamp = localIso(), today = stamp.slice(0, 10);
    if (action === 'add_txn') E.localAdd(args, stamp);
    else if (action === 'update_txn') E.localUpdate(args.id, args.changes, args.confirm);
    else if (action === 'void_txn' || action === 'merge_dup') E.localStatus(args.id, 'void');
    else if (action === 'restore_txn' || action === 'keep_both') E.localStatus(args.id, 'auto');
    else if (action === 'mark_paid') E.localFlag(args.id, 'paid');
    else if (action === 'attach_photo') E.localUpdate(args.id, { receipt_drive_id: 'pending' }, false);
    else if (action === 'set_balance') E.localBalance(args, today, stamp);
    else if (action === 'set_limit') E.localLimit(args.account, Number(args.limit) || 0);
    else if (/^(set_target|set_four_walls|move_money|set_debt_order|set_budget_settings|plan_next_month)$/.test(action)) E.localBudget(action, args, stamp);
    else return;
    pushViews();
  }
  /** The screen copies are worked out from the phone's data when a screen asks for them, and again only after a change. */
  function pushViews() {
    if (!E.ready()) return;
    Object.keys(mem).forEach(function (k) { delete mem[k]; });
    var u = E.user(); if (u) setWho(u);
    var hc = snap('home'); if (hc) { state.counts.review = hc.d.reviewCount; renderNav(); }
    repaintOverlays();
  }
  function computeView(k) {
    var today = localIso().slice(0, 10);
    return k === 'categories' ? catsPayload() : E.view(k, today);
  }
  function catsPayload() {
    var accts = E.accountList().map(function (a) { return { account: a.account, type: a.type === 'savings' ? 'bank' : a.type, entity: a.entity || '', owner: a.owner || '', payNow: Number(a.pay_within_days) > 0 }; });
    return { categories: E.categories().map(function (c) { return { category: c.category, group: c.group, bucket: c.group, held: false }; }),
      accounts: accts.filter(function (a) { return a.entity !== 'PT'; }).map(function (a) { return a.account; }), accountsFull: accts, apiV: E.apiV() };
  }
  function hasPhoto(q) { return !!(q.args && q.args.photo); }
  function failedItem(q, msg) { banner('Could not save ' + (q.label || 'a change') + '. ' + msg + ' Please enter it again.', true, 0); }
  function gotData(d) { if (d && d.warning) banner(d.warning, true, 0); }
  function flush() {
    if (flushing) return flushing;
    flushing = step().then(function (ok) { flushing = null; setPill(); return ok; }, function () { flushing = null; return false; });
    return flushing;
  }
  /** Sends the oldest waiting change (or a group of up to 30 with a newer server). A change that is refused for a reason a person can fix is dropped with a clear message; anything else stays and is tried again. */
  function step() {
    if (!queue.length) { state.flushErr = ''; return Promise.resolve(true); }
    var group = [];
    if ((state.apiV || 1) >= 3) for (var i = 0; i < queue.length && group.length < 30; i++) { if (hasPhoto(queue[i])) break; group.push(queue[i]); }
    if (group.length > 1) {
      return api('batch', { ops: group.map(function (q) { return Object.assign({ action: q.action, today: localIso().slice(0, 10) }, q.args); }) }).then(function (r) {
        var done = 0, i2;
        for (i2 = 0; i2 < group.length; i2++) {
          var res = r.results[i2];
          if (!res || (!res.ok && res.retry)) break;
          done++;
          if (!res.ok) failedItem(group[i2], res.error); else gotData(res.data);
        }
        queue.splice(0, done); saveQueue();
        if (done < group.length) { state.flushErr = (r.results[done] && r.results[done].error) || ''; return false; }
        return step();
      }, onStepError);
    }
    var q = queue[0];
    return api(q.action, q.args).then(function (d) { queue.shift(); saveQueue(); gotData(d); return step(); }, function (e) { return onStepError(e, q); });
  }
  function onStepError(e, q) {
    state.flushErr = e.message;
    if (e.net || e.auth) return false;
    if (e.retry) {
      if (q) { q.tries = (q.tries || 0) + 1; if (q.tries >= 8) { queue.shift(); saveQueue(); failedItem(q, e.message); return step(); } saveQueue(); }
      return false;
    }
    if (q) { queue.shift(); saveQueue(); failedItem(q, e.message); return step(); }
    return false;
  }
  function useCats(c) {
    state.cats = c.categories; state.accounts = c.accounts; state.apiV = c.apiV || 1;
    state.accountsFull = c.accountsFull || c.accounts.map(function (a) { return { account: a, type: '', entity: '' }; });
  }
  function setWho(u) { if (u) { state.role = u.role; $('whoName').textContent = u.name; $('avatar').textContent = u.name.slice(0, 2).toUpperCase(); } }
  /** One request brings Home, Review, Activity and the category list. */
  function refresh() {
    return flush().then(function () {
      if (queue.length) { var qe = state.flushErr && !/Cannot reach/.test(state.flushErr); var e = new Error(qe ? 'Some changes are waiting to be sent: ' + state.flushErr : 'Cannot reach Hanaro. Check your internet connection.'); e.net = !qe; throw e; }
      if (!bootP) { var syncT0 = performance.now(); bootP = api('sync', { since: E.since() }).then(function (d) {
        E.absorb(d); state.synced = true; pushViews(); lastSyncAt = Date.now(); state.syncMs = Math.round(performance.now() - syncT0);
        addPlaces(snap('activity').d.items.map(function (t) { return { lat: t.lat, lng: t.lng, payee: t.payee, category: t.category, account: t.account }; }));
        state.offline = false; state.offlineSaid = false;
        bootP = null; return d;
      }, function (e) {
        bootP = null;
        if (/does not know/.test(e.message)) throw new Error('Hanaro needs its server update. Paste the newest API code and redeploy it.');
        throw e;
      }); }
      return bootP;
    });
  }
  var lastSyncAt = 0;
  var wt;
  /** After a change was sent, show the server's own numbers once (not once per change). */
  function afterWrite(ok) {
    if (!ok || queue.length) return;
    clearTimeout(wt);
    wt = setTimeout(function () { if (!queue.length) { bootP = null; render(true); } }, 900);
  }
  function editing(v) { var a = document.activeElement; return !!(a && v.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName)); }
  /** This phone's own clock with its own offset, so an entry made abroad keeps the day it was made on. */
  function localIso() {
    var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; }, o = -d.getTimezoneOffset(), a = Math.abs(o);
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + 'T' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds()) + (o < 0 ? '-' : '+') + z(Math.floor(a / 60)) + ':' + z(a % 60);
  }

  /* ---------- setup ---------- */
  function showSetup(msg) {
    $('app').hidden = true; $('nav').hidden = true; $('setup').hidden = false; $('setupMsg').textContent = msg || '';
  }
  function parseHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return;
    var p = {}; h.split('&').forEach(function (kv) { var i = kv.indexOf('='); if (i > 0) p[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
    if (p.u && p.k) { LS.set('hanaro.url', p.u); LS.set('hanaro.key', p.k); }
    history.replaceState(null, '', location.pathname);
  }
  $('setupGo').addEventListener('click', function () {
    var u = $('setupUrl').value.trim(), k = $('setupKey').value.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(u)) { $('setupMsg').textContent = 'The link should start with https://script.google.com/macros/s/ and end with /exec.'; return; }
    if (k.length < 20) { $('setupMsg').textContent = 'The key looks too short. Paste it in full.'; return; }
    $('setupGo').disabled = true; $('setupMsg').textContent = 'Connecting…';
    LS.set('hanaro.url', u); LS.set('hanaro.key', k);
    api('ping').then(function () { $('setup').hidden = true; start(); }, function (e) {
      LS.del('hanaro.url'); LS.del('hanaro.key'); $('setupMsg').textContent = e.message;
    }).then(function () { $('setupGo').disabled = false; });
  });

  /* ---------- dialogs (in the app, not the browser's own pop-ups) ---------- */
  /** o: { title, body, input: { value, placeholder, numeric }, actions: [{ label, primary, danger, fn(value) }] }. fn may return false to keep the dialog open. */
  function dialog(o) {
    var wrap = $('dlg'); wrap.innerHTML = '';
    var box = document.createElement('div'); box.className = 'dbox'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    var h = document.createElement('div'); h.className = 'dt'; h.textContent = o.title || ''; box.appendChild(h);
    if (o.body) { var b = document.createElement('p'); b.className = 'db'; b.textContent = o.body; box.appendChild(b); }
    var inp = null, msg = null;
    if (o.input) {
      inp = document.createElement('input'); inp.className = 'di'; inp.value = o.input.value || ''; inp.placeholder = o.input.placeholder || '';
      if (o.input.numeric) { inp.setAttribute('inputmode', 'numeric'); inp.addEventListener('input', function () { var d = inp.value.replace(/[^\d]/g, ''); inp.value = d ? Number(d).toLocaleString('id-ID') : ''; }); }
      box.appendChild(inp);
      msg = document.createElement('p'); msg.className = 'err'; box.appendChild(msg);
    }
    var row = document.createElement('div'); row.className = 'da';
    function close() { wrap.hidden = true; wrap.innerHTML = ''; document.removeEventListener('keydown', onKey); }
    function onKey(ev) { if (ev.key === 'Escape') close(); else if (ev.key === 'Enter' && inp && document.activeElement === inp) { var pr = row.querySelector('.primary'); if (pr) pr.click(); } }
    (o.actions || [{ label: 'OK', primary: true }]).forEach(function (a) {
      var bt = document.createElement('button'); bt.type = 'button'; bt.textContent = a.label; bt.className = a.primary ? 'primary small' + (a.danger ? ' danger' : '') : 'ghost small';
      bt.addEventListener('click', function () {
        var r = a.fn ? a.fn(inp ? inp.value : undefined, function (m) { if (msg) msg.textContent = m; }) : undefined;
        if (r !== false) close();
      });
      row.appendChild(bt);
    });
    box.appendChild(row); wrap.appendChild(box); wrap.hidden = false;
    wrap.onclick = function (ev) { if (ev.target === wrap) close(); };
    document.addEventListener('keydown', onKey);
    if (inp) setTimeout(function () { inp.focus(); inp.select(); }, 30);
  }
  function confirmBox(text, label, fn, danger) {
    dialog({ title: 'Are you sure?', body: text, actions: [{ label: 'Cancel' }, { label: label, primary: true, danger: danger, fn: function () { fn(); } }] });
  }
  function skeleton() { return '<div class="skel" aria-label="Loading"><div class="sk t"></div><div class="sk c"></div><div class="sk c s"></div><div class="sk c s"></div></div>'; }
  /** What to show when a screen cannot load or refresh. Offline is said once and quietly; the saved copy stays on screen. */
  function loadFail(e, tok, v, hadView, retry) {
    state.busy = false;
    if (/not recognised/.test(e.message)) { LS.del('hanaro.key'); showSetup(e.message); return; }
    if (e.net) {
      state.offline = true; setPill(undefined, false);
      if (tok !== state.token) return;
      if (hadView) { if (!state.offlineSaid) { state.offlineSaid = true; banner('You are offline. Showing what was saved. Changes you make are kept and sent later.', false, 3500); } return; }
    } else {
      setPill(undefined, true);
      if (tok !== state.token) return;
      if (hadView) { banner(e.message, true, 6000); return; }
    }
    v.innerHTML = '<div class="card"><div class="label">' + (e.net ? 'You are offline' : 'Could not load') + '</div><p class="note">' + esc(e.message) + '</p><button class="ghost small" id="retry">Try again</button></div>';
    $('retry').addEventListener('click', retry);
  }
  /** A screen that has its own request (reports, accounts, places): saved copy first, refresh behind it, at most every 20 seconds unless forced. */
  function renderRemote(v, tok, ckey, action, args, paint, force) {
    var c = snap(ckey);
    if (c && c.d) paint(v, c.d); else v.innerHTML = skeleton();
    if (c && !force && !queue.length && Date.now() - c.at < 20000) { setPill(); return; }
    state.busy = true; setPill();
    flush().then(function () {
      if (queue.length) { var e = new Error('Some changes are waiting to be sent.'); e.net = !state.flushErr || /Cannot reach/.test(state.flushErr); throw e; }
      return api(action, args);
    }).then(function (d) {
      save(ckey, d); state.busy = false; state.offline = false; state.offlineSaid = false; setPill(undefined, false);
      if (tok === state.token && !editing(v)) paint(v, d);
    }, function (e) {
      if (/does not know/.test(e.message)) { state.busy = false; setPill(undefined, true); if (tok === state.token) v.innerHTML = '<div class="card"><div class="label">Needs a server update</div><p class="note">This screen needs the newest Hanaro server code. Paste it into the Apps Script project and deploy it again.</p></div>'; return; }
      loadFail(e, tok, v, !!(c && c.d), function () { render(true); });
    });
  }

  /* ---------- shell ---------- */
  var ICONS = {
    home: '<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
    review: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/>',
    budget: '<path d="M4 7h16M4 12h10M4 17h6"/><circle cx="18" cy="16" r="3"/>',
    activity: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    spending: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
    status: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
    accounts: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M7 15h4"/>'
  };
  var LABELS = { home: 'HOME', budget: 'BUDGET', review: 'REVIEW', activity: 'ACTIVITY', spending: 'SPENDING', status: 'STATUS', accounts: 'ACCOUNT' };
  function renderNav() {
    document.querySelectorAll('nav [data-go]').forEach(function (b) {
      var v = b.getAttribute('data-go'), on = state.view === v || (v === 'accounts' && (state.view === 'payees' || state.view === 'status')) || (v === 'activity' && state.view === 'review');
      b.className = on ? 'on' : '';
      b.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[v] + '</svg>' +
        '<span class="lb">' + LABELS[v] + '</span>' + (v === 'activity' && state.counts.review ? '<span class="badge">' + state.counts.review + '</span>' : '');
    });
  }
  function setPill(iso, err) {
    if (iso !== undefined) state.sync = iso;
    if (err !== undefined) state.err = err;
    var p = $('syncPill'), a = ago(state.sync);
    var stale = !state.sync || (Date.now() - Date.parse(state.sync)) > 2 * 3600 * 1000;
    if (queue.length) { p.textContent = (state.offline ? 'Offline · ' : '') + queue.length + ' waiting'; p.className = 'pill' + (state.flushErr && !state.offline ? ' bad' : ''); return; }
    if (state.busy) { p.textContent = 'Updating…'; p.className = 'pill'; return; }
    if (state.offline) { p.textContent = 'Offline'; p.className = 'pill'; return; }
    p.textContent = state.err ? 'Not synced' : (a ? 'Synced ' + a : 'No sync yet');
    p.className = 'pill' + (stale || state.err ? ' bad' : '');
  }
  /** What is waiting to be sent, with a way to try now. */
  function showQueue() {
    var n = queue.length;
    dialog({
      title: n ? n + ' change' + (n === 1 ? '' : 's') + ' waiting' : 'Offline',
      body: n ? 'They are saved on this phone and will be sent as soon as Hanaro can be reached.' + (state.flushErr ? ' Last problem: ' + state.flushErr : '') + '\n\n' + queue.slice(0, 6).map(function (q) { return '• ' + (q.label || q.action); }).join('\n') : 'No connection right now. Everything you enter is kept and sent later.',
      actions: [{ label: 'Try now', primary: true, fn: function () { state.offline = false; bootP = null; render(true); } }, { label: 'Close' }]
    });
  }
  function go(v) { state.view = v; renderNav(); render(); window.scrollTo(0, 0); }
  document.querySelectorAll('nav [data-go]').forEach(function (b) { b.addEventListener('click', function () { go(b.getAttribute('data-go')); }); });
  $('syncPill').addEventListener('click', function () { if (queue.length || state.offline) { showQueue(); return; } bootP = null; render(true); });

  var wideMq = window.matchMedia ? window.matchMedia('(min-width: 1000px)') : { matches: false };
  function wide() { return wideMq.matches; }
  if (wideMq.addEventListener) wideMq.addEventListener('change', function () { if (conf().key && !$('app').hidden) render(); });
  /* Wide screens (iPad landscape, desktop): Today, Spending plan and Review side by side. Same data, same screens. */
  function paintBoard(v) {
    v.innerHTML = '<div class="board"><div id="bc1"></div><div id="bc2"></div><div id="bc3"></div></div>';
    var h = snap('home'), p = budgetData(), r = snap('review');
    if (h) paintHome($('bc1'), h.d);
    if (p) paintBudget($('bc2'), p.d); else budgetOff($('bc2'));
    if (r) paintReview($('bc3'), r.d);
  }
  var TITLE = 'font-size:30px;font-weight:300;letter-spacing:-.5px;margin:6px 0 0 2px';
  /** Repaints the screen that is open from the phone's own copy, without asking the server. */
  function paintCurrent() { var n = state.view === 'home' && wide() ? 'board' : state.view; if (n === 'status' || n === 'payees' || editing($('view'))) return; paintNow($('view'), n); }
  /** One screen from the phone's own copy. */
  function paintNow(v, name) {
    var today = localIso().slice(0, 10);
    if (name === 'accounts') return paintAccounts(v, E.view('accounts', today));
    if (name === 'spending') {
      if (!state.spendMonth) state.spendMonth = today.slice(0, 7);
      return paintReport(v, E.view('spending', today, state.spendMonth));
    }
    if (name === 'budget') { var bc = budgetData(); if (!bc) return budgetOff(v); return paintBudget(v, bc.d); }
    var paint = { board: paintBoard, home: paintHome, review: paintReview, activity: paintActivity }[name];
    var c = snap(name === 'board' ? 'home' : name);
    if (c) paint(v, c.d); else v.innerHTML = skeleton();
  }
  /** Opens at once from the phone's copy. A refresh runs behind it (at most every 20 seconds unless forced) and the screen is repainted only if nothing is being typed. */
  function render(force) {
    var v = $('view'), name = state.view, tok = ++state.token;
    v.setAttribute('data-v', name === 'home' && wide() ? 'board' : name);
    if (name === 'home' && wide()) name = 'board';
    if (name === 'status') return renderStatus(v, tok);
    if (name === 'payees') return renderPayees(v, tok);
    var had = E.ready();
    if (had) paintNow(v, name); else v.innerHTML = skeleton();
    if (had && !force && !queue.length && Date.now() - lastSyncAt < 20000) { setPill(); return; }
    state.busy = true; setPill();
    refresh().then(function () {
      state.busy = false; state.offline = false; setPill(undefined, false);
      if (tok !== state.token || editing(v)) return;
      paintNow(v, name);
    }, function (e) { loadFail(e, tok, v, had, function () { render(true); }); });
  }

  /* ---------- Home ---------- */
  /** The big number: what can still be spent in the categories for everyday life (Four Walls and everyday), and what the plan is waiting for. */
  function homeHero(b, h, spentLine) {
    var html = '<div class="card hero"><div class="label">Left to spend this month</div>';
    if (!b.ready) {
      return html + bigHtml(0) + '<p class="note">Give your categories a monthly target in Budget and this shows what is left to spend.</p><button class="primary small" data-go-budget>Open Budget</button>' +
        '<div class="rule"></div><div class="sub2">Spent today ' + rp(h.spentToday) + ' · ' + spentLine + '</div></div>';
    }
    html += bigHtml(b.leftToSpend);
    if (b.waiting > 0) html += '<div class="waitnote">Waiting for income: ' + rp(b.waiting) + ' of this month\'s plan is not covered yet.</div>';
    else html += '<div class="okaynote">This month\'s plan is fully covered.</div>';
    html += '<div class="rule"></div><div class="sub2">Spent today <b>' + rp(h.spentToday) + '</b> · ' + spentLine + '</div></div>';
    return html;
  }
  /** Every budgeted category with what is left in it: pinned ones first, then by group. Overspent rows are red. */
  function homeCats(b) {
    var lines = b.categories;
    if (!lines.length) return '';
    var pinNames = pins().map(function (p) { return p.indexOf('|') === -1 ? p : p.slice(p.indexOf('|') + 1); });
    var first = [], rest = [];
    pinNames.forEach(function (n) { lines.forEach(function (l) { if (l.name === n && first.indexOf(l) === -1) first.push(l); }); });
    lines.forEach(function (l) { if (first.indexOf(l) === -1) rest.push(l); });
    function row(l) {
      return '<button class="hrow" data-hcat="' + esc(l.name) + '"><span class="bl"><span class="p">' + esc(l.name) + '</span>' + (l.target > 0 && l.funded < l.target ? '<span class="s">waiting for ' + rpShort(l.target - l.funded) + '</span>' : '') + '</span><span class="br"><b class="' + (l.left < 0 ? 'neg' : '') + '">' + rp(l.left) + '</b></span>' + leftBar(l) + '</button>';
    }
    var html = '<div class="card" style="gap:0"><div class="cardhead"><div class="label">Left in each category</div><button class="link" data-go-budget style="padding:0">Budget ›</button></div>';
    if (first.length) html += '<div class="glabel">Pinned</div>' + first.map(row).join('');
    var seen = {}, order = [];
    rest.forEach(function (l) { var g = l.group || 'Other'; if (!seen[g]) { seen[g] = []; order.push(g); } seen[g].push(l); });
    order.forEach(function (g) { html += '<div class="glabel">' + esc(g) + '</div>' + seen[g].map(row).join(''); });
    return html + '</div>';
  }

  function paintHome(v, h) {
    state.counts.review = h.reviewCount; renderNav(); LS.set('hanaro.lastsync', h.lastSync || ''); setPill(h.lastSync); setWho(h.user);
    var b = bigParts(h.spentToday), bc = budgetData();
    var html = '<div style="' + TITLE + '">' + (bc ? 'Home' : 'Today') + '</div>';
    var spentLine = (h.spentTodayCount ? h.spentTodayCount + ' purchase' + (h.spentTodayCount === 1 ? '' : 's') : 'Nothing spent yet today');
    if (bc) {
      html += homeHero(bc.d, h, spentLine) + homeCats(bc.d);
    } else {
      html += '<div class="card"><div class="label">Spent today</div><div class="big"><span class="rp">Rp</span><span class="n">' + esc(b.n) + '</span><span class="z">' + esc(b.z) + '</span></div>' +
        '<div style="font-size:14px">' + spentLine + '</div><div class="rule"></div>' +
        '<div class="two"><div><div class="tiny muted">This week</div><div class="stat">' + rpShort(h.spentWeek) + '</div></div><div class="sep"></div><div><div class="tiny muted">This month</div><div class="stat">' + rpShort(h.spentMonth) + '</div></div></div>' +
        '<p class="note" style="margin-top:8px">About ' + rp(h.avgPerDay) + ' a day so far this month. Transfers, card payments, debt payments and company accounts are not counted.</p></div>';
    }
    html += '<button class="card tap" data-go-accounts style="text-align:left"><div class="cardhead"><div class="label">Money now</div><span class="chev" aria-hidden="true">›</span></div>' +
      '<div class="kv"><span>In bank accounts</span><b>' + rp(h.cash) + '</b></div>' +
      '<div class="kv"><span>Owed on cards and loans</span><b>' + rp(h.owed) + '</b></div>' +
      (h.limit ? '<div class="kv"><span>Still available on cards</span><b>' + rp(h.available) + '</b></div>' : '') +
      (h.needsBalances ? '<p class="note" style="color:var(--warn);margin-top:6px">' + h.needsBalances + ' account' + (h.needsBalances === 1 ? '' : 's') + ' need a balance typed in once.</p>' : '') + '</button>';
    if (h.uncleared && h.uncleared.count) {
      html += '<div class="card"><div class="label">Not seen at the bank yet</div><div class="kv"><span>' + h.uncleared.count + ' entr' + (h.uncleared.count === 1 ? 'y' : 'ies') + '</span><b>' + rp(h.uncleared.amount) + '</b></div>' +
        '<p class="note">' + (h.uncleared.old ? h.uncleared.old + ' of them ' + (h.uncleared.old === 1 ? 'is' : 'are') + ' more than a day old. A typo in the amount or account would show up here. ' : '') + 'When the bank email arrives, Hanaro matches it and the entry becomes cleared.</p></div>';
    }
    if (h.toPayCount) {
      html += '<div class="card"><div class="label">Left to pay</div><div class="kv"><span>Card charges not paid yet (' + h.toPayCount + ')</span><b>' + rp(h.toPayTotal) + '</b></div>' +
        '<div class="btnrow"><button class="ghost small" data-go-review>See them</button><button class="primary small" data-paid-all>I paid them all</button></div><p class="note">Paid everything in one payment? Hanaro also notices a lump sum by itself when the bank email arrives.</p></div>';
    }
    if (h.reviewCount) html += '<button class="ghost" data-go-review>' + h.reviewCount + ' item' + (h.reviewCount === 1 ? '' : 's') + ' need you</button>';
    v.innerHTML = html;
    v.querySelectorAll('[data-go-review]').forEach(function (r) { r.addEventListener('click', function () { go('review'); }); });
    v.querySelectorAll('[data-go-accounts]').forEach(function (r) { r.addEventListener('click', function () { go('accounts'); }); });
    v.querySelectorAll('[data-go-budget]').forEach(function (r) { r.addEventListener('click', function () { go('budget'); }); });
    v.querySelectorAll('[data-hcat]').forEach(function (r) { r.addEventListener('click', function () { state.actCat = r.getAttribute('data-hcat'); state.actFilter = 'All'; state.actQ = ''; state.actSearchOn = false; go('activity'); }); });
    var pa = v.querySelector('[data-paid-all]');
    if (pa) pa.addEventListener('click', function () {
      var rc = snap('review'), list = rc ? rc.d.items.filter(function (i) { return i.kind === 'pay_now'; }) : [];
      if (!list.length) { banner('Open Review once so Hanaro can load the charges, then try again.', true); return; }
      confirmBox('Mark ' + list.length + ' card charge' + (list.length === 1 ? '' : 's') + ' as paid? Only do this if you already paid them.', 'Mark as paid', function () {
        applyMany(list, function (i) { return { action: 'mark_paid', args: { id: i.txn.id } }; }, 'paid').then(function () {});
        var c = snap('home'); if (c) paintHome(v, c.d);
      });
    });
  }


  /* ---------- Budget: the plan, filled by income in a fixed order ---------- */
  var PM = { '01': 'January', '02': 'February', '03': 'March', '04': 'April', '05': 'May', '06': 'June', '07': 'July', '08': 'August', '09': 'September', '10': 'October', '11': 'November', '12': 'December' };
  var digits = function (id) { return Number($(id).value.replace(/[^\d]/g, '')); };
  function numOf(el) { return Number(String(el.value).replace(/[^\d]/g, '')) || 0; }
  function fmtEl(el) { var d = el.value.replace(/[^\d]/g, ''); el.value = d ? Number(d).toLocaleString('id-ID') : ''; }
  function monthWord(ym) { return PM[ym.slice(5, 7)]; }
  function bigHtml(n, cls) { var b = bigParts(n); return '<div class="big"><span class="rp">Rp</span><span class="n' + (cls ? ' ' + cls : '') + '">' + esc(b.n) + '</span><span class="z">' + esc(b.z) + '</span></div>'; }
  function budgetData() { return E.budgetOn() ? snap('budget') : null; }
  function budgetWord() { return 'Budget needs the new server code. Paste Code.gs into Apps Script to turn it on.'; }
  /** The one plain line shown when the server is the older version. */
  function budgetOff(v) {
    if (!state.synced && state.busy) { v.innerHTML = skeleton(); return; }
    v.innerHTML = '<div style="' + TITLE + '">Budget</div><div class="card"><div class="label">Budget is not on yet</div><p class="note" id="budOff">' + budgetWord() + '</p></div>';
  }
  /** Sends one budget change after checking it the same way the server will. Returns false (and says why) when it is not valid. */
  function budgetSend(action, args, label, say) {
    var err = E.budgetCheck(action, args, localIso());
    if (err) { if (say) say(err); else banner(err, true); return false; }
    send(action, args, label).then(afterWrite);
    return true;
  }
  function leftBar(l) {
    var avail = l.carryIn + l.funded + l.moved, pct = avail > 0 ? Math.max(0, Math.min(100, Math.round(l.left / avail * 100))) : 0;
    var cls = l.left < 0 ? ' max' : (avail > 0 && l.left / avail < 0.15 ? ' hi' : '');
    return '<span class="meter thin' + cls + '"><span style="width:' + (l.left < 0 ? 100 : pct) + '%"></span></span>';
  }
  function catRow(l) {
    var sub = [];
    if (l.target > 0) sub.push('Target ' + rpShort(l.target)); else sub.push('No target');
    if (l.step === 2 && l.due) sub.push('due ' + dueWord(l.due));
    if (l.target > 0 && l.funded < l.target) sub.push('needs ' + rpShort(l.target - l.funded));
    return '<button class="brow" data-bcat="' + esc(l.name) + '"><span class="bl"><span class="p">' + esc(l.name) + '</span><span class="s">' + esc(sub.join(' · ')) + '</span></span>' +
      '<span class="br"><b class="' + (l.left < 0 ? 'neg' : '') + '">' + rp(l.left) + '</b><span class="s">left</span></span>' + leftBar(l) + '</button>';
  }
  var STEP_HELP = {
    1: 'The basics that keep the household running: food at home, utilities, housing and transport. Funded first.',
    2: 'Bills with a due date (earliest first) and the minimum payment on every debt.',
    3: 'Overspending from earlier months, paid back before everyday spending.',
    4: 'Every other category with a target, including money set aside for yearly costs.',
    5: 'The buffer account is topped up to the starter emergency fund.'
  };
  function stepCard(n, b, owner) {
    var s = b.steps[n], title = n === 6 ? (b.allClear ? 'Full emergency fund and wealth' : 'Debt snowball') : s.name;
    var right = n <= 4 ? rpShort(s.funded) + ' of ' + rpShort(s.target) : (s.funded ? rpShort(s.funded) + ' this month' : '');
    var html = '<div class="card" style="gap:0"><div class="cardhead"><div class="label">Step ' + n + ' · ' + esc(title) + '</div><span class="note">' + right + '</span></div>';
    if (n <= 5) html += '<p class="stephelp">' + STEP_HELP[n] + '</p>';
    if (n === 6) html += '<p class="stephelp">' + (b.allClear ? 'No debt is left. Money goes to the full emergency fund (3 to 6 months of costs), then to wealth.' : 'Everything left goes to one debt at a time: the ones you pinned first, then the smallest balance. A paid off debt frees its minimum for the next one.') + '</p>';
    if (n === 6 && !b.allClear) {
      html += debtRows(b, owner);
    } else {
      s.lines.forEach(function (l) {
        if (l.kind === 'cat') html += catRow(l);
        else if (l.kind === 'min') html += '<div class="brow" style="cursor:default"><span class="bl"><span class="p">' + esc(l.name) + ' <span class="tag gray">MINIMUM</span></span><span class="s">' + (l.due ? 'due ' + dueWord(l.due) + ' · ' : '') + 'Rp ' + Math.round(l.target).toLocaleString('id-ID') + (l.paid ? ' · paid ' + rpShort(l.paid) : '') + '</span></span><span class="br"><b>' + rpShort(l.funded) + '</b><span class="s">of ' + rpShort(l.target) + '</span></span></div>';
        else if (l.kind === 'over') html += '<div class="brow" style="cursor:default"><span class="bl"><span class="p">Overspent on cards or cash</span><span class="s">Carried from earlier months</span></span><span class="br"><b>' + rpShort(l.funded) + '</b><span class="s">of ' + rpShort(l.target) + '</span></span></div>';
        else if (l.kind === 'emg') html += '<div class="brow" style="cursor:default"><span class="bl"><span class="p">Emergency fund</span><span class="s">Held ' + rpShort(l.balance) + ' of ' + rpShort(l.goal) + '</span></span><span class="br"><b>' + rpShort(l.funded) + '</b><span class="s">of ' + rpShort(l.target) + ' needed</span></span></div>';
        else if (l.kind === 'full') html += '<div class="brow" style="cursor:default"><span class="bl"><span class="p">Full emergency fund</span><span class="s">Held ' + rpShort(l.balance) + ' of ' + rpShort(l.goal) + '</span></span><span class="br"><b>' + rpShort(l.funded) + '</b></span></div>';
        else if (l.kind === 'wealth') html += '<div class="brow" style="cursor:default"><span class="bl"><span class="p">Wealth</span><span class="s">Move it to the company account or invest it</span></span><span class="br"><b>' + rpShort(l.funded) + '</b></span></div>';
      });
    }
    if (n === 1 && !s.lines.length) html += '<p class="note" style="padding:8px 0 0">No Four Walls yet. Open a category and switch on Four Walls, or do it in Budget settings.</p>';
    if (n === 2 && !s.lines.length) html += '<p class="note" style="padding:8px 0 0">No bills yet. Give a category a due day to make it a bill.</p>';
    if (n === 3 && !s.lines.length) html += '<p class="note" style="padding:8px 0 0">Nothing carried over. Overspending in a category shows up here next month.</p>';
    if (n === 4) {
      if (!s.lines.length) html += '<p class="note" style="padding:8px 0 0">No everyday categories yet.</p>';
      html += '<button class="addrow" data-add-target>+ Add a category target</button>';
    }
    if (n === 5 && !s.lines.length) html += '<p class="note" style="padding:8px 0 0">No starter emergency fund set.' + (owner ? ' <button class="link" data-open-settings>Set it in Budget settings</button>' : '') + '</p>';
    return html + '</div>';
  }
  function debtRows(b, owner) {
    var byName = {}; b.steps[6].lines.forEach(function (l) { if (l.kind === 'debt') byName[l.name] = l; });
    var active = b.debts.filter(function (x) { return x.balance !== 0; }), html = '';
    if (!b.debts.length) return '<p class="note" style="padding:8px 0 0">No debts yet. Cards and loans show here once they have a balance in Account.</p>';
    active.forEach(function (x, i) {
      var l = byName[x.name], focus = !!(l && l.focus);
      html += '<div class="drow' + (focus ? ' focus' : '') + '"><span><span class="p">' + esc(x.name) + (focus ? ' <span class="tag focus">FOCUS</span>' : '') + '</span><span class="s">' +
        (x.balance === null ? 'No balance yet. Set it in Account.' : 'Balance ' + rpShort(x.balance) + (x.minimum ? ' · minimum ' + rpShort(x.minimum) : '')) + '</span></span>' +
        '<span class="r">' + (l && l.funded ? '+' + rpShort(l.funded) : '<span class="muted">Rp 0</span>') + '</span>' +
        (owner && x.balance !== null ? '<span class="arrs"><button class="arr" data-dmove="-1" data-di="' + i + '" aria-label="Move ' + esc(x.name) + ' up"' + (i === 0 ? ' disabled' : '') + '>↑</button><button class="arr" data-dmove="1" data-di="' + i + '" aria-label="Move ' + esc(x.name) + ' down"' + (i === active.length - 1 ? ' disabled' : '') + '>↓</button></span>' : '<span></span>') + '</div>';
    });
    var paid = b.debts.filter(function (x) { return x.balance === 0; });
    paid.forEach(function (x) { html += '<div class="drow"><span><span class="p">' + esc(x.name) + '</span><span class="s">Paid off</span></span><span class="r"><span class="tag paid">PAID OFF</span></span><span></span></div>'; });
    if (owner && b.pinned && b.pinned.length) html += '<button class="addrow" data-dreset>Back to smallest balance first</button>';
    return html;
  }
  function incomeCard(b) {
    var html = '<div class="card" style="gap:0"><div class="cardhead"><div class="label">Income in ' + monthWord(b.month) + '</div><span class="note">' + rpShort(b.incomes.reduce(function (s, i) { return s + i.amount; }, 0)) + '</span></div>';
    if (!b.incomes.length) html += '<p class="note" style="padding:8px 0 0">No income yet this month. Money moved from a company account to a personal account shows up here and fills the plan straight away.</p>';
    b.incomes.forEach(function (i) {
      html += '<div class="irow"><div class="top"><span><span class="p" style="font-weight:600;font-size:14.5px">' + dayLabel(i.date) + '</span> <span class="sub">' + (i.source === 'transfer' ? (i.from === 'Company account' ? 'Company account' : esc(i.from)) + ' to ' + esc(i.to) : esc(i.from || 'Income') + ' into ' + esc(i.to)) + '</span></span><b>' + rp(i.amount) + '</b></div><div class="chiprow">';
      i.parts.forEach(function (p) { html += '<span class="cpill' + (p.next ? ' blue' : '') + '">' + (p.next ? 'Next month · ' : '') + esc(p.name) + ' · ' + rpShort(p.amount) + '</span>'; });
      if (i.unallocated) html += '<span class="cpill none">Not placed · ' + rpShort(i.unallocated) + '</span>';
      if (!i.parts.length && !i.unallocated) html += '<span class="cpill">Waiting for a target</span>';
      html += '</div>' + (i.fundsMonth !== b.month ? '<div class="sub" style="margin-top:6px">Funds ' + monthWord(i.fundsMonth) + ' (last month pays this month is on)</div>' : '') + '</div>';
    });
    return html + '</div>';
  }
  function paintBudget(v, b) {
    var owner = state.role === 'owner', html = '<div style="' + TITLE + '">Budget</div>';
    if (!b.ready) {
      html += '<div class="card"><div class="label">Set up your budget</div><p class="note">Give each category a monthly target. Money that moves from a company account to a personal account fills them in order: Four Walls first, then bills, everyday spending, the emergency fund and your debts.</p>' +
        (owner ? '<button class="primary small" data-plan-next>Set my targets</button>' : '<button class="primary small" data-add-target>Add a target</button>') + '</div>';
      html += incomeCard(b);
      v.innerHTML = html; wireBudget(v, b); return;
    }
    var pct = b.planTarget ? Math.min(100, Math.round(b.planFunded / b.planTarget * 100)) : 0, nc = b.nextCovered;
    html += '<div class="card"><div class="label">This month\'s plan · ' + monthWord(b.month) + '</div>' + bigHtml(b.planFunded) +
      '<div class="note">funded of Rp ' + Math.round(b.planTarget).toLocaleString('id-ID') + ' planned</div><span class="meter"><span style="width:' + pct + '%"></span></span>' +
      '<div style="font-size:14px;font-weight:600;margin-top:4px">' + esc(b.stage.text) + '</div><div class="rule"></div>' +
      '<div class="kv" style="padding:0"><span>Next month covered</span><b>' + (nc.pct === null ? 'No targets yet' : nc.pct + '%') + '</b></div>' +
      (nc.pct !== null ? '<span class="meter' + (nc.full ? '' : '') + '"><span style="width:' + nc.pct + '%"></span></span>' : '') +
      '<p class="note">' + (b.settings.last_month ? 'Last month\'s income pays this month. This month\'s income funds ' + monthWord(b.nextMonth) + '.' : 'Once this month is covered, extra income fills ' + monthWord(b.nextMonth) + ' before the emergency fund and your debts.') + '</p></div>';
    if (owner && nc.full && !b.settings.last_month) {
      html += '<div class="card"><div class="label">Next month is fully covered</div><p class="note">You can now live on last month\'s income. Turn this on and every income will fund the month after it.</p><button class="primary small" data-last-on>Use last month\'s income for this month</button></div>';
    }
    html += incomeCard(b);
    [1, 2, 3, 4, 5, 6].forEach(function (n) { html += stepCard(n, b, owner); });
    if (b.unbudgeted > 0) html += '<p class="note" style="margin:0 4px">' + rp(b.unbudgeted) + ' was spent in categories with no target this month.</p>';
    if (owner) {
      html += '<button class="primary" data-plan-next>' + (b.reviewedNext ? 'Change the plan for ' + monthWord(b.nextMonth) : 'Plan ' + monthWord(b.nextMonth)) + '</button>';
      html += '<button class="ghost" data-open-settings>Budget settings</button>';
    }
    v.innerHTML = html; wireBudget(v, b);
  }
  function wireBudget(v, b) {
    v.querySelectorAll('[data-bcat]').forEach(function (x) { x.addEventListener('click', function () { openCat(x.getAttribute('data-bcat')); }); });
    v.querySelectorAll('[data-plan-next]').forEach(function (x) { x.addEventListener('click', openPlanNext); });
    v.querySelectorAll('[data-open-settings]').forEach(function (x) { x.addEventListener('click', openSettings); });
    v.querySelectorAll('[data-add-target]').forEach(function (x) { x.addEventListener('click', function () { pickCategory('Add a category target', function (name) { openCat(name); }); }); });
    v.querySelectorAll('[data-dmove]').forEach(function (x) { x.addEventListener('click', function () {
      var active = b.debts.filter(function (d) { return d.balance !== 0; }).map(function (d) { return d.name; }), i = Number(x.getAttribute('data-di')), j = i + Number(x.getAttribute('data-dmove'));
      if (j < 0 || j >= active.length) return;
      var t = active[i]; active[i] = active[j]; active[j] = t;
      budgetSend('set_debt_order', { order: active }, 'the order of your debts'); paintCurrent();
    }); });
    var rs = v.querySelector('[data-dreset]'); if (rs) rs.addEventListener('click', function () { budgetSend('set_debt_order', { order: [] }, 'the order of your debts'); paintCurrent(); });
    var lo = v.querySelector('[data-last-on]'); if (lo) lo.addEventListener('click', function () { budgetSend('set_budget_settings', { lastMonth: true }, 'the last month setting'); banner('Saved'); paintCurrent(); });
  }
  /** A category chosen from the list of everyday categories. */
  function pickCategory(title, onPick) {
    ensureCats().then(function () {
      openPicker({ held: false, selected: '', title: title, noNew: true, onPick: function (name) { onPick(name); } });
    });
  }

  /* ----- one category: Left, target, Four Walls, move money, what was spent ----- */
  var cs = { name: '' };
  function lineFor(b, name) {
    var hit = b.categories.filter(function (l) { return l.name === name; })[0];
    return hit || { name: name, step: 4, target: 0, funded: 0, carryIn: 0, moved: 0, spent: 0, left: 0, dueDay: null, weekend: '', walls: !!(b.walls && b.walls[name]) };
  }
  function openCat(name) { cs.name = name; paintCat(true); $('catSheet').hidden = false; $('catSheet').scrollTop = 0; }
  function closeCat() { $('catSheet').hidden = true; }
  function paintCat(fresh) {
    var bc = budgetData(); if (!bc) return;
    var b = bc.d, l = lineFor(b, cs.name), owner = state.role === 'owner', body = $('catSheetBody');
    $('catSheetTitle').textContent = cs.name;
    var keepT = !fresh && $('csTarget') ? $('csTarget').value : null, keepD = !fresh && $('csDue') ? $('csDue').value : null, keepW = !fresh && $('csWeekend') ? $('csWeekend').value : null;
    var html = '<div class="te-amt" style="' + (l.left < 0 ? 'color:var(--warn)' : '') + '">' + rp(l.left) + '</div><div class="te-sub">Left in ' + monthWord(b.month) + (l.step === 1 ? ' · Four Walls' : l.step === 2 ? ' · bill' : '') + '</div>';
    html += '<div class="card"><div class="kv"><span>Carried in from last month</span><b>' + rp(l.carryIn) + '</b></div><div class="kv"><span>Funded this month' + (l.target ? ' (target ' + rpShort(l.target) + ')' : '') + '</span><b>' + rp(l.funded) + '</b></div>' +
      '<div class="kv"><span>Moved in or out</span><b>' + signed(l.moved) + '</b></div><div class="kv"><span>Spent</span><b>' + rp(l.spent) + '</b></div>' +
      (l.legacy ? '<p class="note">This target came from your old Plan. Save it here to make it a budget target.</p>' : '') + '</div>';
    html += '<div class="fields"><div class="field"><label for="csTarget">Monthly target (Rp)</label><input id="csTarget" inputmode="numeric" autocomplete="off" placeholder="0" value="' + (keepT !== null ? esc(keepT) : (l.target ? Number(l.target).toLocaleString('id-ID') : '')) + '"></div>' +
      '<div class="field"><label for="csDue">Due day of the month (optional, makes it a bill)</label><input id="csDue" inputmode="numeric" autocomplete="off" placeholder="For example, 1" value="' + (keepD !== null ? esc(keepD) : (l.dueDay ? l.dueDay : '')) + '"></div>' +
      '<div class="field"><label for="csWeekend">If the due day is a weekend</label><select id="csWeekend"><option value="">Leave the date</option><option value="before">Pay on the Friday before</option><option value="after">Pay on the Monday after</option></select></div>' +
      '<div class="field"><label class="chk"><input type="checkbox" id="csWalls"' + (l.walls ? ' checked' : '') + '> Four Walls (essential, funded first)</label></div></div>';
    html += '<p id="csMsg" class="err" role="alert"></p><button id="csSave" class="primary">Save target</button><button id="csMove" class="ghost" style="margin-top:10px">Move money</button>' +
      (l.target > 0 ? '<button id="csRemove" class="ghost dangerbtn" style="margin-top:10px">Remove the target</button>' : '');
    var tx = recentTxns().filter(function (t) { return t.category === cs.name && String(t.date).slice(0, 7) === b.month; }).sort(function (x, y) { return String(y.timestamp).localeCompare(String(x.timestamp)); });
    html += '<div class="card" style="gap:0;margin-top:16px"><div class="cardhead"><div class="label">Spent in ' + monthWord(b.month) + '</div><span class="note">' + tx.length + ' entr' + (tx.length === 1 ? 'y' : 'ies') + '</span></div>';
    if (!tx.length) html += '<p class="note" style="padding-top:8px">Nothing spent here this month.</p>';
    tx.slice(0, 30).forEach(function (t) { html += '<button class="txr" data-tx="' + esc(t.id) + '"><span><b style="font-weight:600;font-size:14.5px">' + esc(t.payee || '(no name)') + '</b><span class="s">' + dayLabel(t.date) + ' · ' + esc(t.account || 'No account') + '</span></span><span style="white-space:nowrap">' + rp(t.amount || 0) + '</span></button>'; });
    html += '<button class="addrow" data-allact>See all in Activity</button></div>';
    body.innerHTML = html;
    $('csWeekend').value = keepW !== null ? keepW : (l.weekend || '');
    $('csTarget').addEventListener('input', function () { fmtEl($('csTarget')); });
    $('csSave').addEventListener('click', function () {
      var args = { category: cs.name, amount: numOf($('csTarget')), dueDay: $('csDue').value.trim() === '' ? '' : digits('csDue'), weekend: $('csDue').value.trim() === '' ? '' : $('csWeekend').value };
      if (!budgetSend('set_target', args, 'the target for ' + cs.name, function (m) { $('csMsg').textContent = m; })) return;
      banner('Saved'); paintCat(true); paintCurrent();
    });
    $('csWalls').addEventListener('change', function () { budgetSend('set_four_walls', { category: cs.name, on: $('csWalls').checked }, 'Four Walls for ' + cs.name); banner('Saved'); paintCat(); paintCurrent(); });
    $('csMove').addEventListener('click', function () { openMove(cs.name); });
    var rm = $('csRemove'); if (rm) rm.addEventListener('click', function () {
      confirmBox('Remove the target for ' + cs.name + '? What is left in it stays there.', 'Remove', function () { budgetSend('set_target', { category: cs.name, amount: 0 }, 'removing the target for ' + cs.name); banner('Removed'); paintCat(true); paintCurrent(); }, true);
    });
    body.querySelectorAll('[data-tx]').forEach(function (x) { x.addEventListener('click', function () { openTxnEdit(x.getAttribute('data-tx')); }); });
    body.querySelector('[data-allact]').addEventListener('click', function () { closeCat(); state.actCat = cs.name; state.actFilter = 'All'; state.actQ = ''; state.actSearchOn = false; go('activity'); });
  }
  $('csBack').addEventListener('click', closeCat);

  /* ----- move money between categories ----- */
  var mv = { from: '', to: '' };
  function openMove(from) { mv = { from: from || '', to: '' }; paintMove(); $('moveSheet').hidden = false; $('moveSheet').scrollTop = 0; }
  function paintMove() {
    var bc = budgetData(); if (!bc) return;
    var b = bc.d, fl = mv.from ? lineFor(b, mv.from) : null, keepA = $('mvAmount') ? $('mvAmount').value : '', keepM = $('mvMemo') ? $('mvMemo').value : '';
    $('moveSheetBody').innerHTML = '<div class="fields"><button id="mvFrom" class="field fbtn" type="button"><span class="fl">From</span><span class="fv' + (mv.from ? '' : ' empty') + '">' + esc(mv.from || 'Choose') + '</span><span class="chev" aria-hidden="true">›</span></button>' +
      '<button id="mvTo" class="field fbtn" type="button"><span class="fl">To</span><span class="fv' + (mv.to ? '' : ' empty') + '">' + esc(mv.to || 'Choose') + '</span><span class="chev" aria-hidden="true">›</span></button>' +
      '<div class="field"><label for="mvAmount">Amount (Rp)</label><input id="mvAmount" inputmode="numeric" autocomplete="off" placeholder="0" value="' + esc(keepA) + '"></div>' +
      '<div class="field"><label for="mvMemo">Memo (optional)</label><input id="mvMemo" autocomplete="off" value="' + esc(keepM) + '"></div></div>' +
      (fl ? '<p class="note" style="margin:10px 4px 0">' + esc(mv.from) + ' has ' + rp(fl.left) + ' left.</p>' : '') +
      '<p id="mvMsg" class="err" role="alert"></p><button id="mvSave" class="primary">Move the money</button><p class="note" style="margin:10px 4px 0">Nothing is deleted. The move is kept as its own line in your history.</p>';
    function chooseCat(which) { pickCategory(which === 'from' ? 'Move from' : 'Move to', function (name) { mv[which] = name; paintMove(); }); }
    $('mvFrom').addEventListener('click', function () { chooseCat('from'); });
    $('mvTo').addEventListener('click', function () { chooseCat('to'); });
    $('mvAmount').addEventListener('input', function () { fmtEl($('mvAmount')); });
    $('mvSave').addEventListener('click', function () {
      var args = { id: 'mv_' + newId().slice(2) + Math.random().toString(16).slice(2, 6), from: mv.from, to: mv.to, amount: numOf($('mvAmount')), memo: $('mvMemo').value.trim(), date: localIso().slice(0, 10) };
      if (!budgetSend('move_money', args, 'moving money from ' + mv.from + ' to ' + mv.to, function (m) { $('mvMsg').textContent = m; })) return;
      $('moveSheet').hidden = true; banner('Moved ' + rp(args.amount)); paintCat(); paintCurrent();
    });
  }
  $('mvBack').addEventListener('click', function () { $('moveSheet').hidden = true; });

  /* ----- Plan next month: the monthly review ----- */
  var pn = { rows: [], view: null };
  function openPlanNext() {
    var v = E.view('planNext', localIso().slice(0, 10));
    pn.view = v;
    pn.rows = v.rows.map(function (r) {
      var start = r.nextTarget || r.lastTarget || 0;
      return { category: r.category, group: r.group, lastTarget: r.lastTarget, spent: r.spent, suggested: r.suggested, budgeted: r.budgeted, value: r.budgeted ? start : 0, orig: r.nextTarget || 0, dueDay: r.dueDay, weekend: r.weekend, walls: r.walls, wallsOrig: r.walls };
    });
    paintPlanNext(); $('planNext').hidden = false; $('planNext').scrollTop = 0;
  }
  function pnTotal() { return pn.rows.reduce(function (s, r) { return s + (r.value || 0); }, 0); }
  function pnRow(r, i) {
    return '<div class="planrow" data-pi="' + i + '"><div class="nm"><span class="p">' + esc(r.category) + '</span><span class="sub">' + esc(r.group) + '</span></div>' +
      '<div class="hist">' + monthWord(pn.view.month) + ': target ' + (r.lastTarget ? rpShort(r.lastTarget) : 'none') + ' · spent ' + rpShort(r.spent) + (r.dueDay ? ' · due on the ' + r.dueDay + '.' : '') + '</div>' +
      '<div class="inl"><input data-pv="' + i + '" inputmode="numeric" autocomplete="off" placeholder="0" aria-label="Target for ' + esc(r.category) + '" value="' + (r.value ? Number(r.value).toLocaleString('id-ID') : '') + '">' +
      (r.suggested ? '<button class="sugbtn" data-ps="' + i + '" type="button">Use ' + rpShort(r.suggested) + '</button>' : '') + '</div>' +
      '<label class="chk"><input type="checkbox" data-pw="' + i + '"' + (r.walls ? ' checked' : '') + '> Four Walls</label></div>';
  }
  function paintPlanNext() {
    var nm = monthWord(pn.view.nextMonth), budgeted = pn.rows.map(function (r, i) { return { r: r, i: i }; });
    var yes = budgeted.filter(function (x) { return x.r.budgeted; }), no = budgeted.filter(function (x) { return !x.r.budgeted; });
    $('planNextTitle').textContent = 'Plan ' + nm;
    var html = '<div class="card"><div class="sumbar"><div class="label">Planned for ' + nm + '</div><span class="note">3 month average is the suggestion</span></div>' + '<div class="big" style="margin-top:2px"><span class="rp">Rp</span><span class="n" id="pnTotal" style="font-size:40px">' + Math.round(pnTotal()).toLocaleString('id-ID') + '</span></div>' +
      '<p class="note">' + (pn.view.reviewed ? nm + ' was already planned. Saving again replaces those targets. ' : '') + 'Change any number, then Save. A target of 0 removes the category from the plan.</p></div>';
    html += '<div class="card" style="gap:0"><div class="cardhead"><div class="label">In your plan</div></div>' + (yes.length ? yes.map(function (x) { return pnRow(x.r, x.i); }).join('') : '<p class="note" style="padding-top:8px">No targets yet. Use the suggestions below to start.</p>') + '</div>';
    if (no.length) html += '<div class="card" style="gap:0"><div class="cardhead"><div class="label">Spent on recently, no target</div></div>' + no.map(function (x) { return pnRow(x.r, x.i); }).join('') + '</div>';
    html += '<button class="ghost" id="pnAdd" type="button">+ Add another category</button><p id="pnMsg" class="err" role="alert"></p><button id="pnSave" class="primary stick">Save the plan for ' + nm + '</button>';
    $('planNextBody').innerHTML = html;
    var root = $('planNextBody');
    root.querySelectorAll('[data-pv]').forEach(function (inp) { inp.addEventListener('input', function () { fmtEl(inp); pn.rows[Number(inp.getAttribute('data-pv'))].value = numOf(inp); $('pnTotal').textContent = Math.round(pnTotal()).toLocaleString('id-ID'); }); });
    root.querySelectorAll('[data-ps]').forEach(function (b) { b.addEventListener('click', function () { var i = Number(b.getAttribute('data-ps')); pn.rows[i].value = pn.rows[i].suggested; paintPlanNext(); }); });
    root.querySelectorAll('[data-pw]').forEach(function (c) { c.addEventListener('change', function () { pn.rows[Number(c.getAttribute('data-pw'))].walls = c.checked; }); });
    $('pnAdd').addEventListener('click', function () {
      pickCategory('Add a category', function (name) {
        var ex = pn.rows.filter(function (r) { return r.category === name; })[0];
        if (!ex) pn.rows.push({ category: name, group: groupFor(name) || '', lastTarget: 0, spent: 0, suggested: 0, budgeted: true, value: 0, orig: 0, dueDay: null, weekend: '', walls: false, wallsOrig: false });
        else ex.budgeted = true;
        paintPlanNext();
      });
    });
    $('pnSave').addEventListener('click', function () {
      var items = [];
      pn.rows.forEach(function (r) {
        if (!r.value && !r.orig && !r.budgeted) return;
        if (!r.value && !r.orig && !r.lastTarget) return;
        var it = { category: r.category, amount: r.value || 0, dueDay: r.dueDay === null || r.dueDay === undefined ? '' : r.dueDay, weekend: r.weekend || '' };
        if (r.walls !== r.wallsOrig) it.walls = r.walls;
        items.push(it);
      });
      if (!budgetSend('plan_next_month', { items: items }, 'the plan for ' + nm, function (m) { $('pnMsg').textContent = m; })) return;
      $('planNext').hidden = true; banner('Saved the plan for ' + nm); paintCurrent();
    });
  }
  $('pnBack').addEventListener('click', function () { $('planNext').hidden = true; });

  /* ----- budget settings ----- */
  function openSettings() { paintSettings(); $('budSettings').hidden = false; $('budSettings').scrollTop = 0; }
  function paintSettings() {
    var bc = budgetData(); if (!bc) return;
    var b = bc.d, st = b.settings, root = $('budSettingsBody');
    var html = '<div class="card" style="gap:0"><div class="cardhead"><div class="label">Emergency fund</div></div>' +
      '<button class="prow2" data-set="starter"><span class="l"><span class="p">Starter fund target</span><span class="s">Step 5. Topped up before any debt is paid.</span></span><span class="r">' + (st.starter_target ? rp(st.starter_target) : '<span class="muted">Not set</span>') + '</span></button>' +
      '<button class="prow2" data-set="full"><span class="l"><span class="p">Full emergency fund</span><span class="s">3 to 6 months of costs. Built once your debts are gone.</span></span><span class="r">' + (st.full_target ? rp(st.full_target) : '<span class="muted">Not set</span>') + '</span></button>' +
      '<button class="prow2" data-set="buffer"><span class="l"><span class="p">Buffer account</span><span class="s">The account that holds the emergency fund.</span></span><span class="r">' + (st.buffer_account ? esc(st.buffer_account) : '<span class="muted">Not set</span>') + '</span></button></div>';
    html += '<div class="card"><label class="chk"><input type="checkbox" id="bsLast"' + (st.last_month ? ' checked' : '') + '> Use last month\'s income for this month</label>' +
      '<p class="note">Each income then funds the month after it, so you always spend money you already have. Turn it on once next month is 100% covered.' + (b.nextCovered.pct !== null ? ' Next month is ' + b.nextCovered.pct + '% covered now.' : '') + '</p></div>';
    var walls = b.categories.slice();
    html += '<div class="card" style="gap:0"><div class="cardhead"><div class="label">Four Walls</div></div><p class="stephelp">The essentials that are funded first: food at home, utilities, housing and transport.</p>';
    if (!walls.length) html += '<p class="note">Set a target on a category first.</p>';
    walls.forEach(function (l, i) { html += '<div class="planrow" style="padding:8px 0"><label class="chk" style="margin:0"><input type="checkbox" data-wall="' + esc(l.name) + '"' + (l.walls ? ' checked' : '') + '> ' + esc(l.name) + '</label></div>'; });
    html += '</div>';
    root.innerHTML = html;
    function numDialog(title, body, key, label) {
      dialog({ title: title, body: body, input: { numeric: true, placeholder: 'Rp, or 0 for none', value: st[key] ? Number(st[key]).toLocaleString('id-ID') : '' }, actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, fn: function (val, say) {
        var args = {}; args[key === 'starter_target' ? 'starterTarget' : 'fullTarget'] = val === '' ? 0 : Number(String(val).replace(/[^\d]/g, ''));
        if (!budgetSend('set_budget_settings', args, label, say)) return false;
        setTimeout(function () { paintSettings(); paintCurrent(); }, 0);
      } }] });
    }
    root.querySelector('[data-set="starter"]').addEventListener('click', function () { numDialog('Starter emergency fund', 'How much should the buffer account hold before you start paying off debts?', 'starter_target', 'the starter fund'); });
    root.querySelector('[data-set="full"]').addEventListener('click', function () { numDialog('Full emergency fund', 'Three to six months of costs. It is built after your last debt is paid.', 'full_target', 'the full emergency fund'); });
    root.querySelector('[data-set="buffer"]').addEventListener('click', function () {
      var banks = E.accountList().filter(function (a) { return C_kind(a) === 'bank' && a.entity !== 'PT'; }).map(function (a) { return { name: a.account, value: a.account }; });
      openPicker({ items: [{ name: 'None', value: '' }].concat(banks), selected: st.buffer_account, title: 'Buffer account', onPick: function (val) {
        budgetSend('set_budget_settings', { bufferAccount: val }, 'the buffer account'); setTimeout(function () { paintSettings(); paintCurrent(); }, 0);
      } });
    });
    $('bsLast').addEventListener('change', function () {
      var on = $('bsLast').checked;
      function go2() { budgetSend('set_budget_settings', { lastMonth: on }, 'the last month setting'); banner('Saved'); setTimeout(function () { paintSettings(); paintCurrent(); }, 0); }
      if (on && b.nextCovered.pct !== null && b.nextCovered.pct < 100) {
        $('bsLast').checked = false;
        confirmBox('Next month is only ' + b.nextCovered.pct + '% covered. If you turn this on now, income that arrives this month will stop filling this month\'s plan.', 'Turn it on', go2);
      } else go2();
    });
    root.querySelectorAll('[data-wall]').forEach(function (c) { c.addEventListener('change', function () { budgetSend('set_four_walls', { category: c.getAttribute('data-wall'), on: c.checked }, 'Four Walls for ' + c.getAttribute('data-wall')); paintCurrent(); }); });
  }
  function C_kind(a) { return window.HanaroCore.kindOf_(a); }
  $('bsBack').addEventListener('click', function () { $('budSettings').hidden = true; });
  /** After any change, the open sheets follow the phone's own copy. */
  function repaintOverlays() {
    if (!$('catSheet').hidden) paintCat();
    if (!$('budSettings').hidden) paintSettings();
  }


  /* ---------- Spending report: where the money went this month ---------- */
  function monthChip(ym) { return MON[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(2, 4); }
  function dayBars(series, today) {
    var n = series.length, mx = Math.max.apply(null, series.concat([1])), w = 300, h = 64, bw = w / n, out = '';
    series.forEach(function (y, i) {
      var bh = y ? Math.max(2, y / mx * (h - 6)) : 1, isT = today && i + 1 === today;
      out += '<rect x="' + (i * bw + 1).toFixed(1) + '" y="' + (h - bh).toFixed(1) + '" width="' + Math.max(1, bw - 2).toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="1.5" fill="' + (isT ? '#F28DB0' : y ? '#13867C' : '#DCEBE8') + '"/>';
    });
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="64" preserveAspectRatio="none" role="img" aria-label="Spending for each day of the month">' + out + '</svg><div class="axis"><span>1</span><span>' + Math.round(n / 2) + '</span><span>' + n + '</span></div>';
  }
  function paintReport(v, d) {
    var isNow = d.month === localIso().slice(0, 7), todayN = isNow ? Number(localIso().slice(8, 10)) : 0;
    var html = '<div style="' + TITLE + '">Spending</div>';
    var bud = budgetData(), budNames = {};
    if (bud) bud.d.categories.forEach(function (l) { budNames[l.name] = true; });
    html += '<div class="chips" id="mchips">' + d.months.slice(0, 14).map(function (m) { return '<button class="chip' + (m === d.month ? ' on' : '') + '" data-month="' + m + '">' + monthChip(m) + '</button>'; }).join('') + '</div>';
    var b = bigParts(d.total);
    html += '<div class="card"><div class="label">Spent in ' + PM[d.month.slice(5, 7)] + '</div><div class="big"><span class="rp">Rp</span><span class="n">' + esc(b.n) + '</span><span class="z">' + esc(b.z) + '</span></div>';
    if (!d.empty) {
      html += '<div class="note">About ' + rp(d.avgPerDay) + ' a day.' + (d.fromArchive ? ' From your YNAB history.' : '') + '</div>';
      if (d.hasPrev) html += '<div style="font-size:14px;font-weight:600;margin-top:4px">' + PM[d.prevMonth.slice(5, 7)] + ' in total: ' + rpShort(d.prevTotal) + '</div>';
      if (!d.fromArchive)  html += '<div class="rule"></div>' + dayBars(d.series, todayN);
    }
    html += '</div>';
    if (d.empty) html += '<div class="card empty">Nothing spent in ' + PM[d.month.slice(5, 7)] + ' yet.</div>';
    d.groups.forEach(function (g) {
      html += '<div class="card" style="gap:2px"><div class="cardhead"><div class="label">' + esc(g.group) + '</div><span class="note"><b>' + rpShort(g.amount) + '</b> · ' + (d.total ? Math.round(g.amount / d.total * 100) : 0) + '%</span></div>';
      g.categories.forEach(function (c) {
        html += '<div class="crw"><button class="crow" data-cat="' + esc(c.category) + '"><span class="cn"><span class="p">' + esc(c.category) + '</span><span class="s">' + (c.count ? c.count + ' purchase' + (c.count === 1 ? '' : 's') : '') + '</span></span><span class="cv">' + rp(c.amount) + '<span class="cbar"><span style="width:' + Math.max(2, d.total ? Math.round(c.amount / d.total * 100) : 0) + '%"></span></span></span></button>' +
          (budNames[c.category] ? '<button class="blink" data-budcat="' + esc(c.category) + '" aria-label="Open ' + esc(c.category) + ' in Budget">Budget ›</button>' : '') + '</div>';
      });
      html += '</div>';
    });
    if (d.other && d.other.length) {
      html += '<div class="card"><div class="label">Not counted as everyday spending</div>' + d.other.map(function (o) { return '<div class="kv"><span>' + esc(o.group) + '</span><span>' + rp(o.amount) + '</span></div>'; }).join('') + '<p class="note">Debt payments, income and buffer groups are kept apart so the total above is what the family spent.</p></div>';
    }
    if (d.biggest && d.biggest.length > 1) {
      html += '<div class="card"><div class="label">Biggest purchases</div>' + d.biggest.map(function (t) { return '<div class="kv"><span>' + esc(t.payee || '(no name)') + '<div class="sub">' + dayLabel(t.date) + ' · ' + esc(t.category || 'No category') + '</div></span><span>' + rp(t.amount) + '</span></div>'; }).join('') + '</div>';
    }
    v.innerHTML = html;
    v.querySelectorAll('[data-budcat]').forEach(function (b) { b.addEventListener('click', function () { var n = b.getAttribute('data-budcat'); go('budget'); openCat(n); }); });
    v.querySelectorAll('[data-month]').forEach(function (b) { b.addEventListener('click', function () { state.spendMonth = b.getAttribute('data-month'); render(); }); });
    v.querySelectorAll('[data-cat]').forEach(function (b) { b.addEventListener('click', function () { state.actCat = b.getAttribute('data-cat'); state.actFilter = 'All'; state.actQ = ''; state.actSearchOn = false; go('activity'); }); });
    var act = v.querySelector('#mchips .on'); if (act && act.scrollIntoView) { try { act.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) {} }
  }

  /* ---------- Accounts: banks, cards, debts, net worth ---------- */
  function ageWord(days) { return days === null ? 'No balance yet' : days === 0 ? 'Confirmed today' : days === 1 ? 'Confirmed yesterday' : 'Confirmed ' + days + ' days ago'; }
  function signed(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + rp(Math.abs(n)); }
  function pendingTag(x) { return x.pending ? ' <span class="tag wait">' + x.pending + ' NOT AT BANK YET</span>' : ''; }
  var MONTHS3 = MON;
  function dueWord(iso) { return Number(iso.slice(8, 10)) + ' ' + MONTHS3[Number(iso.slice(5, 7)) - 1]; }
  /** Type what the account really shows. Hanaro keeps the time and how far it was from what it expected. */
  function confirmBalance(v, x, isCard) {
    var cur = isCard ? x.owed : x.tracked, today = localIso().slice(0, 10);
    dialog({ title: x.account, body: isCard ? 'How much does the card show as owed right now?' : 'What does this account show right now?' + (cur !== null ? ' Hanaro expects ' + rp(cur) + '.' : ''),
      input: { numeric: true, placeholder: 'Rp', value: cur !== null ? Number(cur).toLocaleString('id-ID') : '' }, actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, fn: function (val, say) {
        var amt = Number(String(val).replace(/[^\d]/g, '')); if (val === '' || isNaN(amt)) { say('Type the balance as a number.'); return false; }
        var exp = E.trackedNow(x.account, today);
        send('set_balance', { account: x.account, amount: amt, tracked: exp === null ? '' : exp }, 'the balance of ' + x.account).then(afterWrite);
        var diff = exp === null ? 0 : amt - exp;
        banner(diff ? 'Saved. This is ' + rp(Math.abs(diff)) + (diff > 0 ? ' more' : ' less') + (isCard ? ' owed' : '') + ' than Hanaro expected, so an entry may be missing.' : 'Saved. It matches what Hanaro expected.', !!diff && Math.abs(diff) > 0, diff ? 7000 : 2500);
        render();
      } }] });
  }
  function setLimit(v, x) {
    dialog({ title: x.account, body: 'The credit limit of this card.', input: { numeric: true, placeholder: 'Rp', value: x.limit ? Number(x.limit).toLocaleString('id-ID') : '' }, actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, fn: function (val, say) {
      var amt = Number(String(val).replace(/[^\d]/g, '')); if (val === '' || isNaN(amt)) { say('Type the limit as a number.'); return false; }
      send('set_limit', { account: x.account, limit: amt }, 'the limit of ' + x.account).then(afterWrite); banner('Saved'); render();
    } }] });
  }
  /** Company cash, personal cash, debts in snowball order and net worth. Works with any server: it only needs the accounts. */
  function wealthCard() {
    var w = E.view('wealth', localIso().slice(0, 10));
    if (!w) return '';
    var html = '<div class="card wealth"><div class="label">Wealth</div>' + bigHtml(w.netWorth, w.netWorth < 0 ? 'neg' : '') + '<div class="note" style="margin-top:-2px">Net worth</div><div class="rule"></div>';
    if (!w.partner) html += '<div class="kv"><span>Company cash</span><b>' + rp(w.company) + '</b></div>';
    html += '<div class="kv"><span>Personal cash</span><b>' + rp(w.personal) + '</b></div>';
    if (w.held > 0) html += '<div class="kv"><span>Held for other people</span><b>−' + rp(w.held) + '</b></div>';
    if (!w.partner && w.companyOwed > 0) html += '<div class="kv"><span>Company debt</span><b>−' + rp(w.companyOwed) + '</b></div>';
    html += '<div class="kv"><span>Debts</span><b>−' + rp(w.owe) + '</b></div>';
    if (w.debts.length) {
      html += '<div class="rule"></div><div class="label" style="margin-bottom:2px">Debts, in the order you pay them</div>';
      w.debts.forEach(function (x, i) {
        html += '<div class="kv" style="padding:5px 0"><span>' + (i + 1) + '. ' + esc(x.name) + (x.name === w.focus ? ' <span class="tag focus">FOCUS</span>' : '') + (x.owed === 0 ? ' <span class="tag paid">PAID OFF</span>' : '') + '</span><span>' + (x.owed === null ? '<span class="muted">No balance</span>' : rp(x.owed)) + '</span></div>';
      });
    }
    if (w.unknown) html += '<p class="note" style="margin-top:6px;color:var(--warn)">' + w.unknown + ' account' + (w.unknown === 1 ? ' has' : 's have') + ' no confirmed figure yet, so net worth is not complete.</p>';
    return html + '</div>';
  }
  function paintAccounts(v, d) {
    var owner = state.role === 'owner';
    var html = '<div style="' + TITLE + '">Account</div>' + wealthCard();
    var nb = bigParts(d.cash);
    html += '<div class="card"><div class="label">In bank accounts</div><div class="big"><span class="rp">Rp</span><span class="n">' + esc(nb.n) + '</span><span class="z">' + esc(nb.z) + '</span></div>' +
      '<div class="rule"></div><div class="kv"><span>Owed on cards and loans</span><b>' + rp(d.owed) + '</b></div>' +
      (d.limit ? '<div class="kv"><span>Still available on cards</span><b>' + rp(d.available) + '</b></div>' : '') +
      (d.notes.length ? d.notes.map(function (n) { return '<p class="note" style="margin-top:6px;color:var(--warn)">' + esc(n) + '</p>'; }).join('') : '<p class="note" style="margin-top:6px">Each balance is the last one you confirmed plus everything entered since. Company (PT) accounts are not counted.</p>') + '</div>';
    if (d.uncleared.count) html += '<div class="card"><div class="label">Not seen at the bank yet</div><div class="kv"><span>' + d.uncleared.count + ' entr' + (d.uncleared.count === 1 ? 'y' : 'ies') + '</span><b>' + rp(d.uncleared.amount) + '</b></div><p class="note">The bank email clears an entry. ' + (d.uncleared.old ? d.uncleared.old + ' ' + (d.uncleared.old === 1 ? 'is' : 'are') + ' more than a day old: check the amount and the account.' : 'Nothing is old yet.') + '</p></div>';
    html += '<div class="card" style="gap:0"><div class="cardhead"><div class="label">Bank accounts</div></div>';
    d.banks.forEach(function (b, i) {
      var old = b.ageDays !== null && b.ageDays >= 7;
      html += '<button class="prow2" data-bank="' + i + '"' + (owner ? '' : ' disabled') + '><span class="l"><span class="p">' + esc(b.account) + (b.entity === 'PT' ? ' <span class="tag gray">PT AHU</span>' : '') + pendingTag(b) + '</span>' +
        '<span class="s' + (old || b.confirmed === null ? ' warnt' : '') + '">' + (b.confirmed === null ? 'No balance yet. Tap to set it.' : ageWord(b.ageDays) + (b.moved ? ' · ' + signed(b.moved) + ' since' : '') + (old ? ' · check it' : '')) + '</span></span>' +
        '<span class="r">' + (b.tracked === null ? '<span class="muted">Set</span>' : rp(b.tracked)) + '</span></button>';
    });
    if (!d.banks.length) html += '<p class="note" style="padding:10px 0 0">No bank accounts yet.</p>';
    if (owner && d.banks.length) html += '<p class="note" style="padding-top:8px">Tap an account to confirm what it shows today. Do it now and then so Hanaro stays right.</p>';
    html += '</div>';
    if (d.cards.length) {
      html += '<div class="card" style="gap:0"><div class="cardhead"><div class="label">Credit cards</div><span class="note">' + rpShort(d.owed) + ' owed</span></div>';
      d.cards.forEach(function (c, i) {
        var cls = c.util === null ? '' : c.util >= 100 ? ' max' : c.util >= 80 ? ' hi' : '';
        html += '<button class="prow2" data-card="' + i + '"' + (owner ? '' : ' disabled') + ' style="align-items:flex-start;flex-wrap:wrap"><span class="l" style="flex:1 1 60%"><span class="p">' + esc(c.account) + pendingTag(c) + '</span>' +
          '<span class="s">' + (c.owed === null ? 'No balance yet. Tap to set what is owed.' : c.limit ? rpShort(c.available) + ' available of ' + rpShort(c.limit) + ' · ' + c.util + '% used' : 'No limit set') + (c.due ? ' · due ' + dueWord(c.due) : '') + '</span>' +
          (c.unpaidCount ? '<span class="s warnt">' + c.unpaidCount + ' charge' + (c.unpaidCount === 1 ? '' : 's') + ' to pay: ' + rp(c.unpaidTotal) + '</span>' : '') + '</span>' +
          '<span class="r">' + (c.owed === null ? '<span class="muted">Set</span>' : rp(c.owed)) + '</span>' +
          (c.limit && c.owed !== null ? '<span class="meter' + cls + '" style="flex:1 1 100%"><span style="width:' + Math.min(100, Math.max(1, c.util)) + '%"></span></span>' : '') + '</button>';
      });
      if (owner) html += '<p class="note" style="padding-top:8px">Tap a card to confirm what is owed or set its limit.</p>';
      html += '</div>';
    }
    if (d.loans.length) {
      html += '<div class="card" style="gap:0"><div class="cardhead"><div class="label">Loans</div></div>';
      d.loans.forEach(function (x, i) {
        html += '<button class="prow2" data-loan="' + i + '"' + (owner ? '' : ' disabled') + '><span class="l"><span class="p">' + esc(x.account) + '</span><span class="s">' + (x.confirmed === null ? 'No balance yet' : ageWord(x.ageDays)) + '</span></span><span class="r">' + (x.owed === null ? '<span class="muted">Set</span>' : rp(x.owed)) + '</span></button>';
      });
      html += '</div>';
    }
    html += '<div id="health"></div>';
    html += '<div class="card"><div class="label">Places and payees</div><p class="note">See where you spend and set the default category for each place.</p><button class="ghost small" id="openPlaces">Open places</button></div>';
    html += '<div class="card"><div class="label">This device</div><p class="note">The link and key are stored on this device only.</p><button class="link" id="signOut">Disconnect this device</button><p class="tiny muted" style="margin-top:6px">' + esc(diagLine()) + '</p></div>';
    v.innerHTML = html;
    v.querySelectorAll('[data-bank]').forEach(function (b) { b.addEventListener('click', function () { confirmBalance(v, d.banks[Number(b.getAttribute('data-bank'))], false); }); });
    v.querySelectorAll('[data-loan]').forEach(function (b) { b.addEventListener('click', function () { confirmBalance(v, d.loans[Number(b.getAttribute('data-loan'))], true); }); });
    v.querySelectorAll('[data-card]').forEach(function (b) { b.addEventListener('click', function () {
      var x = d.cards[Number(b.getAttribute('data-card'))];
      dialog({ title: x.account, body: 'What do you want to do?', actions: [{ label: 'Cancel' }, { label: 'Set limit', fn: function () { setTimeout(function () { setLimit(v, x); }, 0); } }, { label: 'Confirm owed', primary: true, fn: function () { setTimeout(function () { confirmBalance(v, x, true); }, 0); } }] });
    }); });
    $('openPlaces').addEventListener('click', function () { go('payees'); });
    $('signOut').addEventListener('click', disconnect);
    loadHealth();
  }
  /** One quiet line of timings, so a slow screen can be told apart from a slow connection. */
  function diagLine() { return 'Opened in ' + (state.openMs || '?') + ' ms · last sync ' + (state.syncMs || '?') + ' ms · ' + E.count() + ' entries on this phone'; }
  function disconnect() {
    confirmBox('Disconnect this device from Hanaro? Changes still waiting to be sent will be lost.', 'Disconnect', function () {
      ['key', 'url', 'queue', 'lastsync'].forEach(function (k) { LS.del('hanaro.' + k); });
      ['status', 'payees'].forEach(function (k) { LS.del('hanaro.cache.' + k); });
      E.clear().then(function () { location.reload(); });
    }, true);
  }
  /** Email sync and backup, from the same Status request as before, shown at the bottom of Accounts. */
  function loadHealth() {
    function paintH(s) {
      var el = $('health'); if (!el) return;
      LS.set('hanaro.lastsync', s.lastSync || ''); setPill(s.lastSync);
      var stale = !s.lastSync || (Date.now() - Date.parse(s.lastSync)) > 2 * 3600 * 1000;
      el.innerHTML = '<div class="card"><div class="label">Bank emails</div><div class="kv"><span><span class="dot' + (stale ? ' bad' : '') + '"></span>' + (s.lastSync ? 'Last read ' + esc(ago(s.lastSync)) : 'No emails read yet') + '</span></div>' +
        (s.lastSyncError ? '<p class="note" style="color:var(--warn)">Last error: ' + esc(s.lastSyncError) + '</p>' : '') +
        '<div class="kv"><span>Emails Hanaro could not read</span><b>' + s.unreadable + '</b></div><div class="kv"><span>Last backup</span><span>' + esc(s.lastBackup ? ago(s.lastBackup) : 'none yet') + '</span></div>' +
        (s.senders && s.senders.length ? '<div class="rule"></div>' + s.senders.map(function (x) { return '<div class="kv"><span>' + esc(x.sender) + '</span><span class="muted">' + esc(ago(x.last)) + '</span></div>'; }).join('') : '') + '</div>';
    }
    var c = snap('status'); if (c) paintH(c.d);
    api('status').then(function (s) { save('status', s); paintH(s); }, function () {});
  }

  /* ---------- categories ---------- */
  function ensureCats() {
    if (state.cats) return Promise.resolve();
    var c = snap('categories'); if (c) { useCats(c.d); return Promise.resolve(); }
    return refresh().then(function () {});
  }
  function opt(c, sel, withBucket) {
    return '<option value="' + esc(c.category) + '"' + (c.category === sel ? ' selected' : '') + '>' + esc(c.category) + (withBucket && c.bucket ? ' · ' + esc(c.bucket) : '') + '</option>';
  }
  /** mode: 'spend' = my own spending, 'held' = money held for others, otherwise both (Review). */
  function catOptions(sel, mode) {
    var all = state.cats || [], mine = all.filter(function (c) { return !c.held && c.category !== 'Income'; }), held = all.filter(function (c) { return c.held; });
    var head = '<option value="">' + (mode === 'held' ? 'What kind of money is it' : 'Choose a category') + '</option>';
    if (mode === 'spend') return head + mine.map(function (c) { return opt(c, sel, true); }).join('');
    if (mode === 'held') return head + held.map(function (c) { return opt(c, sel, false); }).join('') + '<option value="__new">+ Add a new kind…</option>';
    return head + mine.map(function (c) { return opt(c, sel, true); }).join('') + (held.length ? '<optgroup label="Held for others (not my money)">' + held.map(function (c) { return opt(c, sel, false); }).join('') + '</optgroup>' : '');
  }

  /* ---------- Review ---------- */
  var KIND = { pay_now: ['Pay now', 'pay'], confirm: ['New', 'new'], duplicate: ['Possible duplicate', 'dup'], unread: ['Could not read', 'unread'] };
  /** Category button for Review cards. Opens the same picker as the Add screen. */
  function catBtn(sel, attrs) {
    return '<button type="button" class="fbtn cbtn" data-pickbtn data-val="' + esc(sel || '') + '"' + (attrs || '') + '><span class="fv' + (sel ? '' : ' empty') + '">' + (sel ? esc(sel.replace(/^Held:\s*/, 'Held: ')) : 'Choose a category') + '</span><span class="chev" aria-hidden="true">›</span></button>';
  }
  function wirePickBtns(root) {
    root.querySelectorAll('[data-pickbtn]').forEach(function (b) {
      b.addEventListener('click', function () {
        openPicker({ held: false, both: true, selected: b.getAttribute('data-val'), title: 'Category', noNew: true, payee: (function () { var pp = b.closest('.card').querySelector('.p'); return pp ? pp.textContent : ''; })(), onPick: function (name, group) {
          b.setAttribute('data-val', name); b.setAttribute('data-grp', group || groupFor(name) || '');
          var fv = b.querySelector('.fv'); fv.textContent = name; fv.className = 'fv';
          var er = b.closest('.card').querySelector('[data-err]'); if (er) er.textContent = '';
        } });
      });
    });
  }
  function repaintReview(v) { paintReview(v, snap('review').d); }
  function paintReview(v, data) {
    ensureCats().then(function () {
      var items = data.items.filter(function (i) { return !state.later[i.txn.id]; });
      state.counts.review = items.length; renderNav(); var n = { all: items.length };
      Object.keys(KIND).forEach(function (k) { n[k] = items.filter(function (i) { return i.kind === k; }).length; });
      var tabs = [['all', 'All'], ['pay_now', 'Pay now'], ['duplicate', 'Duplicates'], ['unread', 'Unread']];
      var html = '<div style="' + TITLE + '">Review</div><div class="chips">' +
        tabs.map(function (t) { return '<button class="chip' + (state.filter === t[0] ? ' on' : '') + '" data-f="' + t[0] + '">' + t[1] + ' ' + n[t[0]] + '</button>'; }).join('') + '</div>';
      var shown = items.filter(function (i) { return state.filter === 'all' || i.kind === state.filter; });
      if (!shown.length) html += '<div class="card empty">' + (items.length ? 'Nothing here.' : 'All clear. Nothing needs you right now.') + '</div>';
      // The newest transaction always comes first. Bulk helpers never push it down.
      var payNow = shown.filter(function (i) { return i.kind === 'pay_now'; });
      if (payNow.length >= 2 && state.filter === 'pay_now') html += '<div class="card"><span class="tag pay">PAY NOW</span><div class="item-top"><div class="p">' + payNow.length + ' card charges not paid yet</div><div class="a">' + rp(payNow.reduce(function (a, i) { return a + (i.txn.amount || 0); }, 0)) + '</div></div><div class="sub">If you already paid these in myBCA, clear them all at once.</div><div class="btnrow"><button class="primary small" data-bulk="paid">Mark all as paid</button></div></div>';
      var ready = shown.filter(function (i) { return i.kind === 'confirm' && i.txn.category; });
      var groups = {}, order = [];
      shown.forEach(function (i) {
        if (i.kind === 'confirm' && !i.txn.category && !state.notSame[i.txn.id]) { var k = payeeKey(i.txn.payee); if (k) { if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(i); } }
      });
      var grouped = {};
      order.forEach(function (k) { if (groups[k].length >= 2) grouped[k] = true; });
      // One timeline. A Same place card sits where its newest charge would be.
      var blocks = [];
      function ms(i) { var m = Date.parse(i.txn.timestamp); return isNaN(m) ? 0 : m; }
      order.forEach(function (k) { if (grouped[k]) blocks.push({ ms: Math.max.apply(null, groups[k].map(ms)), html: groupCard(k, groups[k]) }); });
      shown.forEach(function (i) {
        if (i.kind === 'confirm' && !i.txn.category && !state.notSame[i.txn.id] && grouped[payeeKey(i.txn.payee)]) return;
        blocks.push({ ms: ms(i), html: reviewCard(i) });
      });
      blocks.forEach(function (b, n) { b.n = n; });
      blocks.sort(function (a, b) { return b.ms - a.ms || a.n - b.n; });
      html += blocks.map(function (b) { return b.html; }).join('');
      if (ready.length >= 2) html += '<div class="card"><span class="tag new">READY</span><div class="item-top"><div class="p">' + ready.length + ' already have a category</div></div><div class="sub">Looks right? Confirm them all in one tap.</div><div class="btnrow"><button class="primary small" data-bulk="ready">Confirm ' + ready.length + '</button></div></div>';
      v.innerHTML = html;
      wirePickBtns(v);
      v.querySelectorAll('[data-notsame]').forEach(function (b) { b.addEventListener('click', function () { state.notSame[b.getAttribute('data-notsame')] = true; LS.set('hanaro.notsame', JSON.stringify(state.notSame)); repaintReview(v); }); });
      v.querySelectorAll('[data-bulk]').forEach(function (b) { b.addEventListener('click', function () { bulkAction(b, v, shown); }); });
      v.querySelectorAll('[data-group-go]').forEach(function (b) { b.addEventListener('click', function () { groupAction(b, v, groups); }); });
      v.querySelectorAll('[data-f]').forEach(function (b) { b.addEventListener('click', function () { state.filter = b.getAttribute('data-f'); repaintReview(v); }); });
      v.querySelectorAll('[data-act]').forEach(function (b) { b.addEventListener('click', function () { reviewAction(b, v); }); });
    });
  }
  function payeeKey(p) { return String(p || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40); }
  function groupCard(k, list) {
    var total = list.reduce(function (a, i) { return a + (i.txn.amount || 0); }, 0);
    var same = list.every(function (i) { return i.txn.amount === list[0].txn.amount; });
    var rowsHtml = list.map(function (i) {
      return '<div class="mrow"><span class="mt">' + esc(when(i.txn.timestamp)) + '<span class="ma">' + esc(i.txn.account) + '</span></span><span class="mv">' + rp(i.txn.amount || 0) + '</span><button type="button" class="ns" data-notsame="' + esc(i.txn.id) + '">Not here</button><span class="mk" aria-hidden="true">✓</span></div>';
    }).join('');
    return '<div class="card" data-group="' + esc(k) + '"><span class="tag new">SAME PLACE</span><div class="item-top"><div class="p">' + esc(list[0].txn.payee) + ' · ' + list.length + ' times</div><div class="a">' + rp(total) + '</div></div>' +
      '<div class="sub">' + (same ? 'Same amount each time.' : 'Different amounts.') + ' Check them, then pick one category for all. Hanaro remembers it for next time. Tap Not here on any charge that was somewhere else.</div>' +
      '<div class="mlist">' + rowsHtml + '</div>' +
      catBtn('', ' data-group-cat') + '<p class="err" data-err></p>' +
      '<div class="btnrow"><button class="primary small" data-group-go="' + esc(k) + '">Confirm all ' + list.length + '</button></div></div>';
  }
  /**
   * Makes a confirm feel real: the button turns into a green "Confirmed", the card flashes green,
   * then it slides out and the gap closes. Resolves when the last card is gone.
   */
  function playDone(cards) {
    var calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    return new Promise(function (resolve) {
      if (!cards.length) return resolve();
      var lastEnd = 0;
      cards.forEach(function (c, n) {
        var t0 = calm ? 0 : n * 80;
        setTimeout(function () {
          var b = c.querySelector('.btnrow .primary');
          if (b) { b.textContent = '✓ Confirmed'; b.classList.add('okbtn'); b.disabled = true; }
          c.classList.add('done');
          c.querySelectorAll('.mrow').forEach(function (r, j) { setTimeout(function () { r.classList.add('ok'); }, calm ? 0 : j * 110); });
        }, t0);
        setTimeout(function () {
          c.style.maxHeight = c.offsetHeight + 'px';
          void c.offsetHeight;
          c.classList.add('leaving'); c.style.maxHeight = '0px';
        }, t0 + (calm ? 200 : 900));
        lastEnd = Math.max(lastEnd, t0 + (calm ? 200 : 900) + (calm ? 50 : 480));
      });
      setTimeout(resolve, lastEnd);
    });
  }
  /** Removes items from the saved copy at once and queues one change per item. */
  function applyMany(items, makeCall, label, hold) {
    var ids = {}; items.forEach(function (i) { ids[i.txn.id] = i; });
    var paidAmt = 0, paidN = 0;
    if (label === 'paid') items.forEach(function (i) { paidN++; paidAmt += i.txn.amount || 0; });
    patch('review', function (d) { d.items = d.items.filter(function (i) { return !ids[i.txn.id]; }); });
    patch('home', function (h) {
      h.reviewCount = Math.max(0, h.reviewCount - items.length);
      if (label === 'paid') { h.toPayCount = Math.max(0, h.toPayCount - paidN); h.toPayTotal = Math.max(0, h.toPayTotal - paidAmt); }
    });
    items.forEach(function (i) { var c = makeCall(i); queue.push({ action: c.action, args: c.args, label: rp(i.txn.amount || 0) + ' ' + (i.txn.payee || '') }); });
    saveQueue(); banner('Saved ' + items.length);
    return flush().then(function (ok) { return (hold || Promise.resolve()).then(function () { afterWrite(ok); }); });
  }
  function bulkAction(btn, v, shown) {
    var kind = btn.getAttribute('data-bulk');
    if (kind === 'paid') {
      var list = shown.filter(function (i) { return i.kind === 'pay_now'; });
      confirmBox('Mark ' + list.length + ' card charges as paid? Only do this if you already paid them.', 'Mark as paid', function () {
        var hold1 = playDone([btn.closest('.card')]);
        applyMany(list, function (i) { return { action: 'mark_paid', args: { id: i.txn.id } }; }, 'paid', hold1);
        hold1.then(function () { repaintReview(v); });
      });
    } else {
      var ready = shown.filter(function (i) { return i.kind === 'confirm' && i.txn.category; });
      var ids = {}; ready.forEach(function (i) { ids[i.txn.id] = true; });
      var cards = [btn.closest('.card')].concat([].slice.call(v.querySelectorAll('.card[data-id]')).filter(function (c) { return ids[c.getAttribute('data-id')]; }));
      var hold2 = playDone(cards);
      applyMany(ready, function (i) { return { action: 'update_txn', args: { id: i.txn.id, changes: { category: i.txn.category, category_group: i.txn.group || groupFor(i.txn.category) || '' }, confirm: true } }; }, 'ready', hold2);
      hold2.then(function () { repaintReview(v); });
    }
  }
  function groupAction(btn, v, groups) {
    var card = btn.closest('.card'), cat = card.querySelector('[data-group-cat]').getAttribute('data-val'), err = card.querySelector('[data-err]');
    if (!cat) { err.textContent = 'Choose a category first.'; return; }
    var list = groups[btn.getAttribute('data-group-go')], gg = card.querySelector('[data-group-cat]').getAttribute('data-grp') || groupFor(cat) || '';
    var hold = playDone([card]);
    applyMany(list, function (i) { return { action: 'update_txn', args: { id: i.txn.id, changes: { category: cat, category_group: gg }, confirm: true } }; }, 'group', hold);
    hold.then(function () { repaintReview(v); });
  }
  function reviewCard(i) {
    var t = i.txn, k = KIND[i.kind], id = esc(t.id);
    var h = '<div class="card" data-id="' + id + '"><span class="tag ' + k[1] + '">' + (i.kind === 'confirm' && t.source === 'email' ? 'FROM THE BANK, NOT TYPED IN' : k[0].toUpperCase()) + '</span>';
    var amt = t.amount === null ? '' : '<div class="a">' + rp(t.amount) + '</div>';
    if (i.kind === 'unread') {
      h += '<div class="item-top"><div class="p">' + esc(t.payee || 'Unreadable email') + '</div></div><div class="sub">' + esc(t.memo) + '</div>' +
        '<label>Amount (Rp)</label><input data-f-amount inputmode="numeric" placeholder="0"><label>What was it</label><input data-f-payee value="' + esc(t.payee) + '">' +
        '<label>Category</label>' + catBtn('', ' data-f-cat') + '<p class="err" data-err></p>' +
        '<div class="btnrow"><button class="primary small" data-act="save_unread" data-id="' + id + '">Save</button></div>';
    } else if (i.kind === 'duplicate') {
      var o = i.other;
      h += '<div class="item-top"><div class="p">' + esc(t.payee) + '</div>' + amt + '</div><div class="sub">' + esc(when(t.timestamp)) + ' · ' + esc(t.account) + '</div>' +
        (o ? '<div class="sub" style="margin-top:6px">Looks the same as one saved at ' + esc(o.timestamp.slice(11, 16)) + ' for ' + rp(o.amount) + '.</div>' : '') +
        '<div class="btnrow"><button class="ghost small" data-act="keep_both" data-id="' + id + '">Keep both</button><button class="primary small" data-act="merge_dup" data-id="' + id + '">Merge into one</button></div>';
    } else if (i.kind === 'pay_now') {
      h += '<div class="item-top"><div class="p">' + esc(t.payee) + '</div>' + amt + '</div><div class="sub">' + esc(t.account) + ' · ' + esc(t.timestamp.slice(11, 16)) + '. Pay it today to earn miles and avoid interest.</div>' +
        catBtn(t.category, ' data-f-cat') + '<p class="err" data-err></p>' +
        '<div class="btnrow"><button class="ghost small" data-act="later" data-id="' + id + '">Later</button><button class="primary small" data-act="paid" data-id="' + id + '">I paid it</button></div>';
    } else {
      h += '<div class="item-top"><div class="p">' + esc(t.payee) + '</div>' + amt + '</div><div class="sub">' + esc(when(t.timestamp)) + ' · ' + esc(t.account) + '</div>' +
        catBtn(t.category, ' data-f-cat') + '<p class="err" data-err></p>' +
        '<div class="btnrow">' + (t.type === 'transfer' && (state.apiV || 1) >= 3 ? '<button class="ghost small" data-act="own_transfer" data-id="' + id + '">My own transfer</button>' : '') + '<button class="primary small" data-act="confirm" data-id="' + id + '">Confirm</button></div>';
    }
    return h + '</div>';
  }
  function reviewAction(btn, v) {
    var act = btn.getAttribute('data-act'), id = btn.getAttribute('data-id'), card = btn.closest('.card');
    var err = card.querySelector('[data-err]');
    function fail(m) { if (err) err.textContent = m; else banner(m, true); }
    if (err) err.textContent = '';
    if (act === 'later') { state.later[id] = true; LS.set('hanaro.later', JSON.stringify({ day: state.laterDay, ids: state.later })); repaintReview(v); return; }
    var action, args, label = 'that change';
    if (act === 'paid') {
      action = 'mark_paid'; args = { id: id };
      // A category picked on the card is saved first, so it is not asked for again after paying.
      var pcat = card.querySelector('[data-f-cat]');
      pcat = pcat ? pcat.getAttribute('data-val') : '';
      if (pcat) queue.push({ action: 'update_txn', args: { id: id, changes: { category: pcat, category_group: card.querySelector('[data-f-cat]').getAttribute('data-grp') || groupFor(pcat) || '' }, confirm: true }, label: 'the category' }), saveQueue();
    }
    else if (act === 'own_transfer') { action = 'update_txn'; args = { id: id, changes: { category: 'Own transfer' }, confirm: true }; }
    else if (act === 'keep_both') { action = 'keep_both'; args = { id: id }; }
    else if (act === 'merge_dup') { action = 'merge_dup'; args = { id: id }; }
    else {
      var cat = card.querySelector('[data-f-cat]').getAttribute('data-val');
      if (!cat) return fail('Choose a category first.');
      var changes = { category: cat }, cg = card.querySelector('[data-f-cat]').getAttribute('data-grp') || groupFor(cat); if (cg) changes.category_group = cg;
      if (act === 'save_unread') {
        var a = Number(card.querySelector('[data-f-amount]').value.replace(/[^\d]/g, ''));
        var p = card.querySelector('[data-f-payee]').value.trim();
        if (!a) return fail('Type the amount as a number.');
        if (!p) return fail('Type what it was for.');
        changes.idr_amount = a; changes.payee = p;
      }
      action = 'update_txn'; args = { id: id, changes: changes, confirm: true };
    }
    // Show the result at once, send in the background.
    var gone = null;
    patch('review', function (d) { d.items = d.items.filter(function (i) { if (i.txn.id === id) gone = i; return i.txn.id !== id; }); });
    patch('home', function (h) {
      h.reviewCount = Math.max(0, h.reviewCount - 1);
      if (act === 'paid' && gone && gone.txn.amount) { h.toPayCount = Math.max(0, h.toPayCount - 1); h.toPayTotal = Math.max(0, h.toPayTotal - gone.txn.amount); }
    });
    banner('Saved');
    var hold = playDone([card]);
    hold.then(function () { repaintReview(v); });
    send(action, args, label).then(function (ok) { return hold.then(function () { afterWrite(ok); }); });
  }

  /* ---------- Activity ---------- */
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  /** Date band above each day, for example "Today · November 11, 2026". */
  function bandLabel(iso) {
    var t = localIso().slice(0, 10), d = new Date(t + 'T12:00:00'); d.setDate(d.getDate() - 1);
    var z = function (n) { return (n < 10 ? '0' : '') + n; }, yest = d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
    var full = MONTHS[Number(iso.slice(5, 7)) - 1] + ' ' + Number(iso.slice(8, 10)) + ', ' + iso.slice(0, 4);
    return iso === t ? 'Today · ' + full : iso === yest ? 'Yesterday · ' + full : full;
  }
  /** What the grey pill under the payee says. */
  function actPill(t) {
    if (t.type === 'payment') return '<span class="cpill blue">Card payment</span>';
    if (t.type === 'transfer') return '<span class="cpill">Transfer</span>';
    if (t.type === 'income') return '<span class="cpill green">Income</span>';
    if (t.type === 'held_in') return '<span class="cpill">Held for others</span>';
    if (t.type === 'held_out') return '<span class="cpill">Passed on</span>';
    return t.category ? '<span class="cpill">' + esc(t.category.replace(/^Held:\s*/, 'Held: ')) + '</span>' : '<span class="cpill none">No category yet</span>';
  }
  function actTags(t) {
    var h = '';
    if (t.status === 'needs_review') h += '<span class="tag unread">UNREAD</span>';
    else if (t.status === 'possible_duplicate') h += '<span class="tag dup">DUPLICATE?</span>';
    else if (t.payNow && t.paid) h += '<span class="tag paid">PAID</span>';
    else if (t.payNow) h += '<span class="tag pay">PAY NOW</span>';
    else if (t.cleared) h += '<span class="tag clr">CLEARED</span>';
    else if (t.waiting) h += '<span class="tag wait">NOT AT BANK YET</span>';
    return h;
  }
  function actRow(t) {
    var plus = t.type === 'income' || t.type === 'held_in', edit = true;
    var amt = t.amount === null ? '–' : (plus ? '+' : '−') + rp(t.amount);
    var fx = t.origCurrency && t.origCurrency !== 'IDR' && t.origAmount !== null ? '<div class="ac">' + esc(t.origCurrency) + ' ' + Number(t.origAmount).toFixed(2) + (t.est ? ' · est.' : '') + '</div>' : '';
    var inner = '<div class="al"><div class="ap">' + esc(t.payee || '(no name)') + '</div><div class="achips">' + actPill(t) + actTags(t) + '</div></div>' +
      '<div class="ar"><div class="aa' + (plus ? ' plus' : '') + '">' + amt + (t.cleared ? '<span class="clr" title="Confirmed by the bank email">✓</span>' : '') + '</div>' +
      '<div class="ac">' + esc(t.account || 'No account') + (t.by ? ' · ' + esc(t.by) : '') + '</div>' + fx + '</div>';
    return edit ? '<button type="button" class="arow" data-edit="' + esc(t.id) + '">' + inner + '</button>' : '<div class="arow">' + inner + '</div>';
  }
  function fillActList(v, d) {
    var q = (state.actQ || '').toLowerCase().trim(), fsel = state.actFilter || 'All';
    var items = d.items.filter(function (t) {
      if (fsel !== 'All' && t.by !== fsel) return false;
      if (state.actCat && t.category !== state.actCat) return false;
      if (q && [t.payee, t.category, t.account, t.memo, t.by].join(' ').toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || String(b.timestamp).localeCompare(String(a.timestamp)); });
    var html = '';
    if (!items.length) html = '<div class="card empty">' + (q ? 'Nothing matches "' + esc(state.actQ) + '".' : state.actCat ? 'Nothing in ' + esc(state.actCat) + ' among the latest transactions.' : d.items.length ? 'Nothing for ' + fsel + ' in the latest transactions.' : 'Nothing yet.') + '</div>';
    else {
      var last = '';
      html = '<div class="acard">';
      items.forEach(function (t) {
        if (t.date !== last) { html += '<div class="dband">' + esc(bandLabel(t.date)) + '</div>'; last = t.date; }
        html += actRow(t);
      });
      html += '</div>';
    }
    $('actList').innerHTML = html;
    $('actList').querySelectorAll('[data-edit]').forEach(function (b) { b.addEventListener('click', function () { openTxnEdit(b.getAttribute('data-edit')); }); });
  }
  function paintActivity(v, d) {
    var FILTERS = ['All', 'AJ', 'Cynthia', 'Business'], fsel = state.actFilter || 'All', n = state.counts.review || 0;
    var html = '<div class="acthead"><div style="' + TITLE + '">Activity</div><button type="button" id="actSearchBtn" class="roundx" aria-label="Search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg></button></div>';
    if (state.actSearchOn) html += '<input id="actQ" type="search" placeholder="Search payee, category or account" autocomplete="off" value="' + esc(state.actQ || '') + '">';
    if (n) html += '<div class="inbox"><span class="cnt">' + n + '</span><span class="it">New transactions</span><button type="button" class="rv" data-go-review>Review</button></div>';
    if (state.actCat) html += '<div class="chips"><button class="chip on" data-clearcat>' + esc(state.actCat) + ' ×</button></div>';
    html += '<div class="chips">' + FILTERS.map(function (f) { return '<button class="chip' + (f === fsel ? ' on' : '') + '" data-actf="' + f + '">' + f + '</button>'; }).join('') + '</div><div id="actList"></div>';
    v.innerHTML = html;
    fillActList(v, d);
    v.querySelectorAll('[data-clearcat]').forEach(function (b) { b.addEventListener('click', function () { state.actCat = ''; paintActivity(v, d); }); });
    v.querySelectorAll('[data-actf]').forEach(function (b) { b.addEventListener('click', function () { state.actFilter = b.getAttribute('data-actf'); paintActivity(v, d); }); });
    v.querySelectorAll('[data-go-review]').forEach(function (b) { b.addEventListener('click', function () { go('review'); }); });
    $('actSearchBtn').addEventListener('click', function () {
      state.actSearchOn = !state.actSearchOn; if (!state.actSearchOn) state.actQ = '';
      paintActivity(v, d); if (state.actSearchOn && $('actQ')) $('actQ').focus();
    });
    if ($('actQ')) $('actQ').addEventListener('input', function () { state.actQ = $('actQ').value; fillActList(v, d); });
  }

  /* ---------- Open one entry: change what was typed, fix amount, date, account, who; delete with undo ---------- */
  var te = { t: null, cat: '', grp: '', photo: null, who: '', acc: '' };
  function setTeCat(name, group) { te.cat = name || ''; te.grp = name ? (group || groupFor(name)) : ''; var el = $('teCatVal'); el.textContent = name ? name.replace(/^Held:\s*/, 'Held: ') : 'Choose'; el.className = 'fv' + (name ? '' : ' empty'); }
  function setTeWho(w) { te.who = w; $('teAJ').className = w === 'AJ' ? 'on' : ''; $('teCyn').className = w === 'Cynthia' ? 'on' : ''; }
  function setTeAcc(a) { te.acc = a || ''; $('teAccVal').textContent = a || 'Not sure'; }
  function findTxnLocal(id) { var c = snap('activity'); return c && c.d.items.filter(function (x) { return x.id === id; })[0]; }
  function openTxnEdit(id) {
    var t = findTxnLocal(id);
    if (!t) return;
    var v3 = (state.apiV || 1) >= 3, manual = t.source === 'manual', canAmt = v3 && (manual || t.est), canDate = v3 && manual, canAcct = v3 && manual;
    var spendish = t.type === 'purchase' || t.type === 'held_in' || t.type === 'held_out', named = t.type === 'purchase' || t.type === 'income' || t.type === 'held_in' || t.type === 'held_out';
    te = { t: t, cat: t.category || '', grp: t.group || '', photo: null, who: '', acc: t.account || '', canAmt: canAmt, canDate: canDate, canAcct: canAcct };
    $('teAmt').textContent = t.amount === null ? '–' : (t.type === 'income' || t.type === 'held_in' ? '+' : '−') + rp(t.amount);
    $('teSub').textContent = bandLabel(t.date) + ' · ' + (t.account || 'No account') + (t.origCurrency && t.origCurrency !== 'IDR' && t.origAmount !== null ? ' · ' + t.origCurrency + ' ' + Number(t.origAmount).toFixed(2) : '') + (t.source === 'email' ? ' · from the bank email' : '');
    $('teAmtWrap').hidden = !canAmt; $('teAmtIn').value = t.amount ? Number(t.amount).toLocaleString('id-ID') : '';
    $('teAmtLabel').textContent = t.est ? 'Real rupiah amount from your card statement' : 'Amount (Rp)';
    $('tePayeeWrap').hidden = !named; $('tePayee').value = t.payee || ''; $('teMemo').value = t.memo || '';
    $('teCat').hidden = !spendish; $('tePhotoWrap').hidden = !spendish;
    $('teAcc').hidden = !canAcct; setTeAcc(t.account);
    $('teDateWrap').hidden = !canDate; $('teDate').value = t.date; $('teDate').max = localIso().slice(0, 10);
    $('teWhoWrap').hidden = !(v3 && manual); setTeWho(t.who === 'AJ' || t.who === 'Cynthia' ? t.who : '');
    $('teDelete').hidden = !v3;
    setTeCat(te.cat);
    $('tePhoto').textContent = t.receipt ? 'Receipt saved ✓ · Replace' : 'Add receipt photo'; $('tePhotoThumb').hidden = true; $('teMsg').textContent = '';
    $('txnEdit').hidden = false; $('txnEdit').scrollTop = 0;
  }
  $('teBack').addEventListener('click', function () { $('txnEdit').hidden = true; });
  $('teAJ').addEventListener('click', function () { setTeWho('AJ'); });
  $('teCyn').addEventListener('click', function () { setTeWho('Cynthia'); });
  $('teAmtIn').addEventListener('input', function () { var d = $('teAmtIn').value.replace(/[^\d]/g, ''); $('teAmtIn').value = d ? Number(d).toLocaleString('id-ID') : ''; });
  $('teAcc').addEventListener('click', function () {
    openPicker({ items: accItems('any'), selected: te.acc, title: 'Account', onPick: function (v) { setTeAcc(v); } });
  });
  $('teCat').addEventListener('click', function () {
    ensureCats().then(function () {
      var held = te.t && (te.t.type === 'held_in' || te.t.type === 'held_out');
      openPicker({ held: held, selected: te.cat, title: 'Category', noNew: true, payee: $('tePayee').value, onPick: function (name, group) { setTeCat(name, group); } });
    }, function (e) { banner(e.message, true); });
  });
  $('tePhoto').addEventListener('click', function () { $('tePhotoIn').click(); });
  $('tePhotoIn').addEventListener('change', function () {
    var f = $('tePhotoIn').files[0]; if (!f) return;
    $('tePhoto').textContent = 'Preparing…';
    compress(f).then(function (ph) { te.photo = ph; $('tePhoto').textContent = 'Photo ready ✓ · Replace'; $('tePhotoThumb').src = dataUrl(ph); $('tePhotoThumb').hidden = false; }, function (e) { te.photo = null; $('tePhoto').textContent = 'Add receipt photo'; $('teMsg').textContent = e.message; });
    $('tePhotoIn').value = '';
  });
  $('teSave').addEventListener('click', function () {
    var t = te.t; if (!t) return;
    var named = !$('tePayeeWrap').hidden, payee = $('tePayee').value.trim(), memo = $('teMemo').value.trim(), ch = {};
    if (named && !payee) { $('teMsg').textContent = 'Type who or what it was for.'; return; }
    if (named && payee !== (t.payee || '')) ch.payee = payee;
    if (!$('teCat').hidden && te.cat && (te.cat !== (t.category || '') || (te.grp && te.grp !== (t.group || '')))) { ch.category = te.cat; ch.category_group = te.grp || groupFor(te.cat) || ''; }
    if (memo !== (t.memo || '')) ch.memo = memo;
    if (te.canAmt) {
      var na = Number($('teAmtIn').value.replace(/[^\d]/g, ''));
      if (!na) { $('teMsg').textContent = 'Type the amount as a number above zero.'; return; }
      if (na !== t.amount) ch.idr_amount = na;
    }
    if (te.canDate && $('teDate').value && $('teDate').value !== t.date) {
      if ($('teDate').value > localIso().slice(0, 10)) { $('teMsg').textContent = 'The date cannot be in the future.'; return; }
      ch.date = $('teDate').value;
    }
    if (te.canAcct && te.acc !== (t.account || '')) ch.account = te.acc;
    if (!$('teWhoWrap').hidden && te.who && te.who !== t.who) ch.who = te.who;
    // Saving a new transaction that has a category also confirms it, so it leaves Review.
    var confirm = t.status === 'auto' && !!(te.cat || t.category) && (t.type === 'purchase'), photo = te.photo, id = t.id;
    if (!Object.keys(ch).length && !confirm && !photo) { $('txnEdit').hidden = true; return; }
    $('txnEdit').hidden = true; banner('Saved');
    if (Object.keys(ch).length || confirm) send('update_txn', { id: id, changes: ch, confirm: confirm || undefined }, 'the changes to ' + (t.payee || 'an entry')).then(afterWrite);
    if (photo) send('attach_photo', { id: id, photo: photo }, 'the receipt photo').then(afterWrite);
    paintCurrent();
  });
  /** Delete hides the entry everywhere. It stays in the history, and Undo brings it back. */
  function deleteTxn(t) {
    banner('Deleted ' + (t.payee || 'the entry'), false, 7000, { label: 'Undo', fn: function () {
      send('restore_txn', { id: t.id }, 'undoing the delete').then(afterWrite); paintCurrent();
    } });
    send('void_txn', { id: t.id }, 'deleting ' + (t.payee || 'an entry')).then(afterWrite);
    paintCurrent();
  }
  $('teDelete').addEventListener('click', function () {
    var t = te.t; if (!t) return;
    confirmBox('Delete ' + (t.payee || 'this entry') + (t.amount ? ' (' + rp(t.amount) + ')' : '') + '? It disappears from your totals. You can undo it right after.', 'Delete', function () { $('txnEdit').hidden = true; deleteTxn(t); }, true);
  });

  /* ---------- Status ---------- */
  function renderStatus(v, tok) {
    var c = snap('status');
    if (c) paintStatus(v, c.d); else v.innerHTML = '<div class="empty">Loading…</div>';
    state.busy = true; setPill();
    flush().then(function () { return api('status'); }).then(function (s) {
      save('status', s); state.busy = false; setPill(undefined, false);
      if (tok === state.token && !editing(v)) paintStatus(v, s);
    }, function (e) {
      state.busy = false; setPill(undefined, true);
      if (tok !== state.token) return;
      if (c) banner(e.message, true, 6000);
      else { v.innerHTML = '<div class="card"><div class="label">Could not load</div><p class="note">' + esc(e.message) + '</p></div>'; banner(e.message, true); }
    });
  }
  function paintStatus(v, s) {
    (function () {
      LS.set('hanaro.lastsync', s.lastSync || ''); setPill(s.lastSync);
      var stale = !s.lastSync || (Date.now() - Date.parse(s.lastSync)) > 2 * 3600 * 1000;
      var html = '<div style="' + TITLE + '">Status</div>';
      html += '<div class="card"><div class="label">Email sync</div><div class="kv"><span><span class="dot' + (stale ? ' bad' : '') + '"></span>' + (s.lastSync ? 'Last sync ' + esc(ago(s.lastSync)) : 'No sync yet') + '</span></div>' +
        (s.lastSyncError ? '<p class="note" style="color:var(--warn)">Last error: ' + esc(s.lastSyncError) + '</p>' : '') +
        '<div class="kv"><span>Emails I could not read</span><b>' + s.unreadable + '</b></div><div class="kv"><span>Last backup</span><span>' + esc(s.lastBackup ? ago(s.lastBackup) : 'none yet') + '</span></div></div>';
      html += '<div class="card"><div class="label">Places and payees</div><p class="note">See where you spend and set the default category for each place.</p><button class="ghost small" id="openPlaces">Open places</button></div>';
      html += '<div class="card"><div class="label">Last email from each bank</div>' + (s.senders.length ? s.senders.map(function (x) { return '<div class="kv"><span>' + esc(x.sender) + '</span><span class="muted">' + esc(ago(x.last)) + '</span></div>'; }).join('') : '<p class="note">None yet.</p>') + '</div>';
      if (s.canSetup) {
        html += '<div class="card"><div class="label">Bank balances</div><p class="note">Type what each account shows today.</p>' +
          s.accounts.map(function (a) { return '<div class="kv"><span>' + esc(a.account) + '<div class="sub">' + (a.date ? 'Set ' + dayLabel(a.date) : 'Not set') + (a.balance !== null ? ' · ' + rp(a.balance) : '') + '</div></span><input inputmode="numeric" data-bal="' + esc(a.account) + '" placeholder="Rp"></div>'; }).join('') +
          '<p class="err" data-err-bal></p><button class="primary small" id="saveBal">Save balances</button></div>';
      }
      html += '<div class="card"><div class="label">This device</div><p class="note">Hanaro version 1. The link and key are stored on this device only.</p><button class="link" id="signOut">Disconnect this device</button></div>';
      v.innerHTML = html;
      function saver(btnId, attr, errSel, action, field, label) {
        var b = $(btnId); if (!b) return;
        b.addEventListener('click', function () {
          var inputs = [].slice.call(v.querySelectorAll('[' + attr + ']')).filter(function (i) { return i.value.trim() !== ''; });
          var err = v.querySelector(errSel); err.textContent = '';
          if (!inputs.length) { err.textContent = 'Type at least one number first.'; return; }
          b.disabled = true;
          Promise.all(inputs.map(function (i) {
            var a = {}; a[field[0]] = i.getAttribute(attr); a[field[1]] = Number(i.value.replace(/[^\d]/g, ''));
            return api(action, a);
          })).then(function () { banner(label + ' saved'); render(); }, function (e) { b.disabled = false; err.textContent = e.message; });
        });
      }
      saver('saveBal', 'data-bal', '[data-err-bal]', 'set_balance', ['account', 'amount'], 'Balances');
      $('openPlaces').addEventListener('click', function () { go('payees'); });
      $('signOut').addEventListener('click', disconnect);
    })();
  }

  /* ---------- Places and payees ---------- */
  function renderPayees(v, tok) {
    var c = snap('payees');
    if (c) paintPayees(v, c.d); else v.innerHTML = '<div class="empty">Loading…</div>';
    state.busy = true; setPill();
    flush().then(function () { return api('payees'); }).then(function (d) {
      save('payees', d); if (!state.cats) useCats({ categories: d.categories, accounts: state.accounts || [] });
      state.busy = false; setPill(undefined, false);
      if (tok === state.token && !editing(v)) paintPayees(v, d);
    }, function (e) {
      state.busy = false; setPill(undefined, true);
      if (tok !== state.token) return;
      if (c) banner(e.message, true, 6000);
      else { v.innerHTML = '<div class="card"><div class="label">Could not load</div><p class="note">' + esc(e.message) + '</p></div>'; banner(e.message, true); }
    });
  }
  function paintPayees(v, d) {
    ensureCats().then(function () {
      v.innerHTML = '<div style="' + TITLE + '">Places</div><button class="link" id="plBack">‹ Back to Accounts</button>' +
        '<input id="plSearch" type="search" placeholder="Search places" autocomplete="off"><div id="plList"></div>';
      $('plBack').addEventListener('click', function () { go('accounts'); });
      function fill() {
        var q = $('plSearch').value.toLowerCase().trim(), list = d.payees.filter(function (p) { return !q || p.payee.toLowerCase().indexOf(q) !== -1; }).slice(0, 80);
        if (!list.length) { $('plList').innerHTML = '<div class="card empty">' + (d.payees.length ? 'Nothing matches.' : 'No places yet. They appear as you spend.') + '</div>'; return; }
        $('plList').innerHTML = '<div class="card" style="padding:4px 18px;margin-top:8px">' + list.map(function (p, i) {
          return '<div class="plrow"><div class="l"><div class="p">' + esc(p.payee) + '</div><div class="sub">' + p.count + ' time' + (p.count === 1 ? '' : 's') + ' · ' + rpShort(p.total) + ' · last ' + dayLabel(p.last) + (p.trusted ? ' · auto' : '') + '</div></div>' +
            '<button class="plcat' + (p.category ? '' : ' none') + '" data-pi="' + i + '">' + esc(p.category || 'Choose') + '</button></div>';
        }).join('') + '</div>';
        $('plList').querySelectorAll('[data-pi]').forEach(function (b) {
          b.addEventListener('click', function () {
            var p = list[Number(b.getAttribute('data-pi'))];
            openPicker({ held: false, selected: p.category, title: p.payee, noNew: true, onPick: function (name) {
              patch('payees', function (dd) { dd.payees.forEach(function (x) { if (x.key === p.key) { x.category = name; x.remembered = true; x.trusted = true; } }); });
              var cc = snap('payees'); if (cc) d = cc.d;
              fill(); banner('Saved');
              send('set_payee_category', { payee: p.payee, category: name }, p.payee);
            } });
          });
        });
      }
      $('plSearch').addEventListener('input', fill); fill();
    });
  }

  /* ---------- Add ---------- */
  function recentTxns() { var c = snap('activity'); return c ? c.d.items : []; }
  function kindRows() { var all = state.cats || [], held = state.kind === 'held'; return all.filter(function (c) { return held ? c.held : (!c.held && c.category !== 'Income'); }); }
  function setCat(name, group) {
    state.addCat = name; state.addGroup = name && name !== '__new' ? (group || groupFor(name)) : '';
    var el = $('catVal');
    if (!name) { el.textContent = 'Choose'; el.className = 'fv empty'; }
    else if (name === '__new') { el.textContent = 'A new kind…'; el.className = 'fv'; }
    else { el.textContent = name; el.className = 'fv'; }
    $('newTypeWrap').hidden = name !== '__new';
  }
  /** The group of a category by name, when the name is in one group only. */
  function groupFor(name) {
    var g = '', n = 0; (state.cats || []).forEach(function (c) { if (c.category === name && c.group !== g) { g = c.group; n++; } });
    return n === 1 ? g : '';
  }
  function setAcc(v) {
    $('addAcc').value = v || ''; $('accVal').textContent = v || (state.kind === 'transfer' || state.kind === 'payment' ? 'Choose' : 'Not sure');
    $('accVal').className = 'fv' + (v || state.kind === 'spent' || state.kind === 'got' ? '' : ' empty');
  }
  function setTo(v) { $('addTo').value = v || ''; $('toVal').textContent = v || 'Choose'; $('toVal').className = 'fv' + (v ? '' : ' empty'); }
  /** The accounts to choose from. mode: any (spent, received), from (transfer, card payment), to (transfer), card (card payment). */
  function accItems(mode) {
    var full = state.accountsFull || [], last = LS.get('hanaro.lastacct') || '', count = {};
    recentTxns().forEach(function (t) { if (t.account) count[t.account] = (count[t.account] || 0) + 1; });
    var list = full.filter(function (a) { return mode === 'card' ? a.type === 'credit card' : mode === 'any' ? true : (a.type === 'bank' || !a.type); });
    list.sort(function (x, y) { return ((y.account === last) - (x.account === last)) || ((count[y.account] || 0) - (count[x.account] || 0)); });
    var out = list.map(function (a) { return { name: a.account + (a.entity === 'PT' ? ' · PT AHU' : ''), value: a.account }; });
    if (mode === 'any') { out.push({ name: 'Cash', value: 'Cash' }); out.push({ name: 'Not sure', value: '' }); }
    if (mode === 'to') out.push({ name: 'Cash', value: 'Cash' });
    return out;
  }
  function fmtAmt(el) {
    if (el.id === 'addAmount' && $('addCur').value !== 'IDR') {
      // Foreign money keeps two decimals, for example 5.50 or 5,5. Either a dot or a comma works.
      var v = el.value.replace(',', '.').replace(/[^\d.]/g, ''), i = v.indexOf('.');
      if (i !== -1) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '').slice(0, 2);
      el.value = v; return;
    }
    var d = el.value.replace(/[^\d]/g, '');
    el.value = d ? Number(d).toLocaleString('id-ID') : '';
  }
  function setCur(c) {
    $('addCur').value = c; var foreign = c !== 'IDR';
    setExpr(''); renderKeyLeft();
    $('fxWrap').hidden = !foreign || state.kind !== 'spent'; $('addIdr').value = '';
    LS.set('hanaro.lastcur', JSON.stringify({ c: c, at: Date.now() }));
  }
  function openAdd() {
    loadHints();
    ensureCats().then(function () {
      var last = LS.get('hanaro.lastacct') || '';
      setExpr(''); ['addPayee', 'addMemo', 'addNewType'].forEach(function (i) { $(i).value = ''; });
      setDate(localIso().slice(0, 10)); $('calWrap').hidden = true; $('photoMenu').hidden = true; $('payeeSug').hidden = true; $('addMsg').textContent = ''; setKind('spent'); setAcc(accItems('any').some(function (i) { return i.value === last && last; }) ? last : ''); setTo(''); (function () { var lc = null; try { lc = JSON.parse(LS.get('hanaro.lastcur') || 'null'); } catch (e) {} setCur(lc && lc.c && Date.now() - lc.at < 3 * 86400000 ? lc.c : 'IDR'); })();
      setPhoto(null); locateAdd();
      $('sheetBack').hidden = false; $('sheet').hidden = false; showFavs(); $('sheet').scrollTop = 0; kpScroll = 0; openKeypad();
    }, function (e) { banner(e.message, true); });
  }
  /* Location: suggests payee, category and account from the nearest earlier purchase (within 150 m). */
  function locateAdd() {
    state.geo = null; $('geoNote').hidden = true; state.geoApplied = false;
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
      state.geo = { lat: Math.round(pos.coords.latitude * 1e5) / 1e5, lng: Math.round(pos.coords.longitude * 1e5) / 1e5 };
      if (state.kind !== 'spent' || $('addPayee').value || $('sheet').hidden) return;
      var best = null, bd = 150;
      readPlaces().forEach(function (p) { var d = distM(state.geo, p); if (d < bd) { bd = d; best = p; } });
      if (!best) return;
      $('addPayee').value = best.payee;
      if (best.category && kindRows().some(function (c) { return c.category === best.category; })) setCat(best.category);
      if (best.account && state.accounts.indexOf(best.account) !== -1) setAcc(best.account);
      state.geoApplied = true; $('geoText').textContent = 'Suggested from your location.'; $('geoNote').hidden = false;
    }, function (err) {
      if (err && err.code === 1 && !LS.get('hanaro.geosaid')) { LS.set('hanaro.geosaid', '1'); $('geoText').textContent = 'Location is off for Hanaro, so there are no place suggestions. You can allow it in Settings.'; $('geoClear').hidden = true; $('geoNote').hidden = false; }
    }, { timeout: 4000, maximumAge: 60000, enableHighAccuracy: false });
  }
  $('geoClear').addEventListener('click', function () { $('addPayee').value = ''; setCat(''); $('geoNote').hidden = true; state.geoApplied = false; });
  function dataUrl(ph) { return 'data:' + ph.mime + ';base64,' + ph.data; }
  function setPhoto(ph) {
    state.photo = ph; $('photoMenu').hidden = true;
    $('photoPrev').hidden = !ph; if (ph) $('photoThumb').src = dataUrl(ph); else $('photoThumb').removeAttribute('src');
    $('photoVal').textContent = ph ? 'Added' : 'Add a receipt photo'; $('photoVal').className = ph ? 'fv' : 'fv empty';
  }
  function takePhoto(input) {
    var f = input.files[0]; if (!f) return;
    $('photoVal').textContent = 'Preparing photo…'; $('photoMenu').hidden = true;
    compress(f).then(setPhoto, function (e) { setPhoto(null); $('addMsg').textContent = e.message; });
    input.value = '';
  }
  $('photoBtn').addEventListener('click', function () { $('photoMenu').hidden = !$('photoMenu').hidden; });
  $('photoTake').addEventListener('click', function () { $('photoCam').click(); });
  $('photoPick').addEventListener('click', function () { $('photoIn').click(); });
  $('photoChange').addEventListener('click', function () { $('photoMenu').hidden = false; });
  $('photoRemove').addEventListener('click', function () { setPhoto(null); });
  $('photoCam').addEventListener('change', function () { takePhoto($('photoCam')); });
  $('photoIn').addEventListener('change', function () { takePhoto($('photoIn')); });
  $('photoThumb').addEventListener('click', function () { $('photoThumb').classList.toggle('big'); });
  /* Date: tapping the row opens a month calendar right under it, like YNAB. Future days are off. */
  var cal = { y: 0, m: 0 }, MONTHS_L = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function setDate(iso) {
    $('addDate').value = iso; $('addDate').max = localIso().slice(0, 10);
    var p = iso.split('-'); $('dateVal').textContent = MONTHS_L[Number(p[1]) - 1] + ' ' + Number(p[2]) + ', ' + p[0];
    cal.y = Number(p[0]); cal.m = Number(p[1]) - 1; paintCal();
  }
  function paintCal() {
    var today = localIso().slice(0, 10), sel = $('addDate').value, first = new Date(cal.y, cal.m, 1).getDay(), n = new Date(cal.y, cal.m + 1, 0).getDate(), h = '', i;
    $('calTitle').textContent = MONTHS_L[cal.m] + ' ' + cal.y;
    for (i = 0; i < first; i++) h += '<span></span>';
    for (i = 1; i <= n; i++) {
      var iso = cal.y + '-' + ('0' + (cal.m + 1)).slice(-2) + '-' + ('0' + i).slice(-2);
      h += '<button type="button" data-d="' + iso + '" class="' + (iso === sel ? 'on' : '') + '"' + (iso > today ? ' disabled' : '') + '>' + i + '</button>';
    }
    $('calDays').innerHTML = h;
    var t = today.split('-'); $('calNext').disabled = cal.y > Number(t[0]) || (cal.y === Number(t[0]) && cal.m >= Number(t[1]) - 1);
  }
  $('dateBtn').addEventListener('click', function () { $('calWrap').hidden = !$('calWrap').hidden; });
  $('calPrev').addEventListener('click', function () { cal.m--; if (cal.m < 0) { cal.m = 11; cal.y--; } paintCal(); });
  $('calNext').addEventListener('click', function () { cal.m++; if (cal.m > 11) { cal.m = 0; cal.y++; } paintCal(); });
  $('calDays').addEventListener('click', function (ev) { var b = ev.target.closest('[data-d]'); if (b && !b.disabled) setDate(b.getAttribute('data-d')); });
  function closeAdd() { closeKeypad(); $('sheet').hidden = true; $('sheetBack').hidden = true; $('picker').hidden = true; }
  var KIND_BTN = { spent: 'kindSpent', got: 'kindGot', transfer: 'kindTransfer', payment: 'kindPay', held: 'kindHeld' };
  function setKind(k) {
    state.kind = k;
    // A place suggestion is for purchases only; drop it when switching to another kind.
    if (k !== 'spent' && state.geoApplied) { $('addPayee').value = ''; setCat(''); $('geoNote').hidden = true; state.geoApplied = false; }
    Object.keys(KIND_BTN).forEach(function (x) { $(KIND_BTN[x]).className = k === x ? 'on' : ''; });
    var move = k === 'transfer' || k === 'payment', newServer = (state.apiV || 1) >= 3;
    $('kindTransfer').hidden = !newServer; $('kindPay').hidden = !newServer;
    if (k !== 'spent' && $('addCur').value !== 'IDR') setCur('IDR');
    $('addCur').disabled = k !== 'spent';
    $('catBtn').hidden = k === 'got' || move;
    $('payeeLabel').textContent = k === 'got' ? 'Received from' : 'Payee';
    $('payeeLabel').parentNode.hidden = move;
    $('catLabel').textContent = k === 'held' ? 'What kind of money' : 'Category';
    $('accLabel').textContent = k === 'got' ? 'Received into' : move ? (k === 'payment' ? 'Paid from' : 'From') : 'Account';
    $('toBtn').hidden = !move; $('toLabel').textContent = k === 'payment' ? 'Card that was paid' : 'To';
    $('moveHint').hidden = !move;
    $('moveHint').textContent = k === 'payment' ? 'Paying a credit card bill. It clears card charges and is not counted as spending.' : k === 'transfer' ? 'Moving your own money between accounts. It is not counted as spending. Choose Cash for a withdrawal.' : '';
    document.querySelectorAll('[data-spendonly]').forEach(function (x) { x.hidden = move; });
    if (move) { setPhoto(null); $('photoPrev').hidden = true; }
    $('heldHint').hidden = k !== 'held'; $('fxWrap').hidden = $('addCur').value === 'IDR' || k !== 'spent'; setCat('');
    var a = $('addAcc').value; if (move && (a === 'Cash' || !accItems('from').some(function (i) { return i.value === a; }))) setAcc(''); else setAcc(a);
  }
  /* Payee suggestions come from what you entered before; picking one fills the category and account too. */
  function payeeSuggestions(q) {
    q = q.toLowerCase().trim(); var seen = {}, out = [];
    if (q.length < 1) return out;
    recentTxns().forEach(function (t) {
      var p = String(t.payee || ''), key = p.toLowerCase();
      if (!p || seen[key] || key.indexOf(q) === -1) return;
      seen[key] = 1; out.push(t);
    });
    // Then places from your YNAB history and learned rules (loaded in the background, kept on this device).
    var hs = hints(), hit = [];
    for (var i = 0; i < hs.length; i++) {
      var key = String(hs[i].p).toLowerCase();
      if (seen[key] || key.indexOf(q) === -1) continue;
      seen[key] = 1; hit.push({ payee: hs[i].p, category: hs[i].c, account: '' });
      if (hit.length >= 5) break;
    }
    return out.concat(hit).slice(0, 6);
  }
  function hints() { try { var h = JSON.parse(LS.get('hanaro.hints') || 'null'); return h && h.list ? h.list : []; } catch (e) { return []; } }
  /** Once a day, in the background: places and usual categories from the YNAB history. */
  function loadHints() {
    var h = null; try { h = JSON.parse(LS.get('hanaro.hints') || 'null'); } catch (e) {}
    if (h && h.at && Date.now() - h.at < 86400000) return;
    api('payee_hints', {}).then(function (r) { LS.set('hanaro.hints', JSON.stringify({ at: Date.now(), list: r.hints || [] })); }, function () {});
  }
  var sugCache = [];
  /** The payees used most in the latest transactions, shown before anything is typed. One tap fills payee, category and account. */
  function favPayees() {
    var type = { spent: 'purchase', got: 'income', held: 'held_in' }[state.kind], count = {}, last = {}, order = [];
    recentTxns().forEach(function (t) {
      var p = String(t.payee || '').trim(); if (!p || t.type !== type) return;
      var k = p.toLowerCase();
      if (!count[k]) { count[k] = 0; last[k] = t; order.push(k); }
      count[k]++;
    });
    var rank = {}; order.forEach(function (k, i) { rank[k] = i; });
    order.sort(function (x, y) { return count[y] - count[x] || rank[x] - rank[y]; });
    return order.slice(0, 6).map(function (k) { return last[k]; });
  }
  function renderSug(list) {
    sugCache = list; var box = $('payeeSug');
    box.innerHTML = list.map(function (t, i) { return '<button type="button" data-sug="' + i + '">' + esc(t.payee) + '</button>'; }).join('');
    box.hidden = !list.length;
    box.querySelectorAll('[data-sug]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = sugCache[Number(b.getAttribute('data-sug'))];
        $('addPayee').value = t.payee; box.hidden = true;
        if (state.kind !== 'got' && t.category && kindRows().some(function (c) { return c.category === t.category; })) setCat(t.category);
        var da = t.account || defaultAcctFor(t.payee);
        if (da && state.accounts.indexOf(da) !== -1) setAcc(da);
      });
    });
  }
  /** The account this place was last paid from most often, so the account does not have to be chosen each time. */
  function defaultAcctFor(payee) {
    var key = String(payee || '').trim().toLowerCase(), n = {}, best = '';
    if (!key) return '';
    recentTxns().forEach(function (t) { if (t.account && t.type === 'purchase' && String(t.payee || '').trim().toLowerCase() === key) n[t.account] = (n[t.account] || 0) + 1; });
    Object.keys(n).forEach(function (a) { if (!best || n[a] > n[best]) best = a; });
    return best;
  }
  /* No payee chips before typing. Suggestions come only from the location, or from what is typed. */
  function showFavs() { $('payeeSug').hidden = true; }
  $('addPayee').addEventListener('change', function () {
    if (state.kind !== 'spent' || $('addAcc').value) return;
    var da = defaultAcctFor($('addPayee').value);
    if (da && state.accounts.indexOf(da) !== -1) setAcc(da);
  });
  $('addPayee').addEventListener('input', function () {
    var v = $('addPayee').value;
    if (!v.trim()) { showFavs(); return; }
    renderSug(payeeSuggestions(v));
    if (!sugCache.length && !hints().length && !LS.get('hanaro.hints') && v.trim().length >= 2) { $('payeeSug').innerHTML = '<span class="note">Places from your YNAB history are still loading. Try again in a moment.</span>'; $('payeeSug').hidden = false; }
  });
  /* Category picker: suggested first (for this payee), then pinned, then grouped. Also used for the account list. */
  function pickRows() {
    var all = state.cats || [], held = state.pick.held;
    if (state.pick.both) return all.filter(function (c) { return c.category !== 'Income'; });
    return all.filter(function (c) { return held ? c.held : (!c.held && c.category !== 'Income'); });
  }
  function pins() { try { return JSON.parse(LS.get('hanaro.pins') || '[]') || []; } catch (e) { return []; } }
  function togglePin(name) { var a = pins(), i = a.indexOf(name); if (i === -1) a.push(name); else a.splice(i, 1); LS.set('hanaro.pins', JSON.stringify(a)); }
  /** Categories this payee had before come first, then the ones used most lately. */
  function suggestedFor(rows, payee) {
    var ok = {}; rows.forEach(function (c) { ok[c.group + '|' + c.category] = c; });
    var key = String(payee || '').trim().toLowerCase(), byPayee = {}, recent = {}, out = [];
    recentTxns().forEach(function (t) {
      var k = (t.group || groupFor(t.category) || '') + '|' + t.category;
      if (!t.category || !ok[k]) return;
      recent[k] = (recent[k] || 0) + 1;
      if (key && String(t.payee || '').trim().toLowerCase() === key) byPayee[k] = (byPayee[k] || 0) + 1;
    });
    function byCount(m) { return Object.keys(m).sort(function (x, y) { return m[y] - m[x]; }); }
    byCount(byPayee).slice(0, 3).forEach(function (n) { out.push(ok[n]); });
    byCount(recent).forEach(function (n) { if (out.length < 5 && out.indexOf(ok[n]) === -1) out.push(ok[n]); });
    return out;
  }
  function bindPick() {
    $('pickList').querySelectorAll('[data-cat]').forEach(function (b) {
      b.addEventListener('click', function () { $('picker').hidden = true; state.pick.onPick(b.getAttribute('data-cat'), b.getAttribute('data-grp') || ''); });
    });
    $('pickList').querySelectorAll('[data-pin]').forEach(function (b) {
      b.addEventListener('click', function () { togglePin(b.getAttribute('data-pin')); pickList($('pickSearch').value); });
    });
  }
  /** The category list: Suggested for this payee, Pinned on this phone, then YNAB's groups. Search looks in category and group names. */
  function pickList(q) {
    q = (q || '').toLowerCase().trim();
    var sel = state.pick.selected, html = '';
    if (state.pick.items) {
      var its = state.pick.items.filter(function (i) { return !q || i.name.toLowerCase().indexOf(q) !== -1; });
      html = its.length ? '<div class="pcard">' + its.map(function (i) { return '<div class="prw"><button type="button" class="prow" data-cat="' + esc(i.value) + '"><span>' + esc(i.name) + '</span>' + (i.value === sel ? '<span class="ck">✓</span>' : '') + '</button></div>'; }).join('') + '</div>' : '<p class="note" style="padding:14px 4px">Nothing matches "' + esc(q) + '".</p>';
      $('pickList').innerHTML = html; bindPick(); return;
    }
    var rows = pickRows(), held = state.pick.held, pinned = pins();
    function row(c, mark, withGroup) {
      var id = c.group + '|' + c.category, on = pinned.indexOf(id) !== -1;
      return '<div class="prw"><button type="button" class="prow" data-cat="' + esc(c.category) + '" data-grp="' + esc(c.group || '') + '"><span>' + esc(c.category.replace(/^Held:\s*/, '')) + (withGroup && c.group ? ' <span class="muted">· ' + esc(c.group) + '</span>' : '') + '</span>' + (mark ? '<span class="ck">✓</span>' : '') + '</button>' +
        '<button type="button" class="pin' + (on ? ' on' : '') + '" data-pin="' + esc(id) + '" aria-label="' + (on ? 'Unpin ' : 'Pin ') + esc(c.category) + '">' + (on ? '★' : '☆') + '</button></div>';
    }
    function isSel(c) { return c.category === sel && (!state.pick.selectedGroup || c.group === state.pick.selectedGroup); }
    if (!q) {
      var top = suggestedFor(rows, state.pick.payee);
      if (top.length) html += '<div class="pgroup">Suggested</div><div class="pcard">' + top.map(function (c) { return row(c, isSel(c), true); }).join('') + '</div>';
      var pn = rows.filter(function (c) { return pinned.indexOf(c.group + '|' + c.category) !== -1; });
      if (pn.length) html += '<div class="pgroup">Pinned</div><div class="pcard">' + pn.map(function (c) { return row(c, isSel(c), true); }).join('') + '</div>';
    }
    var groups = {}, order = [];
    rows.forEach(function (c) {
      if (q && c.category.toLowerCase().indexOf(q) === -1 && String(c.group || '').toLowerCase().indexOf(q) === -1) return;
      var g = held || c.held ? 'Held for others (not my money)' : (c.group || 'Other');
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(c);
    });
    order.forEach(function (g) { html += '<div class="pgroup">' + esc(g) + '</div><div class="pcard">' + groups[g].map(function (c) { return row(c, isSel(c), false); }).join('') + '</div>'; });
    if (held && !q && !state.pick.noNew) html += '<div class="pcard" style="margin-top:14px"><button type="button" class="prow add" data-cat="__new">+ Add a new kind…</button></div>';
    if (!order.length && q) html += '<p class="note" style="padding:14px 4px">Nothing matches "' + esc(q) + '".</p>';
    $('pickList').innerHTML = html; bindPick();
  }
  function openPicker(opts) {
    state.pick = opts;
    $('pickTitle').textContent = opts.title || 'Category';
    $('pickSearch').value = ''; pickList(''); $('picker').hidden = false; $('picker').scrollTop = 0;
  }
  $('accBtn').addEventListener('click', function () {
    var k = state.kind, mode = (k === 'transfer' || k === 'payment') ? 'from' : 'any';
    openPicker({ items: accItems(mode), selected: $('addAcc').value, title: $('accLabel').textContent, onPick: function (v) { setAcc(v); } });
  });
  $('toBtn').addEventListener('click', function () {
    openPicker({ items: accItems(state.kind === 'payment' ? 'card' : 'to'), selected: $('addTo').value, title: $('toLabel').textContent, onPick: function (v) { setTo(v); } });
  });
  $('catBtn').addEventListener('click', function () {
    openPicker({ held: state.kind === 'held', payee: $('addPayee').value, selected: state.addCat, title: state.kind === 'held' ? 'What kind of money' : 'Category', onPick: function (name, group) {
      setCat(name, group); if (name === '__new') setTimeout(function () { $('addNewType').focus(); }, 50);
    } });
  });
  $('pickSearch').addEventListener('input', function () { pickList($('pickSearch').value); });
  $('pickBack').addEventListener('click', function () { $('picker').hidden = true; });
  $('addCur').addEventListener('change', function () { setCur($('addCur').value); });
  $('addIdr').addEventListener('input', function () { fmtAmt($('addIdr')); });
  $('addNewType').addEventListener('input', function () { $('addMsg').textContent = ''; });
  $('addBtn').addEventListener('click', openAdd);
  $('addCancel').addEventListener('click', closeAdd); $('sheetBack').addEventListener('click', closeAdd);
  $('kindSpent').addEventListener('click', function () { setKind('spent'); }); $('kindGot').addEventListener('click', function () { setKind('got'); });
  $('kindTransfer').addEventListener('click', function () { setKind('transfer'); }); $('kindPay').addEventListener('click', function () { setKind('payment'); });
  $('kindHeld').addEventListener('click', function () { setKind('held'); });
  /* ---------- Amount keypad: digits plus + − × ÷, like YNAB. The phone's own number pad has no calculator keys. ---------- */
  var KEYS = [['7', '7'], ['8', '8'], ['9', '9'], ['/', '÷', 'op'], ['4', '4'], ['5', '5'], ['6', '6'], ['*', '×', 'op'], ['1', '1'], ['2', '2'], ['3', '3'], ['-', '−', 'op'], ['L', '000'], ['0', '0'], ['bk', '⌫'], ['+', '+', 'op'], ['=', '=', 'op'], ['done', 'Done', 'done']];
  $('keypad').innerHTML = KEYS.map(function (k) { return '<button type="button" data-k="' + k[0] + '" class="' + (k[2] || '') + '"' + (k[0] === 'L' ? ' id="kpLeft"' : '') + '>' + k[1] + '</button>'; }).join('');
  state.expr = '';
  function isForeign() { return $('addCur').value !== 'IDR' && state.kind === 'spent'; }
  function renderKeyLeft() { $('kpLeft').textContent = isForeign() ? '.' : '000'; }
  /** Evaluates 45000+12000×2. × and ÷ first. A trailing sign is ignored. Returns NaN if it makes no sense. */
  function calc(expr) {
    var t = String(expr).match(/\d+(?:\.\d*)?|[+\-*\/]/g) || [];
    if (t.length && /^[+\-*\/]$/.test(t[t.length - 1])) t.pop();
    if (!t.length || /^[+\-*\/]$/.test(t[0])) return NaN;
    var a = [Number(t[0])], i, r;
    for (i = 1; i < t.length; i += 2) {
      var op = t[i], n = Number(t[i + 1]);
      if (op === '*') a[a.length - 1] *= n;
      else if (op === '/') a[a.length - 1] = n === 0 ? NaN : a[a.length - 1] / n;
      else { a.push(op); a.push(n); }
    }
    r = a[0];
    for (i = 1; i < a.length; i += 2) r = a[i] === '+' ? r + a[i + 1] : r - a[i + 1];
    return r;
  }
  function showExpr(e) {
    var d = e.replace(/\d+(?:\.\d*)?/g, function (m) { return isForeign() ? m : Number(m).toLocaleString('id-ID'); }).replace(/\*/g, '×').replace(/\//g, '÷').replace(/-/g, '−');
    $('addAmount').value = d;
    $('addAmount').style.fontSize = d.length > 16 ? '26px' : d.length > 11 ? '34px' : '';
  }
  function setExpr(e) { state.expr = e; showExpr(e); }
  function press(k) {
    var e = state.expr, last = e.slice(-1), isOp = function (c) { return /[+\-*\/]/.test(c); };
    var curNum = (e.match(/[\d.]+$/) || [''])[0];
    if (/^\d$/.test(k)) { if (curNum === '0') e = e.slice(0, -1); e += k; }
    else if (k === 'L') {
      if (isForeign()) { if (curNum.indexOf('.') === -1) e += curNum ? '.' : '0.'; }
      else if (curNum && curNum !== '0') e += '000';
    }
    else if (k === 'bk') e = e.slice(0, -1);
    else if (isOp(k)) { if (!e) return; e = isOp(last) ? e.slice(0, -1) + k : e + k; }
    else if (k === '=' || k === 'done') {
      if (/[+\-*\/]/.test(e)) {
        var v = calc(e);
        if (isNaN(v) || v <= 0) { banner('That sum does not give an amount above zero.', true); return; }
        e = String(isForeign() ? Math.round(v * 100) / 100 : Math.round(v));
      }
    }
    setExpr(e);
    if (k === 'done') { closeKeypad(); if (!$('addPayee').value) $('addPayee').focus(); }
  }
  function openKeypad() { renderKeyLeft(); $('keypad').classList.remove('off'); document.body.classList.add('kp'); }
  function closeKeypad() { $('keypad').classList.add('off'); document.body.classList.remove('kp'); }
  function keypadOpen() { return !$('keypad').classList.contains('off'); }
  $('keypad').querySelectorAll('[data-k]').forEach(function (b) { b.addEventListener('click', function () { press(b.getAttribute('data-k')); }); });
  /* Tap the amount to bring the keypad back. */
  document.querySelector('.amtwrap').addEventListener('click', function (ev) { if (!ev.target.closest('select')) openKeypad(); });
  /* Scrolling the form slides the keypad down so it never sits on top of the fields. */
  var kpScroll = 0;
  $('sheet').addEventListener('scroll', function () {
    var st = $('sheet').scrollTop;
    if (keypadOpen() && st > 0 && Math.abs(st - kpScroll) > 6) closeKeypad();
    kpScroll = st;
  }, { passive: true });
  $('addCur').addEventListener('change', openKeypad);
  /* Tapping any other field puts the keypad away so the phone's keyboard can show. */
  $('sheet').addEventListener('click', function (ev) { if (!ev.target.closest('.amtwrap') && !ev.target.closest('.seg')) closeKeypad(); });
  /* A hardware keyboard (iPad) works too. */
  document.addEventListener('keydown', function (ev) {
    if (!keypadOpen() || $('sheet').hidden) return;
    var k = ev.key;
    if (/^\d$/.test(k) || /^[+\-*\/]$/.test(k)) press(k);
    else if (k === '.') press('L');
    else if (k === 'Backspace') press('bk');
    else if (k === 'Enter' || k === '=') press('=');
    else return;
    ev.preventDefault();
  });
  var saving = false;
  $('addSave').addEventListener('click', function () {
    if (saving) return;
    var k = state.kind, cur = $('addCur').value, foreign = cur !== 'IDR' && k === 'spent', calced = calc(state.expr || '');
    var amt = foreign ? Math.round(calced * 100) / 100 : Math.round(calced), typedIdr = foreign ? Number($('addIdr').value.replace(/[^\d]/g, '')) : 0, payee = $('addPayee').value.trim(), cat = state.addCat;
    var move = k === 'transfer' || k === 'payment', acct = $('addAcc').value, to = $('addTo').value;
    var m = $('addMsg'); m.textContent = '';
    function fail(msg) { m.textContent = msg; banner(msg, true); }
    var nowStamp = localIso(), todayIso = nowStamp.slice(0, 10), dateVal = $('addDate').value || todayIso;
    if (!amt || isNaN(amt) || amt <= 0) return fail('Type the amount as a number above zero.');
    if (!move && !payee) return fail(k === 'got' ? 'Type who it came from.' : 'Type who or what it was for.');
    if (dateVal > todayIso) return fail('The date cannot be in the future.');
    if (k === 'transfer') { if (!acct || acct === 'Cash') return fail('Choose the account the money leaves from.'); if (!to) return fail('Choose the account the money goes to.'); if (to === acct) return fail('Choose two different accounts.'); }
    if (k === 'payment') { if (!acct || acct === 'Cash') return fail('Choose the account the payment came from.'); if (!to) return fail('Choose the card that was paid.'); }
    // An older server cannot take these yet. Say so now, plainly, instead of losing the entry later.
    if ((state.apiV || 1) < 2 && k === 'spent' && !cat) return fail('Choose a category. Saving without one needs the Hanaro server update.');
    if ((state.apiV || 1) < 2 && dateVal !== todayIso) return fail('Past dates need the Hanaro server update. Use today for now.');
    if (k === 'held' && !cat) return fail('Choose what kind of money this is.');
    var newName = $('addNewType').value.trim();
    if (k === 'held' && cat === '__new' && !newName) return fail('Type a name for the new kind, for example Seminar fees.');
    saving = true; setTimeout(function () { saving = false; }, 600);
    // Saved on this device right away; sent in the background. The id is made here, so sending twice never adds twice.
    var kind = { spent: 'purchase', got: 'income', held: 'held', transfer: 'transfer', payment: 'payment' }[k], memo = $('addMemo').value.trim(), id = newId();
    if (!move) LS.set('hanaro.lastacct', acct);
    var geo = state.geo, photo = state.photo;
    if (geo && k === 'spent') addPlaces([{ lat: geo.lat, lng: geo.lng, payee: payee, category: cat, account: acct }]);
    var label = (foreign ? cur + ' ' + amt.toFixed(2) : rp(amt)) + ' ' + (move ? (k === 'payment' ? 'card payment' : 'transfer') : payee);
    if (k === 'held' && cat === '__new') {
      cat = 'Held: ' + newName.replace(/^Held:\s*/i, '').trim();
      if (!state.cats.some(function (c) { return c.category === cat; })) state.cats.push({ category: cat, bucket: '', held: true });
      var cc = snap('categories'); if (cc) { cc.d.categories = state.cats; save('categories', cc.d); }
      queue.push({ action: 'add_held_type', args: { name: newName }, label: 'the new kind ' + newName });
    }
    closeAdd(); banner('Saved');
    var args = { id: id, kind: kind, currency: foreign ? cur : 'IDR', idr_amount: typedIdr || undefined, amount: amt, payee: move ? undefined : payee, category: move ? undefined : cat, account: acct, memo: memo, date: dateVal, at: nowStamp, group: move ? undefined : (state.addGroup || groupFor(cat) || undefined), lat: geo ? geo.lat : null, lng: geo ? geo.lng : null, photo: photo || undefined };
    if (k === 'transfer') args.toAccount = to; if (k === 'payment') args.card = to;
    send('add_txn', args, label).then(afterWrite);
    paintCurrent();
  });

  /* ---------- start ---------- */
  function start() {
    $('setup').hidden = true; $('app').hidden = false; $('nav').hidden = false;
    renderNav();
    var t0 = performance.now();
    E.load().then(function (ok) { if (ok) pushViews(); render(); state.openMs = Math.round(performance.now() - t0); });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && conf().key && $('sheet').hidden && $('dlg').hidden) { if (queue.length) flush().then(afterWrite); render(); } });
  window.addEventListener('online', function () { state.offline = false; if (conf().key) { flush().then(afterWrite); setPill(); } });
  window.addEventListener('offline', function () { state.offline = true; setPill(); });
  window.addEventListener('error', function (e) { if (/ResizeObserver/.test(e.message || '')) return; banner('Something broke in the app: ' + e.message, true); });
  window.addEventListener('unhandledrejection', function (e) { banner('Something went wrong: ' + (e.reason && e.reason.message || e.reason), true); });
  /* A new version of the app: say so once and offer to reload. */
  if ('serviceWorker' in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(function () {});
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController) banner('Hanaro was updated.', false, 0, { label: 'Reload', fn: function () { location.reload(); } });
      hadController = true;
    });
  }
  /* Pull down at the top of a screen to refresh. */
  (function () {
    var y0 = null, pulled = 0, ind = null;
    function top() { return (window.scrollY || document.documentElement.scrollTop || 0) <= 0; }
    document.addEventListener('touchstart', function (ev) { if (top() && $('sheet').hidden && $('picker').hidden && $('txnEdit').hidden && $('catSheet').hidden && $('moveSheet').hidden && $('planNext').hidden && $('budSettings').hidden && $('dlg').hidden && ev.touches.length === 1) { y0 = ev.touches[0].clientY; pulled = 0; } else y0 = null; }, { passive: true });
    document.addEventListener('touchmove', function (ev) {
      if (y0 === null) return;
      pulled = ev.touches[0].clientY - y0;
      if (pulled > 8 && top()) { if (!ind) { ind = document.createElement('div'); ind.className = 'ptr'; document.body.appendChild(ind); } ind.textContent = pulled > 80 ? 'Release to refresh' : 'Pull to refresh'; ind.style.opacity = Math.min(1, pulled / 80); ind.style.transform = 'translateY(' + Math.min(pulled / 2, 50) + 'px)'; }
    }, { passive: true });
    document.addEventListener('touchend', function () {
      if (ind) { ind.remove(); ind = null; }
      if (y0 !== null && pulled > 80 && conf().key) { bootP = null; state.offline = false; render(true); }
      y0 = null; pulled = 0;
    }, { passive: true });
  })();
  parseHash();
  if (conf().url && conf().key) start(); else showSetup('');
})();
