// Run with: node tests/run.js
// Samples below are rebuilt from real email layouts with invented names, numbers and references.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const sandbox = { module: { exports: {} }, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/capture/Parsers.gs'), 'utf8'), sandbox);
const P = sandbox.module.exports;

let failed = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok  ', name);
}
const tr = (cells) => '<tr>' + cells.map((c) => '<td>' + c + '</td>').join('') + '</tr>';
const tbl = (rows) => '<table>' + rows.map((r) => tr([r[0], ':', r[1]])).join('') + '</table>';

// --- amounts and dates
eq('idr english', P.parseIdr('IDR 35,589,340.00'), 35589340);
eq('idr indo', P.parseIdr('Rp96.416,00'), 96416);
eq('idr no decimals', P.parseIdr('IDR185,000'), 185000);
eq('idr suffix', P.parseIdr('5,328,000.00 IDR'), 5328000);
eq('idr junk', P.parseIdr('n/a'), null);
eq('date bca', P.parseWib('07 Nov 2026 17:43:53'), '2026-11-07T17:43:53+07:00');
eq('date card', P.parseWib('07-11-2026 20:13:39 WIB'), '2026-11-07T20:13:39+07:00');
eq('date cimb', P.parseWib('2026-10-30/23:33:12'), '2026-10-30T23:33:12+07:00');
eq('date jenius', P.parseWib('04 NOV 2026 04:27:39 WIB'), '2026-11-04T04:27:39+07:00');

// --- BCA journal: card payment
let r = P.parseEmail({
  from: 'bca@bca.co.id', subject: 'Internet Transaction Journal', messageId: 'm1',
  html: tbl([['Status', 'Successful'], ['Transaction Date', '07 Nov 2026 17:43:53'], ['Transaction Type', 'Credit Card &amp; Paylater - BCA'],
    ['Source of Fund', '8105****99'], ['Card No. / Customer No.', '0000000017****69'], ['Total Bill', 'IDR 35,589,340.00'],
    ['Total Payment', 'IDR 400,000.00'], ['Remaining Bill', 'IDR 14,836,914.00'], ['Reference No.', 'REF-CARD-0001']])
});
eq('bca payment status', r.status, 'parsed');
eq('bca payment type', r.txn.txn_type, 'payment');
eq('bca payment amount', r.txn.idr_amount, 400000);
eq('bca payment remaining', r.txn.card_remaining_bill, 14836914);

// --- BCA journal: transfer
r = P.parseEmail({
  from: 'bca@bca.co.id', subject: 'Internet Transaction Journal', messageId: 'm2',
  html: tbl([['Status', 'Successful'], ['Transaction Date', '07 Nov 2026 18:17:18'], ['Transfer Type', 'Transfer to BCA Account'],
    ['Source of Fund', '8105xxxx99'], ['Beneficiary Name', 'PT EXAMPLE CO'], ['Transfer Amount', 'IDR 2,200,000.00'],
    ['Remarks', 'Order 12'], ['Reference No.', 'REF-TRF-0002']])
});
eq('bca transfer type', r.txn.txn_type, 'transfer');
eq('bca transfer amount', r.txn.idr_amount, 2200000);
eq('bca transfer payee', r.txn.payee, 'PT EXAMPLE CO');

// --- BCA journal: unknown type with no amount must fail loudly, not vanish
r = P.parseEmail({
  from: 'bca@bca.co.id', subject: 'Internet Transaction Journal', messageId: 'm3',
  html: tbl([['Status', 'Successful'], ['Transaction Date', '06 Nov 2026 19:49:56'], ['Transaction Type', 'Fleet Top Up'], ['Source of Fund', '8105****99']])
});
eq('bca unknown type fails visibly', r.status, 'failed');

// --- BCA card notification
r = P.parseEmail({
  from: 'kartukreditbca@bca.co.id', subject: 'Credit Card Transaction Notification', messageId: 'm4',
  html: tbl([['Nomor Customer', '0000000012345678'], ['Nomor Kartu', '431657XXXX1234'], ['Merchant / ATM', 'GoPayQRSAMPLECAFE'],
    ['Jenis Transaksi', 'E-COMMERCE'], ['Pada Tanggal', '07-11-2026 20:13:39 WIB'], ['Sejumlah', 'Rp96.416,00']])
});
eq('bca card amount', r.txn.idr_amount, 96416);
eq('bca card last4', r.txn.account_last, '1234');
eq('bca card payee', r.txn.payee, 'GoPayQRSAMPLECAFE');

// --- BCA marketing from the card sender is ignored, not review
r = P.parseEmail({ from: 'kartukreditbca@bca.co.id', subject: 'Potongan hingga Rp511 Ribu! Booking Tiket', messageId: 'm5', html: '<p>promo</p>' });
eq('bca marketing ignored', r.status, 'ignored');

// --- CIMB
r = P.parseEmail({
  from: 'CREDITCARD.NOTIFICATION@cimbniaga.co.id', subject: '[RAHASIA] Konfirmasi Transaksi', messageId: 'm6',
  html: tbl([['No. Kartu Kredit', '5289-19XX-XXXX-XX18'], ['Jumlah Transaksi', '5,328,000.00 IDR'], ['Tanggal/Waktu Transaksi', '2026-10-30/23:33:12'], ['Nama Merchant', 'EXAMPLE STORE Jakarta IDN']])
});
eq('cimb amount', r.txn.idr_amount, 5328000);
eq('cimb time', r.txn.timestamp, '2026-10-30T23:33:12+07:00');

// --- Jenius card (plain text lines)
r = P.parseEmail({
  from: 'jenius_noreply@smbci.com', subject: 'Credit Card Transaction Notification', messageId: 'm7',
  plain: "Hi Sample,\n\nThank you for using Jenius Credit Card. You've just made a transaction with\nCard number: 437896******1111\nMerchant: EXAMPLE.COM/BILL IE\nTransaction date & time: 04 NOV 2026 04:27:39 WIB\nTotal: IDR 319,000.00\nIf you not do this transaction, call"
});
eq('jenius card amount', r.txn.idr_amount, 319000);
eq('jenius card payee', r.txn.payee, 'EXAMPLE.COM/BILL IE');
eq('jenius card last4', r.txn.account_last, '1111');

// --- Jenius transfer (time comes from the email itself)
r = P.parseEmail({
  from: 'jenius_noreply@smbci.com', subject: "You've transferred money from your Jenius account", messageId: 'm8', dateIso: '2026-11-01T02:03:12Z',
  plain: 'Hi Sample,\n\nYou have just transferred IDR185,000 to JANE EXAMPLE .\n\nYou can view your transfer status'
});
eq('jenius transfer amount', r.txn.idr_amount, 185000);
eq('jenius transfer payee', r.txn.payee, 'JANE EXAMPLE');
eq('jenius transfer time', r.txn.timestamp, '2026-11-01T09:03:12+07:00');

// --- UOB must never be guessed
r = P.parseEmail({ from: 'noreply_UOB@uob.co.id', subject: 'Transaksi Pembayaran Tagihan atau Pembelian melalui Internet/Digital Banking UOB', messageId: 'm9', html: '<p>x</p>' });
eq('uob goes to review', r.status, 'failed');
r = P.parseEmail({ from: 'notification@uob.co.id', subject: 'Informasi Penukaran UOB Points Kartu Kredit Anda', messageId: 'm10', html: '<p>x</p>' });
eq('uob points ignored', r.status, 'ignored');

// --- Same message parsed twice gives the same dedupe key
const a = P.parseEmail({ from: 'CREDITCARD.NOTIFICATION@cimbniaga.co.id', subject: '[RAHASIA] Konfirmasi Transaksi', messageId: 'x', html: tbl([['No. Kartu Kredit', '5289-19XX-XXXX-XX18'], ['Jumlah Transaksi', '1,000.00 IDR'], ['Tanggal/Waktu Transaksi', '2026-10-30/23:33:12'], ['Nama Merchant', 'A']]) });
const b = P.parseEmail({ from: 'CREDITCARD.NOTIFICATION@cimbniaga.co.id', subject: '[RAHASIA] Konfirmasi Transaksi', messageId: 'y', html: tbl([['No. Kartu Kredit', '5289-19XX-XXXX-XX18'], ['Jumlah Transaksi', '1,000.00 IDR'], ['Tanggal/Waktu Transaksi', '2026-10-30/23:33:12'], ['Nama Merchant', 'A']]) });
eq('dedupe key stable', a.txn.dedupe_key, b.txn.dedupe_key);

// --- Real emails have line breaks and tabs between cells; rows must still parse
const rowNl = (k, v) => '\r\n\t\t<tr>\r\n\t\t\t<td width="198">' + k + '</td>\r\n\t\t\t<td width="2">: </td>\r\n\t\t\t<td>' + v + '</td>\r\n\t\t</tr>';
r = P.parseEmail({
  from: 'bca@bca.co.id', subject: 'Internet Transaction Journal', messageId: 'nl1',
  html: '<html><body><div>Hello,<br/>\r\n details :</div><table>' + [['Status', 'Successful'], ['Transaction Date', '07 Nov 2026 17:43:53'], ['Transaction Type', 'Credit Card & Paylater - BCA'], ['Source of Fund', '8105****99'], ['Total Bill', 'IDR 1,000,000.00'], ['Total Payment', 'IDR 400,000.00'], ['Remaining Bill', 'IDR 600,000.00'], ['Reference No.', 'REF-NL-1']].map((x) => rowNl(x[0], x[1])).join('') + '</table></body></html>'
});
eq('bca journal with line breaks', r.status, 'parsed');
eq('bca journal with line breaks amount', r.txn && r.txn.idr_amount, 400000);
r = P.parseEmail({
  from: 'kartukreditbca@bca.co.id', subject: 'Credit Card Transaction Notification', messageId: 'nl2',
  html: '<table>' + [['Nomor Kartu', '431657XXXX1234'], ['Merchant / ATM', 'SAMPLE SHOP'], ['Pada Tanggal', '07-11-2026 20:13:39 WIB'], ['Sejumlah', 'Rp96.416,00']].map((x) => rowNl(x[0], x[1])).join('') + '</table>'
});
eq('bca card with line breaks', r.txn && r.txn.idr_amount, 96416);

console.log(failed ? '\n' + failed + ' FAILED' : '\nAll passed');
process.exit(failed ? 1 : 0);
