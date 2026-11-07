/**
 * Hanaro capture (Apps Script project A, the only project with Gmail access).
 * Runs every 15 minutes. Reads new bank emails, saves every one to Inbox_Raw,
 * turns parsed ones into Transactions, and sends anything it cannot read to Review.
 * Needs Parsers.gs and Ops.gs in the same project.
 */
var SHEET_ID = 'PASTE_SHEET_ID_HERE';          // set once in the pasted copy, never committed
var SENDER_QUERY = 'from:(bca@bca.co.id OR kartukreditbca@bca.co.id OR CREDITCARD.NOTIFICATION@cimbniaga.co.id OR jenius_noreply@smbci.com OR notification@uob.co.id OR noreply_UOB@uob.co.id)';
var INITIAL_LOOKBACK_DAYS = 7;
var MAX_THREADS_PER_RUN = 100;

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

function ruleFor_(rules, payee) {
  var p = String(payee || '').toLowerCase();
  for (var i = 0; i < rules.length; i++) {
    var m = String(rules[i].match_text || '').toLowerCase();
    if (m && p.indexOf(m) !== -1) return rules[i];
  }
  return null;
}

function captureRun() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { return; } // another run is in progress; the next 15-minute run will catch up
  var book, logSheet;
  try {
    book = ss_();
    logSheet = book.getSheetByName('Log');
    var props = PropertiesService.getScriptProperties();
    var last = Number(props.getProperty('LAST_TS') || 0);
    if (!last) last = Math.floor(Date.now() / 1000) - INITIAL_LOOKBACK_DAYS * 86400;
    var started = Math.floor(Date.now() / 1000);

    var inbox = book.getSheetByName('Inbox_Raw');
    var tx = book.getSheetByName('Transactions');
    var dd = book.getSheetByName('DedupeIndex');
    var seenIds = {};
    readTab_(inbox).forEach(function (r) { seenIds[r.message_id] = true; });
    var seenKeys = {};
    readTab_(dd).forEach(function (r) { seenKeys[r.dedupe_key] = r.transaction_id; });
    var accounts = readTab_(book.getSheetByName('Accounts'));
    var rules = readTab_(book.getSheetByName('Rules'));

    // Gmail "after:" takes seconds; go back 1 hour so a slow run never drops a message.
    var query = SENDER_QUERY + ' after:' + (last - 3600);
    var threads = GmailApp.search(query, 0, MAX_THREADS_PER_RUN);
    var inboxRows = [], txRows = [], ddRows = [], counts = { parsed: 0, failed: 0, ignored: 0, dup: 0 };

    threads.forEach(function (th) {
      th.getMessages().forEach(function (m) {
        var mid = m.getHeader('Message-ID') || m.getId();
        if (seenIds[mid]) return;
        if (Math.floor(m.getDate().getTime() / 1000) < last - 3600) return;
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
            orig_currency: 'IDR', account: acc ? acc.account : t.bank + ' ...' + (t.account_last || '?'),
            payee: t.payee, category: rule ? rule.category : '', bucket: rule ? rule.bucket : '',
            source: 'email', bank_ref: t.bank_ref || '', source_message_id: mid, links_to_id: linked,
            settled: t.settled, status: status, flags: flags.join(','), memo: t.memo || '',
            created_at: nowIso_(), updated_at: nowIso_()
          });
          if (rule && String(rule.auto_confirm).toUpperCase() === 'Y') txRows[txRows.length - 1].flags += (flags.length ? ',' : '') + 'rule:' + rule.rule_id;
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

    appendObjects_(inbox, inboxRows);
    appendObjects_(tx, txRows);
    appendObjects_(dd, ddRows);
    props.setProperty('LAST_TS', String(started));
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

/** Run once from the editor after pasting. Creates the 15-minute capture, the watchdog and the nightly backup. */
function setup() {
  PropertiesService.getScriptProperties().deleteProperty('LAST_TS'); // re-read the last 7 days; already-saved emails are skipped
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('captureRun').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('watchdogRun').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('autoConfirmRun').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('backupRun').timeBased().atHour(2).everyDays(1).create();
  captureRun(); // first run now, so Google asks for Gmail permission once
}
