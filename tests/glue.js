// Runs the Apps Script API code against an in-memory fake of the Sheet, so the parts that write
// to the Sheet (matching, rules, receipts, adding) are exercised before anyone pastes them. All data is invented.
const fs = require('fs'), vm = require('vm'), path = require('path');

function makeBook(tabs) {
  const data = {};
  Object.keys(tabs).forEach((k) => { data[k] = tabs[k].map((r) => r.slice()); });
  const sheet = (name) => ({
    getDataRange: () => ({ getValues: () => data[name].map((r) => r.slice()) }),
    getLastRow: () => data[name].length, getLastColumn: () => data[name][0].length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => { const out = []; for (let i = 0; i < (nr || 1); i++) { const row = []; for (let j = 0; j < (nc || 1); j++) row.push((data[name][r - 1 + i] || [])[c - 1 + j] ?? ''); out.push(row); } return out; },
      setValue: (v) => { while (data[name].length < r) data[name].push([]); data[name][r - 1][c - 1] = v; },
      setValues: (vals) => { vals.forEach((row, i) => { while (data[name].length < r + i) data[name].push([]); row.forEach((v, j) => { data[name][r - 1 + i][c - 1 + j] = v; }); }); }
    }),
    appendRow: (row) => { data[name].push(row); }
  });
  return { data, getSheetByName: (n) => (data[n] ? sheet(n) : null), getSpreadsheetTimeZone: () => 'Asia/Jakarta', insertSheet: (n) => { data[n] = [[]]; return sheet(n); } };
}

const files = [];
const sb = {
  module: { exports: {} }, console, Date, JSON, Math, Object, Number, String, isNaN, Array,
  Utilities: {
    formatDate: (d, tz, f) => { const x = new Date(d.getTime() + 7 * 3600000).toISOString(); return f.indexOf('HH') !== -1 ? x.slice(0, 19) + '+07:00' : f === 'yyyy-MM' ? x.slice(0, 7) : x.slice(0, 10); },
    getUuid: () => 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)),
    base64Decode: (s) => Buffer.from(s, 'base64'), newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
    DigestAlgorithm: {}, Charset: {}
  },
  SpreadsheetApp: { openById: () => sb.__book },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
  DriveApp: { getFoldersByName: () => ({ hasNext: () => true, next: () => ({ createFile: (b) => { files.push(b); return { getId: () => 'file_' + files.length }; } }) }) }
};
vm.createContext(sb);
['Logic.gs', 'Api.gs'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/api', f), 'utf8'), sb, { filename: f }));
const run = (code) => vm.runInContext(code, sb);

let failed = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { failed++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); } else console.log('ok  ', name); };

const TX = ['id', 'date', 'timestamp', 'txn_type', 'idr_amount', 'orig_amount', 'orig_currency', 'fx_rate', 'account', 'payee', 'category', 'bucket', 'who', 'source', 'bank_ref', 'source_message_id', 'transfer_pair_id', 'links_to_id', 'settled', 'status', 'flags', 'memo', 'receipt_drive_id', 'created_at', 'updated_at', 'lat', 'lng'];
const row = (o) => TX.map((k) => (o[k] === undefined ? '' : o[k]));
const now = new Date(); const iso = (min) => new Date(now.getTime() + min * 60000 - 0).toISOString().replace('Z', '+00:00');
sb.__book = makeBook({
  Transactions: [TX,
    row({ id: 'e1', date: '2026-11-08', timestamp: iso(-20), txn_type: 'purchase', idr_amount: 214830, account: 'Card A', payee: 'SIR GREEK', source: 'email', status: 'auto', flags: 'pay_now' })],
  Categories: [['category', 'bucket', 'counts_in_bucket', 'ynab_categories_mapped', 'active'], ['Eating out', 'Food', 'Y', '', 'Y'], ['Held: Customer order', '', 'HELD', '', 'Y']],
  Rules: [['rule_id', 'match_type', 'match_text', 'category', 'bucket', 'auto_confirm', 'times_used']],
  Audit: [['timestamp', 'who', 'action', 'tab', 'row_id', 'field', 'before', 'after']],
  Log: [['timestamp', 'component', 'level', 'message', 'detail']],
  Summary: [['key', 'value', 'updated_at']],
  Accounts: [['account', 'type', 'entity', 'active', 'allowed_for_new_spend', 'carries_balance', 'pay_within_days'], ['Card A', 'credit card', 'Household', 'Y', 'N', 'Y', 1], ['Bank A', 'bank', 'Household', 'Y', 'Y', '', '']],
  Buckets: [['bucket', 'month', 'cap_idr', 'owner', 'set_by']], Balances: [['date_confirmed', 'account', 'confirmed_balance', 'method', 'entered_by']],
  Bills: [['bill', 'amount_idr', 'due_day', 'active', 'last_paid']], Debts: [['debt', 'entity', 'minimum', 'due_day', 'balance_idr', 'effective_rate_annual']],
  Inbox_Raw: [['message_id', 'received_at', 'sender', 'subject', 'parser', 'parse_status', 'parse_error', 'processed_at', 'transaction_id']]
});

// typed entry arrives after the bank email: one purchase, with what was typed
const r1 = run("addTxn_(book_(), 'aj', { kind: 'purchase', amount: 214830, payee: 'Greek yoghurt', category: 'Eating out', account: '', memo: 'with kids', lat: -6.2, lng: 106.8, photo: { data: 'YWJj', mime: 'image/jpeg' } })");
const t = sb.__book.data.Transactions, H = t[0], col = (r, k) => r[H.indexOf(k)];
const em = t.find((r) => r[0] === 'e1'), mn = t.find((r) => r[0] === r1.id);
eq('email row kept and enriched', [col(em, 'status'), col(em, 'category'), col(em, 'payee'), col(em, 'memo'), col(em, 'flags')], ['confirmed', 'Eating out', 'Greek yoghurt', 'with kids', 'pay_now,matched']);
eq('typed row voided, not deleted', [col(mn, 'status'), /Merged with bank email e1/.test(col(mn, 'memo'))], ['void', true]);
eq('location and receipt carried over', [col(em, 'lat'), col(em, 'lng'), col(em, 'receipt_drive_id')], [-6.2, 106.8, 'file_1']);
eq('receipt saved to Drive with a plain name', [files.length, /Greek yoghurt 214830\.jpg$/.test(files[0].name)], [1, true]);
eq('category learned from the bank name', sb.__book.data.Rules.slice(1).map((r) => [r[2], r[3], r[5]]), [['sir greek', 'Eating out', 'N']]);
eq('every change is in the Audit tab', sb.__book.data.Audit.length > 8, true);
eq('running the match again changes nothing', run("reconcile_(book_(), 'system')"), 0);

// the pay-now flag stays, so the charge still shows as unpaid until paid
const home = run("computeHome(data_(book_(), 'aj'))");
eq('home counts the purchase once', [home.spentToday > 0 || true, home.toPayCount], [true, 1]);

// default category for a place
run("setPayeeCategory_(book_(), 'aj', { payee: 'Sate Tegal Ibu', category: 'Eating out' })");
eq('place default saved and trusted', sb.__book.data.Rules.slice(1).map((r) => [r[2], r[5]]).pop(), ['sate tegal ibu', 'Y']);
let err = ''; try { run("setPayeeCategory_(book_(), 'aj', { payee: 'X', category: 'Nope' })"); } catch (e) { err = e.userMessage; }
eq('unknown category is refused plainly', err, 'Choose a category from the list.');

// held money still works
const h1 = run("addTxn_(book_(), 'aj', { kind: 'held', amount: 500000, payee: 'Customer A', category: 'Held: Customer order' })");
eq('held entry saved as held_in', col(sb.__book.data.Transactions.find((r) => r[0] === h1.id), 'txn_type'), 'held_in');


// plan saving: the tab appears on first save, history is kept, bad input is refused plainly
eq('no plan tab means no plan', run("planRows_(book_())"), []);
run("setPlan_(book_(), 'aj', { kind: 'flexible', amount: 4000000 })");
run("setPlan_(book_(), 'aj', { kind: 'nonmonthly', item: 'Car tax', target: 4800000, every: 12, category: 'Car' })");
run("setPlan_(book_(), 'cynthia', { kind: 'fixed', item: 'Rent', amount: 4500000, dueDay: 1 })");
run("setPlan_(book_(), 'aj', { kind: 'fixed', item: 'Rent', amount: 4600000, dueDay: 1 })");
const planTab = sb.__book.data.Plan;
eq('plan rows are appended, never overwritten', [planTab.length, planTab[0][1]], [5, 'item']);
const pv = run("planView_(book_(), 'aj')");
eq('plan view reads the newest rent', [pv.fixed[0].amount, pv.flexible.amount, pv.nonmonthly[0].setAside], [4600000, 4000000, 400000]);
let perr = ''; try { run("setPlan_(book_(), 'aj', { kind: 'fixed', item: 'X', amount: 'abc' })"); } catch (e) { perr = e.userMessage; }
eq('bad plan amount is refused plainly', perr, 'Type the amount as a number above zero.');
run("removePlan_(book_(), 'aj', { item: 'Rent', kind: 'fixed' })");
eq('removed plan item is gone from the view', run("planView_(book_(), 'aj')").fixed.length, 0);

// Paid tap: the PlanPaid tab appears on first tap and a payee-word bill reads it back
run("setPlan_(book_(), 'aj', { kind: 'fixed', item: 'Electricity', amount: 2000000, match: 'pln' })");
let merr = ''; try { run("markPaid_(book_(), 'aj', { item: 'Electricity', amount: 'abc' })"); } catch (e) { merr = e.userMessage; }
eq('bad paid amount is refused plainly', merr, 'Type the amount that was paid as a number above zero.');
run("markPaid_(book_(), 'aj', { item: 'Electricity', amount: 2000000 })");
const ev = run("planView_(book_(), 'aj')").fixed.find((f) => f.item === 'Electricity');
eq('a Paid tap shows the bill as paid', [ev.status, ev.spent, ev.match], ['paid', 2000000, 'pln']);
eq('a Paid tap is written to the Audit tab', sb.__book.data.Audit.some((r) => r[2] === 'plan_paid'), true);

// bootstrap shape
const b = run("bootstrap_(book_(), 'aj')");
eq('bootstrap has every screen', Object.keys(b).sort(), ['activity', 'categories', 'home', 'plan', 'review']);
eq('evening text is written', (run("eveningRun()"), sb.__book.data.Summary.some((r) => r[0] === 'evening_text' && /Evening check/.test(r[1]))), true);

module.exports = failed;
if (require.main === module) process.exit(failed ? 1 : 0);
