/* Hanaro app. Plain JavaScript, no build step. The link and key live only in this device's storage. */
(function () {
  'use strict';
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var $ = function (id) { return document.getElementById(id); };
  var state = { pick: { held: false, selected: '', onPick: function () {} }, geo: null, photo: null, token: 0, busy: false, err: false, sync: null, view: 'home', filter: 'all', later: {}, cats: null, accounts: [], kind: 'spent', counts: { review: 0 } };

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
  var bannerTimer;
  function banner(msg, bad, ms) {
    var b = $('banner'); b.textContent = msg; b.className = bad ? 'bad' : ''; b.hidden = false;
    clearTimeout(bannerTimer);
    if (ms !== 0) bannerTimer = setTimeout(function () { b.hidden = true; }, ms || (bad ? 7000 : 2500));
  }

  /* ---------- API ---------- */
  function conf() { return { url: LS.get('hanaro.url'), key: LS.get('hanaro.key') }; }
  function api(action, args) {
    var c = conf();
    if (!c.url || !c.key) return Promise.reject(new Error('This device is not connected yet.'));
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 30000);
    var body = JSON.stringify(Object.assign({ key: c.key, action: action }, args || {}));
    return fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body, signal: ctl.signal, redirect: 'follow' })
      .then(function (r) { return r.json(); }, function () { throw new Error('Cannot reach Hanaro. Check your internet connection.'); })
      .then(function (j) {
        clearTimeout(t);
        if (!j.ok) throw new Error(j.error || 'Something went wrong.');
        return j.data;
      }, function (e) {
        clearTimeout(t);
        if (e instanceof SyntaxError) throw new Error('Hanaro sent back something unreadable. Check the link is the latest one and that its access is set to Anyone.');
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
  function snap(k) { var raw = LS.get('hanaro.cache.' + k); try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
  function save(k, d) { LS.set('hanaro.cache.' + k, JSON.stringify({ at: Date.now(), d: d })); }
  function patch(k, fn) { var c = snap(k); if (!c) return; fn(c.d); save(k, c.d); }
  function readQueue() { try { return JSON.parse(LS.get('hanaro.queue') || '[]'); } catch (e) { return []; } }
  var queue = readQueue(), flushing = null, bootP = null;
  function saveQueue() { LS.set('hanaro.queue', JSON.stringify(queue)); setPill(); }
  /** Changes are saved on this device first, then sent. If there is no connection they wait and retry. */
  function send(action, args, label) { queue.push({ action: action, args: args, label: label }); saveQueue(); return flush(); }
  function flush() {
    if (flushing) return flushing;
    flushing = (function next() {
      if (!queue.length) return Promise.resolve(true);
      var q = queue[0];
      return api(q.action, q.args).then(function () { queue.shift(); saveQueue(); return next(); }, function (e) {
        if (/Cannot reach/.test(e.message)) return false;
        queue.shift(); saveQueue();
        banner('Could not save ' + (q.label || 'a change') + '. ' + e.message + ' Please enter it again.', true, 0);
        return next();
      });
    })().then(function (ok) { flushing = null; return ok; });
    return flushing;
  }
  function useCats(c) { state.cats = c.categories; state.accounts = c.accounts; }
  function setWho(u) { if (u) { $('whoName').textContent = u.name; $('avatar').textContent = u.name.slice(0, 2).toUpperCase(); } }
  /** One request brings Home, Review, Activity and the category list. */
  function refresh() {
    return flush().then(function () {
      if (queue.length) throw new Error('Cannot reach Hanaro. Check your internet connection.');
      if (!bootP) bootP = api('bootstrap').then(function (b) {
        ['home', 'review', 'activity', 'categories', 'plan'].forEach(function (k) { if (b[k]) save(k, b[k]); });
        addPlaces(b.activity.items.map(function (t) { return { lat: t.lat, lng: t.lng, payee: t.payee, category: t.category, account: t.account }; }));
        useCats(b.categories); setWho(b.home.user); state.counts.review = b.home.reviewCount; renderNav();
        bootP = null; return b;
      }, function (e) {
        bootP = null;
        if (/does not know/.test(e.message)) throw new Error('Hanaro needs its server update. Paste the newest API code and redeploy it.');
        throw e;
      });
      return bootP;
    });
  }
  function editing(v) { var a = document.activeElement; return !!(a && v.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName)); }
  function localIso() {
    var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + 'T' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds()) + '+07:00';
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

  /* ---------- shell ---------- */
  var ICONS = {
    home: '<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
    review: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/>',
    activity: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    spending: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
    status: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>'
  };
  var LABELS = { home: 'HOME', review: 'REVIEW', activity: 'ACTIVITY', spending: 'SPENDING', status: 'STATUS' };
  function renderNav() {
    document.querySelectorAll('nav [data-go]').forEach(function (b) {
      var v = b.getAttribute('data-go'), on = state.view === v || (v === 'status' && state.view === 'payees') || (v === 'spending' && state.view === 'activity');
      b.className = on ? 'on' : '';
      b.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[v] + '</svg>' +
        (on ? (state.view === 'activity' && v === 'spending' ? 'ACTIVITY' : LABELS[v]) : '') + (v === 'review' && state.counts.review ? '<span class="badge">' + state.counts.review + '</span>' : '');
    });
  }
  function setPill(iso, err) {
    if (iso !== undefined) state.sync = iso;
    if (err !== undefined) state.err = err;
    var p = $('syncPill'), a = ago(state.sync);
    var stale = !state.sync || (Date.now() - Date.parse(state.sync)) > 2 * 3600 * 1000;
    if (queue.length) { p.textContent = 'Sending ' + queue.length + '…'; p.className = 'pill'; return; }
    if (state.busy) { p.textContent = 'Updating…'; p.className = 'pill'; return; }
    p.textContent = state.err ? 'Not synced' : (a ? 'Synced ' + a : 'No sync yet');
    p.className = 'pill' + (stale || state.err ? ' bad' : '');
  }
  function go(v) { state.view = v; renderNav(); render(); window.scrollTo(0, 0); }
  document.querySelectorAll('nav [data-go]').forEach(function (b) { b.addEventListener('click', function () { go(b.getAttribute('data-go')); }); });
  $('syncPill').addEventListener('click', function () { render(); });

  var TITLE = 'font-size:30px;font-weight:300;letter-spacing:-.5px;margin:6px 0 0 2px';
  function usable(name, c) { return c && (name !== 'home' || c.d.spentToday !== undefined) && (name !== 'spending' || c.d.fixed !== undefined); }
  function render() {
    var v = $('view'), name = state.view, tok = ++state.token;
    if (name === 'status') return renderStatus(v, tok);
    if (name === 'payees') return renderPayees(v, tok);
    var paint = { home: paintHome, review: paintReview, activity: paintActivity, spending: paintSpending }[name];
    var ck = name === 'spending' ? 'plan' : name;
    var c = snap(ck); if (!usable(name, c)) c = null;
    if (c) paint(v, c.d); else v.innerHTML = '<div class="empty">Loading…</div>';
    state.busy = true; setPill();
    refresh().then(function () {
      state.busy = false; setPill(undefined, false);
      if (tok !== state.token || editing(v)) return;
      var fresh = snap(ck);
      if (!fresh) { v.innerHTML = '<div class="card"><div class="label">Needs a server update</div><p class="note">Hanaro did not send the plan. Paste the newest API code into the Apps Script project and deploy it again, then reopen this screen.</p></div>'; return; }
      paint(v, fresh.d);
    }, function (e) {
      state.busy = false; setPill(undefined, true);
      if (tok !== state.token) return;
      if (/not recognised/.test(e.message)) { LS.del('hanaro.key'); showSetup(e.message); return; }
      if (c) { banner(/Cannot reach/.test(e.message) ? 'Offline. Showing what was saved ' + ago(new Date(snap(ck).at).toISOString()) + '.' : e.message, true, 6000); return; }
      v.innerHTML = '<div class="card"><div class="label">Could not load</div><p class="note">' + esc(e.message) + '</p><button class="ghost small" id="retry">Try again</button></div>';
      $('retry').addEventListener('click', render);
      banner(e.message, true);
    });
  }

  /* ---------- Home ---------- */
  function paintHome(v, h) {
    state.counts.review = h.reviewCount; renderNav(); LS.set('hanaro.lastsync', h.lastSync || ''); setPill(h.lastSync); setWho(h.user);
    var b = bigParts(h.spentToday);
    var html = '<div style="' + TITLE + '">Today</div>';
    html += '<div class="card"><div class="label">Spent today</div><div class="big"><span class="rp">Rp</span><span class="n">' + esc(b.n) + '</span><span class="z">' + esc(b.z) + '</span></div>' +
      '<div style="font-size:14px">' + (h.spentTodayCount ? h.spentTodayCount + ' purchase' + (h.spentTodayCount === 1 ? '' : 's') : 'Nothing spent yet today') + '</div><div class="rule"></div>' +
      '<div class="two"><div><div class="tiny muted">This week</div><div class="stat">' + rpShort(h.spentWeek) + '</div></div><div class="sep"></div><div><div class="tiny muted">This month</div><div class="stat">' + rpShort(h.spentMonth) + '</div></div></div>' +
      '<p class="note" style="margin-top:8px">About ' + rp(h.avgPerDay) + ' a day so far this month. Transfers, card payments, business accounts and money held for others are not counted.</p></div>';
    if (h.pacing) {
      var pc = h.pacing, pct = Math.max(0, Math.min(100, pc.amount ? pc.spent / pc.amount * 100 : 0));
      var word = { on: 'On pace', near: 'Close to the line', over: 'Over the line' }[pc.status];
      html += '<div class="card"><div class="cardhead"><div class="label">Flexible spending</div><div class="tiny ' + (pc.status === 'on' ? '' : 'bad') + '" style="font-weight:700;color:' + (pc.status === 'on' ? 'var(--good)' : pc.status === 'near' ? 'var(--yellowText)' : 'var(--warn)') + '">' + word + '</div></div>' +
        '<div class="big" style="margin-top:4px"><span class="mid">' + rpShort(pc.spent) + '</span><span class="note" style="margin-left:8px">of ' + rpShort(pc.amount) + ' planned</span></div>' +
        '<div class="pace ' + pc.status + '"><div class="f" style="width:' + pct.toFixed(1) + '%"></div><div class="tick" style="left:' + (pc.dayFrac * 100).toFixed(1) + '%"></div></div>' +
        '<div class="pacefoot"><span>Day ' + pc.day + ' of ' + pc.daysInMonth + '</span><span>' + (pc.under >= 0 ? rpShort(pc.under) + ' under the line' : rpShort(-pc.under) + ' over the line') + '</span></div>' +
        '<p class="note" style="margin-top:6px">About ' + rp(pc.perDay) + ' a day left for ' + pc.daysLeft + ' days.</p></div>';
    } else if (!h.hasPlan) {
      html += '<div class="card"><div class="label">Plan</div><p class="note">Set a planned amount for the month and Home will show how you are pacing.</p><button class="ghost small" data-go-spending>Set the plan</button></div>';
    }
    if (h.compare && h.compare.hasLast) {
      var cp = h.compare;
      html += '<div class="card" style="flex-direction:row;justify-content:space-between;align-items:center"><div><div style="font-size:14px;font-weight:600">' + (cp.diff >= 0 ? rpShort(cp.diff) + ' less' : rpShort(-cp.diff) + ' more') + ' than last month</div><div class="note">at this point in the month</div></div>' + spark(cp.thisSeries, cp.lastSeries) + '</div>';
    }
    if (h.toPayCount || h.billsWeek.length) {
      html += '<div class="card"><div class="label">Left to pay</div>';
      if (h.toPayCount) html += '<div class="kv"><span>Card charges not paid yet (' + h.toPayCount + ')</span><b>' + rp(h.toPayTotal) + '</b></div>';
      h.billsWeek.forEach(function (o) { html += '<div class="kv"><span>' + esc(o.name) + '<div class="sub">Due ' + dayLabel(o.due) + '</div></span><span>' + rp(o.amount) + '</span></div>'; });
      if (h.toPayCount) html += '<div class="btnrow"><button class="ghost small" data-go-review>See them</button><button class="primary small" data-paid-all>I paid them all</button></div><p class="note">Paid everything in one payment? Hanaro also notices a lump sum by itself when the bank email arrives.</p>';
      html += '</div>';
    }
    if (h.heldByType && h.heldByType.length) {
      html += '<div class="card"><div class="label">Held for others</div><div class="stat' + (h.heldTotal < 0 ? ' bad' : '') + '" style="margin-top:2px">' + rp(h.heldTotal) + '</div>' +
        h.heldByType.map(function (x) { return '<div class="kv"><span>' + esc(x.type) + '</span><span class="' + (x.amount < 0 ? 'bad' : 'muted') + '">' + rp(x.amount) + '</span></div>'; }).join('') +
        '<p class="note">' + (h.heldTotal < 0 ? 'You have sent out more than you were given. An entry for money received may be missing.' : 'This is other people\'s money. It is not counted as yours.') + '</p></div>';
    }
    if (h.reviewCount) html += '<button class="ghost" data-go-review>' + h.reviewCount + ' item' + (h.reviewCount === 1 ? '' : 's') + ' need you</button>';
    v.innerHTML = html;
    v.querySelectorAll('[data-go-review]').forEach(function (r) { r.addEventListener('click', function () { go('review'); }); });
    v.querySelectorAll('[data-go-spending]').forEach(function (r) { r.addEventListener('click', function () { go('spending'); }); });
    var pa = v.querySelector('[data-paid-all]');
    if (pa) pa.addEventListener('click', function () {
      var rc = snap('review'), list = rc ? rc.d.items.filter(function (i) { return i.kind === 'pay_now'; }) : [];
      if (!list.length) { banner('Open Review once so Hanaro can load the charges, then try again.', true); return; }
      if (!confirm('Mark ' + list.length + ' card charges as paid? Only do this if you already paid them.')) return;
      applyMany(list, function (i) { return { action: 'mark_paid', args: { id: i.txn.id } }; }, 'paid').then(function () {});
      var c = snap('home'); if (c) paintHome(v, c.d);
    });
  }


  /* ---------- Spending: the plan in three buckets ---------- */
  function spark(a, b) {
    var n = Math.max(a.length, b.length), mx = Math.max(1, a[a.length - 1] || 0, b[b.length - 1] || 0);
    function path(s) { return s.map(function (y, i) { return (i ? 'L' : 'M') + (2 + 92 * i / Math.max(1, n - 1)).toFixed(1) + ' ' + (33 - 29 * y / mx).toFixed(1); }).join(''); }
    var ex = 2 + 92 * (a.length - 1) / Math.max(1, n - 1), ey = 33 - 29 * (a[a.length - 1] || 0) / mx;
    return '<svg width="96" height="36" viewBox="0 0 96 36" role="img" aria-label="This month against last month, running total"><path d="' + path(b) + '" fill="none" stroke="#B7DAD6" stroke-width="2" stroke-linecap="round"/><path d="' + path(a) + '" fill="none" stroke="#0B6F7A" stroke-width="2.5" stroke-linecap="round"/><circle cx="' + ex.toFixed(1) + '" cy="' + ey.toFixed(1) + '" r="3.5" fill="#F28DB0"/></svg>';
  }
  var PM = { '01': 'January', '02': 'February', '03': 'March', '04': 'April', '05': 'May', '06': 'June', '07': 'July', '08': 'August', '09': 'September', '10': 'October', '11': 'November', '12': 'December' };
  function paintSpending(v, p) {
    var html = '<div style="' + TITLE + '">Spending</div>';
    html += '<div class="card"><div class="label">Planned for ' + PM[p.month.slice(5, 7)] + '</div><div class="big"><span class="rp">Rp</span><span class="n">' + esc(bigParts(p.planned).n) + '</span><span class="z">' + esc(bigParts(p.planned).z) + '</span></div>' +
      '<p class="note">Fixed bills, money set aside for yearly costs, and one flexible number for everything else.</p></div>';
    html += '<div class="card" style="gap:0"><div class="cardhead"><div class="label">Fixed</div><span class="note">' + rpShort(p.fixedTotal) + '</span></div>';
    p.fixed.forEach(function (f, i) {
      var tag = { paid: '<span class="tag paid">PAID</span>', soon: '<span class="tag soon">IN ' + f.daysTo + ' DAY' + (f.daysTo === 1 ? '' : 'S') + '</span>', late: '<span class="tag late">OVERDUE</span>', later: f.due ? '<span class="tag gray">LATER</span>' : '' }[f.status];
      html += '<button class="prow2" data-edit="fixed" data-i="' + i + '"><span class="l"><span class="p">' + esc(f.item) + '</span><span class="s">' + (f.dueDay ? 'Due on the ' + f.dueDay + (f.dueDay === 1 ? 'st' : f.dueDay === 2 ? 'nd' : f.dueDay === 3 ? 'rd' : 'th') : 'No due day') + '</span></span><span class="r">' + rp(f.amount) + ' ' + tag + '</span></button>';
    });
    if (!p.fixed.length) html += '<p class="note" style="padding:10px 0 0">Rent, school fees, internet and other bills that are the same every month.</p>';
    html += '<button class="addrow" data-add="fixed">+ Add a fixed bill</button></div>';
    html += '<div class="card" style="gap:0"><div class="cardhead"><div class="label">Non-monthly</div><span class="note">' + rpShort(p.setAsideTotal) + ' set aside</span></div>';
    p.nonmonthly.forEach(function (n, i) {
      html += '<button class="prow2" data-edit="nonmonthly" data-i="' + i + '"><span class="l"><span class="p">' + esc(n.item) + '</span><span class="s">Every ' + n.every + ' month' + (n.every === 1 ? '' : 's') + ', ' + rp(n.target) + '</span></span><span class="r">' + rp(n.setAside) + '<span class="s">a month</span></span></button>';
    });
    if (!p.nonmonthly.length) html += '<p class="note" style="padding:10px 0 0">Costs that come once in a while, like car service or annual tax. Hanaro spreads each one over the months so it never surprises you.</p>';
    html += '<button class="addrow" data-add="nonmonthly">+ Add a yearly or occasional cost</button></div>';
    var f = p.flexible;
    if (f) {
      html += '<button class="card" data-edit="flexible" style="border:0;text-align:left;font:inherit;color:inherit;width:100%"><div class="cardhead"><div class="label">Flexible</div><span class="note">one number</span></div>' +
        '<div class="big" style="margin-top:4px"><span class="rp" style="font-size:18px">Rp</span><span class="n" style="font-size:36px;color:var(--text)">' + esc(bigParts(f.amount).n) + '</span><span class="z" style="font-size:18px">' + esc(bigParts(f.amount).z) + '</span></div>' +
        '<div class="pace ' + f.status + '"><div class="f" style="width:' + Math.max(0, Math.min(100, f.amount ? f.spent / f.amount * 100 : 0)).toFixed(1) + '%"></div><div class="tick" style="left:' + (f.dayFrac * 100).toFixed(1) + '%"></div></div>' +
        '<div class="pacefoot"><span>' + rpShort(f.spent) + ' spent</span><span style="color:' + (f.left >= 0 ? 'var(--good)' : 'var(--warn)') + ';font-weight:700">' + (f.left >= 0 ? rpShort(f.left) + ' left' : rpShort(-f.left) + ' over') + ' · ' + f.daysLeft + ' days</span></div>' +
        '<p class="note" style="margin-top:4px">Everything that is not a fixed or non-monthly item: groceries, eating out, fuel, fun. No limits per category.</p></button>';
    } else {
      html += '<div class="card"><div class="label">Flexible</div><p class="note">One number for groceries, eating out, fuel, fun and everything else that moves.' + (p.suggestFlexible ? ' You spent about ' + rpShort(p.suggestFlexible) + ' a month on this over the last 3 months.' : '') + '</p>' +
        '<button class="primary small" data-add="flexible"' + (p.suggestFlexible ? ' data-suggest="' + p.suggestFlexible + '"' : '') + '>' + (p.suggestFlexible ? 'Use ' + rpShort(p.suggestFlexible) : 'Set the flexible number') + '</button></div>';
    }
    html += '<button class="ghost" data-go-activity>See all transactions</button>';
    v.innerHTML = html;
    v.querySelectorAll('[data-edit]').forEach(function (b) { b.addEventListener('click', function () {
      var k = b.getAttribute('data-edit'), i = Number(b.getAttribute('data-i'));
      openPlan(k, k === 'fixed' ? p.fixed[i] : k === 'nonmonthly' ? p.nonmonthly[i] : p.flexible);
    }); });
    v.querySelectorAll('[data-add]').forEach(function (b) { b.addEventListener('click', function () { openPlan(b.getAttribute('data-add'), null, Number(b.getAttribute('data-suggest')) || 0); }); });
    v.querySelector('[data-go-activity]').addEventListener('click', function () { go('activity'); });
  }
  function openPlan(kind, row, suggest) {
    state.plan = { kind: kind, row: row };
    var titles = { fixed: 'Fixed bill', nonmonthly: 'Yearly or occasional cost', flexible: 'Flexible number' };
    $('planTitle').textContent = (row ? 'Change ' : 'Add ') + titles[kind].toLowerCase();
    $('pfName').hidden = kind === 'flexible'; $('pfDue').hidden = kind !== 'fixed'; $('pfTarget').hidden = kind !== 'nonmonthly'; $('pfEvery').hidden = kind !== 'nonmonthly';
    $('pfAmount').hidden = kind === 'nonmonthly'; $('pfCat').hidden = kind === 'flexible';
    $('planAmountLabel').textContent = kind === 'flexible' ? 'Amount for the month (Rp)' : 'Amount per month (Rp)';
    $('planName').value = row ? row.item : ''; $('planName').disabled = !!row;
    $('planAmount').value = row ? (kind === 'flexible' ? row.amount : row.amount) || '' : (suggest || '');
    $('planDue').value = row && row.dueDay ? row.dueDay : '';
    $('planTarget').value = row && row.target ? row.target : ''; $('planEvery').value = row && row.every ? row.every : '';
    var sel = $('planCat'); sel.innerHTML = '<option value="">None</option>';
    (state.cats || []).filter(function (c) { return !c.held; }).forEach(function (c) { var o = document.createElement('option'); o.value = c.category; o.textContent = c.category; sel.appendChild(o); });
    sel.value = row && row.category ? row.category : '';
    $('planHint').textContent = { fixed: 'Pick the category it is paid under so Hanaro can mark it paid by itself.', nonmonthly: 'Hanaro sets aside the target divided by the months. Pick the category so spending on it shows up here.', flexible: 'Fixed and non-monthly categories are left out of this number.' }[kind];
    $('planMsg').textContent = ''; $('planRemove').hidden = !row || kind === 'flexible';
    $('planEdit').hidden = false; window.scrollTo(0, 0);
  }
  function closePlan() { $('planEdit').hidden = true; }
  $('planBack').addEventListener('click', closePlan);
  var digits = function (id) { return Number($(id).value.replace(/[^\d]/g, '')); };
  $('planSave').addEventListener('click', function () {
    var p = state.plan, k = p.kind, m = $('planMsg'); m.textContent = '';
    var args = { kind: k, item: p.row ? p.row.item : $('planName').value.trim(), category: $('planCat').value };
    if (k !== 'flexible' && !args.item) { m.textContent = 'Type a name for this item.'; return; }
    if (k === 'nonmonthly') {
      args.target = digits('planTarget'); args.every = digits('planEvery');
      if (!args.target) { m.textContent = 'Type the target amount as a number.'; return; }
      if (!args.every) { m.textContent = 'Type how many months it covers, for example 6 or 12.'; return; }
    } else {
      args.amount = digits('planAmount');
      if (!args.amount) { m.textContent = 'Type the amount as a number.'; return; }
      if (k === 'fixed') { var dd = digits('planDue'); args.dueDay = $('planDue').value.trim() === '' ? '' : dd; if (args.dueDay !== '' && (dd < 1 || dd > 31)) { m.textContent = 'The due day must be from 1 to 31.'; return; } }
    }
    closePlan(); banner('Saved');
    send('set_plan', args, 'the plan for ' + (args.item || 'Flexible')).then(function (ok) { if (ok && !queue.length) { bootP = null; render(); } });
  });
  $('planRemove').addEventListener('click', function () {
    var p = state.plan; if (!p.row) return;
    if (!confirm('Remove ' + p.row.item + ' from the plan?')) return;
    closePlan(); banner('Removed');
    send('remove_plan', { item: p.row.item, kind: p.kind }, 'removing ' + p.row.item).then(function (ok) { if (ok && !queue.length) { bootP = null; render(); } });
  });

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
        openPicker({ held: false, both: true, selected: b.getAttribute('data-val'), title: 'Category', noNew: true, onPick: function (name) {
          b.setAttribute('data-val', name);
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
      // Bulk helpers so a backlog does not need one tap per item.
      var payNow = shown.filter(function (i) { return i.kind === 'pay_now'; });
      if (payNow.length >= 2) html += '<div class="card"><span class="tag pay">PAY NOW</span><div class="item-top"><div class="p">' + payNow.length + ' card charges not paid yet</div><div class="a">' + rp(payNow.reduce(function (a, i) { return a + (i.txn.amount || 0); }, 0)) + '</div></div><div class="sub">If you already paid these in myBCA, clear them all at once.</div><div class="btnrow"><button class="primary small" data-bulk="paid">Mark all as paid</button></div></div>';
      var ready = shown.filter(function (i) { return i.kind === 'confirm' && i.txn.category; });
      if (ready.length >= 2) html += '<div class="card"><span class="tag new">READY</span><div class="item-top"><div class="p">' + ready.length + ' already have a category</div></div><div class="sub">Looks right? Confirm them all in one tap.</div><div class="btnrow"><button class="primary small" data-bulk="ready">Confirm ' + ready.length + '</button></div></div>';
      var groups = {}, order = [];
      shown.forEach(function (i) {
        if (i.kind === 'confirm' && !i.txn.category) { var k = payeeKey(i.txn.payee); if (k) { if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(i); } }
      });
      var grouped = {};
      order.forEach(function (k) { if (groups[k].length >= 2) { grouped[k] = true; html += groupCard(k, groups[k]); } });
      shown.forEach(function (i) {
        if (i.kind === 'pay_now' && payNow.length >= 2 && state.filter === 'all') return;
        if (i.kind === 'confirm' && !i.txn.category && grouped[payeeKey(i.txn.payee)]) return;
        html += reviewCard(i);
      });
      v.innerHTML = html;
      wirePickBtns(v);
      v.querySelectorAll('[data-bulk]').forEach(function (b) { b.addEventListener('click', function () { bulkAction(b, v, shown); }); });
      v.querySelectorAll('[data-group-go]').forEach(function (b) { b.addEventListener('click', function () { groupAction(b, v, groups); }); });
      v.querySelectorAll('[data-f]').forEach(function (b) { b.addEventListener('click', function () { state.filter = b.getAttribute('data-f'); repaintReview(v); }); });
      v.querySelectorAll('[data-act]').forEach(function (b) { b.addEventListener('click', function () { reviewAction(b, v); }); });
    });
  }
  function payeeKey(p) { return String(p || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40); }
  function groupCard(k, list) {
    var total = list.reduce(function (a, i) { return a + (i.txn.amount || 0); }, 0);
    return '<div class="card"><span class="tag new">SAME PLACE</span><div class="item-top"><div class="p">' + esc(list[0].txn.payee) + ' · ' + list.length + ' times</div><div class="a">' + rp(total) + '</div></div>' +
      '<div class="sub">Pick one category for all of them. Hanaro remembers it for next time.</div>' +
      catBtn('', ' data-group-cat') + '<p class="err" data-err></p>' +
      '<div class="btnrow"><button class="primary small" data-group-go="' + esc(k) + '">Confirm all ' + list.length + '</button></div></div>';
  }
  /** Removes items from the saved copy at once and queues one change per item. */
  function applyMany(items, makeCall, label) {
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
    return flush().then(function (ok) { if (ok && !queue.length) render(); });
  }
  function bulkAction(btn, v, shown) {
    var kind = btn.getAttribute('data-bulk');
    if (kind === 'paid') {
      var list = shown.filter(function (i) { return i.kind === 'pay_now'; });
      if (!confirm('Mark ' + list.length + ' card charges as paid? Only do this if you already paid them.')) return;
      applyMany(list, function (i) { return { action: 'mark_paid', args: { id: i.txn.id } }; }, 'paid');
    } else {
      var ready = shown.filter(function (i) { return i.kind === 'confirm' && i.txn.category; });
      applyMany(ready, function (i) { return { action: 'update_txn', args: { id: i.txn.id, changes: { category: i.txn.category }, confirm: true } }; }, 'ready');
    }
    repaintReview(v);
  }
  function groupAction(btn, v, groups) {
    var card = btn.closest('.card'), cat = card.querySelector('[data-group-cat]').getAttribute('data-val'), err = card.querySelector('[data-err]');
    if (!cat) { err.textContent = 'Choose a category first.'; return; }
    var list = groups[btn.getAttribute('data-group-go')];
    applyMany(list, function (i) { return { action: 'update_txn', args: { id: i.txn.id, changes: { category: cat }, confirm: true } }; }, 'group');
    repaintReview(v);
  }
  function reviewCard(i) {
    var t = i.txn, k = KIND[i.kind], id = esc(t.id);
    var h = '<div class="card" data-id="' + id + '"><span class="tag ' + k[1] + '">' + k[0].toUpperCase() + '</span>';
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
        '<div class="btnrow"><button class="ghost small" data-act="later" data-id="' + id + '">Later</button><button class="primary small" data-act="paid" data-id="' + id + '">I paid it</button></div>';
    } else {
      h += '<div class="item-top"><div class="p">' + esc(t.payee) + '</div>' + amt + '</div><div class="sub">' + esc(when(t.timestamp)) + ' · ' + esc(t.account) + '</div>' +
        catBtn(t.category, ' data-f-cat') + '<p class="err" data-err></p>' +
        '<div class="btnrow"><button class="primary small" data-act="confirm" data-id="' + id + '">Confirm</button></div>';
    }
    return h + '</div>';
  }
  function reviewAction(btn, v) {
    var act = btn.getAttribute('data-act'), id = btn.getAttribute('data-id'), card = btn.closest('.card');
    var err = card.querySelector('[data-err]');
    function fail(m) { if (err) err.textContent = m; else banner(m, true); }
    if (err) err.textContent = '';
    if (act === 'later') { state.later[id] = true; repaintReview(v); return; }
    var action, args, label = 'that change';
    if (act === 'paid') { action = 'mark_paid'; args = { id: id }; }
    else if (act === 'keep_both') { action = 'keep_both'; args = { id: id }; }
    else if (act === 'merge_dup') { action = 'merge_dup'; args = { id: id }; }
    else {
      var cat = card.querySelector('[data-f-cat]').getAttribute('data-val');
      if (!cat) return fail('Choose a category first.');
      var changes = { category: cat };
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
    banner('Saved'); repaintReview(v);
    send(action, args, label).then(function (ok) { if (ok && !queue.length) render(); });
  }

  /* ---------- Activity ---------- */
  function paintActivity(v, d) {
    (function () {
      var html = '<div style="' + TITLE + '">Activity</div>';
      if (!d.items.length) html += '<div class="card empty">Nothing yet.</div>';
      var last = '', open = false;
      d.items.forEach(function (t) {
        if (t.date !== last) { if (open) html += '</div>'; html += '<div class="day">' + dayLabel(t.date).toUpperCase() + '</div><div class="card" style="padding:6px 18px">'; open = true; last = t.date; }
        var tag = '';
        if (t.status === 'needs_review') tag = '<span class="tag unread">UNREAD</span>';
        else if (t.status === 'possible_duplicate') tag = '<span class="tag dup">DUPLICATE?</span>';
        else if (t.payNow && t.paid) tag = '<span class="tag paid">PAID</span>';
        else if (t.payNow) tag = '<span class="tag pay">PAY NOW</span>';
        else if (t.type === 'payment') tag = '<span class="tag gray">CARD PAYMENT</span>';
        else if (t.type === 'transfer') tag = '<span class="tag gray">TRANSFER</span>';
        else if (t.type === 'income') tag = '<span class="tag paid">RECEIVED</span>';
        else if (t.type === 'held_in') tag = '<span class="tag new">HELD FOR OTHERS</span>';
        else if (t.type === 'held_out') tag = '<span class="tag new">PASSED ON</span>';
        html += '<div class="act"><div class="l"><div class="p">' + esc(t.payee || '(no name)') + '</div><div class="sub">' + esc(t.category || (t.type === 'payment' ? 'Paid to your card' : t.type === 'transfer' ? 'Sent to someone' : 'No category yet')) + ' · ' + esc(t.account) + '</div>' + (tag ? '<div style="margin-top:4px">' + tag + '</div>' : '') + (t.type === 'purchase' && String(t.id).indexOf('local_') !== 0 ? '<button class="link rc" data-photo="' + esc(t.id) + '">' + (t.receipt ? 'Receipt saved ✓ · Replace' : 'Add receipt photo') + '</button>' : '') + '</div><div class="r">' + (t.amount === null ? '–' : (t.type === 'income' || t.type === 'held_in' ? '+' : '') + rp(t.amount)) + (t.cleared ? '<span class="clr" title="Confirmed by the bank email">✓</span>' : '') + '</div></div>';
      });
      if (open) html += '</div>';
      v.innerHTML = html;
      v.querySelectorAll('[data-photo]').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-photo'), inp = document.createElement('input');
          inp.type = 'file'; inp.accept = 'image/*';
          inp.addEventListener('change', function () {
            if (!inp.files[0]) return;
            b.textContent = 'Preparing…';
            compress(inp.files[0]).then(function (ph) {
              patch('activity', function (d) { d.items.forEach(function (t) { if (t.id === id) t.receipt = true; }); });
              banner('Saved');
              send('attach_photo', { id: id, photo: ph }, 'the receipt photo').then(function (ok) { if (ok && !queue.length) render(); });
              var c = snap('activity'); if (c) paintActivity(v, c.d);
            }, function (e) { b.textContent = 'Add receipt photo'; banner(e.message, true); });
          });
          inp.click();
        });
      });
    })();
  }

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
        html += '<div class="card"><div class="label">Bank balances</div><p class="note">Type what each account shows today. Safe to spend uses the latest numbers.</p>' +
          s.accounts.map(function (a) { return '<div class="kv"><span>' + esc(a.account) + '<div class="sub">' + (a.date ? 'Set ' + dayLabel(a.date) : 'Not set') + (a.balance !== null ? ' · ' + rp(a.balance) : '') + '</div></span><input inputmode="numeric" data-bal="' + esc(a.account) + '" placeholder="Rp"></div>'; }).join('') +
          '<p class="err" data-err-bal></p><button class="primary small" id="saveBal">Save balances</button></div>';
        html += '<div class="card"><div class="label">Bucket caps this month</div><p class="note">The most you plan to spend in each bucket.</p>' +
          s.buckets.map(function (b) { return '<div class="kv"><span>' + esc(b.bucket) + '<div class="sub">' + (b.cap === null ? 'No cap yet' : rp(b.cap)) + '</div></span><input inputmode="numeric" data-cap="' + esc(b.bucket) + '" placeholder="Rp"></div>'; }).join('') +
          '<p class="err" data-err-cap></p><button class="primary small" id="saveCap">Save caps</button></div>';
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
      saver('saveCap', 'data-cap', '[data-err-cap]', 'set_cap', ['bucket', 'cap'], 'Caps');
      $('openPlaces').addEventListener('click', function () { go('payees'); });
      $('signOut').addEventListener('click', function () { if (confirm('Disconnect this device from Hanaro?')) { ['key', 'url', 'queue', 'lastsync'].forEach(function (k) { LS.del('hanaro.' + k); }); ['home', 'review', 'activity', 'categories', 'status', 'plan'].forEach(function (k) { LS.del('hanaro.cache.' + k); }); location.reload(); } });
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
      v.innerHTML = '<div style="' + TITLE + '">Places</div><button class="link" id="plBack">‹ Back to Status</button>' +
        '<input id="plSearch" type="search" placeholder="Search places" autocomplete="off"><div id="plList"></div>';
      $('plBack').addEventListener('click', function () { go('status'); });
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
  function setCat(name) {
    state.addCat = name;
    var el = $('catVal');
    if (!name) { el.textContent = 'Choose'; el.className = 'fv empty'; }
    else if (name === '__new') { el.textContent = 'A new kind…'; el.className = 'fv'; }
    else { el.textContent = name; el.className = 'fv'; }
    $('newTypeWrap').hidden = name !== '__new';
  }
  function fmtAmt(el) {
    var d = el.value.replace(/[^\d]/g, '');
    el.value = d ? Number(d).toLocaleString('id-ID') : '';
  }
  function openAdd() {
    ensureCats().then(function () {
      var last = LS.get('hanaro.lastacct') || '';
      $('addAcc').innerHTML = '<option value="">Not sure / cash</option>' + state.accounts.map(function (a) { return '<option' + (a === last ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('');
      ['addAmount', 'addPayee', 'addMemo', 'addNewType'].forEach(function (i) { $(i).value = ''; });
      $('payeeSug').hidden = true; $('addMsg').textContent = ''; setKind('spent');
      state.photo = null; $('photoMsg').textContent = ''; $('photoBtn').textContent = 'Take or choose a photo'; locateAdd();
      $('sheetBack').hidden = false; $('sheet').hidden = false; setTimeout(function () { $('addAmount').focus(); }, 50);
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
      if (best.account && state.accounts.indexOf(best.account) !== -1) $('addAcc').value = best.account;
      state.geoApplied = true; $('geoText').textContent = 'Suggested from your location.'; $('geoNote').hidden = false;
    }, function (err) {
      if (err && err.code === 1) { $('geoText').textContent = 'Location is off for Hanaro, so there are no place suggestions. You can allow it in Settings.'; $('geoClear').hidden = true; $('geoNote').hidden = false; }
    }, { timeout: 4000, maximumAge: 60000, enableHighAccuracy: false });
  }
  $('geoClear').addEventListener('click', function () { $('addPayee').value = ''; setCat(''); $('geoNote').hidden = true; state.geoApplied = false; });
  $('photoBtn').addEventListener('click', function () { $('photoIn').click(); });
  $('photoIn').addEventListener('change', function () {
    var f = $('photoIn').files[0]; if (!f) return;
    $('photoMsg').textContent = 'Preparing photo…';
    compress(f).then(function (ph) { state.photo = ph; $('photoMsg').textContent = 'Photo added ✓'; $('photoBtn').textContent = 'Change photo'; }, function (e) { state.photo = null; $('photoMsg').textContent = e.message; });
    $('photoIn').value = '';
  });
  function closeAdd() { $('sheet').hidden = true; $('sheetBack').hidden = true; $('picker').hidden = true; }
  function setKind(k) {
    state.kind = k;
    ['Spent:spent', 'Got:got', 'Held:held'].forEach(function (x) { var p = x.split(':'); $('kind' + p[0]).className = k === p[1] ? 'on' : ''; });
    $('catBtn').hidden = k === 'got';
    $('payeeLabel').textContent = k === 'got' ? 'Received from' : 'Payee';
    $('catLabel').textContent = k === 'held' ? 'What kind of money' : 'Category';
    $('accLabel').textContent = k === 'got' ? 'Received into' : 'Account';
    $('heldHint').hidden = k !== 'held'; setCat('');
  }
  /* Payee suggestions come from what you entered before; picking one fills the category and account too. */
  function payeeSuggestions(q) {
    q = q.toLowerCase().trim(); var seen = {}, out = [];
    if (q.length < 2) return out;
    recentTxns().forEach(function (t) {
      var p = String(t.payee || ''), key = p.toLowerCase();
      if (!p || seen[key] || key.indexOf(q) === -1) return;
      seen[key] = 1; out.push(t);
    });
    return out.slice(0, 4);
  }
  var sugCache = [];
  $('addPayee').addEventListener('input', function () {
    sugCache = payeeSuggestions($('addPayee').value);
    var box = $('payeeSug');
    box.innerHTML = sugCache.map(function (t, i) { return '<button type="button" data-sug="' + i + '">' + esc(t.payee) + '</button>'; }).join('');
    box.hidden = !sugCache.length;
    box.querySelectorAll('[data-sug]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = sugCache[Number(b.getAttribute('data-sug'))];
        $('addPayee').value = t.payee; box.hidden = true;
        if (state.kind !== 'got' && t.category && kindRows().some(function (c) { return c.category === t.category; })) setCat(t.category);
        if (t.account && state.accounts.indexOf(t.account) !== -1) $('addAcc').value = t.account;
      });
    });
  });
  /* Category picker: suggested first, then grouped. Used by Add and by the Places page. */
  function pickRows() {
    var all = state.cats || [], held = state.pick.held;
    if (state.pick.both) return all.filter(function (c) { return c.category !== 'Income'; });
    return all.filter(function (c) { return held ? c.held : (!c.held && c.category !== 'Income'); });
  }
  function pickList(q) {
    q = (q || '').toLowerCase().trim();
    var rows = pickRows(), held = state.pick.held, sel = state.pick.selected, html = '';
    function row(name, mark) { return '<button type="button" class="prow" data-cat="' + esc(name) + '"><span>' + esc(name.replace(/^Held:\s*/, '')) + '</span>' + (mark ? '<span class="ck">✓</span>' : '') + '</button>'; }
    if (!q) {
      var count = {};
      recentTxns().forEach(function (t) { if (t.category && rows.some(function (c) { return c.category === t.category; })) count[t.category] = (count[t.category] || 0) + 1; });
      var top = Object.keys(count).sort(function (a, b) { return count[b] - count[a]; }).slice(0, 5);
      if (top.length) html += '<div class="pgroup">Suggested</div><div class="pcard">' + top.map(function (n) { return row(n, n === sel); }).join('') + '</div>';
    }
    var groups = {}, order = [];
    rows.forEach(function (c) {
      if (q && c.category.toLowerCase().indexOf(q) === -1) return;
      var g = (held || c.held) ? 'Held for others (not my money)' : (c.bucket || 'Other');
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(c);
    });
    order.forEach(function (g) { html += '<div class="pgroup">' + esc(g) + '</div><div class="pcard">' + groups[g].map(function (c) { return row(c.category, c.category === sel); }).join('') + '</div>'; });
    if (held && !q && !state.pick.noNew) html += '<div class="pcard" style="margin-top:14px"><button type="button" class="prow add" data-cat="__new">+ Add a new kind…</button></div>';
    if (!order.length && q) html += '<p class="note" style="padding:14px 4px">Nothing matches "' + esc(q) + '".</p>';
    $('pickList').innerHTML = html;
    $('pickList').querySelectorAll('[data-cat]').forEach(function (b) {
      b.addEventListener('click', function () { $('picker').hidden = true; state.pick.onPick(b.getAttribute('data-cat')); });
    });
  }
  function openPicker(opts) {
    state.pick = opts;
    $('pickTitle').textContent = opts.title || 'Category';
    $('pickSearch').value = ''; pickList(''); $('picker').hidden = false; $('picker').scrollTop = 0;
  }
  $('catBtn').addEventListener('click', function () {
    openPicker({ held: state.kind === 'held', selected: state.addCat, title: state.kind === 'held' ? 'What kind of money' : 'Category', onPick: function (name) {
      setCat(name); if (name === '__new') setTimeout(function () { $('addNewType').focus(); }, 50);
    } });
  });
  $('pickSearch').addEventListener('input', function () { pickList($('pickSearch').value); });
  $('pickBack').addEventListener('click', function () { $('picker').hidden = true; });
  $('addAmount').addEventListener('input', function () { fmtAmt($('addAmount')); });
  $('addNewType').addEventListener('input', function () { $('addMsg').textContent = ''; });
  $('addBtn').addEventListener('click', openAdd);
  $('addCancel').addEventListener('click', closeAdd); $('sheetBack').addEventListener('click', closeAdd);
  $('kindSpent').addEventListener('click', function () { setKind('spent'); }); $('kindGot').addEventListener('click', function () { setKind('got'); });
  $('kindHeld').addEventListener('click', function () { setKind('held'); });
  $('addSave').addEventListener('click', function () {
    var amt = Number($('addAmount').value.replace(/[^\d]/g, '')), payee = $('addPayee').value.trim(), cat = state.addCat, k = state.kind;
    var m = $('addMsg'); m.textContent = '';
    if (!amt) { m.textContent = 'Type the amount as a number.'; return; }
    if (!payee) { m.textContent = k === 'got' ? 'Type who it came from.' : 'Type who or what it was for.'; return; }
    if (k === 'spent' && !cat) { m.textContent = 'Choose a category.'; return; }
    if (k === 'held' && !cat) { m.textContent = 'Choose what kind of money this is.'; return; }
    var newName = $('addNewType').value.trim();
    if (k === 'held' && cat === '__new' && !newName) { m.textContent = 'Type a name for the new kind, for example Seminar fees.'; return; }
    // Saved on this device right away; sent in the background.
    var kind = { spent: 'purchase', got: 'income', held: 'held' }[k], acct = $('addAcc').value, memo = $('addMemo').value.trim();
    LS.set('hanaro.lastacct', acct);
    var geo = state.geo, photo = state.photo;
    if (geo && k === 'spent') addPlaces([{ lat: geo.lat, lng: geo.lng, payee: payee, category: cat, account: acct }]);
    var label = rp(amt) + ' ' + payee;
    if (k === 'held' && cat === '__new') {
      cat = 'Held: ' + newName.replace(/^Held:\s*/i, '').trim();
      if (!state.cats.some(function (c) { return c.category === cat; })) state.cats.push({ category: cat, bucket: '', held: true });
      var cc = snap('categories'); if (cc) { cc.d.categories = state.cats; save('categories', cc.d); }
      queue.push({ action: 'add_held_type', args: { name: newName }, label: 'the new kind ' + newName });
    }
    var now = localIso();
    patch('activity', function (d) {
      d.items.unshift({ id: 'local_' + Date.now(), date: now.slice(0, 10), timestamp: now, type: kind === 'purchase' ? 'purchase' : kind === 'income' ? 'income' : 'held_in', amount: amt, account: acct, payee: payee, category: kind === 'income' ? 'Income' : cat, bucket: '', status: 'confirmed', memo: memo, source: 'manual', payNow: false, paid: false, links: '', who: '', cleared: false, receipt: !!photo, lat: geo ? geo.lat : null, lng: geo ? geo.lng : null });
    });
    if (kind === 'purchase') patch('home', function (h) {
      h.spentToday += amt; h.spentWeek += amt; h.spentMonth += amt; h.spentTodayCount += 1;
      h.avgPerDay = Math.round(h.spentMonth / Math.max(1, Number(now.slice(8, 10))));
    });
    closeAdd(); banner('Saved');
    var c0 = snap(state.view === 'spending' ? 'plan' : state.view); if (c0 && state.view !== 'status' && !editing($('view'))) ({ home: paintHome, review: paintReview, activity: paintActivity, spending: paintSpending })[state.view]($('view'), c0.d);
    send('add_txn', { kind: kind, amount: amt, payee: payee, category: cat, account: acct, memo: memo, lat: geo ? geo.lat : null, lng: geo ? geo.lng : null, photo: photo || undefined }, label).then(function (ok) { if (ok && !queue.length) render(); });
  });

  /* ---------- start ---------- */
  function start() {
    $('setup').hidden = true; $('app').hidden = false; $('nav').hidden = false;
    var hc = snap('home'); if (hc && hc.d.user) { setWho(hc.d.user); state.counts.review = hc.d.reviewCount || 0; }
    var cc = snap('categories'); if (cc) useCats(cc.d);
    renderNav(); render();
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && conf().key && $('sheet').hidden) render(); });
  window.addEventListener('error', function (e) { banner('Something broke in the app: ' + e.message, true); });
  window.addEventListener('unhandledrejection', function (e) { banner('Something went wrong: ' + (e.reason && e.reason.message || e.reason), true); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  parseHash();
  if (conf().url && conf().key) start(); else showSetup('');
})();
