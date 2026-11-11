/**
 * Hanaro API (Apps Script project B). No Gmail access. Serves the app as a web app.
 * Needs Logic.gs in the same project.
 * Requests are POST with a text/plain JSON body: { key, action, ...args }.
 * Keys are never stored, only their SHA-256 hashes (Script Properties). Roles are enforced here, not in the app.
 */
var SHEET_ID = 'PASTE_SHEET_ID_HERE';   // set once in the pasted copy, never committed
var ROLES = { aj: 'owner', cynthia: 'partner' };
var NAMES = { aj: 'AJ', cynthia: 'Cynthia', system: 'Hanaro (auto)' };
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
  txns = dropMatchedManual_(txns);
  return {
    book: book, accounts: accounts, txns: txns, buckets: rows_(book, 'Buckets'), balances: rows_(book, 'Balances'),
    plan: planRows_(book), paid: paidRows_(book), history: historyRows_(book), debts: rows_(book, 'Debts'), summary: rows_(book, 'Summary'),
    today: Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd')
  };
}

var PLAN_HEADERS = ['month', 'item', 'kind', 'amount_idr', 'due_day', 'target_idr', 'every_months', 'category', 'active', 'set_by', 'match'];

/** The Plan tab is created the first time a plan is saved. Until then there is simply no plan. */
/** Imported YNAB history (month x category totals). Optional: used only to suggest the Flexible number. */
function historyRows_(book) { return book.getSheetByName('YNAB_Monthly') ? rows_(book, 'YNAB_Monthly') : []; }
var PAID_HEADERS = ['month', 'item', 'amount_idr', 'paid_date', 'set_by'];
function paidRows_(book) { return book.getSheetByName('PlanPaid') ? rows_(book, 'PlanPaid') : []; }
function planRows_(book) { return book.getSheetByName('Plan') ? rows_(book, 'Plan') : []; }

function ensurePlan_(book) {
  var sh = book.getSheetByName('Plan');
  if (sh) return;
  sh = book.insertSheet('Plan');
  sh.getRange(1, 1, 1, PLAN_HEADERS.length).setValues([PLAN_HEADERS]);
}

/** The match column was added later: an older Plan tab gets it the first time it is needed. */
function ensureMatchColumn_(sh) {
  var h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  if (h.indexOf('match') === -1) sh.getRange(1, h.length + 1).setValue('match');
}

/** One tap on "Paid": records money paid outside what Hanaro can see. Adds a row, never overwrites. */
function markPaid_(book, who, req) {
  var item = String(req.item || '').trim(), amt = Number(req.amount);
  if (!item) throw userError_('Choose the bill that was paid.');
  if (isNaN(amt) || amt <= 0) throw userError_('Type the amount that was paid as a number above zero.');
  var today = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  var sh = book.getSheetByName('PlanPaid');
  if (!sh) { sh = book.insertSheet('PlanPaid'); sh.getRange(1, 1, 1, PAID_HEADERS.length).setValues([PAID_HEADERS]); }
  append_(book, 'PlanPaid', [{ month: today.slice(0, 7), item: item, amount_idr: amt, paid_date: today, set_by: NAMES[who] }]);
  audit_(book, NAMES[who], 'plan_paid', 'PlanPaid', item, 'amount_idr', '', amt);
  return { saved: true };
}

function planView_(book, who) {
  var d = data_(book, who);
  return computePlan_({ plan: d.plan, txns: d.txns, accounts: d.accounts, today: d.today, paid: d.paid });
}

/** Saves one planned item for this month. History is kept: a change adds a row, it never overwrites. */
function setPlan_(book, who, req) {
  var kind = String(req.kind || ''), item = String(req.item || '').trim();
  if (['fixed', 'nonmonthly', 'flexible'].indexOf(kind) === -1) throw userError_('Choose Fixed, Non-monthly or Flexible.');
  if (kind === 'flexible') item = 'Flexible';
  if (!item) throw userError_('Type a name for this item.');
  if (item.length > 40) throw userError_('Keep the name under 40 characters.');
  var row = { month: Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM'), item: item, kind: kind, active: 'Y', set_by: NAMES[who], category: req.category || '' };
  if (kind === 'nonmonthly') {
    var target = Number(req.target), every = Number(req.every);
    if (isNaN(target) || target <= 0) throw userError_('Type the target amount as a number above zero.');
    if (isNaN(every) || every < 1 || every > 60 || Math.round(every) !== every) throw userError_('Type how many months it covers, for example 6 or 12.');
    row.target_idr = target; row.every_months = every;
  } else {
    var amt = Number(req.amount);
    if (isNaN(amt) || amt <= 0) throw userError_('Type the amount as a number above zero.');
    row.amount_idr = amt;
    if (kind === 'fixed' && req.dueDay !== '' && req.dueDay !== null && req.dueDay !== undefined) {
      var dd = Number(req.dueDay);
      if (isNaN(dd) || dd < 1 || dd > 31 || Math.round(dd) !== dd) throw userError_('Type the due day as a number from 1 to 31.');
      row.due_day = dd;
    }
  }
  if (kind === 'fixed' && req.match !== undefined) {
    var mt = String(req.match || '').trim();
    if (mt.length > 80) throw userError_('Keep the payee words under 80 characters.');
    row.match = mt;
  }
  ensurePlan_(book);
  ensureMatchColumn_(book.getSheetByName('Plan'));
  append_(book, 'Plan', [row]);
  audit_(book, NAMES[who], 'set_plan', 'Plan', item, kind, '', row.amount_idr || row.target_idr);
  return { saved: true };
}

function removePlan_(book, who, req) {
  var item = String(req.item || '').trim();
  if (!item) throw userError_('Choose an item to remove.');
  ensurePlan_(book);
  append_(book, 'Plan', [{ month: Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM'), item: item, kind: req.kind || '', active: 'N', set_by: NAMES[who] }]);
  audit_(book, NAMES[who], 'remove_plan', 'Plan', item, '', '', '');
  return { saved: true };
}

function slim_(t, settled, ctx) {
  var f = String(t.flags || '').split(',').filter(function (x) { return x; });
  return {
    id: t.id, date: String(t.date).slice(0, 10), timestamp: t.timestamp, type: t.txn_type, amount: t.idr_amount === '' ? null : Number(t.idr_amount),
    account: t.account, payee: t.payee, category: t.category, bucket: t.bucket, status: t.status, memo: t.memo, source: t.source,
    payNow: f.indexOf('pay_now') !== -1, paid: !!(settled && settled[t.id]), links: t.links_to_id || '', who: t.who || '', by: byOf_(t, ctx),
    cleared: t.source === 'email', receipt: !!t.receipt_drive_id, entity: t.entity || '', origAmount: has_(t.orig_amount) && t.orig_amount !== '' ? Number(t.orig_amount) : null, origCurrency: t.orig_currency || '', est: flagsOf_(t).indexOf('fx_est') !== -1, ptFile: String(t.pt_file).toUpperCase() === 'Y', lat: has_(t.lat) && t.lat !== '' ? Number(t.lat) : null, lng: has_(t.lng) && t.lng !== '' ? Number(t.lng) : null
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
  if (a === 'plan') return planView_(book, who);
  if (a === 'set_plan') return setPlan_(book, who, req);
  if (a === 'remove_plan') return removePlan_(book, who, req);
  if (a === 'plan_paid') return markPaid_(book, who, req);
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
    var d3 = data_(book, who), s3 = settledPayNow(d3.txns), byCtx = { pt: ptAccounts_(d3.accounts), owners: {} };
    d3.accounts.forEach(function (x) { byCtx.owners[x.account] = x.owner; if (x.last4 && x.type === 'bank') byCtx.owners['BCA ...' + x.last4] = x.owner; });
    var list = d3.txns.filter(function (t) { return t.status !== 'void'; })
      .sort(function (x, y) { return Date.parse(y.timestamp) - Date.parse(x.timestamp); }).slice(0, 150)
      .map(function (t) { return slim_(t, s3, byCtx); });
    return { items: list };
  }
  if (a === 'categories') {
    return { categories: rows_(book, 'Categories').filter(function (c) { return String(c.active).toUpperCase() !== 'N'; })
      .map(function (c) { return { category: c.category, bucket: c.bucket, held: String(c.counts_in_bucket).toUpperCase() === 'HELD' }; }), accounts: rows_(book, 'Accounts').filter(function (x) { return x.active !== 'N' && x.entity !== 'PT' && (x.type === 'bank' || x.type === 'credit card'); }).map(function (x) { return x.account; }) };
  }
  if (a === 'status') return status_(book, who);
  if (a === 'payees') return { payees: payeeSummary_(data_(book, who).txns, rows_(book, 'Rules')), categories: categoryList_(book) };
  if (a === 'payee_hints') {
    var arch = book.getSheetByName('Archive_YNAB') ? rows_(book, 'Archive_YNAB') : [];
    return { hints: buildPayeeHints_(arch, ynabCategoryMap_(rows_(book, 'Categories')), rows_(book, 'Rules')) };
  }
  if (a === 'pt_file_list') return ptFileList_(book, who, req);
  if (a === 'set_payee_category') return setPayeeCategory_(book, who, req);
  if (a === 'attach_photo') return attachPhoto_(book, who, req);
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

var EDITABLE = { category: 1, payee: 1, idr_amount: 1, memo: 1, account: 1, entity: 1, pt_file: 1 };

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
    if (k === 'entity' && val !== 'Family' && val !== 'Business' && val !== '') throw userError_('Choose Family or Business.');
    if (k === 'pt_file' && val !== 'Y' && val !== '') throw userError_('File for PT AHU can only be on or off.');
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

var CURRENCIES = { IDR: 1, SGD: 1, MYR: 1, USD: 1, JPY: 1, EUR: 1, AUD: 1, THB: 1 };

/** Rupiah per 1 unit of a currency: the card's last real rate (from the last 60 days) first, then today's market rate. Never invented. */
function fxRate_(book, cur) {
  var best = null, cutoff = Utilities.formatDate(new Date(Date.now() - 60 * 86400000), 'Asia/Jakarta', 'yyyy-MM-dd');
  rows_(book, 'Transactions').forEach(function (t) {
    if (t.orig_currency !== cur || !has_(t.fx_rate) || t.fx_rate === '' || String(t.date).slice(0, 10) < cutoff || flagsOf_(t).indexOf('fx_est') !== -1) return;
    if (!best || String(t.timestamp) > best.ts) best = { ts: String(t.timestamp), rate: Number(t.fx_rate) };
  });
  if (best && best.rate > 0) return { rate: best.rate, source: 'card' };
  var cache = CacheService.getScriptCache(), key = 'fx_' + cur, hit = cache.get(key);
  if (hit) return { rate: Number(hit), source: 'market' };
  try {
    var res = UrlFetch_('https://open.er-api.com/v6/latest/' + cur);
    var r = res && res.rates && res.rates.IDR;
    if (r > 0) { cache.put(key, String(r), 6 * 3600); return { rate: r, source: 'market' }; }
  } catch (e) {}
  return null;
}
function UrlFetch_(url) {
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return null;
  return JSON.parse(r.getContentText());
}

function addTxn_(book, who, req) {
  var cur = String(req.currency || 'IDR').toUpperCase();
  if (!CURRENCIES[cur]) throw userError_('That currency is not set up. Use IDR, SGD, MYR, USD, JPY, EUR, AUD or THB.');
  var amt = Number(req.amount), fx = null, est = false, origAmt = '';
  if (isNaN(amt) || amt <= 0) throw userError_('Type the amount as a number above zero.');
  if (cur !== 'IDR') {
    origAmt = Math.round(amt * 100) / 100;
    var typedIdr = Number(req.idr_amount);
    if (typedIdr > 0) { amt = Math.round(typedIdr); fx = Math.round(amt / origAmt * 10000) / 10000; }
    else {
      var fr = fxRate_(book, cur);
      if (!fr) throw userError_('Hanaro could not find today\'s ' + cur + ' rate. Type the rupiah amount too, once, and it will remember the rate.');
      fx = fr.rate; amt = Math.round(origAmt * fr.rate); est = true;
    }
  }
  if (!req.payee) throw userError_('Type who or what it was for.');
  var income = req.kind === 'income', held = req.kind === 'held';
  if (held && !req.category) throw userError_('Choose what kind of money this is.');
  if (held && !isHeld_(book, req.category)) throw userError_('That kind of money is not set up for holding. Add it as a new type first.');
  if (!held && !income && req.category && isHeld_(book, req.category)) throw userError_('That type is for money held for others. Use Held for others.');
  var now = nowIso_(), id = 't_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  var cat = income ? 'Income' : (req.category || '');
  // A spend without a category is saved now and waits in Review for a category.
  var uncategorized = !income && !held && !cat;
  // A date other than today is kept as the day it happened, so totals and lists put it on the right day.
  var day = now.slice(0, 10), stamp = now;
  if (req.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.date))) throw userError_('Choose the date again.');
    if (String(req.date) > day) throw userError_('The date cannot be in the future.');
    if (String(req.date) < day) { day = String(req.date); stamp = day + 'T12:00:00+07:00'; }
  }
  append_(book, 'Transactions', [{
    id: id, date: day, timestamp: stamp, txn_type: held ? 'held_in' : (income ? 'income' : 'purchase'), idr_amount: amt, orig_amount: origAmt, orig_currency: cur, fx_rate: fx === null ? '' : fx, flags: est ? 'fx_est' : '',
    account: req.account || '', payee: req.payee, category: cat, bucket: (income || held || !cat) ? '' : bucketForCategory(rows_(book, 'Categories'), cat),
    who: NAMES[who], source: 'manual', settled: 'Y', status: uncategorized ? 'auto' : 'confirmed', memo: req.memo || '', entity: (req.entity === 'Family' || req.entity === 'Business') ? req.entity : '', pt_file: req.pt_file ? 'Y' : '', created_at: now, updated_at: now,
    lat: has_(req.lat) && req.lat !== '' && req.lat !== null ? Number(req.lat) : '', lng: has_(req.lng) && req.lng !== '' && req.lng !== null ? Number(req.lng) : ''
  }]);
  audit_(book, NAMES[who], 'add', 'Transactions', id, '', '', amt);
  if (req.photo) { try { attachPhoto_(book, who, { id: id, photo: req.photo }); } catch (e) { log_(book, 'warn', 'Receipt photo not saved: ' + e.message, id); } }
  try { reconcile_(book, who); } catch (e2) { log_(book, 'warn', 'Matching failed: ' + e2.message, ''); }
  return { id: id };
}


/** Everything the app screens need, in one request. Each sheet is read once. */
function bootstrap_(book, who) {
  var d = data_(book, who), role = ROLES[who];
  var home = computeHome(d); home.user = { name: NAMES[who], role: role };
  var settled = settledPayNow(d.txns), byId = {};
  var byCtx = { pt: ptAccounts_(d.accounts), owners: {} };
  d.accounts.forEach(function (x) { byCtx.owners[x.account] = x.owner; if (x.last4 && x.type === 'bank') byCtx.owners['BCA ...' + x.last4] = x.owner; });
  d.txns.forEach(function (t) { byId[t.id] = t; });
  var review = reviewItems(d.txns).slice(0, 100).map(function (i) {
    var o = { kind: i.kind, txn: slim_(i.t, settled) };
    if (i.kind === 'duplicate' && byId[i.t.links_to_id]) o.other = slim_(byId[i.t.links_to_id], settled);
    return o;
  });
  var activity = d.txns.filter(function (t) { return t.status !== 'void'; })
    .sort(function (x, y) { return Date.parse(y.timestamp) - Date.parse(x.timestamp); }).slice(0, 150)
    .map(function (t) { return slim_(t, settled, byCtx); });
  var cats = rows_(book, 'Categories').filter(function (c) { return String(c.active).toUpperCase() !== 'N'; })
    .map(function (c) { return { category: c.category, bucket: c.bucket, held: String(c.counts_in_bucket).toUpperCase() === 'HELD' }; });
  var accts = d.accounts.filter(function (x) { return x.active !== 'N' && x.entity !== 'PT' && (x.type === 'bank' || x.type === 'credit card'); }).map(function (x) { return x.account; });
  var plan = computePlan_({ plan: d.plan, txns: d.txns, accounts: d.accounts, today: d.today, paid: d.paid });
  return { home: home, review: { items: review }, activity: { items: activity }, categories: { categories: cats, accounts: accts, apiV: 2 }, plan: plan };
}


function categoryList_(book) {
  return rows_(book, 'Categories').filter(function (c) { return String(c.active).toUpperCase() !== 'N'; })
    .map(function (c) { return { category: c.category, bucket: c.bucket, held: String(c.counts_in_bucket).toUpperCase() === 'HELD' }; });
}

function addFlag_(book, who, f, flag) {
  var col = f.h.indexOf('flags'), cur = String(f.vals[col] || '');
  if (cur.split(',').indexOf(flag) === -1) setField_(book, who, f, 'flags', cur ? cur + ',' + flag : flag);
}

/**
 * A purchase typed in the app and its bank email are one purchase. The email row is kept (it has the exact time,
 * account and reference) and receives what the person typed; the typed row is voided, never deleted.
 */
function reconcile_(book, who) {
  var pairs = findMatches_(rows_(book, 'Transactions'));
  pairs.forEach(function (p) {
    var e = findTxn_(book, p.email.id), m = findTxn_(book, p.manual.id);
    function mv(k) { return m.vals[m.h.indexOf(k)]; }
    if (mv('category')) { setField_(book, who, e, 'category', mv('category')); setField_(book, who, e, 'bucket', mv('bucket')); }
    if (mv('payee')) setField_(book, who, e, 'payee', mv('payee'));
    if (mv('who')) setField_(book, who, e, 'who', mv('who'));
    if (mv('memo')) setField_(book, who, e, 'memo', mv('memo'));
    if (mv('lat') !== '') { setField_(book, who, e, 'lat', mv('lat')); setField_(book, who, e, 'lng', mv('lng')); }
    if (mv('receipt_drive_id')) setField_(book, who, e, 'receipt_drive_id', mv('receipt_drive_id'));
    if (mv('orig_currency') && mv('orig_currency') !== 'IDR' && has_(mv('orig_amount'))) {
      var real = num_(e.vals[e.h.indexOf('idr_amount')]), oa = num_(mv('orig_amount'));
      setField_(book, who, e, 'orig_amount', oa); setField_(book, who, e, 'orig_currency', mv('orig_currency'));
      if (oa > 0 && real > 0) setField_(book, who, e, 'fx_rate', Math.round(real / oa * 10000) / 10000);
    }
    if (mv('entity')) setField_(book, who, e, 'entity', mv('entity'));
    if (mv('pt_file')) setField_(book, who, e, 'pt_file', mv('pt_file'));
    setField_(book, who, e, 'status', 'confirmed');
    addFlag_(book, who, e, 'matched');
    touch_(e);
    setField_(book, who, m, 'status', 'void');
    setField_(book, who, m, 'memo', (mv('memo') ? mv('memo') + ' | ' : '') + 'Merged with bank email ' + p.email.id);
    addFlag_(book, who, m, 'matched');
    touch_(m);
    if (mv('category')) learnRule_(book, p.email.payee, mv('category'), mv('bucket'));
  });
  return pairs.length;
}

/** Trigger, every 5 minutes: pair typed entries with bank emails that arrived afterwards. */
function reconcileRun() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  var book = book_();
  try { reconcile_(book, 'system'); } catch (e) { try { log_(book, 'error', 'Matching failed: ' + e.message, String(e.stack || '')); } catch (e2) {} } finally { lock.releaseLock(); }
}

function setSummary_(book, key, value) {
  var sh = book.getSheetByName('Summary'), rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) if (rows[i][0] === key) { sh.getRange(i + 1, 2, 1, 2).setValues([[value, nowIso_()]]); return; }
  sh.appendRow([key, value, nowIso_()]);
}

/** Trigger, every evening: writes the message the capture script sends to Telegram. */
function eveningRun() {
  var book = book_();
  try {
    var d = data_(book, 'aj');
    setSummary_(book, 'evening_text', eveningText_(computeHome(d)));
    setSummary_(book, 'evening_date', d.today);
  } catch (e) { try { log_(book, 'error', 'Evening summary failed: ' + e.message, String(e.stack || '')); } catch (e2) {} throw e; }
}

/** Run once from the editor after pasting. Replaces this project's triggers. */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('reconcileRun').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('eveningRun').timeBased().atHour(20).everyDays(1).create();
  eveningRun();
  DriveApp.getRootFolder(); // asks for Drive permission once, used for receipt photos
}

/** Defaults for a place: the next bank email from it gets this category (trusted straight away). */
function setPayeeCategory_(book, who, req) {
  var key = ruleKey(req.payee);
  if (!key) throw userError_('Choose a place first.');
  var cats = rows_(book, 'Categories'), bucket = null;
  cats.forEach(function (c) { if (c.category === req.category) bucket = c.bucket || ''; });
  if (bucket === null) throw userError_('Choose a category from the list.');
  var sh = book.getSheetByName('Rules'), v = sh.getDataRange().getValues(), h = v[0];
  var iT = h.indexOf('match_text'), iC = h.indexOf('category'), iB = h.indexOf('bucket'), iA = h.indexOf('auto_confirm');
  for (var i = 1; i < v.length; i++) if (ruleKey(v[i][iT]) === key) {
    sh.getRange(i + 1, iC + 1).setValue(req.category); sh.getRange(i + 1, iB + 1).setValue(bucket); sh.getRange(i + 1, iA + 1).setValue('Y');
    audit_(book, NAMES[who], 'set_payee_category', 'Rules', key, 'category', v[i][iC], req.category);
    return { saved: true };
  }
  append_(book, 'Rules', [{ rule_id: 'r_' + Utilities.getUuid().replace(/-/g, '').slice(0, 8), match_type: 'contains', match_text: key, category: req.category, bucket: bucket, auto_confirm: 'Y', times_used: 0 }]);
  audit_(book, NAMES[who], 'set_payee_category', 'Rules', key, 'category', '', req.category);
  return { saved: true };
}

/** Everything filed for PT AHU in a month (default: this month), with receipt links, for the accountant. */
function ptFileList_(book, who, req) {
  var month = /^\d{4}-\d{2}$/.test(String(req.month || '')) ? req.month : Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM');
  var items = rows_(book, 'Transactions').filter(function (t) {
    return String(t.pt_file).toUpperCase() === 'Y' && t.status !== 'void' && String(t.date || t.timestamp).slice(0, 7) === month;
  }).sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); }).map(function (t) {
    return { id: t.id, date: String(t.date).slice(0, 10), payee: t.payee, category: t.category, amount: num_(t.idr_amount), account: t.account, entity: t.entity || '',
      receipt: t.receipt_drive_id ? 'https://drive.google.com/file/d/' + t.receipt_drive_id + '/view' : '' };
  });
  return { month: month, items: items, total: items.reduce(function (a, i) { return a + i.amount; }, 0), missingReceipts: items.filter(function (i) { return !i.receipt; }).length };
}

/** Saves a receipt photo to PT_Receipts/_Inbox in Drive (the nightly PT filing sorts it from there) and links it to the transaction. */
function attachPhoto_(book, who, req) {
  var ph = req.photo || req;
  if (!ph.data) throw userError_('The photo did not arrive. Please try again.');
  var f = findTxn_(book, req.id);
  var it = DriveApp.getFoldersByName('PT_Receipts'), root = it.hasNext() ? it.next() : DriveApp.createFolder('PT_Receipts');
  var sub = root.getFoldersByName('_Inbox'), folder = sub.hasNext() ? sub.next() : root.createFolder('_Inbox');
  var rawDate = f.vals[f.h.indexOf('date')];
  var d = (rawDate instanceof Date) ? Utilities.formatDate(rawDate, 'Asia/Jakarta', 'yyyy-MM-dd') : String(rawDate).slice(0, 10), pay = String(f.vals[f.h.indexOf('payee')] || 'receipt').replace(/[^\w\- ]+/g, '').trim().slice(0, 30);
  var name = d + ' ' + pay + ' ' + f.vals[f.h.indexOf('idr_amount')] + '.jpg';
  var file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(ph.data), ph.mime || 'image/jpeg', name));
  setField_(book, who, f, 'receipt_drive_id', file.getId());
  touch_(f);
  return { saved: true };
}
