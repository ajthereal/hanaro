/**
 * Hanaro API (Apps Script project B). No Gmail access. Serves the app as a web app.
 * Needs Logic.gs in the same project.
 * Requests are POST with a text/plain JSON body: { key, action, ...args }.
 * Keys are never stored, only their SHA-256 hashes (Script Properties). Roles are enforced here, not in the app.
 *
 * Reads never wait for the lock and are cached for 45 seconds (any write clears the cache at once).
 * Writes take the lock, change the Sheet, and write every change to the Audit tab in one go.
 * Errors that a person can fix carry a plain message. Anything else is marked retry so the app keeps the
 * change on the phone and sends it again instead of throwing it away.
 */
var SHEET_ID = 'PASTE_SHEET_ID_HERE';   // set once in the pasted copy, never committed
var ROLES = { aj: 'owner', cynthia: 'partner' };
var NAMES = { aj: 'AJ', cynthia: 'Cynthia', system: 'Hanaro (auto)' };
var MAX_FAILS = 10;
var API_V = 3;            // 2: save without a category, past dates. 3: ids from the phone, batches, edit, delete, transfers, reports
var TX_WINDOW = 3000;     // the newest rows of Transactions that every screen reads (about 8+ months)
var CACHE_SECONDS = 45;
var DEFER_AUDIT_ = false, AUDIT_BUF_ = [];

/** Actions that change the Sheet. Only these take the lock. */
var WRITES_ = { set_plan: 1, remove_plan: 1, plan_paid: 1, set_payee_category: 1, attach_photo: 1, add_held_type: 1, update_txn: 1, add_txn: 1, mark_paid: 1, keep_both: 1, merge_dup: 1, set_balance: 1, set_cap: 1, set_debt: 1, void_txn: 1, restore_txn: 1, batch: 1 };
/** Actions that may travel together in one batch request. */
var BATCHABLE_ = { set_plan: 1, remove_plan: 1, plan_paid: 1, set_payee_category: 1, attach_photo: 1, add_held_type: 1, update_txn: 1, add_txn: 1, mark_paid: 1, keep_both: 1, merge_dup: 1, set_balance: 1, set_cap: 1, set_debt: 1, void_txn: 1, restore_txn: 1 };

function book_() { return SpreadsheetApp.openById(SHEET_ID); }

function nowIso_(tz) { return Utilities.formatDate(new Date(), tz || 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function jakartaToday_() { return Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd'); }

/** The day the person is living in. A phone abroad sends its own date; anything more than a day from Jakarta is ignored. */
function todayFor_(req) {
  var jak = jakartaToday_(), t = String((req && req.today) || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(t) && !isNaN(Date.parse(t + 'T00:00:00Z')) && Math.abs(daysBetween_(jak, t)) <= 1) return t;
  return jak;
}

/* ---------- reading the Sheet ---------- */

function cellOut_(c, tz) { return (c instanceof Date) ? Utilities.formatDate(c, tz, "yyyy-MM-dd'T'HH:mm:ssXXX") : c; }

/** Every row of a tab as objects keyed by header. n > 0 reads only the newest n rows (one call for the header, one for the rows). */
function rowsFrom_(book, name, n) {
  var sh = book.getSheetByName(name);
  if (!sh) throw new Error('The Sheet has no tab called ' + name + '.');
  var tz = book.getSpreadsheetTimeZone(), h, v, first = 2;
  if (!n) {
    v = sh.getDataRange().getValues();
    if (v.length < 2) return [];
    h = v[0]; v = v.slice(1);
  } else {
    var last = sh.getLastRow(), cols = sh.getLastColumn();
    if (last < 2 || cols < 1) return [];
    h = sh.getRange(1, 1, 1, cols).getValues()[0];
    first = (last - 1 > n) ? last - n + 1 : 2;
    v = sh.getRange(first, 1, last - first + 1, cols).getValues();
  }
  return v.map(function (r, i) {
    var o = { _row: first + i };
    h.forEach(function (k, j) { o[k] = cellOut_(r[j], tz); });
    return o;
  });
}
function rows_(book, name) { return rowsFrom_(book, name, 0); }
function rowsTail_(book, name, n) { return rowsFrom_(book, name, n); }

/** One column of a tab from row 2 down, as an array. Used for totals that must cover every row, not just the newest. */
function column_(sh, header) {
  var last = sh.getLastRow(), cols = sh.getLastColumn();
  if (last < 2) return [];
  var h = sh.getRange(1, 1, 1, cols).getValues()[0], i = h.indexOf(header);
  if (i < 0) return [];
  return sh.getRange(2, i + 1, last - 1, 1).getValues().map(function (r) { return r[0]; });
}

function append_(book, name, objs) {
  if (!objs.length) return;
  var sh = book.getSheetByName(name);
  var h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var out = objs.map(function (o) { return h.map(function (k) { return o[k] === undefined ? '' : o[k]; }); });
  sh.getRange(sh.getLastRow() + 1, 1, out.length, h.length).setValues(out);
}

/** Audit entries wait in memory during a write and are saved together at the end, so a change costs one extra write, not one per field. */
function audit_(book, who, action, tab, rowId, field, before, after) {
  var o = { timestamp: nowIso_(), who: who, action: action, tab: tab, row_id: rowId, field: field, before: before, after: after };
  if (DEFER_AUDIT_) { AUDIT_BUF_.push(o); return; }
  append_(book, 'Audit', [o]);
}
function flushAudit_(book) {
  var buf = AUDIT_BUF_; AUDIT_BUF_ = [];
  if (buf.length) append_(book, 'Audit', buf);
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
  var cache = CacheService.getScriptCache(), req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return reply_({ ok: false, error: 'The app sent something unreadable. Please update the app.' }); }
  var who = who_(req.key);
  if (!who) {
    // A wrong key never blocks a right one. The keys are 160 bits, so guessing is hopeless; the count only feeds the Log.
    var fails = Number(cache.get('fails') || 0) + 1;
    cache.put('fails', String(fails), 900);
    if (fails <= MAX_FAILS) { try { log_(book_(), 'warn', 'Wrong key used', 'attempt ' + fails); } catch (e2) {} }
    return reply_({ ok: false, error: 'This key is not recognised. Check it was copied in full.' });
  }
  var lock = null;
  try {
    if (WRITES_[req.action]) { lock = LockService.getScriptLock(); lock.waitLock(25000); }
    try { return reply_({ ok: true, data: handle_(req, who) }); } finally { if (lock) lock.releaseLock(); }
  } catch (err) {
    try { log_(book_(), 'error', 'API ' + req.action + ' failed: ' + err.message, String(err.stack || '')); } catch (e3) {}
    return reply_({ ok: false, error: err.userMessage || ('Something went wrong: ' + err.message), retry: !err.userMessage });
  }
}

function userError_(msg) { var e = new Error(msg); e.userMessage = msg; return e; }

/* ---------- short-lived cache for reads ---------- */

function bump_() { try { CacheService.getScriptCache().put('ver', String(Date.now()), 21600); } catch (e) {} }

function cachePutBig_(cache, key, str, secs) {
  var parts = [], i;
  for (i = 0; i < str.length; i += 30000) parts.push(str.slice(i, i + 30000));
  if (parts.length > 14) return;
  var all = {}; all[key] = String(parts.length);
  parts.forEach(function (p, n) { all[key + '#' + n] = p; });
  cache.putAll(all, secs);
}
function cacheGetBig_(cache, key) {
  var n = Number(cache.get(key) || 0);
  if (!n) return null;
  var keys = []; for (var i = 0; i < n; i++) keys.push(key + '#' + i);
  var got = cache.getAll(keys), out = '';
  for (var j = 0; j < n; j++) { if (got[keys[j]] === undefined || got[keys[j]] === null) return null; out += got[keys[j]]; }
  return out;
}
/** Runs fn and keeps its answer for a few seconds, per person and per day. req.nocache skips reading (pull to refresh). */
function cached_(who, req, name, fn) {
  var cache = CacheService.getScriptCache(), ver = cache.get('ver') || '0';
  var key = name + '_' + who + '_' + todayFor_(req) + '_' + String((req && (req.month || req.region)) || '') + '_' + ver;
  if (!(req && req.nocache)) { try { var hit = cacheGetBig_(cache, key); if (hit) return JSON.parse(hit); } catch (e) {} }
  var out = fn();
  try { cachePutBig_(cache, key, JSON.stringify(out), CACHE_SECONDS); } catch (e2) {}
  return out;
}

/* ---------- what every screen reads ---------- */

function ptNames_(accounts) { return ptAccounts_(accounts); }

function data_(book, who, req) {
  var accounts = rows_(book, 'Accounts'), pt = ptAccounts_(accounts);
  var partner = ROLES[who] === 'partner';
  var txns = rowsTail_(book, 'Transactions', TX_WINDOW);
  if (partner) txns = txns.filter(function (t) { return !pt[t.account]; });
  txns = dropMatchedManual_(txns);
  return {
    book: book, accounts: accounts, txns: txns, buckets: rows_(book, 'Buckets'), balances: rows_(book, 'Balances'),
    plan: planRows_(book), paid: paidRows_(book), history: historyRows_(book), debts: rows_(book, 'Debts'), summary: rows_(book, 'Summary'),
    heldAll: heldAll_(book, partner ? pt : null), today: todayFor_(req)
  };
}

/** Money held for others, from every row of the Sheet (a held balance can be older than the newest rows). Reads five columns only. */
function heldAll_(book, hidePt) {
  var sh = book.getSheetByName('Transactions');
  if (!sh) return null;
  var ty = column_(sh, 'txn_type'), st = column_(sh, 'status'), ca = column_(sh, 'category'), am = column_(sh, 'idr_amount'), ac = column_(sh, 'account'), out = [];
  for (var i = 0; i < ty.length; i++) {
    if (ty[i] !== 'held_in' && ty[i] !== 'held_out') continue;
    if (hidePt && hidePt[ac[i]]) continue;
    out.push({ txn_type: ty[i], status: st[i], category: ca[i], idr_amount: am[i] });
  }
  return heldFrom_(out);
}

var PLAN_HEADERS = ['month', 'item', 'kind', 'amount_idr', 'due_day', 'target_idr', 'every_months', 'category', 'active', 'set_by', 'match', 'weekend'];

/** Imported YNAB history (month x category totals). Optional: used only to suggest the Flexible number and for old months. */
function historyRows_(book) { return book.getSheetByName('YNAB_Monthly') ? rows_(book, 'YNAB_Monthly') : []; }
var PAID_HEADERS = ['month', 'item', 'amount_idr', 'paid_date', 'set_by'];
function paidRows_(book) { return book.getSheetByName('PlanPaid') ? rows_(book, 'PlanPaid') : []; }
/** The Plan tab is created the first time a plan is saved. Until then there is simply no plan. */
function planRows_(book) { return book.getSheetByName('Plan') ? rows_(book, 'Plan') : []; }
var DEBTBAL_HEADERS = ['date_confirmed', 'debt', 'balance_idr', 'set_by'];
function debtBalanceRows_(book) { return book.getSheetByName('DebtBalances') ? rows_(book, 'DebtBalances') : []; }

function ensurePlan_(book) {
  var sh = book.getSheetByName('Plan');
  if (sh) return;
  sh = book.insertSheet('Plan');
  sh.getRange(1, 1, 1, PLAN_HEADERS.length).setValues([PLAN_HEADERS]);
}

/** Columns added later (match, weekend): an older Plan tab gets each one the first time it is needed. */
function ensurePlanColumn_(sh, name) {
  var h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  if (h.indexOf(name) === -1) sh.getRange(1, h.length + 1).setValue(name);
}
function ensureMatchColumn_(sh) { ensurePlanColumn_(sh, 'match'); }

/** One tap on "Paid": records money paid outside what Hanaro can see. Adds a row, never overwrites. A second tap with the same amount on the same day is the same tap. */
function markPaid_(book, who, req) {
  var item = String(req.item || '').trim(), amt = Number(req.amount);
  if (!item) throw userError_('Choose the bill that was paid.');
  if (isNaN(amt) || amt <= 0) throw userError_('Type the amount that was paid as a number above zero.');
  var today = todayFor_(req);
  var sh = book.getSheetByName('PlanPaid');
  if (!sh) { sh = book.insertSheet('PlanPaid'); sh.getRange(1, 1, 1, PAID_HEADERS.length).setValues([PAID_HEADERS]); }
  var dup = paidRows_(book).some(function (r) { return r.item === item && Number(r.amount_idr) === amt && String(r.paid_date).slice(0, 10) === today && r.set_by === NAMES[who]; });
  if (dup) return { saved: true, duplicate: true };
  append_(book, 'PlanPaid', [{ month: today.slice(0, 7), item: item, amount_idr: amt, paid_date: today, set_by: NAMES[who] }]);
  audit_(book, NAMES[who], 'plan_paid', 'PlanPaid', item, 'amount_idr', '', amt);
  return { saved: true };
}

function planView_(book, who, req) {
  var d = data_(book, who, req);
  return computePlan_({ plan: d.plan, txns: d.txns, accounts: d.accounts, today: d.today, paid: d.paid });
}

/** Saves one planned item for this month. History is kept: a change adds a row, it never overwrites. */
function setPlan_(book, who, req) {
  var kind = String(req.kind || ''), item = String(req.item || '').trim();
  if (['fixed', 'nonmonthly', 'flexible'].indexOf(kind) === -1) throw userError_('Choose Fixed, Non-monthly or Flexible.');
  if (kind === 'flexible') item = 'Flexible';
  if (!item) throw userError_('Type a name for this item.');
  if (item.length > 40) throw userError_('Keep the name under 40 characters.');
  var row = { month: jakartaToday_().slice(0, 7), item: item, kind: kind, active: 'Y', set_by: NAMES[who], category: req.category || '' };
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
  if (kind === 'fixed' && req.weekend !== undefined) {
    var wk = String(req.weekend || '');
    if (['', 'before', 'after'].indexOf(wk) === -1) throw userError_('Choose what to do when the due day is a weekend.');
    row.weekend = wk;
  }
  ensurePlan_(book);
  ensurePlanColumn_(book.getSheetByName('Plan'), 'match');
  ensurePlanColumn_(book.getSheetByName('Plan'), 'weekend');
  append_(book, 'Plan', [row]);
  audit_(book, NAMES[who], 'set_plan', 'Plan', item, kind, '', row.amount_idr || row.target_idr);
  return { saved: true };
}

function removePlan_(book, who, req) {
  var item = String(req.item || '').trim();
  if (!item) throw userError_('Choose an item to remove.');
  ensurePlan_(book);
  append_(book, 'Plan', [{ month: jakartaToday_().slice(0, 7), item: item, kind: req.kind || '', active: 'N', set_by: NAMES[who] }]);
  audit_(book, NAMES[who], 'remove_plan', 'Plan', item, '', '', '');
  return { saved: true };
}

function slim_(t, settled, ctx) {
  var f = flagsOf_(t);
  return {
    id: t.id, date: dayOf_(t), timestamp: t.timestamp, type: t.txn_type, amount: t.idr_amount === '' ? null : Number(t.idr_amount),
    account: t.account, payee: t.payee, category: t.category, bucket: t.bucket, status: t.status, memo: t.memo, source: t.source,
    payNow: f.indexOf('pay_now') !== -1, paid: !!(settled && settled[t.id]), links: t.links_to_id || '', who: t.who || '', by: byOf_(t, ctx),
    cleared: t.source === 'email', receipt: !!t.receipt_drive_id, entity: t.entity || '', origAmount: has_(t.orig_amount) && t.orig_amount !== '' ? Number(t.orig_amount) : null, origCurrency: t.orig_currency || '', est: f.indexOf('fx_est') !== -1, ptFile: String(t.pt_file).toUpperCase() === 'Y', lat: has_(t.lat) && t.lat !== '' ? Number(t.lat) : null, lng: has_(t.lng) && t.lng !== '' ? Number(t.lng) : null,
    matched: f.indexOf('matched') !== -1, dateOnly: dateOnly_(t)
  };
}

function ownersCtx_(d) {
  var ctx = { pt: ptAccounts_(d.accounts), owners: {} };
  d.accounts.forEach(function (x) { ctx.owners[x.account] = x.owner; if (x.last4 && x.type === 'bank') ctx.owners['BCA ...' + x.last4] = x.owner; });
  return ctx;
}

function reviewList_(d) {
  var settled = settledPayNow(d.txns), byId = {};
  d.txns.forEach(function (t) { byId[t.id] = t; });
  return reviewItems(d.txns).slice(0, 100).map(function (i) {
    var o = { kind: i.kind, txn: slim_(i.t, settled) };
    if (i.kind === 'duplicate' && byId[i.t.links_to_id]) o.other = slim_(byId[i.t.links_to_id], settled);
    return o;
  });
}

function activityList_(d) {
  var settled = settledPayNow(d.txns), ctx = ownersCtx_(d);
  return d.txns.filter(function (t) { return t.status !== 'void'; })
    .sort(function (x, y) { return Date.parse(y.timestamp) - Date.parse(x.timestamp); }).slice(0, 150)
    .map(function (t) { return slim_(t, settled, ctx); });
}

function accountsFull_(accounts, role) {
  return accounts.filter(function (x) { return x.active !== 'N' && (x.type === 'bank' || x.type === 'credit card') && (role === 'owner' || x.entity !== 'PT'); })
    .map(function (x) { return { account: x.account, type: x.type, entity: x.entity || '', owner: x.owner || '', payNow: Number(x.pay_within_days) > 0 }; });
}

function categoriesView_(book, who) {
  var role = ROLES[who], accounts = rows_(book, 'Accounts');
  return {
    categories: categoryList_(book),
    accounts: accounts.filter(function (x) { return x.active !== 'N' && x.entity !== 'PT' && (x.type === 'bank' || x.type === 'credit card'); }).map(function (x) { return x.account; }),
    accountsFull: accountsFull_(accounts, role), apiV: API_V
  };
}

/** Everything the app screens need, in one request. Each sheet is read once. */
function bootstrap_(book, who, req) {
  req = req || {};
  return cached_(who, req, 'boot', function () {
    var d = data_(book, who, req), role = ROLES[who];
    var home = computeHome(d); home.user = { name: NAMES[who], role: role };
    var cats = categoryList_(book);
    var plan = computePlan_({ plan: d.plan, txns: d.txns, accounts: d.accounts, today: d.today, paid: d.paid });
    return {
      home: home, review: { items: reviewList_(d) }, activity: { items: activityList_(d) }, plan: plan, apiV: API_V,
      categories: { categories: cats, accounts: d.accounts.filter(function (x) { return x.active !== 'N' && x.entity !== 'PT' && (x.type === 'bank' || x.type === 'credit card'); }).map(function (x) { return x.account; }), accountsFull: accountsFull_(d.accounts, role), apiV: API_V }
    };
  });
}

function categoryList_(book) {
  return rows_(book, 'Categories').filter(function (c) { return String(c.active).toUpperCase() !== 'N'; })
    .map(function (c) { return { category: c.category, bucket: c.bucket, held: String(c.counts_in_bucket).toUpperCase() === 'HELD' }; });
}

/** Spending for one month: by category, family and business, with the same month a year of YNAB history behind it. */
function spendingView_(book, who, req) {
  return cached_(who, req, 'spend', function () {
    var d = data_(book, who, req);
    return spendingReport_({ txns: d.txns, accounts: d.accounts, categories: rows_(book, 'Categories'), history: d.history, today: d.today, month: /^\d{4}-\d{2}$/.test(String(req.month || '')) ? req.month : d.today.slice(0, 7), role: ROLES[who] });
  });
}

/** Accounts, cards, debts and net worth. */
function accountsView_(book, who, req) {
  return cached_(who, req, 'acct', function () {
    var d = data_(book, who, req);
    return accountsReport_({ accounts: d.accounts, balances: d.balances, debts: d.debts, debtBalances: debtBalanceRows_(book), held: d.heldAll, today: d.today, role: ROLES[who] });
  });
}

function dispatch_(book, who, req) {
  var role = ROLES[who], a = req.action, owner = role === 'owner';
  if (a === 'home') {
    var d = data_(book, who, req), h = computeHome(d);
    h.user = { name: NAMES[who], role: role };
    return h;
  }
  if (a === 'bootstrap') return bootstrap_(book, who, req);
  if (a === 'plan') return planView_(book, who, req);
  if (a === 'spending') return spendingView_(book, who, req);
  if (a === 'accounts') return accountsView_(book, who, req);
  if (a === 'set_plan') return setPlan_(book, who, req);
  if (a === 'remove_plan') return removePlan_(book, who, req);
  if (a === 'plan_paid') return markPaid_(book, who, req);
  if (a === 'review') return { items: reviewList_(data_(book, who, req)) };
  if (a === 'activity') return { items: activityList_(data_(book, who, req)) };
  if (a === 'categories') return categoriesView_(book, who);
  if (a === 'status') return status_(book, who);
  if (a === 'payees') return { payees: payeeSummary_(data_(book, who, req).txns, rows_(book, 'Rules')), categories: categoryList_(book) };
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
  if (a === 'void_txn') return voidTxn_(book, who, req);
  if (a === 'restore_txn') return restoreTxn_(book, who, req);
  if (a === 'mark_paid') return flagTxn_(book, who, req.id, 'paid');
  if (a === 'keep_both') return setStatus_(book, who, req.id, 'auto', 'keep_both');
  if (a === 'merge_dup') return setStatus_(book, who, req.id, 'void', 'merge_duplicate');
  if (a === 'batch') return batch_(book, who, req);
  if (a === 'set_balance') {
    if (!owner) throw userError_('Only AJ can change balances.');
    var amt = Number(req.amount);
    if (!req.account || req.amount === '' || req.amount === null || isNaN(amt)) throw userError_('Choose an account and type the balance as a number.');
    append_(book, 'Balances', [{ date_confirmed: todayFor_(req), account: req.account, confirmed_balance: amt, method: 'manual', entered_by: NAMES[who] }]);
    audit_(book, NAMES[who], 'set_balance', 'Balances', req.account, 'confirmed_balance', '', amt);
    return { saved: true };
  }
  if (a === 'set_debt') {
    if (!owner) throw userError_('Only AJ can change debts.');
    var bal = Number(req.balance);
    if (!req.debt || req.balance === '' || req.balance === null || isNaN(bal) || bal < 0) throw userError_('Choose a debt and type what is left as a number.');
    var sh = book.getSheetByName('DebtBalances');
    if (!sh) { sh = book.insertSheet('DebtBalances'); sh.getRange(1, 1, 1, DEBTBAL_HEADERS.length).setValues([DEBTBAL_HEADERS]); }
    append_(book, 'DebtBalances', [{ date_confirmed: todayFor_(req), debt: req.debt, balance_idr: bal, set_by: NAMES[who] }]);
    audit_(book, NAMES[who], 'set_debt', 'DebtBalances', req.debt, 'balance_idr', '', bal);
    return { saved: true };
  }
  if (a === 'set_cap') {
    if (!owner) throw userError_('Only AJ can change caps.');
    var cap = Number(req.cap);
    if (!req.bucket || isNaN(cap) || cap < 0) throw userError_('Choose a bucket and type the cap as a number.');
    var month = jakartaToday_().slice(0, 7);
    append_(book, 'Buckets', [{ bucket: req.bucket, month: month, cap_idr: cap, owner: req.owner || '', set_by: NAMES[who] }]);
    audit_(book, NAMES[who], 'set_cap', 'Buckets', req.bucket + ' ' + month, 'cap_idr', '', cap);
    return { saved: true };
  }
  throw userError_('The app asked for something this version does not know. Please refresh the app.');
}

function handle_(req, who) {
  var a = req.action;
  if (a === 'ping') return { name: NAMES[who], role: ROLES[who], apiV: API_V };
  var book = book_(), write = !!WRITES_[a];
  DEFER_AUDIT_ = write;
  try { return dispatch_(book, who, req); }
  finally { if (write) { try { flushAudit_(book); } finally { DEFER_AUDIT_ = false; bump_(); } } else DEFER_AUDIT_ = false; }
}

/** Several changes in one request: one lock, one trip. Each change succeeds or fails on its own and gets its own answer. */
function batch_(book, who, req) {
  var ops = req.ops || [];
  if (!ops.length || ops.length > 30) throw userError_('Too many changes at once. Please try again.');
  var results = ops.map(function (op) {
    try {
      if (!BATCHABLE_[op.action]) throw userError_('That change cannot be sent in a group.');
      return { ok: true, data: dispatch_(book, who, op) };
    } catch (err) {
      if (!err.userMessage) { try { log_(book, 'error', 'API ' + op.action + ' failed in a batch: ' + err.message, String(err.stack || '')); } catch (e2) {} }
      return { ok: false, error: err.userMessage || ('Something went wrong: ' + err.message), retry: !err.userMessage };
    }
  });
  return { results: results };
}

function status_(book, who) {
  var owner = ROLES[who] === 'owner';
  var summary = {}; rows_(book, 'Summary').forEach(function (r) { summary[r.key] = r.value; });
  var txns = rowsTail_(book, 'Transactions', TX_WINDOW);
  var inbox = rowsTail_(book, 'Inbox_Raw', 800), seen = {};
  inbox.forEach(function (r) {
    if (r.parse_status === 'ignored') return;
    var m = String(r.sender).toLowerCase().match(/[\w.\-]+@[\w.\-]+/), addr = m ? m[0] : String(r.sender);
    if (!seen[addr] || String(r.received_at) > seen[addr]) seen[addr] = String(r.received_at);
  });
  var out = {
    lastSync: summary.last_sync_ok || null, lastSyncError: summary.last_sync_error || null, lastSyncCounts: summary.last_sync_counts || null,
    lastBackup: summary.last_backup_ok || null, unreadable: txns.filter(function (t) { return t.status === 'needs_review'; }).length,
    senders: Object.keys(seen).map(function (k) { return { sender: k, last: seen[k] }; }), canSetup: owner, apiV: API_V
  };
  if (owner) {
    var bal = latestBalances_(rows_(book, 'Balances'));
    out.accounts = rows_(book, 'Accounts').filter(function (x) { return x.type === 'bank' && x.active !== 'N'; }).map(function (x) {
      var b = bal[x.account]; return { account: x.account, balance: b ? Number(b.confirmed_balance) : null, date: b ? String(b.date_confirmed).slice(0, 10) : null };
    });
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

/* ---------- one transaction row: find, change, save once ---------- */

var EDITABLE = { category: 1, payee: 1, idr_amount: 1, memo: 1, account: 1, entity: 1, pt_file: 1, date: 1, who: 1 };

/** Finds a row by id from the bottom up (new rows are at the bottom). Reads the id column, then only that row. */
function findTxn_(book, id) {
  var sh = book.getSheetByName('Transactions'), last = sh.getLastRow(), cols = sh.getLastColumn();
  var h = sh.getRange(1, 1, 1, cols).getValues()[0], iId = h.indexOf('id');
  if (last >= 2 && id) {
    var ids = sh.getRange(2, iId + 1, last - 1, 1).getValues();
    for (var i = ids.length - 1; i >= 0; i--) {
      if (ids[i][0] === id) return { sh: sh, h: h, row: i + 2, vals: sh.getRange(i + 2, 1, 1, cols).getValues()[0], dirty: {} };
    }
  }
  throw userError_('That item was not found. Pull down to refresh.');
}

function txnExists_(book, id) {
  var sh = book.getSheetByName('Transactions'), ids = column_(sh, 'id');
  for (var i = ids.length - 1; i >= 0; i--) if (ids[i] === id) return true;
  return false;
}

var PT_ONLY_MSG_ = 'Only AJ can use the company account.';

/** Cynthia never sees or changes anything on the company account. */
function assertVisible_(book, who, f) {
  if (ROLES[who] !== 'partner') return;
  var pt = ptAccounts_(rows_(book, 'Accounts'));
  if (pt[String(f.vals[f.h.indexOf('account')])]) throw userError_('That item was not found. Pull down to refresh.');
}

function setField_(book, who, f, field, value) {
  var col = f.h.indexOf(field);
  if (col < 0) throw new Error('Unknown field ' + field);
  var before = f.vals[col];
  if (String(before) === String(value)) return;
  f.vals[col] = value; f.dirty[col] = true;
  audit_(book, NAMES[who], 'edit', 'Transactions', f.vals[f.h.indexOf('id')], field, before, value);
}

/** Stamps the update time and writes every changed cell of the row in one call. */
function touch_(f) {
  var u = f.h.indexOf('updated_at');
  if (u >= 0) { f.vals[u] = nowIso_(); f.dirty[u] = true; }
  var cols = Object.keys(f.dirty).map(Number);
  if (!cols.length) return;
  var lo = Math.min.apply(null, cols), hi = Math.max.apply(null, cols);
  f.sh.getRange(f.row, lo + 1, 1, hi - lo + 1).setValues([f.vals.slice(lo, hi + 1)]);
  f.dirty = {};
}

function flagsOfRow_(f) { return String(f.vals[f.h.indexOf('flags')] || '').split(',').filter(function (x) { return x; }); }
function setFlags_(book, who, f, list) { setField_(book, who, f, 'flags', list.join(',')); }
function addFlag_(book, who, f, flag) {
  var cur = flagsOfRow_(f);
  if (cur.indexOf(flag) === -1) { cur.push(flag); setFlags_(book, who, f, cur); }
}

function categoryBucket_(ctx, book, name) {
  if (!ctx.cats) ctx.cats = rows_(book, 'Categories');
  return bucketForCategory(ctx.cats, name);
}

function updateTxn_(book, who, req) {
  var f = findTxn_(book, req.id), ch = req.changes || {}, ctx = {};
  assertVisible_(book, who, f);
  var type = f.vals[f.h.indexOf('txn_type')];
  Object.keys(ch).forEach(function (k) {
    if (!EDITABLE[k]) throw userError_('That field cannot be changed.');
    var val = ch[k];
    if (k === 'entity' && val !== 'Family' && val !== 'Business' && val !== '') throw userError_('Choose Family or Business.');
    if (k === 'pt_file' && val !== 'Y' && val !== '') throw userError_('File for PT AHU can only be on or off.');
    if (k === 'who' && val !== 'AJ' && val !== 'Cynthia' && val !== '') throw userError_('Choose AJ or Cynthia.');
    if (k === 'account' && val && ROLES[who] !== 'owner' && ptAccounts_(rows_(book, 'Accounts'))[val]) throw userError_(PT_ONLY_MSG_);
    if (k === 'idr_amount') { val = Number(val); if (isNaN(val) || val <= 0) throw userError_('Type the amount as a number above zero.'); val = Math.round(val); }
    if (k === 'date') {
      val = String(val);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(val) || isNaN(Date.parse(val + 'T00:00:00Z'))) throw userError_('Choose the date again.');
      if (val > todayFor_(req)) throw userError_('The date cannot be in the future.');
      var flags = flagsOfRow_(f), tzf = flags.filter(function (x) { return x.indexOf('tz:') === 0; })[0];
      if (val !== dayOf_({ date: f.vals[f.h.indexOf('date')], timestamp: '' }) ) {
        setField_(book, who, f, 'timestamp', val + 'T12:00:00' + (tzf ? tzf.slice(3) : '+07:00'));
        if (flags.indexOf('date_only') === -1) { flags.push('date_only'); setFlags_(book, who, f, flags); }
      }
    }
    setField_(book, who, f, k, val);
    if (k === 'category') setField_(book, who, f, 'bucket', categoryBucket_(ctx, book, val));
    if (k === 'idr_amount') {
      var oc = String(f.vals[f.h.indexOf('orig_currency')] || ''), oa = num_(f.vals[f.h.indexOf('orig_amount')]);
      if (oc && oc !== 'IDR' && oa > 0) {
        setField_(book, who, f, 'fx_rate', Math.round(val / oa * 10000) / 10000);
        setFlags_(book, who, f, flagsOfRow_(f).filter(function (x) { return x !== 'fx_est'; }));
      }
    }
  });
  if (req.confirm) {
    if (!f.vals[f.h.indexOf('category')] && type !== 'payment') throw userError_('Choose a category before confirming.');
    if (f.vals[f.h.indexOf('status')] === 'needs_review') {
      if (!f.vals[f.h.indexOf('idr_amount')]) throw userError_('Type the amount before confirming.');
      if (!f.vals[f.h.indexOf('txn_type')]) setField_(book, who, f, 'txn_type', 'purchase');
    }
    if (isHeld_(book, f.vals[f.h.indexOf('category')])) setField_(book, who, f, 'txn_type', 'held_out');
    setField_(book, who, f, 'status', 'confirmed');
    // Who spent it is not changed by confirming. A bank email belongs to the owner of its account; a typed entry to whoever typed it.
    learnRule_(book, f.vals[f.h.indexOf('payee')], f.vals[f.h.indexOf('category')], f.vals[f.h.indexOf('bucket')]);
  }
  touch_(f);
  return { saved: true };
}

/** Remember a payee's category. After 3 confirmations it is trusted and auto-confirms after 48 hours. Names under 3 letters are too loose to remember. */
function learnRule_(book, payee, category, bucket) {
  var key = ruleKey(payee);
  if (key.length < 3 || !category) return;
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
  var f = findTxn_(book, id);
  assertVisible_(book, who, f);
  addFlag_(book, who, f, flag);
  touch_(f);
  return { saved: true };
}

function setStatus_(book, who, id, status, why) {
  var f = findTxn_(book, id);
  assertVisible_(book, who, f);
  setField_(book, who, f, 'status', status);
  if (why === 'merge_duplicate') setField_(book, who, f, 'memo', (f.vals[f.h.indexOf('memo')] ? f.vals[f.h.indexOf('memo')] + ' | ' : '') + 'Merged: counted once');
  touch_(f);
  return { saved: true };
}

/** Delete = void. The row stays in the Sheet (history is never removed) and is hidden everywhere. The old status is kept so Undo can bring it back. */
function voidTxn_(book, who, req) {
  var f = findTxn_(book, req.id);
  assertVisible_(book, who, f);
  var cur = String(f.vals[f.h.indexOf('status')]);
  if (cur === 'void') return { saved: true };
  var flags = flagsOfRow_(f).filter(function (x) { return x.indexOf('was:') !== 0; });
  flags.push('was:' + cur);
  setFlags_(book, who, f, flags);
  setField_(book, who, f, 'status', 'void');
  var memo = String(f.vals[f.h.indexOf('memo')] || '');
  setField_(book, who, f, 'memo', (memo ? memo + ' | ' : '') + 'Deleted by ' + NAMES[who]);
  touch_(f);
  return { saved: true };
}

function restoreTxn_(book, who, req) {
  var f = findTxn_(book, req.id);
  assertVisible_(book, who, f);
  if (String(f.vals[f.h.indexOf('status')]) !== 'void') return { saved: true };
  var flags = flagsOfRow_(f), was = flags.filter(function (x) { return x.indexOf('was:') === 0; })[0];
  setFlags_(book, who, f, flags.filter(function (x) { return x.indexOf('was:') !== 0; }));
  setField_(book, who, f, 'status', was ? was.slice(4) : 'confirmed');
  var memo = String(f.vals[f.h.indexOf('memo')] || '');
  setField_(book, who, f, 'memo', memo.replace(/( \| )?Deleted by [A-Za-z ]+$/, ''));
  touch_(f);
  return { saved: true };
}

var CURRENCIES = { IDR: 1, SGD: 1, MYR: 1, USD: 1, JPY: 1, EUR: 1, AUD: 1, THB: 1 };

/** Rupiah per 1 unit of a currency: the card's last real rate (from the last 60 days) first, then today's market rate. Never invented. */
function fxRate_(book, cur) {
  var best = null, cutoff = Utilities.formatDate(new Date(Date.now() - 60 * 86400000), 'Asia/Jakarta', 'yyyy-MM-dd');
  rowsTail_(book, 'Transactions', 800).forEach(function (t) {
    if (t.orig_currency !== cur || !has_(t.fx_rate) || t.fx_rate === '' || dayOf_(t) < cutoff || flagsOf_(t).indexOf('fx_est') !== -1) return;
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

/**
 * When and which day an entry belongs to. The phone sends `at` (its own clock with its own offset, for example
 * 2026-11-13T00:30:00+08:00 in Kuala Lumpur) and `date` (the day picked). Without `at` (older app) Jakarta time is used.
 * Today's entry keeps the real time. A past day is stamped at noon on that day and marked date_only.
 */
function stamp_(req) {
  var given = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(String(req.at || '')) && !isNaN(Date.parse(req.at));
  var at = given ? String(req.at) : nowIso_();
  if (given && Date.parse(at) > Date.now() + 10 * 60000) throw userError_('This phone\'s clock is ahead of the real time. Fix it in Settings, General, Date & Time, then try again.');
  var atDay = at.slice(0, 10), off = at.slice(-6);
  var date = req.date ? String(req.date) : atDay;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + 'T00:00:00Z'))) throw userError_('Choose the date again.');
  if (date > atDay) throw userError_('The date cannot be in the future.');
  var back = date < atDay, flags = [];
  if (off !== '+07:00') flags.push('tz:' + off);
  if (back) flags.push('date_only');
  return { day: date, stamp: back ? date + 'T12:00:00' + off : at, flags: flags };
}

function newTxnId_() { return 't_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12); }

/**
 * Adds one entry. kind: purchase (spent), income (received), held (held for others), transfer (between own accounts),
 * payment (paying a credit card). The phone may send its own id: if that id is already saved, nothing is added twice.
 */
function addTxn_(book, who, req) {
  var kind = String(req.kind || 'purchase');
  if (['purchase', 'income', 'held', 'transfer', 'payment'].indexOf(kind) === -1) throw userError_('That kind of entry is not known. Please refresh the app.');
  var id = /^t_[0-9a-f]{12}$/.test(String(req.id || '')) ? String(req.id) : newTxnId_();
  if (req.id && id === req.id && txnExists_(book, id)) return { id: id, duplicate: true };

  var cur = String(req.currency || 'IDR').toUpperCase();
  if (!CURRENCIES[cur]) throw userError_('That currency is not set up. Use IDR, SGD, MYR, USD, JPY, EUR, AUD or THB.');
  if (kind !== 'purchase' && cur !== 'IDR') throw userError_('Foreign currency can only be used for spending. Type this amount in rupiah.');
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
  } else amt = Math.round(amt);

  var accounts = rows_(book, 'Accounts'), pt = ptAccounts_(accounts), acct = String(req.account || '');
  var partner = ROLES[who] !== 'owner';
  if (partner && (pt[acct] || pt[String(req.toAccount || '')] || pt[String(req.card || '')])) throw userError_(PT_ONLY_MSG_);

  var payee = String(req.payee || '').trim(), cat = '', type = 'purchase', status = 'confirmed', entity = '', ptFile = '';
  if (kind === 'transfer') {
    var to = String(req.toAccount || '').trim();
    if (!acct || acct === 'Cash') throw userError_('Choose the account the money leaves from.');
    if (!to) throw userError_('Choose the account the money goes to.');
    if (to === acct) throw userError_('Choose two different accounts.');
    type = 'transfer'; cat = 'Own transfer'; payee = 'To ' + to;
  } else if (kind === 'payment') {
    var card = String(req.card || '').trim();
    if (!card) throw userError_('Choose the card that was paid.');
    if (!acct || acct === 'Cash') throw userError_('Choose the account the payment came from.');
    type = 'payment'; payee = 'Payment to ' + card;
  } else {
    if (!payee) throw userError_('Type who or what it was for.');
    if (kind === 'held') {
      if (!req.category) throw userError_('Choose what kind of money this is.');
      if (!isHeld_(book, req.category)) throw userError_('That kind of money is not set up for holding. Add it as a new type first.');
      type = 'held_in'; cat = req.category;
    } else if (kind === 'income') { type = 'income'; cat = 'Income'; }
    else {
      cat = String(req.category || '');
      if (cat && isHeld_(book, cat)) throw userError_('That type is for money held for others. Use Held for others.');
      entity = (req.entity === 'Family' || req.entity === 'Business') ? req.entity : '';
      ptFile = req.pt_file ? 'Y' : '';
    }
  }
  // A spend without a category is saved now and waits in Review for a category.
  if (kind === 'purchase' && !cat) status = 'auto';

  var tm = stamp_(req), now = nowIso_(), flags = tm.flags.slice();
  if (est) flags.push('fx_est');
  append_(book, 'Transactions', [{
    id: id, date: tm.day, timestamp: tm.stamp, txn_type: type, idr_amount: amt, orig_amount: origAmt, orig_currency: cur, fx_rate: fx === null ? '' : fx, flags: flags.join(','),
    account: acct, payee: payee, category: cat, bucket: (kind === 'purchase' && cat) ? bucketForCategory(rows_(book, 'Categories'), cat) : '',
    who: NAMES[who], source: 'manual', settled: 'Y', status: status, memo: req.memo || '', entity: entity, pt_file: ptFile, created_at: now, updated_at: now,
    lat: has_(req.lat) && req.lat !== '' && req.lat !== null ? Number(req.lat) : '', lng: has_(req.lng) && req.lng !== '' && req.lng !== null ? Number(req.lng) : ''
  }]);
  audit_(book, NAMES[who], 'add', 'Transactions', id, '', '', amt);
  var out = { id: id };
  if (req.photo) {
    try { attachPhoto_(book, who, { id: id, photo: req.photo }); }
    catch (e) {
      log_(book, 'warn', 'Receipt photo not saved: ' + e.message, id);
      out.warning = 'The entry was saved, but its receipt photo did not upload (' + (e.userMessage || e.message) + '). Open the entry and add the photo again.';
    }
  }
  try { reconcile_(book, who); } catch (e2) { log_(book, 'warn', 'Matching failed: ' + e2.message, ''); }
  return out;
}

/**
 * An entry typed in the app and its bank email are one payment. The email row is kept (it has the exact time,
 * account and reference) and receives what the person typed; the typed row is voided, never deleted.
 */
function reconcile_(book, who) {
  var pairs = findMatches_(rowsTail_(book, 'Transactions', TX_WINDOW));
  pairs.forEach(function (p) {
    var e = findTxn_(book, p.email.id), m = findTxn_(book, p.manual.id);
    function mv(k) { return m.vals[m.h.indexOf(k)]; }
    function ev(k) { return e.vals[e.h.indexOf(k)]; }
    if (mv('category')) { setField_(book, who, e, 'category', mv('category')); setField_(book, who, e, 'bucket', mv('bucket')); }
    if (mv('payee')) setField_(book, who, e, 'payee', mv('payee'));
    if (mv('who')) setField_(book, who, e, 'who', mv('who'));
    if (mv('memo')) setField_(book, who, e, 'memo', mv('memo'));
    if (mv('lat') !== '') { setField_(book, who, e, 'lat', mv('lat')); setField_(book, who, e, 'lng', mv('lng')); }
    if (mv('receipt_drive_id')) setField_(book, who, e, 'receipt_drive_id', mv('receipt_drive_id'));
    if (mv('orig_currency') && mv('orig_currency') !== 'IDR' && has_(mv('orig_amount'))) {
      var real = num_(ev('idr_amount')), oa = num_(mv('orig_amount'));
      setField_(book, who, e, 'orig_amount', oa); setField_(book, who, e, 'orig_currency', mv('orig_currency'));
      if (oa > 0 && real > 0) setField_(book, who, e, 'fx_rate', Math.round(real / oa * 10000) / 10000);
    }
    if (mv('entity')) setField_(book, who, e, 'entity', mv('entity'));
    if (mv('pt_file')) setField_(book, who, e, 'pt_file', mv('pt_file'));
    // A typed purchase that matched a bank transfer is a purchase: that is what the person said it was.
    if (mv('txn_type') === 'purchase' && ev('txn_type') === 'transfer') setField_(book, who, e, 'txn_type', 'purchase');
    // Confirmed only when it has what Review would ask for. A typed entry with no category still waits for one.
    if (ev('category') || ev('txn_type') === 'payment') setField_(book, who, e, 'status', 'confirmed');
    addFlag_(book, who, e, 'matched');
    touch_(e);
    setField_(book, who, m, 'status', 'void');
    setField_(book, who, m, 'memo', (mv('memo') ? mv('memo') + ' | ' : '') + 'Merged with bank email ' + p.email.id);
    addFlag_(book, who, m, 'matched');
    touch_(m);
    if (mv('category') && mv('txn_type') === 'purchase') learnRule_(book, p.email.payee, mv('category'), mv('bucket'));
  });
  return pairs.length;
}

/** Trigger, every 5 minutes: pair typed entries with bank emails that arrived afterwards. */
function reconcileRun() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  var book = book_();
  DEFER_AUDIT_ = true;
  try { if (reconcile_(book, 'system')) bump_(); } catch (e) { try { log_(book, 'error', 'Matching failed: ' + e.message, String(e.stack || '')); } catch (e2) {} }
  finally { try { flushAudit_(book); } finally { DEFER_AUDIT_ = false; lock.releaseLock(); } }
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
    var d = data_(book, 'aj', {});
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
  if (key.length < 3) throw userError_('That name is too short to remember. Use at least 3 letters.');
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

/** Everything filed for PT AHU in a month (default: this month), with receipt links, for the accountant. Only AJ sees the company side. */
function ptFileList_(book, who, req) {
  if (ROLES[who] !== 'owner') throw userError_('Only AJ can see what is filed for the company.');
  var month = /^\d{4}-\d{2}$/.test(String(req.month || '')) ? req.month : todayFor_(req).slice(0, 7);
  var items = rowsTail_(book, 'Transactions', TX_WINDOW).filter(function (t) {
    return String(t.pt_file).toUpperCase() === 'Y' && t.status !== 'void' && dayOf_(t).slice(0, 7) === month;
  }).sort(function (a, b) { return dayOf_(a).localeCompare(dayOf_(b)); }).map(function (t) {
    return { id: t.id, date: dayOf_(t), payee: t.payee, category: t.category, amount: num_(t.idr_amount), account: t.account, entity: t.entity || '',
      receipt: t.receipt_drive_id ? 'https://drive.google.com/file/d/' + t.receipt_drive_id + '/view' : '' };
  });
  return { month: month, items: items, total: items.reduce(function (a, i) { return a + i.amount; }, 0), missingReceipts: items.filter(function (i) { return !i.receipt; }).length };
}

/** Saves a receipt photo to PT_Receipts/_Inbox in Drive (the nightly PT filing sorts it from there) and links it to the transaction. */
function attachPhoto_(book, who, req) {
  var ph = req.photo || req;
  if (!ph.data) throw userError_('The photo did not arrive. Please try again.');
  if (String(ph.data).length > 8000000) throw userError_('That photo is too large. Take it again or pick a smaller one.');
  var f = findTxn_(book, req.id);
  assertVisible_(book, who, f);
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
