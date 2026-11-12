/**
 * Hanaro capture (Apps Script project A, the only project with Gmail access).
 * Runs every 5 minutes. Reads new bank emails, saves every one to Inbox_Raw,
 * turns parsed ones into Transactions, and sends anything it cannot read to Review.
 * Needs Parsers.gs and Ops.gs in the same project.
 */
var SHEET_ID = 'PASTE_SHEET_ID_HERE';          // set once in the pasted copy, never committed
var SENDER_QUERY = 'from:(bca@bca.co.id OR kartukreditbca@bca.co.id OR CREDITCARD.NOTIFICATION@cimbniaga.co.id OR jenius_noreply@smbci.com OR notification@uob.co.id OR noreply_UOB@uob.co.id)';
var INITIAL_LOOKBACK_DAYS = 7;
var MAX_THREADS_PER_RUN = 100;
var MAX_PAGES = 20;          // up to 2000 threads in one run (a long gap, or a new install)
var OVERLAP_SECONDS = 1800; // each run looks back 30 minutes so a slow or late email is never dropped

function ss_() { return SpreadsheetApp.openById(SHEET_ID); }

/** Rows of a tab as objects keyed by header. */
function readTab_(sheet) {
  var v = sheet.getDataRange().getValues();
  if (v.length < 2) return [];
  var h = v[0];
  return v.slice(1).map(function (r) { var o = {}; h.forEach(function (k, i) { o[k] = r[i]; }); return o; });
}

/** Append objects to a tab in one write, matching columns by header name. */
function appendObjects_(sheet, objs) {
  if (!objs.length) return;
  var h = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var rows = objs.map(function (o) { return h.map(function (k) { return o[k] === undefined ? '' : o[k]; }); });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, h.length).setValues(rows);
}

/** One column of a tab, from row 2 down. */
function columnValues_(sheet, header) {
  var last = sheet.getLastRow(); if (last < 2) return [];
  var h = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0], i = h.indexOf(header);
  if (i < 0) return [];
  return sheet.getRange(2, i + 1, last - 1, 1).getValues().map(function (r) { return r[0]; });
}

function newId_() { return 't_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function nowIso_() { return Utilities.formatDate(new Date(), 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ssXXX"); }

function log_(sheet, level, message, detail) {
  appendObjects_(sheet, [{ timestamp: nowIso_(), component: 'capture', level: level, message: message, detail: detail || '' }]);
}

function setSummary_(sheet, key, value) {
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) { sheet.getRange(i + 1, 2, 1, 2).setValues([[value, nowIso_()]]); return; }
  }
  sheet.appendRow([key, value, nowIso_()]);
}

function accountFor_(accounts, t) {
  var last = String(t.account_last || '');
  if (last) {
    for (var i = 0; i < accounts.length; i++) {
      var a = accounts[i];
      if (String(a.last4 || '') === last) return a;
    }
  }
  return null;
}

function ruleKey_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function ruleFor_(rules, payee) {
  var p = ruleKey_(payee);
  for (var i = 0; i < rules.length; i++) {
    var m = ruleKey_(rules[i].match_text);
    if (m.length >= 3 && p.indexOf(m) !== -1) return rules[i];
  }
  return null;
}

function captureRun() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { return; } // another run is in progress; the next run will catch up
  var book, logSheet;
  try {
    book = ss_();
    logSheet = book.getSheetByName('Log');
    var props = PropertiesService.getScriptProperties();
    var last = Number(props.getProperty('LAST_TS') || 0);
    if (!last) last = Math.floor(Date.now() / 1000) - INITIAL_LOOKBACK_DAYS * 86400;
    var started = Math.floor(Date.now() / 1000);

    // Cheap exit first: most minutes there is nothing new, so skip reading the big tabs.
    var query = SENDER_QUERY + ' after:' + (last - OVERLAP_SECONDS);
    var threads = [], truncated = false;
    for (var pg = 0; pg < MAX_PAGES; pg++) {
      var part = GmailApp.search(query, pg * MAX_THREADS_PER_RUN, MAX_THREADS_PER_RUN);
      threads = threads.concat(part);
      if (part.length < MAX_THREADS_PER_RUN) break;
      if (pg === MAX_PAGES - 1) truncated = true;
    }
    if (!threads.length) {
      props.setProperty('LAST_TS', String(started));
      setSummary_(book.getSheetByName('Summary'), 'last_sync_ok', nowIso_());
      return;
    }
    var inbox = book.getSheetByName('Inbox_Raw');
    var tx = book.getSheetByName('Transactions');
    var dd = book.getSheetByName('DedupeIndex');
    var seenIds = {};
    readTab_(inbox).forEach(function (r) { seenIds[r.message_id] = true; });
    // An email already turned into a transaction is never added twice, even if its Inbox_Raw row was lost in an earlier failed run.
    columnValues_(tx, 'source_message_id').forEach(function (v) { if (v) seenIds[v] = true; });
    var seenKeys = {};
    readTab_(dd).forEach(function (r) { seenKeys[r.dedupe_key] = r.transaction_id; });
    var accounts = readTab_(book.getSheetByName('Accounts'));
    var rules = readTab_(book.getSheetByName('Rules'));
    var txAll = null; // read only if a foreign-currency charge shows up

    var inboxRows = [], txRows = [], ddRows = [], pings = [], counts = { parsed: 0, failed: 0, ignored: 0, dup: 0 };

    threads.forEach(function (th) {
      th.getMessages().forEach(function (m) {
        var mid = m.getHeader('Message-ID') || m.getId();
        if (seenIds[mid]) return;
        if (Math.floor(m.getDate().getTime() / 1000) < last - OVERLAP_SECONDS) return;
        seenIds[mid] = true;
        var res = parseEmail({
          from: m.getFrom(), subject: m.getSubject(), messageId: mid,
          dateIso: m.getDate().toISOString(), html: m.getBody(), plain: m.getPlainBody()
        });
        var row = {
          message_id: mid, received_at: m.getDate().toISOString(), sender: m.getFrom(), subject: m.getSubject(),
          parser: res.parser || (res.txn && res.txn.parser) || '', parse_status: res.status,
          parse_error: res.error || res.reason || '', processed_at: nowIso_()
        };
        if (res.status === 'parsed' && res.txn.orig_currency && res.txn.orig_currency !== 'IDR' && (res.txn.idr_amount === null || res.txn.idr_amount === undefined)) {
          // Charged abroad: the bank email has no rupiah amount, so estimate it. The real amount can be typed in later.
          if (!txAll) txAll = readTab_(tx);
          var fr = fxEstimate_(txAll, res.txn.orig_currency);
          if (fr) {
            res.txn.fx_rate = fr.rate;
            res.txn.idr_amount = Math.round(res.txn.orig_amount * fr.rate);
          } else {
            res = { status: 'failed', parser: res.txn.parser, error: 'Charged in ' + res.txn.orig_currency + ' ' + res.txn.orig_amount.toFixed(2) + ' and no exchange rate could be found. Please enter the rupiah amount by hand.' };
            row.parse_status = 'failed'; row.parse_error = res.error;
          }
        }
        if (res.status === 'parsed') {
          counts.parsed++;
          var t = res.txn;
          var key = t.dedupe_key;
          var status = 'auto', linked = '';
          if (seenKeys[key]) {
            if (t.bank_ref) { counts.dup++; row.parse_status = 'duplicate'; row.transaction_id = seenKeys[key]; inboxRows.push(row); return; }
            status = 'possible_duplicate'; linked = seenKeys[key];
          }
          var acc = accountFor_(accounts, t);
          var rule = ruleFor_(rules, t.payee);
          var flags = t.flags.slice();
          if (acc && Number(acc.pay_within_days) > 0 && t.txn_type === 'purchase') flags.push('pay_now');
          var id = newId_();
          txRows.push({
            id: id, date: t.date, timestamp: t.timestamp, txn_type: t.txn_type, idr_amount: t.idr_amount,
            orig_currency: t.orig_currency || 'IDR', orig_amount: t.orig_amount === undefined ? '' : t.orig_amount, fx_rate: t.fx_rate || '',
            account: acc ? acc.account : t.bank + ' ...' + (t.account_last || '?'),
            payee: t.payee, category: rule ? rule.category : '', bucket: rule ? rule.bucket : '',
            source: 'email', bank_ref: t.bank_ref || '', source_message_id: mid, links_to_id: linked,
            settled: t.settled, status: status, flags: flags.join(','), memo: t.memo || '',
            created_at: nowIso_(), updated_at: nowIso_()
          });
          if (rule && String(rule.auto_confirm).toUpperCase() === 'Y') txRows[txRows.length - 1].flags += (flags.length ? ',' : '') + 'rule:' + rule.rule_id;
          if (t.txn_type === 'purchase' && status === 'auto') pings.push({ amount: t.idr_amount, orig: (t.orig_currency && t.orig_currency !== 'IDR') ? t.orig_currency + ' ' + Number(t.orig_amount).toFixed(2) : '', account: acc ? acc.account : t.bank, payNow: flags.indexOf('pay_now') !== -1, ms: Date.parse(t.timestamp) });
          ddRows.push({ dedupe_key: key, bank: t.bank, account_last4: t.account_last, bank_ref: t.bank_ref || '', transaction_id: id, created_at: nowIso_() });
          seenKeys[key] = id;
          row.transaction_id = id;
        } else if (res.status === 'failed') {
          counts.failed++;
          var fid = newId_();
          txRows.push({
            id: fid, date: Utilities.formatDate(m.getDate(), 'Asia/Jakarta', 'yyyy-MM-dd'), timestamp: m.getDate().toISOString(),
            txn_type: '', idr_amount: '', account: '', payee: m.getSubject(), source: 'email', source_message_id: mid,
            settled: 'N', status: 'needs_review', memo: 'Could not read this email: ' + res.error,
            created_at: nowIso_(), updated_at: nowIso_()
          });
          row.transaction_id = fid;
        } else { counts.ignored++; }
        inboxRows.push(row);
      });
    });

    // Order matters: money rows first. If a later write fails, the next run sees these ids and does not add them again.
    appendObjects_(tx, txRows);
    appendObjects_(dd, ddRows);
    appendObjects_(inbox, inboxRows);
    notifyNew_(tx, pings, counts.failed);
    if (truncated) {
      log_(logSheet, 'warn', 'Capture run saw more than ' + (MAX_PAGES * MAX_THREADS_PER_RUN) + ' emails', 'Older emails may not have been read. Run setup again after raising MAX_PAGES.');
    } else props.setProperty('LAST_TS', String(started));
    var summary = book.getSheetByName('Summary');
    setSummary_(summary, 'last_sync_ok', nowIso_());
    setSummary_(summary, 'last_sync_counts', JSON.stringify(counts));
    if (txRows.length || counts.failed) log_(logSheet, counts.failed ? 'warn' : 'info', 'Capture run', JSON.stringify(counts));
  } catch (e) {
    try { if (book) { log_(logSheet || book.getSheetByName('Log'), 'error', 'Capture run failed: ' + e.message, String(e.stack || '')); setSummary_(book.getSheetByName('Summary'), 'last_sync_error', e.message); } } catch (e2) {}
    throw e; // shows in Apps Script's own failure e-mails too
  } finally {
    lock.releaseLock();
  }
}

/** Entries typed in the app in the last 12 hours, so a charge you already recorded does not ping again. */
function recentManualAmounts_(tx) {
  var last = tx.getLastRow(); if (last < 2) return [];
  var start = Math.max(2, last - 200), h = tx.getRange(1, 1, 1, tx.getLastColumn()).getValues()[0];
  var v = tx.getRange(start, 1, last - start + 1, h.length).getValues();
  var iS = h.indexOf('source'), iA = h.indexOf('idr_amount'), iT = h.indexOf('timestamp'), out = [];
  v.forEach(function (r) { if (r[iS] === 'manual' && (Date.now() - new Date(r[iT]).getTime()) < 12 * 3600 * 1000) out.push(Number(r[iA])); });
  return out;
}

/** One Telegram message per run. Amounts and account names only, never who it was paid to. */
function notifyNew_(tx, pings, failed) {
  var lines = [];
  if (pings.length) {
    var manual = recentManualAmounts_(tx);
    pings = pings.filter(function (p) { var i = manual.indexOf(Number(p.amount)); if (i !== -1) { manual.splice(i, 1); return false; } return true; });
  }
  pings.slice(0, 6).forEach(function (p) { lines.push('New charge ' + (p.orig ? p.orig + ' (about ' + rpText_(p.amount) + ')' : rpText_(p.amount)) + ' on ' + p.account + (p.payNow ? ' (pay today)' : '')); });
  if (pings.length > 6) lines.push('and ' + (pings.length - 6) + ' more');
  if (failed) lines.push('Could not read ' + failed + ' email' + (failed === 1 ? '' : 's') + '. Check Review in Hanaro.');
  if (!lines.length) return;
  if (pings.length) lines.push('Open Hanaro to confirm.');
  telegram_(lines.join('\n'));
}

/** Rupiah per 1 unit of a foreign currency: the card's last real rate (last 60 days) first, then today's market rate. Never invented; null if neither is found. */
function fxEstimate_(rows, cur) {
  var cutoff = Utilities.formatDate(new Date(Date.now() - 60 * 86400000), 'Asia/Jakarta', 'yyyy-MM-dd'), best = null;
  rows.forEach(function (r) {
    if (r.orig_currency !== cur || !(Number(r.fx_rate) > 0) || String(r.date).slice(0, 10) < cutoff || String(r.flags).indexOf('fx_est') !== -1) return;
    if (!best || String(r.timestamp) > best.ts) best = { ts: String(r.timestamp), rate: Number(r.fx_rate) };
  });
  if (best) return { rate: best.rate, source: 'card' };
  try {
    var resp = UrlFetchApp.fetch('https://open.er-api.com/v6/latest/' + cur, { muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      var j = JSON.parse(resp.getContentText()), rate = j && j.rates && j.rates.IDR;
      if (rate > 0) return { rate: rate, source: 'market' };
    }
  } catch (e) {}
  return null;
}

function rpText_(n) { return 'Rp ' + Math.round(Number(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

/** Run once from the editor after pasting. Creates the 5-minute capture, the watchdog, the evening message and the nightly backup. */
function setup() {
  PropertiesService.getScriptProperties().deleteProperty('LAST_TS'); // re-read the last 7 days; already-saved emails are skipped
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('captureRun').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('watchdogRun').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('autoConfirmRun').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('backupRun').timeBased().atHour(2).everyDays(1).create();
  ScriptApp.newTrigger('eveningSend').timeBased().atHour(21).everyDays(1).create();
  captureRun(); // first run now, so Google asks for Gmail permission once
}
