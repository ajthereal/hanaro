/**
 * Hanaro API (Apps Script project B). No Gmail access. Serves the app as a web app.
 * Needs Logic.gs in the same project.
 * Requests are POST with a text/plain JSON body: { key, action, ...args }.
 * Keys are never stored, only their SHA-256 hashes (Script Properties). Roles are enforced here, not in the app.
 */
var SHEET_ID = 'PASTE_SHEET_ID_HERE';   // set once in the pasted copy, never committed
var ROLES = { aj: 'owner', cynthia: 'partner' };
var NAMES = { aj: 'AJ', cynthia: 'Cynthia' };
var MAX_FAILS = 10;

function book_() { return SpreadsheetApp.openById(SHEET_ID); }

function nowIso_(tz) { return Utilities.formatDate(new Date(), tz || 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ssXXX"); }

function rows_(book, name) {
  var sh = book.getSheetByName(name);
  var v = sh.getDataRange().getValues();
  if (v.length < 2) return [];
  var h = v[0], tz = book.getSpreadsheetTimeZone();
  return v.slice(1).map(function (r, i) {
    var o = { _row: i + 2 };
    h.forEach(function (k, j) {
      var c = r[j];
      o[k] = (c instanceof Date) ? Utilities.formatDate(c, tz, "yyyy-MM-dd'T'HH:mm:ssXXX") : c;
    });
    return o;
  });
}

function append_(book, name, objs) {
  if (!objs.length) return;
  var sh = book.getSheetByName(name);
  var h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var out = objs.map(function (o) { return h.map(function (k) { return o[k] === undefined ? '' : o[k]; }); });
  sh.getRange(sh.getLastRow() + 1, 1, out.length, h.length).setValues(out);
}

function audit_(book, who, action, tab, rowId, field, before, after) {
  append_(book, 'Audit', [{ timestamp: nowIso_(), who: who, action: action, tab: tab, row_id: rowId, field: field, before: before, after: after }]);
}

function log_(book, level, message, detail) {
  append_(book, 'Log', [{ timestamp: nowIso_(), component: 'api', level: level, message: message, detail: detail || '' }]);
}

function sha_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/** Run once from the editor. Creates one key per person and shows them in the execution log. Running it again replaces them. */
function makeKeys() {
  var props = PropertiesService.getScriptProperties();
  Object.keys(ROLES).forEach(function (who) {
    var key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty('HASH_' + who, sha_(key));
    Logger.log('Key for ' + NAMES[who] + ': ' + key);
  });
  Logger.log('Copy each key now. They cannot be shown again. Send Cynthia hers privately.');
}

function who_(key) {
  if (!key) return null;
  var h = sha_(String(key)), props = PropertiesService.getScriptProperties();
  var names = Object.keys(ROLES);
  for (var i = 0; i < names.length; i++) if (props.getProperty('HASH_' + names[i]) === h) return names[i];
  return null;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() { return reply_({ ok: false, error: 'This address only works from the Hanaro app.' }); }

function doPost(e) {
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('fails') || 0);
  if (fails >= MAX_FAILS) return reply_({ ok: false, error: 'Too many wrong keys. Try again in 15 minutes.' });
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return reply_({ ok: false, error: 'The app sent something unreadable. Please update the app.' }); }
  var who = who_(req.key);
  if (!who) {
    cache.put('fails', String(fails + 1), 900);
    try { log_(book_(), 'warn', 'Wrong key used', 'attempt ' + (fails + 1)); } catch (e2) {}
    return reply_({ ok: false, error: 'This key is not recognised. Check it was copied in full.' });
  }
  try {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try { return reply_({ ok: true, data: handle_(req, who) }); } finally { lock.releaseLock(); }
  } catch (err) {
    try { log_(book_(), 'error', 'API ' + req.action + ' failed: ' + err.message, String(err.stack || '')); } catch (e3) {}
    return reply_({ ok: false, error: err.userMessage || ('Something went wrong: ' + err.message) });
  }
}

function userError_(msg) { var e = new Error(msg); e.userMessage = msg; return e; }

function data_(book, who) {
  var accounts = rows_(book, 'Accounts');
  var ptNames = {};
  accounts.forEach(function (a) { if (a.entity === 'PT') ptNames[a.account] = true; });
  var txns = rows_(book, 'Transactions');
  if (ROLES[who] === 'partner') txns = txns.filter(function (t) { return !ptNames[t.account]; });
  return {
    book: book, accounts: accounts, txns: txns, buckets: rows_(book, 'Buckets'), balances: rows_(book, 'Balances'),
    bills: rows_(book, 'Bills'), debts: rows_(book, 'Debts'), summary: rows_(book, 'Summary'),
    today: Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd')
  };
}

function slim_(t, settled) {
  var f = String(t.flags || '').split(',').filter(function (x) { return x; });
  return {
    id: t.id, date: String(t.date).slice(0, 10), timestamp: t.timestamp, type: t.txn_type, amount: t.idr_amount === '' ? null : Number(t.idr_amount),
    account: t.account, payee: t.payee, category: t.category, bucket: t.bucket, status: t.status, memo: t.memo, source: t.source,
    payNow: f.indexOf('pay_now') !== -1, paid: !!(settled && settled[t.id]), links: t.links_to_id || '', who: t.who || ''
  };
}

function handle_(req, who) {
  var role = ROLES[who], book = book_(), a = req.action;
  var owner = role === 'owner';
  if (a === 'ping') return { name: NAMES[who], role: role };

  if (a === 'home') {
    var d = data_(book, who), h = computeHome(d);
    h.user = { name: NAMES[who], role: role };
    return h;
  }
  if (a === 'bootstrap') return bootstrap_(book, who);
  if (a === 'review') {
    var d2 = data_(book, who), settled = settledPayNow(d2.txns), byId = {};
    d2.txns.forEach(function (t) { byId[t.id] = t; });
    var items = reviewItems(d2.txns).slice(0, 100).map(function (i) {
      var o = { kind: i.kind, txn: slim_(i.t, settled) };
      if (i.kind === 'duplicate' && byId[i.t.links_to_id]) o.other = slim_(byId[i.t.links_to_id], settled);
      return o;
    });
    return { items: items };
  }
  if (a === 'activity') {
    var d3 = data_(book, who), s3 = settledPayNow(d3.txns);
    var list = d3.txns.filter(function (t) { return t.status !== 'void'; })
      .sort(function (x, y) { return Date.parse(y.timestamp) - Date.parse(x.timestamp); }).slice(0, 80)
      .map(function (t) { return slim_(t, s3); });
    return { items: list };
  }
  if (a === 'categories') {
    return { categories: rows_(book, 'Categories').filter(function (c) { return String(c.active).toUpperCase() !== 'N'; })
      .map(function (c) { return { category: c.category, bucket: c.bucket, held: String(c.counts_in_bucket).toUpperCase() === 'HELD' }; }), accounts: rows_(book, 'Accounts').filter(function (x) { return x.active !== 'N' && x.entity !== 'PT' && (x.type === 'bank' || x.type === 'credit card'); }).map(function (x) { return x.account; }) };
  }
  if (a === 'status') return status_(book, who);
  if (a === 'add_held_type') return addHeldType_(book, who, req);

  if (a === 'update_txn') return updateTxn_(book, who, req);
  if (a === 'add_txn') return addTxn_(book, who, req);
  if (a === 'mark_paid') return flagTxn_(book, who, req.id, 'paid');
  if (a === 'keep_both') return setStatus_(book, who, req.id, 'auto', 'keep_both');
  if (a === 'merge_dup') return setStatus_(book, who, req.id, 'void', 'merge_duplicate');

  if (a === 'set_balance' || a === 'set_cap') {
    if (!owner) throw userError_('Only AJ can change balances and caps.');
    if (a === 'set_balance') {
      var amt = Number(req.amount);
      if (!req.account || isNaN(amt)) throw userError_('Choose an account and type the balance as a number.');
      append_(book, 'Balances', [{ date_confirmed: Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd'), account: req.account, confirmed_balance: amt, method: 'manual', entered_by: NAMES[who] }]);
      audit_(book, NAMES[who], 'set_balance', 'Balances', req.account, 'confirmed_balance', '', amt);
      return { saved: true };
    }
    var cap = Number(req.cap);
    if (!req.bucket || isNaN(cap) || cap < 0) throw userError_('Choose a bucket and type the cap as a number.');
    var month = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM');
    append_(book, 'Buckets', [{ bucket: req.bucket, month: month, cap_idr: cap, owner: req.owner || '', set_by: NAMES[who] }]);
    audit_(book, NAMES[who], 'set_cap', 'Buckets', req.bucket + ' ' + month, 'cap_idr', '', cap);
    return { saved: true };
  }
  throw userError_('The app asked for something this version does not know. Please refresh the app.');
}

function status_(book, who) {
  var owner = ROLES[who] === 'owner';
  var summary = {}; rows_(book, 'Summary').forEach(function (r) { summary[r.key] = r.value; });
  var txns = rows_(book, 'Transactions');
  var inbox = rows_(book, 'Inbox_Raw'), seen = {};
  inbox.forEach(function (r) {
    if (r.parse_status === 'ignored') return;
    var m = String(r.sender).toLowerCase().match(/[\w.\-]+@[\w.\-]+/), addr = m ? m[0] : String(r.sender);
    if (!seen[addr] || String(r.received_at) > seen[addr]) seen[addr] = String(r.received_at);
  });
  var out = {
    lastSync: summary.last_sync_ok || null, lastSyncError: summary.last_sync_error || null, lastSyncCounts: summary.last_sync_counts || null,
    lastBackup: summary.last_backup_ok || null, unreadable: txns.filter(function (t) { return t.status === 'needs_review'; }).length,
    senders: Object.keys(seen).map(function (k) { return { sender: k, last: seen[k] }; }), canSetup: owner
  };
  if (owner) {
    var bal = latestBalances_(rows_(book, 'Balances'));
    out.accounts = rows_(book, 'Accounts').filter(function (x) { return x.type === 'bank' && x.active !== 'N'; }).map(function (x) {
      var b = bal[x.account]; return { account: x.account, balance: b ? Number(b.confirmed_balance) : null, date: b ? String(b.date_confirmed).slice(0, 10) : null };
    });
    var month = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM');
    var caps = bucketCaps_(rows_(book, 'Buckets'), month);
    out.buckets = Object.keys(caps).map(function (n) { return { bucket: n, cap: has_(caps[n].cap_idr) ? Number(caps[n].cap_idr) : null }; });
  }
  return out;
}

function isHeld_(book, category) {
  var rows = rows_(book, 'Categories');
  for (var i = 0; i < rows.length; i++) if (rows[i].category === category) return String(rows[i].counts_in_bucket).toUpperCase() === 'HELD';
  return false;
}

/** A new kind of money held for others, for example "Seminar fees". Stored as "Held: <name>". */
function addHeldType_(book, who, req) {
  var name = String(req.name || '').replace(/^Held:\s*/i, '').trim();
  if (!name) throw userError_('Type a name for this kind of money, for example Seminar fees.');
  if (name.length > 40) throw userError_('Keep the name under 40 characters.');
  var full = 'Held: ' + name;
  var rows = rows_(book, 'Categories');
  for (var i = 0; i < rows.length; i++) if (String(rows[i].category).toLowerCase() === full.toLowerCase()) return { category: rows[i].category };
  append_(book, 'Categories', [{ category: full, bucket: '', counts_in_bucket: 'HELD', ynab_categories_mapped: '', active: 'Y' }]);
  audit_(book, NAMES[who], 'add_held_type', 'Categories', full, '', '', full);
  return { category: full };
}

var EDITABLE = { category: 1, payee: 1, idr_amount: 1, memo: 1, account: 1 };

function findTxn_(book, id) {
  var sh = book.getSheetByName('Transactions');
  var v = sh.getDataRange().getValues(), h = v[0], iId = h.indexOf('id');
  for (var i = 1; i < v.length; i++) if (v[i][iId] === id) return { sh: sh, h: h, row: i + 1, vals: v[i] };
  throw userError_('That item was not found. Pull down to refresh.');
}

function setField_(book, who, f, field, value) {
  var col = f.h.indexOf(field);
  if (col < 0) throw new Error('Unknown field ' + field);
  var before = f.vals[col];
  if (String(before) === String(value)) return;
  f.sh.getRange(f.row, col + 1).setValue(value);
  f.vals[col] = value;
  audit_(book, NAMES[who], 'edit', 'Transactions', f.vals[f.h.indexOf('id')], field, before, value);
}

function touch_(f) { f.sh.getRange(f.row, f.h.indexOf('updated_at') + 1).setValue(nowIso_()); }

function updateTxn_(book, who, req) {
  var f = findTxn_(book, req.id), ch = req.changes || {};
  Object.keys(ch).forEach(function (k) {
    if (!EDITABLE[k]) throw userError_('That field cannot be changed.');
    var val = ch[k];
    if (k === 'idr_amount') { val = Number(val); if (isNaN(val) || val <= 0) throw userError_('Type the amount as a number above zero.'); }
    setField_(book, who, f, k, val);
    if (k === 'category') setField_(book, who, f, 'bucket', bucketForCategory(rows_(book, 'Categories'), val));
  });
  if (req.confirm) {
    if (!f.vals[f.h.indexOf('category')] && f.vals[f.h.indexOf('txn_type')] !== 'payment') throw userError_('Choose a category before confirming.');
    if (f.vals[f.h.indexOf('status')] === 'needs_review') {
      if (!f.vals[f.h.indexOf('idr_amount')]) throw userError_('Type the amount before confirming.');
      if (!f.vals[f.h.indexOf('txn_type')]) setField_(book, who, f, 'txn_type', 'purchase');
    }
    if (isHeld_(book, f.vals[f.h.indexOf('category')])) setField_(book, who, f, 'txn_type', 'held_out');
    setField_(book, who, f, 'status', 'confirmed');
    setField_(book, who, f, 'who', NAMES[who]);
    learnRule_(book, f.vals[f.h.indexOf('payee')], f.vals[f.h.indexOf('category')], f.vals[f.h.indexOf('bucket')]);
  }
  touch_(f);
  return { saved: true };
}

/** Remember a payee's category. After 3 confirmations it is trusted and auto-confirms after 48 hours. */
function learnRule_(book, payee, category, bucket) {
  var key = ruleKey(payee);
  if (!key || !category) return;
  var sh = book.getSheetByName('Rules'), v = sh.getDataRange().getValues(), h = v[0];
  var iT = h.indexOf('match_text'), iC = h.indexOf('category'), iB = h.indexOf('bucket'), iA = h.indexOf('auto_confirm'), iU = h.indexOf('times_used');
  for (var i = 1; i < v.length; i++) {
    if (ruleKey(v[i][iT]) === key) {
      var n = Number(v[i][iU] || 0) + 1;
      sh.getRange(i + 1, iC + 1, 1, 1).setValue(category);
      sh.getRange(i + 1, iB + 1).setValue(bucket);
      sh.getRange(i + 1, iU + 1).setValue(n);
      sh.getRange(i + 1, iA + 1).setValue(n >= 3 ? 'Y' : 'N');
      return;
    }
  }
  append_(book, 'Rules', [{ rule_id: 'r_' + Utilities.getUuid().replace(/-/g, '').slice(0, 8), match_type: 'contains', match_text: key, category: category, bucket: bucket, auto_confirm: 'N', times_used: 1 }]);
}

function flagTxn_(book, who, id, flag) {
  var f = findTxn_(book, id), col = f.h.indexOf('flags'), cur = String(f.vals[col] || '');
  if (cur.split(',').indexOf(flag) === -1) setField_(book, who, f, 'flags', cur ? cur + ',' + flag : flag);
  touch_(f);
  return { saved: true };
}

function setStatus_(book, who, id, status, why) {
  var f = findTxn_(book, id);
  setField_(book, who, f, 'status', status);
  if (why === 'merge_duplicate') setField_(book, who, f, 'memo', (f.vals[f.h.indexOf('memo')] ? f.vals[f.h.indexOf('memo')] + ' | ' : '') + 'Merged: counted once');
  touch_(f);
  return { saved: true };
}

function addTxn_(book, who, req) {
  var amt = Number(req.amount);
  if (isNaN(amt) || amt <= 0) throw userError_('Type the amount as a number above zero.');
  if (!req.payee) throw userError_('Type who or what it was for.');
  var income = req.kind === 'income', held = req.kind === 'held';
  if (!income && !req.category) throw userError_(held ? 'Choose what kind of money this is.' : 'Choose a category.');
  if (held && !isHeld_(book, req.category)) throw userError_('That kind of money is not set up for holding. Add it as a new type first.');
  if (!held && !income && isHeld_(book, req.category)) throw userError_('That type is for money held for others. Use Held for others.');
  var now = nowIso_(), id = 't_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  var cat = income ? 'Income' : req.category;
  append_(book, 'Transactions', [{
    id: id, date: req.date || now.slice(0, 10), timestamp: now, txn_type: held ? 'held_in' : (income ? 'income' : 'purchase'), idr_amount: amt, orig_currency: 'IDR',
    account: req.account || '', payee: req.payee, category: cat, bucket: (income || held) ? '' : bucketForCategory(rows_(book, 'Categories'), cat),
    who: NAMES[who], source: 'manual', settled: 'Y', status: 'confirmed', memo: req.memo || '', created_at: now, updated_at: now
  }]);
  audit_(book, NAMES[who], 'add', 'Transactions', id, '', '', amt);
  return { id: id };
}


/** Everything the app screens need, in one request. Each sheet is read once. */
function bootstrap_(book, who) {
  var d = data_(book, who), role = ROLES[who];
  var home = computeHome(d); home.user = { name: NAMES[who], role: role };
  var settled = settledPayNow(d.txns), byId = {};
  d.txns.forEach(function (t) { byId[t.id] = t; });
  var review = reviewItems(d.txns).slice(0, 100).map(function (i) {
    var o = { kind: i.kind, txn: slim_(i.t, settled) };
    if (i.kind === 'duplicate' && byId[i.t.links_to_id]) o.other = slim_(byId[i.t.links_to_id], settled);
    return o;
  });
  var activity = d.txns.filter(function (t) { return t.status !== 'void'; })
    .sort(function (x, y) { return Date.parse(y.timestamp) - Date.parse(x.timestamp); }).slice(0, 80)
    .map(function (t) { return slim_(t, settled); });
  var cats = rows_(book, 'Categories').filter(function (c) { return String(c.active).toUpperCase() !== 'N'; })
    .map(function (c) { return { category: c.category, bucket: c.bucket, held: String(c.counts_in_bucket).toUpperCase() === 'HELD' }; });
  var accts = d.accounts.filter(function (x) { return x.active !== 'N' && x.entity !== 'PT' && (x.type === 'bank' || x.type === 'credit card'); }).map(function (x) { return x.account; });
  return { home: home, review: { items: review }, activity: { items: activity }, categories: { categories: cats, accounts: accts } };
}
