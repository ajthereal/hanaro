/* The phone's own copy of the data and the sums on top of it, so every screen opens at once and a change shows before it is sent.
   Data is kept in IndexedDB (a localStorage fallback is not used: it is too small for a year of entries).
   The sums come from core.js, the same code the server runs. */
(function (root) {
  'use strict';
  var C = root.HanaroCore, DBN = 'hanaro-store', S = null, memOnly = false, loading = null;

  function open() {
    return new Promise(function (res, rej) {
      if (!root.indexedDB) return rej(new Error('no idb'));
      var r = root.indexedDB.open(DBN, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbGet(k) { return open().then(function (db) { return new Promise(function (res, rej) { var q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); }; }); }); }
  function idbSet(k, v) { return open().then(function (db) { return new Promise(function (res, rej) { var tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); }; }); }); }
  function idbDel(k) { return open().then(function (db) { return new Promise(function (res) { var tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = res; tx.onerror = res; }); }); }

  var saveT = null;
  function persist() {
    if (memOnly || !S) return;
    clearTimeout(saveT);
    saveT = setTimeout(function () { idbSet('data', S).catch(function () { memOnly = true; }); }, 150);
  }

  /** Loads the saved copy. Resolves to true when there is one. */
  function load() {
    if (S) return Promise.resolve(true);
    if (!loading) loading = idbGet('data').then(function (d) { if (d && d.apiV >= 4 && d.txns) { S = d; } return !!S; }, function () { memOnly = true; return false; });
    return loading;
  }
  function ready() { return !!S; }
  function clear() { S = null; loading = null; return idbDel('data').catch(function () {}); }

  /** Takes what the server sent. A first (full) sync replaces everything; a later one replaces the rows that changed. */
  function absorb(d) {
    var byId = {}, list;
    if (d.full || !S) list = d.txns.slice();
    else { list = S.txns.filter(function (t) { return !t._local; }); }
    if (!d.full && S) {
      list.forEach(function (t) { byId[t.id] = list.indexOf(t); });
      d.txns.forEach(function (t) { if (byId[t.id] !== undefined) list[byId[t.id]] = t; else { byId[t.id] = list.length; list.push(t); } });
    }
    var keep = (S && !d.full) ? S.txns.filter(function (t) { return t._local && byId[t.id] === undefined; }) : [];
    S = {
      apiV: d.apiV, user: d.user, accounts: d.accounts, balances: d.balances, cats: d.cats, archive: d.archive, plan: d.plan, paid: d.paid, summary: d.summary,
      cutover: d.cutover, newest: d.newest || (S && S.newest) || '', now: d.now, txns: list.concat(keep), at: Date.now()
    };
    persist();
  }

  /** The marker to send with the next sync. Rows still waiting to be sent do not move it. */
  function since() { return S && S.newest ? S.newest : ''; }

  function ctx(today) { return { txns: C.dropMatchedManual_(S.txns), accounts: S.accounts, balances: S.balances, cats: S.cats, summary: S.summary, today: today, role: S.user && S.user.role }; }

  var views = {
    home: function (today) { var h = C.homeView_(ctx(today)); h.user = S.user; return h; },
    accounts: function (today) { return C.accountsView_(ctx(today)); },
    spending: function (today, month) { var c = ctx(today); return C.spendReport_({ month: month || today.slice(0, 7), today: today, accounts: S.accounts, txns: c.txns, cats: S.cats, archive: S.archive, cutover: S.cutover }); },
    review: function () { return { items: C.reviewList_({ txns: C.dropMatchedManual_(S.txns), accounts: S.accounts }) }; },
    activity: function () { var c = ctx(''); return { items: C.activityList_({ txns: c.txns, accounts: S.accounts }) }; }
  };
  function view(name, today, arg) { return S ? views[name](today, arg) : null; }

  /** Lists the screens need that are not sums: categories grouped for the picker, and the account lists for the Add screen. */
  function categories() {
    if (!S) return [];
    return S.cats.filter(function (c) { return c.active !== 'N' && c.category; }).sort(function (a, b) { return Number(a.sort || 0) - Number(b.sort || 0); });
  }
  function accountList() {
    if (!S) return [];
    return S.accounts.filter(function (a) { return a.active !== 'N' && C.kindOf_(a); });
  }

  /* ---------- changes made on the phone, shown at once; the server's own row replaces them at the next sync ---------- */
  function findIdx(id) { for (var i = 0; i < S.txns.length; i++) if (S.txns[i].id === id) return i; return -1; }
  function localIso(a) { return a.timestamp || a.stamp || new Date().toISOString(); }

  var KIND_TYPE = { purchase: 'purchase', income: 'income', held: 'held_in', transfer: 'transfer', payment: 'payment' };
  /** Mirrors what the server writes for add_txn, enough for the sums. */
  function localAdd(a, stamp) {
    if (!S) return;
    var kind = a.kind || 'purchase', type = KIND_TYPE[kind] || 'purchase', idr = a.idr_amount > 0 ? Math.round(a.idr_amount) : Math.round(Number(a.amount) || 0);
    var payee = a.payee || '';
    if (kind === 'transfer') payee = 'To ' + (a.toAccount || ''); else if (kind === 'payment') payee = 'Payment to ' + (a.card || '');
    var day = (a.date || stamp.slice(0, 10)), ts = a.date && a.date !== stamp.slice(0, 10) ? a.date + 'T12:00:00' + stamp.slice(19) : stamp;
    S.txns.push({
      id: a.id, date: day, timestamp: ts, txn_type: type, idr_amount: idr, orig_amount: a.currency && a.currency !== 'IDR' ? a.amount : '', orig_currency: a.currency || 'IDR', flags: a.date && a.date !== stamp.slice(0, 10) ? 'date_only' : '',
      account: a.account || '', payee: payee, category: kind === 'income' ? 'Income' : (a.category || ''), category_group: a.group || '', to_account: kind === 'transfer' ? (a.toAccount || '') : kind === 'payment' ? (a.card || '') : '',
      who: S.user ? S.user.name : '', source: 'manual', settled: 'Y', status: (kind === 'purchase' && !a.category) ? 'auto' : 'confirmed', memo: a.memo || '', receipt_drive_id: a.photo ? 'pending' : '',
      lat: a.lat === undefined || a.lat === null ? '' : a.lat, lng: a.lng === undefined || a.lng === null ? '' : a.lng, _local: true
    });
    persist();
  }
  function localUpdate(id, changes, confirm) {
    if (!S) return;
    var i = findIdx(id); if (i < 0) return;
    var t = S.txns[i];
    Object.keys(changes || {}).forEach(function (k) {
      if (k === 'date') { t.date = changes.date; t.timestamp = changes.date + 'T12:00:00' + String(t.timestamp || '').slice(19, 25); }
      else t[k] = changes[k];
    });
    if (confirm) t.status = 'confirmed';
    t._local = true; persist();
  }
  function localStatus(id, status) { if (!S) return; var i = findIdx(id); if (i < 0) return; S.txns[i].status = status; S.txns[i]._local = true; persist(); }
  function localBalance(a, today, at) {
    if (!S) return;
    S.balances.push({ date_confirmed: today, account: a.account, confirmed_balance: Number(a.amount), method: 'manual', confirmed_at: at });
    persist();
  }
  function localLimit(account, limit) {
    if (!S) return;
    S.accounts.forEach(function (x) { if (x.account === account) x.credit_limit = limit > 0 ? limit : ''; });
    persist();
  }
  /** The tracked figure of one account right now, sent with a balance confirmation so the Sheet keeps the gap. */
  function trackedNow(account, today) {
    if (!S) return null;
    var v = C.accountsView_(ctx(today)), all = v.banks.concat(v.cards, v.loans);
    for (var i = 0; i < all.length; i++) if (all[i].account === account) return all[i].tracked !== undefined && all[i].tracked !== null ? all[i].tracked : (all[i].owed !== undefined ? all[i].owed : null);
    return null;
  }

  root.HanaroEngine = { load: load, ready: ready, clear: clear, absorb: absorb, since: since, view: view, categories: categories, accountList: accountList,
    localAdd: localAdd, localUpdate: localUpdate, localStatus: localStatus, localBalance: localBalance, localLimit: localLimit, trackedNow: trackedNow, user: function () { return S && S.user; }, apiV: function () { return S ? S.apiV : 0; } };
})(typeof window !== 'undefined' ? window : this);
