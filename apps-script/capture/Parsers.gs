/**
 * Hanaro bank-email parsers. Pure functions, no Google services, so the same
 * file runs in Apps Script and in the Node test runner (tests/run.js).
 *
 * parseEmail(msg) takes { from, subject, dateIso, messageId, html, plain }
 * and returns one of:
 *   { status: 'parsed',  txn: {...} }
 *   { status: 'ignored', reason }        known sender, not a transaction (marketing etc.)
 *   { status: 'failed',  parser, error } known transaction email we could not read
 * It never throws. A failure is a visible needs_review item, never a silent skip.
 */

var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7, aug: 8, agu: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, des: 12 };

/** A QR wallet prefix is not a payee. "GoPayQRTahuKriukYE" becomes "Tahu Kriuk YE". Other names are left alone. */
function cleanMerchant_(raw) {
  var s = String(raw || '').trim();
  var m = s.match(/^(?:gopay\s*qr|gopay)[\s\-*:]*(.+)$/i);
  if (!m) return s;
  s = m[1].trim();
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return s.replace(/\s+/g, ' ').trim() || String(raw || '').trim();
}

function htmlToText(html) {
  if (!html) return '';
  var t = String(html)
    .replace(/>\s+</g, '><')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(tr|p|div|h\d)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(parseInt(n, 10)); });
  return t.replace(/[ \t\r]+/g, ' ').replace(/\n\s*\n+/g, '\n');
}

/** Table rows like "| Key | : | Value |" and plain lines like "Key: Value" -> {key: value} */
function extractFields(text) {
  var out = {};
  String(text).split('\n').forEach(function (line) {
    var l = line.trim();
    if (!l) return;
    if (l.indexOf('|') !== -1) {
      var cells = l.split('|').map(function (c) { return c.trim(); })
        .filter(function (c) { return c !== '' && c !== ':'; });
      if (cells.length >= 2) {
        var k = cells[0].replace(/:$/, '').trim().toLowerCase();
        if (!(k in out)) out[k] = cells.slice(1).join(' ').replace(/^:\s*/, '').trim();
      }
      return;
    }
    var m = l.match(/^([A-Za-z][A-Za-z \/&.]{1,40}?)\s*:\s*(.+)$/);
    if (m) {
      var key = m[1].trim().toLowerCase();
      if (!(key in out)) out[key] = m[2].trim();
    }
  });
  return out;
}

/** "IDR 35,589,340.00", "Rp96.416,00", "IDR185,000", "5,328,000.00 IDR" -> number or null */
function parseIdr(s) {
  if (s === undefined || s === null) return null;
  var c = String(s).replace(/[^0-9.,]/g, '');
  if (!c) return null;
  if (/,\d{2}$/.test(c)) c = c.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{1,2}$/.test(c)) c = c.replace(/,/g, '');
  else c = c.replace(/[.,]/g, '');
  var n = parseFloat(c);
  return isNaN(n) ? null : n;
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** Returns "YYYY-MM-DDTHH:MM:SS+07:00" (WIB) or null. Accepts the formats banks use. */
function parseWib(s) {
  if (!s) return null;
  var t = String(s).trim(), m;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})[\/ T](\d{2}):(\d{2}):(\d{2})/))) {
    return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '+07:00';
  }
  if ((m = t.match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})/))) {
    return m[3] + '-' + m[2] + '-' + m[1] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '+07:00';
  }
  if ((m = t.match(/^(\d{1,2}) ([A-Za-z]{3})[A-Za-z]* (\d{4}) (\d{2}):(\d{2}):(\d{2})/))) {
    var mon = MONTHS[m[2].toLowerCase()];
    if (!mon) return null;
    return m[3] + '-' + pad2(mon) + '-' + pad2(parseInt(m[1], 10)) + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '+07:00';
  }
  return null;
}

function last4(s) {
  var m = String(s || '').match(/(\d{2,4})\s*$/);
  return m ? m[1] : '';
}

function dedupeKey(txn) {
  var minute = (txn.timestamp || '').slice(0, 16);
  if (txn.bank_ref) return [txn.bank, txn.account_last, txn.bank_ref, txn.idr_amount].join('|');
  return [txn.bank, txn.account_last, minute, txn.idr_amount, (txn.payee || '').toLowerCase()].join('|');
}

function baseTxn(msg, bank, parser) {
  return {
    bank: bank, parser: parser, source: 'email', source_message_id: msg.messageId || '',
    settled: 'Y', txn_type: 'purchase', orig_currency: 'IDR', flags: []
  };
}

function fail(parser, error) { return { status: 'failed', parser: parser, error: error }; }

/* ---------- BCA myBCA "Internet Transaction Journal" ---------- */
function parseBcaJournal(msg) {
  var f = extractFields(htmlToText(msg.html) || msg.plain);
  var when = parseWib(f['transaction date']);
  if (!when) return fail('bca_journal', 'Could not find the transaction date');
  var kind = (f['transaction type'] || f['transfer type'] || '').trim();
  var t = baseTxn(msg, 'BCA', 'bca_journal');
  t.timestamp = when; t.date = when.slice(0, 10);
  t.bank_ref = f['reference no.'] || '';
  t.account_last = last4(f['source of fund']);
  t.settled = /success/i.test(f['status'] || '') ? 'Y' : 'N';
  if (/credit card|paylater/i.test(kind)) {
    t.txn_type = 'payment';
    t.idr_amount = parseIdr(f['total payment']);
    t.payee = 'BCA card payment';
    t.card_customer_mask = f['card no. / customer no.'] || '';
    var bill = parseIdr(f['total bill']), left = parseIdr(f['remaining bill']);
    t.memo = 'Card bill ' + bill + ', remaining after payment ' + left;
    t.card_remaining_bill = left;
  } else if (f['transfer type']) {
    t.txn_type = 'transfer';
    t.idr_amount = parseIdr(f['transfer amount']);
    t.payee = f['beneficiary name'] || '';
    t.memo = f['remarks'] || '';
  } else {
    // Other journal types (Fleet Top Up, bill payments...). Take any amount-like field.
    t.payee = kind;
    t.idr_amount = parseIdr(f['top up amount'] || f['total payment'] || f['amount'] || f['total amount'] || f['transaction amount']);
    if (/top up/i.test(kind) && f['flazz card number']) t.memo = 'Card ending ' + last4(f['flazz card number']);
  }
  if (t.idr_amount === null) return fail('bca_journal', 'Could not find the amount for "' + kind + '"');
  return { status: 'parsed', txn: t };
}

/* ---------- BCA credit card notification (HTML only) ---------- */
function parseBcaCard(msg) {
  var f = extractFields(htmlToText(msg.html));
  var when = parseWib(f['pada tanggal']);
  var amt = parseIdr(f['sejumlah']);
  if (!when || amt === null) return fail('bca_card', 'Could not find the date or amount');
  var t = baseTxn(msg, 'BCA', 'bca_card');
  t.timestamp = when; t.date = when.slice(0, 10); t.idr_amount = amt;
  t.account_last = last4(f['nomor kartu']);
  t.card_customer = f['nomor customer'] || '';
  t.payee = cleanMerchant_(f['merchant / atm'] || '');
  t.memo = f['jenis transaksi'] || '';
  return { status: 'parsed', txn: t };
}

/* ---------- CIMB credit card ---------- */
function parseCimb(msg) {
  var f = extractFields(htmlToText(msg.html) || msg.plain);
  var when = parseWib(f['tanggal/waktu transaksi']);
  var amt = parseIdr(f['jumlah transaksi']);
  if (!when || amt === null) return fail('cimb', 'Could not find the date or amount');
  var t = baseTxn(msg, 'CIMB', 'cimb');
  t.timestamp = when; t.date = when.slice(0, 10); t.idr_amount = amt;
  t.account_last = last4(f['no. kartu kredit']);
  t.payee = f['nama merchant'] || '';
  return { status: 'parsed', txn: t };
}

/* ---------- Jenius credit card ---------- */
function parseJeniusCard(msg) {
  var f = extractFields(htmlToText(msg.html) || msg.plain);
  var when = parseWib(f['transaction date & time']);
  var amt = parseIdr(f['total']);
  if (!when || amt === null) return fail('jenius_card', 'Could not find the date or amount');
  var t = baseTxn(msg, 'Jenius', 'jenius_card');
  t.timestamp = when; t.date = when.slice(0, 10); t.idr_amount = amt;
  t.account_last = last4(f['card number']);
  t.payee = f['merchant'] || '';
  return { status: 'parsed', txn: t };
}

/* ---------- Jenius transfer out (no timestamp in the email, so we use the send time) ---------- */
function parseJeniusTransfer(msg) {
  var text = htmlToText(msg.html) || msg.plain || '';
  var m = text.match(/transferred\s+IDR\s?([\d.,]+)\s+to\s+(.+?)\s*\./i);
  if (!m) return fail('jenius_transfer', 'Could not find the amount or recipient');
  var when = msg.dateIso ? toWib(msg.dateIso) : null;
  if (!when) return fail('jenius_transfer', 'No send time on the email');
  var t = baseTxn(msg, 'Jenius', 'jenius_transfer');
  t.txn_type = 'transfer';
  t.idr_amount = parseIdr(m[1]); t.payee = m[2].trim();
  t.timestamp = when; t.date = when.slice(0, 10); t.account_last = '';
  t.flags.push('time_is_email_time');
  return { status: 'parsed', txn: t };
}

/** ISO UTC ("2026-11-01T02:03:12Z") -> WIB string. */
function toWib(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  var w = new Date(d.getTime() + 7 * 3600 * 1000);
  return w.getUTCFullYear() + '-' + pad2(w.getUTCMonth() + 1) + '-' + pad2(w.getUTCDate()) + 'T' +
    pad2(w.getUTCHours()) + ':' + pad2(w.getUTCMinutes()) + ':' + pad2(w.getUTCSeconds()) + '+07:00';
}

/* ---------- Routing ---------- */
var ROUTES = [
  { sender: /bca@bca\.co\.id/i, subject: /internet transaction journal/i, fn: parseBcaJournal, name: 'bca_journal' },
  { sender: /kartukreditbca@bca\.co\.id/i, subject: /credit card transaction notification/i, fn: parseBcaCard, name: 'bca_card' },
  { sender: /creditcard\.notification@cimbniaga\.co\.id/i, subject: /konfirmasi transaksi/i, fn: parseCimb, name: 'cimb' },
  { sender: /jenius_noreply@smbci\.com/i, subject: /credit card transaction notification/i, fn: parseJeniusCard, name: 'jenius_card' },
  { sender: /jenius_noreply@smbci\.com/i, subject: /transferred money/i, fn: parseJeniusTransfer, name: 'jenius_transfer' }
];

var KNOWN_SENDERS = /bca@bca\.co\.id|kartukreditbca@bca\.co\.id|creditcard\.notification@cimbniaga\.co\.id|jenius_noreply@smbci\.com|@uob\.co\.id/i;

function isKnownSender(from) { return KNOWN_SENDERS.test(String(from || '')); }

function parseEmail(msg) {
  try {
    var from = msg.from || '', subject = msg.subject || '';
    for (var i = 0; i < ROUTES.length; i++) {
      var r = ROUTES[i];
      if (r.sender.test(from) && r.subject.test(subject)) {
        var res = r.fn(msg);
        if (res.status === 'parsed') res.txn.dedupe_key = dedupeKey(res.txn);
        return res;
      }
    }
    // UOB has no verified parser yet: never guess, always send it to review.
    if (/@uob\.co\.id/i.test(from)) {
      if (/pembayaran|pembelian|transaksi|transfer/i.test(subject) && !/penukaran|points|promo/i.test(subject)) {
        return fail('uob', 'UOB email format not learned yet. Please enter it by hand.');
      }
      return { status: 'ignored', reason: 'UOB non-transaction email' };
    }
    if (isKnownSender(from)) return { status: 'ignored', reason: 'Known sender, not a transaction email' };
    return { status: 'ignored', reason: 'Unknown sender' };
  } catch (e) {
    return fail('router', 'Unexpected error: ' + e.message);
  }
}

if (typeof module !== 'undefined') {
  module.exports = { parseEmail: parseEmail, parseIdr: parseIdr, parseWib: parseWib, htmlToText: htmlToText, extractFields: extractFields, isKnownSender: isKnownSender, dedupeKey: dedupeKey, cleanMerchant_: cleanMerchant_ };
}
