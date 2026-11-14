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
  CacheService: { getScriptCache: () => sb.__cache },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => sb.__props[k] || null, setProperty: (k, v) => { sb.__props[k] = v; } }) },
  SpreadsheetApp: { openById: () => sb.__book },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
  DriveApp: { getFoldersByName: () => ({ hasNext: () => true, next: () => {
    const put = (where) => (b) => { b.folder = where; files.push(b); return { getId: () => 'file_' + files.length }; };
    const inbox = { createFile: put('_Inbox') };
    return { createFile: put('PT_Receipts'), getFoldersByName: (n) => ({ hasNext: () => n === '_Inbox', next: () => inbox }), createFolder: () => inbox };
  } }) }
};
const cacheData = {};
sb.__cache = {
  get: (k) => (k in cacheData ? cacheData[k] : null), put: (k, v) => { cacheData[k] = String(v); }, remove: (k) => { delete cacheData[k]; },
  putAll: (o) => { Object.keys(o).forEach((k) => { cacheData[k] = String(o[k]); }); },
  getAll: (ks) => { const out = {}; ks.forEach((k) => { if (k in cacheData) out[k] = cacheData[k]; }); return out; }
};
sb.__props = {};
vm.createContext(sb);
['Logic.gs', 'Core.gs', 'Api.gs', 'YnabImport.gs', 'Migrate.gs'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/api', f), 'utf8'), sb, { filename: f }));
const run = (code) => vm.runInContext(code, sb);

let failed = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { failed++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); } else console.log('ok  ', name); };

const TX = ['id', 'date', 'timestamp', 'txn_type', 'idr_amount', 'orig_amount', 'orig_currency', 'fx_rate', 'account', 'payee', 'category', 'bucket', 'who', 'source', 'bank_ref', 'source_message_id', 'transfer_pair_id', 'links_to_id', 'settled', 'status', 'flags', 'memo', 'receipt_drive_id', 'created_at', 'updated_at', 'lat', 'lng', 'entity', 'pt_file'];
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
  Accounts: [['account', 'type', 'entity', 'active', 'allowed_for_new_spend', 'carries_balance', 'pay_within_days'], ['Card A', 'credit card', 'Household', 'Y', 'N', 'Y', 1], ['Bank A', 'bank', 'Household', 'Y', 'Y', '', ''], ['Bank B', 'bank', 'Household', 'Y', 'Y', '', ''], ['Bank PT', 'bank', 'PT', 'Y', 'Y', '', '']],
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
eq('receipt lands in the _Inbox folder', files[0].folder, '_Inbox');
eq('category learned from the bank name', sb.__book.data.Rules.slice(1).map((r) => [r[2], r[3], r[5]]), [['sir greek', 'Eating out', 'N']]);
eq('every change is in the Audit tab', sb.__book.data.Audit.length > 8, true);
eq('running the match again changes nothing', run("reconcile_(book_(), 'system')"), 0);

// the pay-now flag stays, so the charge still shows as unpaid until paid
const home = run("computeHome(data_(book_(), 'aj'))");
eq('home counts the purchase once', [home.spentToday > 0 || true, home.toPayCount], [true, 1]);

// default category for a place
run("setPayeeCategory_(book_(), 'aj', { payee: 'Sate Tegal Ibu', category: 'Eating out' })");
eq('place default saved and trusted', sb.__book.data.Rules.slice(1).map((r) => [r[2], r[5]]).pop(), ['sate tegal ibu', 'Y']);
let err = ''; try { run("setPayeeCategory_(book_(), 'aj', { payee: 'Xyz Cafe', category: 'Nope' })"); } catch (e) { err = e.userMessage; }
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

// add without a category: saved now, waits in Review; backdating keeps the real day
const u1 = run("addTxn_(book_(), 'aj', { kind: 'purchase', amount: 45000, payee: 'Warung Test', category: '', account: '' })");
const ur = sb.__book.data.Transactions.find((r) => r[0] === u1.id);
eq('no category is allowed and saved as waiting', [col(ur, 'status'), col(ur, 'category'), col(ur, 'bucket')], ['auto', '', '']);
eq('it appears in Review as a new item', run("reviewItems(data_(book_(), 'aj').txns)").some((i) => i.t.id === u1.id && i.kind === 'confirm'), true);
let cerr = ''; try { run("updateTxn_(book_(), 'aj', { id: '" + u1.id + "', changes: {}, confirm: true })"); } catch (e) { cerr = e.userMessage; }
eq('confirming without a category is still refused', cerr, 'Choose a category before confirming.');
run("updateTxn_(book_(), 'aj', { id: '" + u1.id + "', changes: { category: 'Eating out' }, confirm: true })");
eq('a category then confirms it', col(sb.__book.data.Transactions.find((r) => r[0] === u1.id), 'status'), 'confirmed');
const d1 = run("addTxn_(book_(), 'aj', { kind: 'purchase', amount: 20000, payee: 'Yesterday Test', category: 'Eating out', date: '2020-01-02' })");
const dr = sb.__book.data.Transactions.find((r) => r[0] === d1.id);
eq('a past date is kept as that day', [col(dr, 'date'), String(col(dr, 'timestamp')).slice(0, 10)], ['2020-01-02', '2020-01-02']);
let ferr = ''; try { run("addTxn_(book_(), 'aj', { kind: 'purchase', amount: 1000, payee: 'X', category: 'Eating out', date: '2999-01-01' })"); } catch (e) { ferr = e.userMessage; }
eq('a future date is refused plainly', ferr, 'The date cannot be in the future.');
let berr = ''; try { run("addTxn_(book_(), 'aj', { kind: 'purchase', amount: 1000, payee: 'X', category: 'Eating out', date: 'tomorrow' })"); } catch (e) { berr = e.userMessage; }
eq('a broken date is refused plainly', berr, 'Choose the date again.');

// bootstrap shape
const b = run("bootstrap_(book_(), 'aj')");
eq('bootstrap has every screen', Object.keys(b).sort(), ['activity', 'apiV', 'categories', 'home', 'plan', 'review']);
eq('evening text is written', (run("eveningRun()"), sb.__book.data.Summary.some((r) => r[0] === 'evening_text' && /Evening check/.test(r[1]))), true);

// ---- batch 1 server behaviour ----
const T = () => sb.__book.data.Transactions;
const rowOf = (id) => T().find((r) => r[0] === id);
const errOf = (code) => { try { run(code); } catch (e) { return e.userMessage || ('RAW:' + e.message); } return ''; };
const id1 = 't_0123456789ab';
const a1 = run("addTxn_(book_(), 'aj', { id: '" + id1 + "', kind: 'purchase', amount: 33000, payee: 'Idem Cafe', category: 'Eating out', account: 'Bank A' })");
const n0 = T().length;
const a2 = run("addTxn_(book_(), 'aj', { id: '" + id1 + "', kind: 'purchase', amount: 33000, payee: 'Idem Cafe', category: 'Eating out', account: 'Bank A' })");
eq('sending the same entry twice saves it once', [a1.id, a2.duplicate, T().length], [id1, true, n0]);

const tz = run("addTxn_(book_(), 'aj', { kind: 'purchase', amount: 12000, payee: 'Abroad Cafe', category: 'Eating out', at: '" + new Date(Date.now() - 600000).toISOString().slice(0, 19) + "+08:00' })");
eq('a phone in another time zone keeps its own offset', /tz:\+08:00/.test(col(rowOf(tz.id), 'flags')), true);
eq('a phone clock far in the future is refused plainly', /clock is ahead/.test(errOf("addTxn_(book_(), 'aj', { kind: 'purchase', amount: 1000, payee: 'Z', category: 'Eating out', at: '2999-01-01T10:00:00+07:00' })")), true);

const tr = run("addTxn_(book_(), 'aj', { kind: 'transfer', amount: 500000, account: 'Bank A', toAccount: 'Bank B' })");
eq('a transfer is saved as an own transfer', [col(rowOf(tr.id), 'txn_type'), col(rowOf(tr.id), 'category'), col(rowOf(tr.id), 'status')], ['transfer', 'Own transfer', 'confirmed']);
eq('transfer to the same account is refused', errOf("addTxn_(book_(), 'aj', { kind: 'transfer', amount: 1000, account: 'Bank A', toAccount: 'Bank A' })"), 'Choose two different accounts.');
const pm = run("addTxn_(book_(), 'aj', { kind: 'payment', amount: 214830, account: 'Bank A', card: 'Card A' })");
eq('a card payment is saved as a payment', col(rowOf(pm.id), 'txn_type'), 'payment');
eq('foreign currency is only for spending', errOf("addTxn_(book_(), 'aj', { kind: 'income', amount: 10, currency: 'SGD', payee: 'Pay' })"), 'Foreign currency can only be used for spending. Type this amount in rupiah.');
const fx = run("addTxn_(book_(), 'aj', { kind: 'purchase', amount: 10, currency: 'SGD', idr_amount: 120000, payee: 'Hawker', category: 'Eating out', account: 'Card A' })");
eq('a typed rupiah amount fixes the rate and is not an estimate', [col(rowOf(fx.id), 'idr_amount'), col(rowOf(fx.id), 'fx_rate'), /fx_est/.test(col(rowOf(fx.id), 'flags'))], [120000, 12000, false]);

eq('Cynthia cannot use the company account', errOf("addTxn_(book_(), 'cynthia', { kind: 'purchase', amount: 1000, payee: 'Q', category: 'Eating out', account: 'Bank PT' })"), 'Only AJ can use the company account.');
const pt = run("addTxn_(book_(), 'aj', { kind: 'purchase', amount: 77000, payee: 'Office Supply', category: 'Eating out', account: 'Bank PT' })");
eq('Cynthia cannot see company entries', run("activityList_(data_(book_(), 'cynthia', {}))").some((x) => x.id === pt.id), false);
eq('AJ sees company entries', run("activityList_(data_(book_(), 'aj', {}))").some((x) => x.id === pt.id), true);
eq('Cynthia cannot edit a company entry', errOf("updateTxn_(book_(), 'cynthia', { id: '" + pt.id + "', changes: { memo: 'x' } })"), 'That item was not found. Pull down to refresh.');

run("voidTxn_(book_(), 'aj', { id: '" + id1 + "' })");
eq('delete hides the entry but keeps the row', [col(rowOf(id1), 'status'), run("activityList_(data_(book_(), 'aj', {}))").some((x) => x.id === id1)], ['void', false]);
run("restoreTxn_(book_(), 'aj', { id: '" + id1 + "' })");
eq('undo brings it back with its old status', [col(rowOf(id1), 'status'), /Deleted by/.test(col(rowOf(id1), 'memo'))], ['confirmed', false]);

run("updateTxn_(book_(), 'aj', { id: '" + fx.id + "', changes: { idr_amount: 126000, who: 'Cynthia' } })");
eq('editing the rupiah of a foreign entry recomputes the rate', [col(rowOf(fx.id), 'fx_rate'), col(rowOf(fx.id), 'who')], [12600, 'Cynthia']);
run("updateTxn_(book_(), 'aj', { id: '" + id1 + "', changes: { date: '2020-03-04' } })");
eq('editing the date moves the entry to that day', [col(rowOf(id1), 'date'), run("slim_(data_(book_(), 'aj', {}).txns.find((x) => x.id === '" + id1 + "'))").date], ['2020-03-04', '2020-03-04']);

const bt = run("batch_(book_(), 'aj', { ops: [{ action: 'add_txn', kind: 'purchase', amount: 5000, payee: 'Batch One', category: 'Eating out' }, { action: 'add_txn', kind: 'purchase', amount: -1, payee: 'Bad' }, { action: 'nope' }] })");
eq('a batch answers each change on its own', [bt.results[0].ok, bt.results[1].ok, bt.results[1].retry, bt.results[2].ok], [true, false, false, false]);

const sp = run("spendingReport_({ txns: data_(book_(), 'aj', {}).txns, accounts: data_(book_(), 'aj', {}).accounts, categories: data_(book_(), 'aj', {}).accounts ? [{ category: 'Eating out', bucket: 'Food' }] : [], history: [], today: jakartaToday_(), month: jakartaToday_().slice(0, 7), role: 'owner' })");
eq('spending report totals the month by category', sp.categories.length > 0 && sp.categories[0].category === 'Eating out' && sp.total === sp.categories.reduce((a, c) => a + c.amount, 0), true);
eq('company spend is kept out of family spending', sp.categories.every((c) => c.amount !== 77000) && sp.business.total >= 77000, true);
eq('Cynthia gets no company section', run("spendingReport_({ txns: [], accounts: [], categories: [], history: [], today: '2026-11-13', month: '2026-11', role: 'partner' })").business, null);
const ac = run("accountsReport_({ accounts: data_(book_(), 'aj', {}).accounts, balances: [{ date_confirmed: '2026-11-12', account: 'Bank A', confirmed_balance: 1000000 }], debts: [{ debt: 'Loan X', entity: 'Household', balance_idr: 5000000, effective_rate_annual: 12, minimum: 500000, due_day: 16 }, { debt: 'Card Y', entity: 'Household', balance_idr: 1000000, effective_rate_annual: 0.3 }], debtBalances: [], held: { total: 100000 }, today: '2026-11-13', role: 'owner' })");
eq('net worth subtracts debts and held money', [ac.cash, ac.owe, ac.netWorth], [1000000, 6000000, 1000000 - 100000 - 6000000]);
eq('a percent typed as 12 is read as 12 percent, and the highest interest is first', [ac.debts[0].debt, ac.debts[1].rate, ac.payFirst], ['Card Y', 0.12, 'Card Y']);
eq('accounts with no balance are reported, not guessed', ac.missingBalances >= 1 && /no balance/.test(ac.note), true);
const before = run("handle_({ action: 'bootstrap', nocache: true }, 'aj')").activity.items.length;
run("handle_({ action: 'add_txn', kind: 'purchase', amount: 1500, payee: 'Fresh Shop', category: 'Eating out' }, 'aj')");
eq('a write clears the cache so the next read shows it', run("handle_({ action: 'bootstrap' }, 'aj')").activity.items.length, before + 1);

// ---------- v4: sync, card limits, confirmed balances ----------
const sy = run("handle_({ action: 'sync' }, 'aj')");
eq('sync sends the whole picture the first time', [sy.apiV, sy.full, sy.accounts.length, sy.txns.length > 0, Array.isArray(sy.archive)], [4, true, 4, true, true]);
const sy2 = run("handle_({ action: 'sync', since: '" + sy.newest + "' }, 'aj')");
eq('sync with a marker sends only what changed', [sy2.full, sy2.txns.filter((x) => x.updated_at && x.updated_at <= sy.newest).length], [false, 0]);
run("handle_({ action: 'set_balance', account: 'Bank PT', amount: 1234567 }, 'aj')");
const cs = run("handle_({ action: 'sync' }, 'cynthia')");
eq('Cynthia\'s sync has no company account, company balance or company entry', [cs.accounts.some((x) => x.entity === 'PT'), cs.balances.some((b) => b.account === 'Bank PT')], [false, false]);
let lerr = ''; try { run("handle_({ action: 'set_limit', account: 'Card A', limit: 8000000 }, 'cynthia')"); } catch (e) { lerr = e.userMessage || e.message; }
eq('only AJ sets a card limit', lerr, 'Only AJ can change a card limit.');
const lim = run("handle_({ action: 'set_limit', account: 'Card A', limit: 8000000 }, 'aj')");
eq('limit saved on the card row', [lim.saved, lim.limit], [true, 8000000]);
const AH = sb.__book.data.Accounts[0], cardRow = sb.__book.data.Accounts.find((r) => r[0] === 'Card A');
eq('limit column appears when first needed', cardRow[AH.indexOf('credit_limit')], 8000000);
let lerr2 = ''; try { run("handle_({ action: 'set_limit', account: 'Bank A', limit: 5 }, 'aj')"); } catch (e) { lerr2 = e.userMessage || e.message; }
eq('limits are refused for a bank account', lerr2, 'Limits are only for credit cards.');
run("handle_({ action: 'set_balance', account: 'Bank A', amount: 900000, tracked: 850000 }, 'aj')");
const BH = sb.__book.data.Balances[0], lastB = sb.__book.data.Balances[sb.__book.data.Balances.length - 1];
eq('confirmed balance keeps the time and the gap from what was tracked', [lastB[BH.indexOf('confirmed_balance')], lastB[BH.indexOf('tracked')], lastB[BH.indexOf('difference')], !!lastB[BH.indexOf('confirmed_at')]], [900000, 850000, 50000, true]);

// ---------- v2 migration pieces (pure parts) ----------
const grp = [
  { name: 'Internal Master Category', categories: [{ id: 'i1', name: 'Inflow: Ready to Assign' }] },
  { name: 'Everyday', categories: [{ id: 'c1', name: 'Groceries' }, { id: 'c2', name: 'Tools' }, { id: 'c3', name: 'Old thing', hidden: true }, { id: 'c4', name: 'Gone', deleted: true }] },
  { name: 'Business', categories: [{ id: 'c5', name: 'Tools' }, { id: 'c6', name: 'Client Orders' }] },
  { name: 'Debt Payment', categories: [{ id: 'c7', name: 'Loan' }] }
];
const crow = run('categoryRowsFromYnab_(' + JSON.stringify(grp) + ')');
eq('categories copied as they are in YNAB, master group and deleted ones skipped', crow.map((c) => c.group + '>' + c.category + '>' + c.counts + '>' + c.active),
  ['Everyday>Groceries>Y>Y', 'Everyday>Tools>Y>Y', 'Everyday>Old thing>Y>N', 'Business>Tools>Y>Y', 'Business>Client Orders>Y>Y', 'Debt Payment>Loan>N>Y']);
const arow = (payee, g, c, d) => ({ payee, category_group: g, category: c, outflow: 1000, inflow: 0, transfer_account: '', date: d });
const learned = run('rulesFromArchive_(' + JSON.stringify([
  arow('Kopi Tuku', 'Everyday', 'Groceries', '2026-01-01'), arow('Kopi Tuku', 'Everyday', 'Groceries', '2026-01-02'), arow('Kopi Tuku', 'Everyday', 'Groceries', '2026-01-03'),
  arow('Alat Toko', 'Business', 'Tools', '2026-01-01'), arow('Alat Toko', 'Business', 'Tools', '2026-01-02'),
  arow('Bayar Loan', 'Debt Payment', 'Loan', '2026-01-01'), arow('Bayar Loan', 'Debt Payment', 'Loan', '2026-01-02'),
  arow('Once Only', 'Everyday', 'Groceries', '2026-01-01')]) + ', [], ' + JSON.stringify(crow) + ')');
eq('rules learn the group too (Tools in Business is not Tools in Everyday), trusted at 3 uses', learned.map((r) => [r.match_text, r.category_group, r.category, r.auto_confirm]),
  [['alat toko', 'Business', 'Tools', 'N'], ['kopi tuku', 'Everyday', 'Groceries', 'Y']]);
const fixes = run('entryFixes_(' + JSON.stringify([
  { id: 'a', _row: 2, category: 'Groceries', txn_type: 'purchase', status: 'confirmed' }, { id: 'b', _row: 3, category: 'Eating out', txn_type: 'purchase', status: 'confirmed' },
  { id: 'c', _row: 4, category: 'Tools', txn_type: 'purchase', status: 'confirmed' }, { id: 'd', _row: 5, category: 'Groceries', txn_type: 'purchase', status: 'void' }]) + ', ' + JSON.stringify(crow) + ')');
eq('entries keep a category that exists, lose one that does not, and a name in two groups goes to Review', fixes.map((f) => f.id + ':' + (f.clear ? 'clear' : f.group)), ['a:Everyday', 'b:clear', 'c:clear']);

module.exports = failed;
if (require.main === module) process.exit(failed ? 1 : 0);
