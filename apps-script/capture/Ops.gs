/**
 * Hanaro operations: watchdog, 48-hour auto-confirm for rule matches, nightly backup, Telegram.
 * Part of the same Apps Script project as Main.gs and Parsers.gs.
 */
var SILENCE_DAYS = { 'bca@bca.co.id': 14, 'kartukreditbca@bca.co.id': 14, 'creditcard.notification@cimbniaga.co.id': 30, 'jenius_noreply@smbci.com': 30 };
var STALE_SYNC_HOURS = 2;
var BACKUP_KEEP_DAYS = 30;

/** Sends a short plain message. Totals only, never merchant names. Failure is logged, never silent. */
function telegram_(text) {
  var p = PropertiesService.getScriptProperties();
  var token = p.getProperty('TELEGRAM_TOKEN'), chat = p.getProperty('TELEGRAM_CHAT');
  if (!token || !chat) { log_(ss_().getSheetByName('Log'), 'warn', 'Telegram not set up yet, alert not sent', text); return false; }
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ chat_id: chat, text: text })
  });
  if (res.getResponseCode() !== 200) { log_(ss_().getSheetByName('Log'), 'error', 'Telegram send failed (' + res.getResponseCode() + ')', res.getContentText().slice(0, 200)); return false; }
  return true;
}

/** Alert once per problem: tells you when sync stops or a bank has gone quiet. */
function watchdogRun() {
  var book = ss_(), props = PropertiesService.getScriptProperties();
  var summary = readTab_(book.getSheetByName('Summary'));
  var lastOk = null;
  summary.forEach(function (r) { if (r.key === 'last_sync_ok') lastOk = new Date(r.value); });
  var problems = [];
  if (!lastOk || isNaN(lastOk.getTime())) problems.push('Hanaro has not synced yet.');
  else if ((Date.now() - lastOk.getTime()) > STALE_SYNC_HOURS * 3600 * 1000) problems.push('Hanaro has not synced for over ' + STALE_SYNC_HOURS + ' hours. Last good sync: ' + Utilities.formatDate(lastOk, 'Asia/Jakarta', 'd MMM HH:mm') + '.');

  var latest = {};
  readTab_(book.getSheetByName('Inbox_Raw')).forEach(function (r) {
    if (r.parse_status === 'ignored') return;
    var s = String(r.sender).toLowerCase();
    var addr = (s.match(/[\w.\-]+@[\w.\-]+/) || [s])[0];
    var t = new Date(r.received_at).getTime();
    if (!latest[addr] || t > latest[addr]) latest[addr] = t;
  });
  Object.keys(SILENCE_DAYS).forEach(function (addr) {
    if (!latest[addr]) return; // never seen yet; nothing to compare against
    var days = (Date.now() - latest[addr]) / 86400000;
    if (days > SILENCE_DAYS[addr]) problems.push('No emails from ' + addr + ' for ' + Math.floor(days) + ' days. Check the forwarding or the bank notification settings.');
  });

  var key = problems.join('|');
  if (key !== (props.getProperty('LAST_ALERT') || '')) {
    if (problems.length) telegram_('Hanaro needs attention:\n- ' + problems.join('\n- '));
    else if (props.getProperty('LAST_ALERT')) telegram_('Hanaro is back to normal.');
    props.setProperty('LAST_ALERT', key);
  }
}

/** Rows matched by a Rule with auto_confirm = Y become confirmed after 48 hours. Guessed ones wait for a person. */
function autoConfirmRun() {
  var book = ss_(), sh = book.getSheetByName('Transactions');
  var v = sh.getDataRange().getValues();
  if (v.length < 2) return;
  var h = v[0], iStatus = h.indexOf('status'), iFlags = h.indexOf('flags'), iCreated = h.indexOf('created_at'), iUpd = h.indexOf('updated_at'), iId = h.indexOf('id');
  var audit = book.getSheetByName('Audit'), changed = [];
  for (var i = 1; i < v.length; i++) {
    if (v[i][iStatus] !== 'auto' || String(v[i][iFlags]).indexOf('rule:') === -1) continue;
    if ((Date.now() - new Date(v[i][iCreated]).getTime()) < 48 * 3600 * 1000) continue;
    sh.getRange(i + 1, iStatus + 1).setValue('confirmed');
    sh.getRange(i + 1, iUpd + 1).setValue(nowIso_());
    changed.push({ timestamp: nowIso_(), who: 'system', action: 'auto_confirm', tab: 'Transactions', row_id: v[i][iId], field: 'status', before: 'auto', after: 'confirmed' });
  }
  appendObjects_(audit, changed);
}

/** Nightly dated copy into the Drive folder "Hanaro Backups"; copies older than 30 days are removed. */
function backupRun() {
  var folders = DriveApp.getFoldersByName('Hanaro Backups');
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('Hanaro Backups');
  var stamp = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  folder.getFilesByName('Hanaro Money Master ' + stamp).hasNext() ||
    DriveApp.getFileById(SHEET_ID).makeCopy('Hanaro Money Master ' + stamp, folder);
  var cutoff = Date.now() - BACKUP_KEEP_DAYS * 86400000;
  var files = folder.getFiles();
  while (files.hasNext()) { var f = files.next(); if (f.getDateCreated().getTime() < cutoff) f.setTrashed(true); }
  setSummary_(ss_().getSheetByName('Summary'), 'last_backup_ok', nowIso_());
}

/** Run once after adding TELEGRAM_TOKEN in Script Properties and sending a message in the group. Finds the group and sends a test. */
function telegramSetup() {
  var p = PropertiesService.getScriptProperties();
  var token = p.getProperty('TELEGRAM_TOKEN');
  if (!token) throw new Error('Add the script property TELEGRAM_TOKEN first (Project Settings, Script Properties).');
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Telegram refused the token (' + res.getResponseCode() + '). Check that it was copied in full.');
  var updates = JSON.parse(res.getContentText()).result || [];
  var chat = null;
  updates.forEach(function (u) {
    var c = (u.message && u.message.chat) || (u.my_chat_member && u.my_chat_member.chat);
    if (c && (c.type === 'group' || c.type === 'supergroup')) chat = c;
  });
  if (!chat) throw new Error('No group found. Send a message in the group that has the bot, then run this again.');
  p.setProperty('TELEGRAM_CHAT', String(chat.id));
  if (!telegram_('Hanaro is connected. Alerts will arrive here.')) throw new Error('The group was found but the test message failed. See the Log tab in the Sheet.');
}
