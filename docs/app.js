/* Hanaro app. Plain JavaScript, no build step. The link and key live only in this device's storage. */
(function () {
  'use strict';
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var $ = function (id) { return document.getElementById(id); };
  var state = { view: 'home', filter: 'all', later: {}, cats: null, accounts: [], kind: 'spent', counts: { review: 0 } };

  /* ---------- helpers ---------- */
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
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
  /** Loads fresh data; if offline, shows the last saved copy and says so. */
  function load(action, args) {
    var ck = 'hanaro.cache.' + action;
    return api(action, args).then(function (d) {
      LS.set(ck, JSON.stringify({ at: Date.now(), d: d })); return d;
    }, function (e) {
      var raw = LS.get(ck);
      if (raw && /Cannot reach/.test(e.message)) {
        var c = JSON.parse(raw);
        banner('Offline. Showing what was saved ' + ago(new Date(c.at).toISOString()) + '.', true, 6000);
        return c.d;
      }
      throw e;
    });
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
    status: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>'
  };
  var LABELS = { home: 'HOME', review: 'REVIEW', activity: 'ACTIVITY', status: 'STATUS' };
  function renderNav() {
    document.querySelectorAll('nav [data-go]').forEach(function (b) {
      var v = b.getAttribute('data-go'), on = state.view === v;
      b.className = on ? 'on' : '';
      b.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[v] + '</svg>' +
        (on ? LABELS[v] : '') + (v === 'review' && state.counts.review ? '<span class="badge">' + state.counts.review + '</span>' : '');
    });
  }
  function setPill(iso, err) {
    var p = $('syncPill'), a = ago(iso);
    var stale = !iso || (Date.now() - Date.parse(iso)) > 2 * 3600 * 1000;
    p.textContent = err ? 'Not synced' : (a ? 'Synced ' + a : 'No sync yet');
    p.className = 'pill' + (stale || err ? ' bad' : '');
  }
  function go(v) { state.view = v; renderNav(); render(); window.scrollTo(0, 0); }
  document.querySelectorAll('nav [data-go]').forEach(function (b) { b.addEventListener('click', function () { go(b.getAttribute('data-go')); }); });
  $('syncPill').addEventListener('click', function () { render(); });

  function render() {
    var v = $('view');
    v.innerHTML = '<div class="empty">Loading…</div>';
    var f = { home: renderHome, review: renderReview, activity: renderActivity, status: renderStatus }[state.view];
    f(v).catch(function (e) {
      if (/not recognised/.test(e.message)) { LS.del('hanaro.key'); showSetup(e.message); return; }
      v.innerHTML = '<div class="card"><div class="label">Could not load</div><p class="note">' + esc(e.message) + '</p><button class="ghost small" id="retry">Try again</button></div>';
      $('retry').addEventListener('click', render);
      banner(e.message, true);
    });
  }

  /* ---------- Home ---------- */
  function renderHome(v) {
    return load('home').then(function (h) {
      state.counts.review = h.reviewCount; renderNav(); LS.set('hanaro.lastsync', h.lastSync || ''); setPill(h.lastSync);
      $('whoName').textContent = h.user.name; $('avatar').textContent = h.user.name.slice(0, 2).toUpperCase();
      var html = '<div style="font-size:30px;font-weight:300;letter-spacing:-.5px;margin:6px 0 0 2px">Today</div>';
      if (h.safeToSpend === null) {
        html += '<div class="card"><div class="label">Safe to spend</div><p class="note" style="font-size:14px;color:var(--text);margin-top:6px">To show your daily number, Hanaro needs today\'s bank balances' + (h.needs.indexOf('caps') !== -1 ? ' and your bucket caps' : '') + '.</p><button class="primary small" data-go-status style="margin-top:10px">Open Status to add them</button></div>';
      } else {
        var b = bigParts(h.safeToSpend);
        html += '<div class="card"><div class="label">Safe to spend</div><div class="big"><span class="rp">Rp</span><span class="n">' + esc(b.n) + '</span><span class="z">' + esc(b.z) + '</span></div>' +
          '<div style="font-size:14px">per day for the next ' + h.days + ' day' + (h.days === 1 ? '' : 's') + '</div><div class="rule"></div>' +
          h.notes.map(function (n) { return '<p class="note">' + esc(n) + '</p>'; }).join('') + '</div>';
      }
      if (h.heldByType && h.heldByType.length) {
        html += '<div class="card"><div class="label">Held for others</div><div class="stat' + (h.heldTotal < 0 ? ' bad' : '') + '" style="margin-top:2px">' + rp(h.heldTotal) + '</div>' +
          h.heldByType.map(function (x) { return '<div class="kv"><span>' + esc(x.type) + '</span><span class="' + (x.amount < 0 ? 'bad' : 'muted') + '">' + rp(x.amount) + '</span></div>'; }).join('') +
          '<p class="note">' + (h.heldTotal < 0 ? 'You have sent out more than you were given. An entry for money received may be missing.' : 'This is other people\'s money. It is not counted in Safe to spend.') + '</p></div>';
      }
      var down = h.debtDown >= 0;
      html += '<div class="card"><div class="two"><div><div class="tiny muted">' + (down ? 'Debt down this month' : 'Debt up this month') + '</div><div class="stat ' + (down ? 'good' : 'bad') + '">' + rpShort(Math.abs(h.debtDown)) + '</div></div>' +
        '<div class="sep"></div><div><div class="tiny muted">Debt cost this month</div><div class="stat ' + (h.debtCost === null ? '' : 'bad') + '">' + (h.debtCost === null ? '–' : rpShort(h.debtCost)) + '</div></div></div>' +
        (h.debtCost === null ? '<p class="note" style="margin-top:8px">Debt cost appears once your debts and rates are added.</p>' : '') + '</div>';
      html += '<div class="card" style="gap:11px"><div class="label">Buckets this month</div>';
      if (!h.buckets.length) html += '<p class="note">No buckets yet.</p>';
      h.buckets.forEach(function (k) {
        var hot = k.pct !== null && k.pct >= 80, w = k.pct === null ? 0 : Math.min(100, k.pct);
        html += '<div class="bar' + (hot ? ' hot' : '') + '"><span class="nm">' + esc(k.bucket) + '</span><div class="track"><div class="fill" style="width:' + w + '%"></div></div><span class="pc">' + (k.pct === null ? rpShort(k.spent) : k.pct + '%') + '</span></div>';
      });
      html += '<div class="rule" style="margin:2px 0"></div><div class="insight"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0B6F7A" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:1px"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg><p class="note">' + esc(h.insight) + '</p></div></div>';
      if (h.reviewCount) html += '<button class="ghost" data-go-review>' + h.reviewCount + ' item' + (h.reviewCount === 1 ? '' : 's') + ' to review' + (h.payNowCount ? ' (' + h.payNowCount + ' to pay now)' : '') + '</button>';
      v.innerHTML = html;
      var s = v.querySelector('[data-go-status]'); if (s) s.addEventListener('click', function () { go('status'); });
      var r = v.querySelector('[data-go-review]'); if (r) r.addEventListener('click', function () { go('review'); });
    });
  }

  /* ---------- categories ---------- */
  function ensureCats() {
    if (state.cats) return Promise.resolve();
    return load('categories').then(function (d) { state.cats = d.categories; state.accounts = d.accounts; });
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
  function renderReview(v) {
    return Promise.all([load('review'), ensureCats()]).then(function (res) {
      var items = res[0].items.filter(function (i) { return !state.later[i.txn.id]; });
      state.counts.review = items.length; renderNav(); setPill(LS.get('hanaro.lastsync') || null);
      var n = { all: items.length };
      Object.keys(KIND).forEach(function (k) { n[k] = items.filter(function (i) { return i.kind === k; }).length; });
      var tabs = [['all', 'All'], ['pay_now', 'Pay now'], ['duplicate', 'Duplicates'], ['unread', 'Unread']];
      var html = '<div style="font-size:30px;font-weight:300;letter-spacing:-.5px;margin:6px 0 0 2px">Review</div><div class="chips">' +
        tabs.map(function (t) { return '<button class="chip' + (state.filter === t[0] ? ' on' : '') + '" data-f="' + t[0] + '">' + t[1] + ' ' + n[t[0]] + '</button>'; }).join('') + '</div>';
      var shown = items.filter(function (i) { return state.filter === 'all' || i.kind === state.filter; });
      if (!shown.length) html += '<div class="card empty">' + (items.length ? 'Nothing here.' : 'All clear. Nothing needs you right now.') + '</div>';
      shown.forEach(function (i) { html += reviewCard(i); });
      v.innerHTML = html;
      v.querySelectorAll('[data-f]').forEach(function (b) { b.addEventListener('click', function () { state.filter = b.getAttribute('data-f'); renderReview(v); }); });
      v.querySelectorAll('[data-act]').forEach(function (b) { b.addEventListener('click', function () { reviewAction(b, v); }); });
    });
  }
  function reviewCard(i) {
    var t = i.txn, k = KIND[i.kind], id = esc(t.id);
    var h = '<div class="card" data-id="' + id + '"><span class="tag ' + k[1] + '">' + k[0].toUpperCase() + '</span>';
    var amt = t.amount === null ? '' : '<div class="a">' + rp(t.amount) + '</div>';
    if (i.kind === 'unread') {
      h += '<div class="item-top"><div class="p">' + esc(t.payee || 'Unreadable email') + '</div></div><div class="sub">' + esc(t.memo) + '</div>' +
        '<label>Amount (Rp)</label><input data-f-amount inputmode="numeric" placeholder="0"><label>What was it</label><input data-f-payee value="' + esc(t.payee) + '">' +
        '<label>Category</label><select data-f-cat>' + catOptions('') + '</select><p class="err" data-err></p>' +
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
        '<select data-f-cat style="margin-top:8px">' + catOptions(t.category) + '</select><p class="err" data-err></p>' +
        '<div class="btnrow"><button class="primary small" data-act="confirm" data-id="' + id + '">Confirm</button></div>';
    }
    return h + '</div>';
  }
  function reviewAction(btn, v) {
    var act = btn.getAttribute('data-act'), id = btn.getAttribute('data-id'), card = btn.closest('.card');
    var err = card.querySelector('[data-err]');
    function fail(m) { if (err) err.textContent = m; else banner(m, true); }
    if (err) err.textContent = '';
    if (act === 'later') { state.later[id] = true; renderReview(v); return; }
    var call;
    if (act === 'paid') call = api('mark_paid', { id: id });
    else if (act === 'keep_both') call = api('keep_both', { id: id });
    else if (act === 'merge_dup') call = api('merge_dup', { id: id });
    else {
      var cat = card.querySelector('[data-f-cat]').value;
      if (!cat) return fail('Choose a category first.');
      var changes = { category: cat };
      if (act === 'save_unread') {
        var a = Number(card.querySelector('[data-f-amount]').value.replace(/[^\d]/g, ''));
        var p = card.querySelector('[data-f-payee]').value.trim();
        if (!a) return fail('Type the amount as a number.');
        if (!p) return fail('Type what it was for.');
        changes.idr_amount = a; changes.payee = p;
      }
      call = api('update_txn', { id: id, changes: changes, confirm: true });
    }
    btn.disabled = true;
    call.then(function () { banner('Saved'); renderReview(v); }, function (e) { btn.disabled = false; fail(e.message); });
  }

  /* ---------- Activity ---------- */
  function renderActivity(v) {
    return load('activity').then(function (d) {
      setPill(LS.get('hanaro.lastsync') || null);
      var html = '<div style="font-size:30px;font-weight:300;letter-spacing:-.5px;margin:6px 0 0 2px">Activity</div>';
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
        html += '<div class="act"><div class="l"><div class="p">' + esc(t.payee || '(no name)') + '</div><div class="sub">' + esc(t.category || (t.type === 'payment' ? 'Paid to your card' : t.type === 'transfer' ? 'Sent to someone' : 'No category yet')) + ' · ' + esc(t.account) + '</div>' + (tag ? '<div style="margin-top:4px">' + tag + '</div>' : '') + '</div><div class="r">' + (t.amount === null ? '–' : (t.type === 'income' || t.type === 'held_in' ? '+' : '') + rp(t.amount)) + '</div></div>';
      });
      if (open) html += '</div>';
      v.innerHTML = html;
    });
  }

  /* ---------- Status ---------- */
  function renderStatus(v) {
    return load('status').then(function (s) {
      LS.set('hanaro.lastsync', s.lastSync || ''); setPill(s.lastSync);
      var stale = !s.lastSync || (Date.now() - Date.parse(s.lastSync)) > 2 * 3600 * 1000;
      var html = '<div style="font-size:30px;font-weight:300;letter-spacing:-.5px;margin:6px 0 0 2px">Status</div>';
      html += '<div class="card"><div class="label">Email sync</div><div class="kv"><span><span class="dot' + (stale ? ' bad' : '') + '"></span>' + (s.lastSync ? 'Last sync ' + esc(ago(s.lastSync)) : 'No sync yet') + '</span></div>' +
        (s.lastSyncError ? '<p class="note" style="color:var(--warn)">Last error: ' + esc(s.lastSyncError) + '</p>' : '') +
        '<div class="kv"><span>Emails I could not read</span><b>' + s.unreadable + '</b></div><div class="kv"><span>Last backup</span><span>' + esc(s.lastBackup ? ago(s.lastBackup) : 'none yet') + '</span></div></div>';
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
          })).then(function () { banner(label + ' saved'); renderStatus(v); }, function (e) { b.disabled = false; err.textContent = e.message; });
        });
      }
      saver('saveBal', 'data-bal', '[data-err-bal]', 'set_balance', ['account', 'amount'], 'Balances');
      saver('saveCap', 'data-cap', '[data-err-cap]', 'set_cap', ['bucket', 'cap'], 'Caps');
      $('signOut').addEventListener('click', function () { if (confirm('Disconnect this device from Hanaro?')) { LS.del('hanaro.key'); LS.del('hanaro.url'); location.reload(); } });
    });
  }

  /* ---------- Add ---------- */
  function openAdd() {
    ensureCats().then(function () {
      $('addCat').innerHTML = catOptions('', 'spend');
      $('addAcc').innerHTML = '<option value="">Not sure / cash</option>' + state.accounts.map(function (a) { return '<option>' + esc(a) + '</option>'; }).join('');
      ['addAmount', 'addPayee', 'addMemo'].forEach(function (i) { $(i).value = ''; });
      $('addMsg').textContent = ''; setKind('spent');
      $('sheetBack').hidden = false; $('sheet').hidden = false; setTimeout(function () { $('addAmount').focus(); }, 50);
    }, function (e) { banner(e.message, true); });
  }
  function closeAdd() { $('sheet').hidden = true; $('sheetBack').hidden = true; }
  function setKind(k) {
    state.kind = k;
    ['Spent:spent', 'Got:got', 'Held:held'].forEach(function (x) { var p = x.split(':'); $('kind' + p[0]).className = k === p[1] ? 'on' : ''; });
    $('catWrap').hidden = k === 'got';
    $('payeeLabel').textContent = k === 'spent' ? 'Spent on' : 'Received from';
    $('catLabel').textContent = k === 'held' ? 'What kind of money' : 'Category';
    $('accLabel').textContent = k === 'spent' ? 'Paid from' : 'Received into';
    $('addCat').innerHTML = catOptions('', k === 'held' ? 'held' : 'spend');
    $('newTypeWrap').hidden = true; $('heldHint').hidden = k !== 'held';
  }
  $('addCat').addEventListener('change', function () { $('newTypeWrap').hidden = $('addCat').value !== '__new'; });
  $('addBtn').addEventListener('click', openAdd);
  $('addCancel').addEventListener('click', closeAdd); $('sheetBack').addEventListener('click', closeAdd);
  $('kindSpent').addEventListener('click', function () { setKind('spent'); }); $('kindGot').addEventListener('click', function () { setKind('got'); });
  $('kindHeld').addEventListener('click', function () { setKind('held'); });
  $('addSave').addEventListener('click', function () {
    var amt = Number($('addAmount').value.replace(/[^\d]/g, '')), payee = $('addPayee').value.trim(), cat = $('addCat').value, k = state.kind;
    var m = $('addMsg'); m.textContent = '';
    if (!amt) { m.textContent = 'Type the amount as a number.'; return; }
    if (!payee) { m.textContent = k === 'spent' ? 'Type who or what it was for.' : 'Type who it came from.'; return; }
    if (k === 'spent' && !cat) { m.textContent = 'Choose a category.'; return; }
    if (k === 'held' && !cat) { m.textContent = 'Choose what kind of money this is.'; return; }
    var newName = $('addNewType').value.trim();
    if (k === 'held' && cat === '__new' && !newName) { m.textContent = 'Type a name for the new kind, for example Seminar fees.'; return; }
    $('addSave').disabled = true;
    var pre = (k === 'held' && cat === '__new') ? api('add_held_type', { name: newName }).then(function (r) { cat = r.category; state.cats = null; }) : Promise.resolve();
    pre.then(function () {
      return api('add_txn', { kind: { spent: 'purchase', got: 'income', held: 'held' }[k], amount: amt, payee: payee, category: cat, account: $('addAcc').value, memo: $('addMemo').value.trim() });
    }).then(function () { closeAdd(); banner('Saved'); render(); }, function (e) { m.textContent = e.message; })
      .then(function () { $('addSave').disabled = false; });
  });

  /* ---------- start ---------- */
  function start() {
    $('setup').hidden = true; $('app').hidden = false; $('nav').hidden = false; renderNav(); render();
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && conf().key && $('sheet').hidden) render(); });
  window.addEventListener('error', function (e) { banner('Something broke in the app: ' + e.message, true); });
  window.addEventListener('unhandledrejection', function (e) { banner('Something went wrong: ' + (e.reason && e.reason.message || e.reason), true); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  parseHash();
  if (conf().url && conf().key) start(); else showSetup('');
})();
