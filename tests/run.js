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

// BCA Fleet / Flazz top up (invented numbers)
let rt = P.parseEmail({
  from: 'bca@bca.co.id', subject: 'Internet Transaction Journal', messageId: 'topup1',
  html: tbl([['Status', 'Successful'], ['Transaction Date', '06 Nov 2026 19:49:56'], ['Transaction Type', 'Fleet Top Up'],
    ['Flazz Card Number', '0000000000001234'], ['Source of Fund', '8105****99'], ['Top Up Amount', 'IDR 200,000.00'], ['Reference No.', 'REF-TOPUP-0001']])
});
eq('top up parsed', [rt.status, rt.txn && rt.txn.idr_amount, rt.txn && rt.txn.payee, rt.txn && rt.txn.txn_type, rt.txn && rt.txn.account_last], ['parsed', 200000, 'Fleet Top Up', 'purchase', '99']);

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
eq('bca card payee', r.txn.payee, 'SAMPLECAFE');
eq('qr prefix removed', P.cleanMerchant_('GoPayQRMieAyamBaruXY'), 'Mie Ayam Baru XY');
eq('qr prefix with space', P.cleanMerchant_('GoPay QR Kopi Sample'), 'Kopi Sample');
eq('other merchant kept', P.cleanMerchant_('Example Store Jakarta'), 'Example Store Jakarta');

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

eq('html entities decode (hex and numeric)', P.htmlToText('<p>A&#x2F;B &#39;C&#39; &amp; D</p>').trim(), "A/B 'C' & D");

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


// ---------- App logic (apps-script/api/Logic.gs) ----------
const sb2 = { module: { exports: {} }, console };
vm.createContext(sb2);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/api/Logic.gs'), 'utf8'), sb2);
const L = sb2.module.exports;
const T = (o) => Object.assign({ txn_type: 'purchase', status: 'auto', flags: '', category: '', bucket: '', account: 'Card A' }, o);

eq('next due this month', L.nextDue_('2026-11-08', 16), '2026-11-16');
eq('next due rolls over', L.nextDue_('2026-11-20', 16), '2026-12-16');
eq('first of next month', L.firstOfNextMonth_('2026-12-15'), '2027-01-01');
eq('rule key', L.ruleKey('GoPayQR*Sample Cafe 12!'), 'gopayqr sample cafe 12');

// pay-now settles when a same-amount card payment follows within a day
const pn = [
  T({ id: 'a', idr_amount: 150000, timestamp: '2026-11-07T08:20:10+07:00', flags: 'pay_now' }),
  T({ id: 'p1', txn_type: 'payment', idr_amount: 150000, timestamp: '2026-11-07T08:20:39+07:00' }),
  T({ id: 'b', idr_amount: 96416, timestamp: '2026-11-07T20:13:39+07:00', flags: 'pay_now' }),
  T({ id: 'c', idr_amount: 5000, timestamp: '2026-11-07T21:00:00+07:00', flags: 'pay_now,paid' })
];
const st = L.settledPayNow(pn);
eq('pay-now matched by payment', !!st.a, true);
eq('pay-now unmatched stays open', !!st.b, false);
eq('pay-now marked paid by hand', !!st.c, true);
eq('one payment settles only one purchase', Object.keys(L.settledPayNow(pn.concat([T({ id: 'a2', idr_amount: 150000, timestamp: '2026-11-07T09:00:00+07:00', flags: 'pay_now' })]))).sort(), ['a', 'c']);

// review list
const rv = L.reviewItems([
  T({ id: 'u', status: 'needs_review', timestamp: '2026-11-06T10:00:00+07:00' }),
  T({ id: 'd', status: 'possible_duplicate', timestamp: '2026-11-06T11:00:00+07:00' }),
  T({ id: 'n', status: 'auto', timestamp: '2026-11-06T12:00:00+07:00' }),
  T({ id: 'k', status: 'auto', category: 'Eating out', flags: 'rule:r_1', timestamp: '2026-11-06T13:00:00+07:00' }),
  T({ id: 'x', status: 'void', timestamp: '2026-11-06T14:00:00+07:00' }),
  T({ id: 'pay', txn_type: 'payment', timestamp: '2026-11-06T15:00:00+07:00' })
]);
eq('review kinds (trusted rule rows skip review)', rv.map((i) => i.kind + ':' + i.t.id), ['confirm:n', 'duplicate:d', 'unread:u']);

// home: safe to spend = lower of bucket money left and cash after bills, per day
const base = {
  today: '2026-11-20',
  accounts: [
    { account: 'Bank A', type: 'bank', allowed_for_new_spend: 'Y' },
    { account: 'Savings', type: 'savings', allowed_for_new_spend: 'N' },
    { account: 'Card A', type: 'credit card', carries_balance: 'Y' }
  ],
  balances: [{ account: 'Bank A', date_confirmed: '2026-11-19', confirmed_balance: 5000000 }, { account: 'Savings', date_confirmed: '2026-11-19', confirmed_balance: 99000000 }],
  buckets: [{ bucket: 'Food', month: '2026-11', cap_idr: 3000000 }, { bucket: 'Kids', month: '2026-11', cap_idr: 1000000 }],
  bills: [{ bill: 'Internet', amount_idr: 500000, due_day: 25, active: 'Y' }, { bill: 'Paid already', amount_idr: 700000, due_day: 22, active: 'Y', last_paid: '2026-11-18' }],
  debts: [{ debt: 'Loan X', entity: 'Household', minimum: 300000, due_day: 28, balance_idr: 12000000, effective_rate_annual: 0.12 }],
  summary: [{ key: 'last_sync_ok', value: '2026-11-20T10:00:00+07:00' }],
  txns: [
    T({ id: '1', idr_amount: 1000000, bucket: 'Food', timestamp: '2026-11-10T12:00:00+07:00' }),
    T({ id: '2', idr_amount: 500000, bucket: 'Food', status: 'needs_review', timestamp: '2026-11-11T12:00:00+07:00' }),
    T({ id: '3', txn_type: 'payment', idr_amount: 2000000, timestamp: '2026-11-12T12:00:00+07:00' })
  ]
};
let h = L.computeHome(base);
// 11 days to 1 Dec. Cash 5,000,000 - 500,000 internet - 300,000 minimum = 4,200,000. Buckets left 2,000,000 + 1,000,000 = 3,000,000. Lower = 3,000,000 / 11 = 272,727, rounded down to 272,000.
eq('days to horizon', h.days, 11);
eq('safe to spend is the lower side per day', h.safeToSpend, 272000);
eq('unread spend is not counted', h.buckets.find((b) => b.bucket === 'Food').spent, 1000000);
eq('savings never count as cash', h.cash, 5000000);
eq('debt cost per month', h.debtCost, 120000);
eq('debt down = payments minus new card spend', h.debtDown, 2000000 - 1000000);
eq('month stored as a date still matches', L.computeHome(Object.assign({}, base, { buckets: [{ bucket: 'Food', month: '2026-11-01T00:00:00+07:00', cap_idr: 3000000 }] })).buckets.length, 1);
const lowCash = L.computeHome(Object.assign({}, base, { balances: [{ account: 'Bank A', date_confirmed: '2026-11-19', confirmed_balance: 400000 }] }));
eq('cash below bills gives zero and says so', [lowCash.safeToSpend, /below/.test(lowCash.notes[0])], [0, true]);
const noData = L.computeHome(Object.assign({}, base, { balances: [], buckets: [] }));
eq('no balances: no invented number', [noData.safeToSpend, noData.needs], [null, ['balances', 'plan']]);


// held for others: never ours, comes off cash, tracked per type
const held = L.computeHome(Object.assign({}, base, { txns: base.txns.concat([
  T({ id: 'h1', txn_type: 'held_in', status: 'confirmed', category: 'Held: Customer order', idr_amount: 1000000, timestamp: '2026-11-15T10:00:00+07:00' }),
  T({ id: 'h2', txn_type: 'held_in', status: 'confirmed', category: 'Held: Convention tickets', idr_amount: 2000000, timestamp: '2026-11-16T10:00:00+07:00' }),
  T({ id: 'h3', txn_type: 'held_out', status: 'confirmed', category: 'Held: Customer order', idr_amount: 400000, timestamp: '2026-11-17T10:00:00+07:00' })
]) }));
eq('held total', held.heldTotal, 2600000);
eq('held by type', held.heldByType, [{ type: 'Convention tickets', amount: 2000000 }, { type: 'Customer order', amount: 600000 }]);
// cash 5,000,000 - 800,000 bills - 2,600,000 held = 1,600,000; buckets left 3,000,000; lower = 1,600,000 / 11 = 145,454 -> 145,000
eq('held money is not spendable', held.safeToSpend, 145000);
eq('held money is not bucket spend', held.buckets.find((b) => b.bucket === 'Food').spent, 1000000);
const heldCard = L.computeHome(Object.assign({}, base, { txns: base.txns.concat([T({ id: 'hc', txn_type: 'held_out', status: 'confirmed', category: 'Held: Customer order', idr_amount: 300000, account: 'Card A', timestamp: '2026-11-18T10:00:00+07:00' })]) }));
eq('held purchase on a card still counts as card debt', heldCard.debtDown, 2000000 - 1000000 - 300000);
const noHeld = L.computeHome(base);
eq('nothing held means no held card', [noHeld.heldTotal, noHeld.heldByType], [0, []]);

// spent today / week / month
const sp = L.computeHome(Object.assign({}, base, {
  accounts: base.accounts.concat([{ account: 'PT Bank', type: 'bank', entity: 'PT', allowed_for_new_spend: 'N' }]),
  txns: base.txns.concat([
    T({ id: 's1', idr_amount: 100000, timestamp: '2026-11-20T08:00:00+07:00' }),
    T({ id: 's2', idr_amount: 50000, status: 'confirmed', timestamp: '2026-11-20T09:30:00+07:00' }),
    T({ id: 's3', idr_amount: 200000, timestamp: '2026-11-17T12:00:00+07:00' }),
    T({ id: 's4', idr_amount: 900000, account: 'PT Bank', timestamp: '2026-11-20T10:00:00+07:00' }),
    T({ id: 's5', idr_amount: 700000, txn_type: 'held_out', status: 'confirmed', category: 'Held: Customer order', timestamp: '2026-11-20T11:00:00+07:00' }),
    T({ id: 's6', idr_amount: 80000, status: 'needs_review', timestamp: '2026-11-20T12:00:00+07:00' })
  ])
}));
eq('spent today counts own purchases only', [sp.spentToday, sp.spentTodayCount], [150000, 2]);
eq('spent this week starts on Monday', sp.spentWeek, 150000 + 200000);
eq('spent this month', sp.spentMonth, 1000000 + 150000 + 200000);
eq('average per day this month', sp.avgPerDay, Math.round(1350000 / 20));
eq('week start is Monday', [L.weekStart_('2026-11-22'), L.weekStart_('2026-11-16')], ['2026-11-16', '2026-11-16']);
const owe = L.computeHome(Object.assign({}, base, { txns: base.txns.concat([
  T({ id: 'o1', idr_amount: 120000, flags: 'pay_now', timestamp: '2026-11-20T08:00:00+07:00' }),
  T({ id: 'o2', idr_amount: 60000, flags: 'pay_now,paid', timestamp: '2026-11-20T09:00:00+07:00' })]) }));
eq('left to pay = unpaid pay-now charges', [owe.toPayTotal, owe.toPayCount], [120000, 1]);
eq('bills due within a week', owe.billsWeek.map((b) => b.name), ['Internet']);

// lump-sum card payment settles several charges at once
const lump = [
  T({ id: 'l1', idr_amount: 100000, timestamp: '2026-11-05T09:00:00+07:00', flags: 'pay_now' }),
  T({ id: 'l2', idr_amount: 150000, timestamp: '2026-11-05T15:00:00+07:00', flags: 'pay_now' }),
  T({ id: 'l3', idr_amount: 125895, timestamp: '2026-11-06T11:00:00+07:00', flags: 'pay_now' }),
  T({ id: 'l4', idr_amount: 40000, timestamp: '2026-11-07T08:00:00+07:00', flags: 'pay_now' })
];
const payAll = T({ id: 'pa', txn_type: 'payment', idr_amount: 415895, timestamp: '2026-11-07T20:00:00+07:00', account: 'Bank A' });
eq('one lump sum settles all open charges', Object.keys(L.settledPayNow(lump.concat([payAll]))).sort(), ['l1', 'l2', 'l3', 'l4']);
const payTwo = T({ id: 'pb', txn_type: 'payment', idr_amount: 250000, timestamp: '2026-11-07T20:00:00+07:00', account: 'Bank A' });
eq('lump sum covering the oldest charges settles only those', Object.keys(L.settledPayNow(lump.concat([payTwo]))).sort(), ['l1', 'l2']);
const payOdd = T({ id: 'pc', txn_type: 'payment', idr_amount: 300000, timestamp: '2026-11-07T20:00:00+07:00', account: 'Bank A' });
eq('a payment that matches no total settles nothing', Object.keys(L.settledPayNow(lump.concat([payOdd]))), []);
eq('charges made after the payment are not covered', Object.keys(L.settledPayNow(lump.concat([T({ id: 'pd', txn_type: 'payment', idr_amount: 415895, timestamp: '2026-11-06T20:00:00+07:00', account: 'Bank A' })]))), []);
eq('lump sum leaves nothing to review', L.reviewItems(lump.concat([payAll])).filter((i) => i.kind === 'pay_now').length, 0);

// manual entries and bank emails are matched, not counted twice
const mt = [
  T({ id: 'm1', source: 'manual', status: 'confirmed', idr_amount: 214830, account: '', payee: 'Yoghurt', category: 'Eating out', timestamp: '2026-11-08T13:00:00+07:00' }),
  T({ id: 'e1', source: 'email', status: 'auto', idr_amount: 214830, account: 'Card A', payee: 'SIR GREEK', timestamp: '2026-11-08T12:41:00+07:00' }),
  T({ id: 'm2', source: 'manual', status: 'confirmed', idr_amount: 50000, account: 'Bank A', timestamp: '2026-11-08T13:05:00+07:00' }),
  T({ id: 'e2', source: 'email', status: 'auto', idr_amount: 50000, account: 'Card A', timestamp: '2026-11-08T13:06:00+07:00' }),
  T({ id: 'm3', source: 'manual', status: 'confirmed', idr_amount: 70000, timestamp: '2026-11-08T13:00:00+07:00' }),
  T({ id: 'e3', source: 'email', status: 'auto', idr_amount: 70000, timestamp: '2026-11-09T13:00:00+07:00' })
];
eq('manual entry and bank email are paired', L.findMatches_(mt).map((p) => p.manual.id + '>' + p.email.id), ['m1>e1']);
eq('different accounts or far apart times are not paired', L.dropMatchedManual_(mt).map((t) => t.id), ['e1', 'm2', 'e2', 'm3', 'e3']);
const twice = L.computeHome(Object.assign({}, base, { today: '2026-11-08', txns: [mt[0], mt[1]] }));
eq('a matched purchase is counted once', twice.spentToday, 214830);
const pay = L.payeeSummary_([T({ payee: 'Sate Tegal', idr_amount: 50000, category: 'Eating out', timestamp: '2026-11-02T12:00:00+07:00' }), T({ payee: 'SATE TEGAL', idr_amount: 60000, category: '', timestamp: '2026-11-03T12:00:00+07:00' })], [{ match_text: 'sate tegal', category: 'Eating out', auto_confirm: 'Y' }]);
eq('payee list groups the same place', [pay.length, pay[0].count, pay[0].total, pay[0].category, pay[0].trusted], [1, 2, 110000, 'Eating out', true]);
eq('evening text', L.eveningText_({ spentToday: 150000, spentTodayCount: 2, toPayCount: 3, toPayTotal: 330000, reviewCount: 5 }).split('\n').length, 4);

// ---------- YNAB import (apps-script/api/YnabImport.gs) ----------
const sb3 = { module: { exports: {} }, console };
vm.createContext(sb3);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/api/Logic.gs'), 'utf8'), sb3);
sb3.ruleKey = sb3.module.exports.ruleKey;
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/api/YnabImport.gs'), 'utf8'), sb3);
const Y = sb3.module.exports;
const yt = (o) => Object.assign({ date: '2026-08-01', account_id: 'a1', cleared: 'cleared', deleted: false }, o);
const flat = Y.flattenYnab_('Plan', [
  yt({ id: 't1', amount: -50000000, payee_name: 'Sate Tegal', category_id: 'c1', category_name: 'Eat Out' }),
  yt({ id: 't2', amount: 1000000000, payee_name: 'Client', category_id: 'c2', category_name: 'Income' }),
  yt({ id: 't3', amount: -100000000, payee_name: 'Mall', category_id: null, subtransactions: [{ amount: -60000000, category_id: 'c1', category_name: 'Eat Out' }, { amount: -40000000, category_id: 'c3', category_name: 'Groceries' }] }),
  yt({ id: 't4', amount: -1000, deleted: true }),
  yt({ id: 't5', amount: -20000000, transfer_account_id: 'a2', payee_name: 'Transfer' })
], [{ id: 'a1', name: 'Card A' }, { id: 'a2', name: 'Bank B' }], [{ name: 'Food', categories: [{ id: 'c1' }] }]);
eq('import rows: splits, deleted, transfers', flat.map((r) => r.ynab_id + ':' + r.outflow + ':' + r.inflow + ':' + r.transfer_account), ['t1:50000:0:', 't2:0:1000000:', 't3#1:60000:0:', 't3#2:40000:0:', 't5:20000:0:Bank B']);
eq('import rows: account and group names', [flat[0].account, flat[0].category_group], ['Card A', 'Food']);
const cmap = Y.ynabCategoryMap_([{ category: 'Eating out', bucket: 'Food & eat out', ynab_categories_mapped: 'Eat Out; Telor' }, { category: 'Groceries', bucket: 'Food & eat out', ynab_categories_mapped: 'Groceries' }]);
const hist = (payee, cat, n, date) => Array.from({ length: n }, () => ({ payee, category: cat, outflow: 10000, transfer_account: '', date: date || '2026-08-01' }));
const learned = Y.learnRulesFromHistory_(
  hist('Sate Tegal', 'Eat Out', 4).concat(hist('Warung Mix', 'Eat Out', 2), hist('Warung Mix', 'Groceries', 2), hist('One Off', 'Eat Out', 1), hist('Known Place', 'Eat Out', 5), hist('Half Trusted', 'Eat Out', 2), hist('BCA', 'Eat Out', 5), hist('Pam', 'Eat Out', 5), hist('Jenius e-Card top up', 'Eat Out', 5)),
  cmap, [{ match_text: 'known place' }]);
eq('learned rules: trusted, mixed and one-off payees', learned.map((r) => r.match_text + '>' + r.category + '>' + r.auto_confirm + '>' + r.times_used), ['half trusted>Eating out>N>2', 'sate tegal>Eating out>Y>4']);

// plan: buckets, flexible pacing, last-month comparison (invented numbers)
const pt = (id, amt, cat, ts, extra) => T(Object.assign({ id: id, idr_amount: amt, category: cat, timestamp: ts, status: 'confirmed' }, extra || {}));
const planRows = [
  { month: '2026-10', item: 'Rent', kind: 'fixed', amount_idr: 4000000, due_day: 1, category: 'Rent', active: 'Y' },
  { month: '2026-11', item: 'Rent', kind: 'fixed', amount_idr: 4500000, due_day: 1, category: 'Rent', active: 'Y' },
  { month: '2026-11', item: 'School fees', kind: 'fixed', amount_idr: 2400000, due_day: 23, category: 'School', active: 'Y' },
  { month: '2026-11', item: 'Car service', kind: 'nonmonthly', target_idr: 3000000, every_months: 6, category: 'Car', active: 'Y' },
  { month: '2026-11', item: 'Flexible', kind: 'flexible', amount_idr: 3000000, active: 'Y' }
];
const planTx = [
  pt('p1', 4500000, 'Rent', '2026-11-01T09:00:00+07:00'),
  pt('p2', 1000000, 'Groceries', '2026-11-05T12:00:00+07:00'),
  pt('p3', 500000, 'Eating out', '2026-11-10T12:00:00+07:00'),
  pt('p4', 900000, 'Groceries', '2026-11-14T12:00:00+07:00', { account: 'Bank PT' }),
  pt('p5', 300000, 'Groceries', '2026-11-15T12:00:00+07:00', { status: 'needs_review' }),
  pt('o1', 2000000, 'Groceries', '2026-10-03T12:00:00+07:00'),
  pt('o2', 1500000, 'Eating out', '2026-10-18T12:00:00+07:00')
];
const planAcc = [{ account: 'Bank A', type: 'bank' }, { account: 'Bank PT', type: 'bank', entity: 'PT' }];
const pl = L.computePlan_({ plan: planRows, txns: planTx, accounts: planAcc, today: '2026-11-20' });
eq('plan uses the newest amount for an item', pl.fixed.find((f) => f.item === 'Rent').amount, 4500000);
eq('fixed bill is paid when its category covers it', pl.fixed.find((f) => f.item === 'Rent').status, 'paid');
eq('fixed bill due in 3 days is soon', pl.fixed.find((f) => f.item === 'School fees').status, 'soon');
eq('non-monthly set aside is target over months', pl.nonmonthly[0].setAside, 500000);
eq('flexible spend skips planned categories, PT and unread', pl.flexible.spent, 1500000);
eq('flexible is on pace when under the line', [pl.flexible.expected, pl.flexible.under, pl.flexible.status], [2000000, 500000, 'on']);
eq('flexible per day left', [pl.flexible.left, pl.flexible.daysLeft, pl.flexible.perDay], [1500000, 11, 136000]);
eq('plan total', pl.planned, 4500000 + 2400000 + 500000 + 3000000);
eq('last month comparison at the same day', [pl.compare.thisSpent, pl.compare.lastSpent, pl.compare.diff], [6000000, 3500000, -2500000]);
// each fixed bill is tracked on its own: payee words, partial amounts, a Paid tap, and bills that share a category
const shx = (id, n, cat, day, payee) => ({ id, date: day.slice(0, 10), timestamp: day, txn_type: 'purchase', idr_amount: n, account: 'Bank A', payee, category: cat, status: 'auto', source: 'email' });
const sharedPlan = [
  { month: '2026-11', item: 'Electricity', kind: 'fixed', amount_idr: 2000000, category: 'Utilities & internet', match: 'pln', active: 'Y' },
  { month: '2026-11', item: 'Water', kind: 'fixed', amount_idr: 200000, category: 'Utilities & internet', match: 'pdam', active: 'Y' },
  { month: '2026-11', item: 'Mama', kind: 'fixed', amount_idr: 3700000, category: 'Family support', match: 'mama,sumiati', active: 'Y' },
  { month: '2026-11', item: 'Milka', kind: 'fixed', amount_idr: 2600000, category: 'Family support', match: 'milka', active: 'Y' },
  { month: '2026-11', item: 'School', kind: 'fixed', amount_idr: 4916666, category: 'School & courses', active: 'Y' },
  { month: '2026-11', item: 'KUR', kind: 'fixed', amount_idr: 9126582, category: 'Debt payment', active: 'Y' }
];
const sharedTx = [shx('s1', 1000000, 'Utilities & internet', '2026-11-03T10:00:00+07:00', 'PLN Prepaid'), shx('s2', 3700000, 'Family support', '2026-11-05T10:00:00+07:00', 'Transfer Mama'), shx('s3', 4916666, 'School & courses', '2026-11-04T10:00:00+07:00', 'Card installment')];
const fxp = L.computePlan_({ plan: sharedPlan, txns: sharedTx, accounts: planAcc, today: '2026-11-09' }).fixed;
const fst = (n) => fxp.find((f) => f.item === n);
eq('shared category: only the bill with the matching payee is touched', [fst('Electricity').status, fst('Water').status, fst('Mama').status, fst('Milka').status], ['part', 'later', 'paid', 'later']);
eq('part paid shows what was paid and when', [fst('Electricity').spent, fst('Electricity').paidOn], [1000000, '2026-11-03']);
eq('no payee words uses the category when it is not shared', [fst('School').status, fst('KUR').status], ['paid', 'later']);
const tapped = L.computePlan_({ plan: sharedPlan, txns: sharedTx, accounts: planAcc, today: '2026-11-09', paid: [{ month: '2026-11', item: 'KUR', amount_idr: 9126582, paid_date: '2026-11-08' }, { month: '2026-11', item: 'Electricity', amount_idr: 1000000, paid_date: '2026-11-08' }, { month: '2026-10', item: 'Water', amount_idr: 200000, paid_date: '2026-10-08' }] }).fixed;
eq('a Paid tap counts, only for its own month', [tapped.find((f) => f.item === 'KUR').status, tapped.find((f) => f.item === 'Electricity').status, tapped.find((f) => f.item === 'Water').status], ['paid', 'paid', 'later']);
// whose transaction: business wins, a typed entry is its typist's, a bank email is its account owner's
const bctx = { pt: { 'Bank PT': true }, owners: { 'Card A': 'AJ', 'Jenius C': 'Cynthia', 'BCA Bersama': 'AJ + Cynthia' } };
eq('badge: business tag wins over owner', L.byOf_({ account: 'Card A', entity: 'Business' }, bctx), 'Business');
eq('badge: PT account is business', L.byOf_({ account: 'Bank PT' }, bctx), 'Business');
eq('badge: bank email goes to the account owner', [L.byOf_({ account: 'Card A' }, bctx), L.byOf_({ account: 'Jenius C' }, bctx)], ['AJ', 'Cynthia']);
eq('badge: typed entry goes to who typed it, shared account otherwise AJ', [L.byOf_({ account: 'BCA Bersama', who: 'Cynthia' }, bctx), L.byOf_({ account: 'BCA Bersama' }, bctx)], ['Cynthia', 'AJ']);
eq('badge: family tag on a PT account is not business', L.byOf_({ account: 'Bank PT', entity: 'Family' }, bctx), '');
const noPlan = L.computePlan_({ plan: [], txns: planTx, accounts: planAcc, today: '2026-11-20' });
eq('no plan means no flexible card and a suggestion', [noPlan.flexible, noPlan.suggestFlexible], [null, 3500000]);
const over = L.computePlan_({ plan: planRows, txns: planTx.concat([pt('p6', 900000, 'Fun', '2026-11-16T12:00:00+07:00')]), accounts: planAcc, today: '2026-11-20' });
eq('flexible over the line is flagged', over.flexible.status, 'over');
const removed = L.planLatest_(planRows.concat([{ month: '2026-11', item: 'School fees', kind: 'fixed', active: 'N' }]), '2026-11').map((r) => r.item).sort();
eq('removed item disappears, history stays', removed, ['Car service', 'Flexible', 'Rent']);
eq('home carries pacing and comparison', [L.computeHome(Object.assign({}, base, { plan: planRows, txns: planTx })).pacing.amount, L.computeHome(base).pacing], [3000000, null]);

// ---------- Business or family tag, plan as the only budget ----------
const ptAccT = { 'PT Bank': true };
eq('tag wins over account', [L.isBusiness_({ entity: 'Business', account: 'Card A' }, ptAccT), L.isBusiness_({ entity: 'Family', account: 'PT Bank' }, ptAccT), L.isBusiness_({ account: 'PT Bank' }, ptAccT), L.isBusiness_({ account: 'Card A' }, ptAccT)], [true, false, true, false]);
const entT = (o) => Object.assign({ txn_type: 'purchase', status: 'confirmed', account: 'Card A', category: 'Fuel', idr_amount: 100000, timestamp: '2026-11-09T10:00:00+07:00' }, o);
const acc2T = [{ account: 'Card A', entity: 'Household' }, { account: 'PT Bank', entity: 'PT' }];
const stEnt = L.spendTotals_([entT({ id: 'a' }), entT({ id: 'b', entity: 'Business' }), entT({ id: 'c', account: 'PT Bank' }), entT({ id: 'd', account: 'PT Bank', entity: 'Family' })], acc2T, '2026-11-09');
eq('business-tagged and PT-account spending stays out of family spending', stEnt.today, 200000);
const planRowsT = [{ month: '2026-11', item: 'Internet', kind: 'fixed', amount_idr: 500000, due_day: 25, category: 'Utilities & internet', active: 'Y' }, { month: '2026-11', item: 'Flex', kind: 'flexible', amount_idr: 20000000, active: 'Y' }];
eq('fixed plan items become bills', L.billsFromPlan_(planRowsT, [], acc2T, '2026-11-09').map((b) => b.bill + ':' + b.due_day + ':' + (b.last_paid ? 'paid' : 'open')), ['Internet:25:open']);
const histT = [{ month: '2026-10', category: 'Eating out', spent_idr: 6000000 }, { month: '2026-10', category: 'Business', spent_idr: 50000000 }, { month: '2026-10', category: 'Debt payment', spent_idr: 9000000 }, { month: '2026-10', category: 'Held: Customer order', spent_idr: 18000000 }, { month: '2026-10', category: 'Utilities & internet', spent_idr: 2000000 }];
eq('history core spending skips business, debt, held and planned items', L.historyCore_(histT, '2026-10', { 'Utilities & internet': true }), 6000000);
eq('flexible suggestion falls back to imported history', L.computePlan_({ plan: planRowsT, txns: [], accounts: acc2T, today: '2026-11-09', history: histT }).suggestFlexible, 6000000);
const homePlanT = L.computeHome(Object.assign({}, base, { plan: planRowsT, history: [], bills: [], buckets: [], today: '2026-11-19' }));
eq('home safe-to-spend follows the plan Flexible number', [homePlanT.safeToSpend > 0, homePlanT.needs.indexOf('plan') === -1], [true, true]);

const hintsT = Y.buildPayeeHints_(
  [{ payee: 'Pertamina SPBU 31', category: 'Operational Car - Petrol', outflow: 300000 }, { payee: 'Pertamina SPBU 31', category: 'Operational Car - Petrol', outflow: 250000 }, { payee: 'Pertamina SPBU 31', category: 'Family Car - Petrol', outflow: 100000 },
   { payee: 'Transfer : BCA', category: 'Ching', outflow: 500000 }, { payee: 'Salary', category: 'Eat Out', outflow: 0 }, { payee: 'Lonely Cafe', category: 'Eat Out', outflow: 40000 }],
  Y.ynabCategoryMap_([{ category: 'Fuel', bucket: 'Car & transport', ynab_categories_mapped: 'Operational Car - Petrol; Family Car - Petrol' }, { category: 'Eating out', bucket: 'Food', ynab_categories_mapped: 'Eat Out' }]),
  [{ match_text: 'kfc', category: 'Eating out', times_used: 12 }]);
eq('payee hints: usual category, counts, one-offs and rule-only places', hintsT.map((h) => h.p + '>' + h.c + '>' + h.n), ['Kfc>Eating out>12', 'Pertamina SPBU 31>Fuel>3', 'Lonely Cafe>Eating out>1']);

// ---------- Foreign currency: a typed SGD entry meets the bank email in rupiah ----------
const fx = (o) => Object.assign({ txn_type: 'purchase', account: 'Card A', category: 'Eating out', idr_amount: 62000, orig_amount: 5.5, orig_currency: 'SGD', source: 'manual', status: 'confirmed', flags: 'fx_est', timestamp: '2026-11-09T12:00:00+07:00' }, o);
const bankMail = (o) => Object.assign({ txn_type: 'purchase', account: 'Card A', idr_amount: 64350, orig_currency: 'IDR', source: 'email', status: 'auto', flags: '', timestamp: '2026-11-09T12:05:00+07:00' }, o);
eq('typed SGD estimate pairs with the bank email that is a few percent different', L.findMatches_([fx({ id: 'm' }), bankMail({ id: 'e' })]).map((p) => p.manual.id + '>' + p.email.id), ['m>e']);
eq('a much different amount is not paired', L.findMatches_([fx({ id: 'm' }), bankMail({ id: 'e', idr_amount: 140000 })]).length, 0);
eq('an IDR entry still needs the exact amount', L.findMatches_([fx({ id: 'm', orig_currency: 'IDR', flags: '', orig_amount: '' }), bankMail({ id: 'e' })]).length, 0);
eq('closest foreign amount wins', L.findMatches_([fx({ id: 'm' }), bankMail({ id: 'far', idr_amount: 68000 }), bankMail({ id: 'near', idr_amount: 63000 })]).map((p) => p.email.id), ['near']);

failed += require('./glue.js');

console.log(failed ? '\n' + failed + ' FAILED' : '\nAll passed');
process.exit(failed ? 1 : 0);
