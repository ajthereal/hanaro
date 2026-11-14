// The phone's own copy (docs/engine.js) on top of the sums (docs/core.js). Invented data. No IndexedDB here, so it runs from memory.
const fs = require('fs'), vm = require('vm'), path = require('path');
const win = { console, setTimeout, clearTimeout, Date, JSON, Math, Object, Array, Number, String, Promise };
win.window = win; vm.createContext(win);
['core.js', 'engine.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../docs', f), 'utf8'), win, { filename: f }));
const E = win.HanaroEngine;
let failed = 0;
function eq(name, got, want) { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { failed++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); } else console.log('ok  ', name); }
const today = '2026-11-14';
const tx = (o) => Object.assign({ txn_type: 'purchase', status: 'confirmed', account: 'Bank A', idr_amount: 100000, source: 'manual', flags: '', category: 'Groceries', category_group: 'Everyday', timestamp: '2026-11-14T10:00:00+07:00', date: '2026-11-14', updated_at: '2026-11-14T10:00:00+07:00' }, o);
const sync = (full, txns, newest) => ({ apiV: 4, now: '2026-11-14T11:00:00+07:00', full, newest, user: { name: 'AJ', role: 'owner' },
  accounts: [{ account: 'Bank A', type: 'bank', last4: '1199', active: 'Y' }, { account: 'Card A', type: 'credit card', active: 'Y', credit_limit: 10000000, allowed_for_new_spend: 'Y' }],
  balances: [{ account: 'Bank A', date_confirmed: '2026-11-13', confirmed_balance: 5000000, confirmed_at: '2026-11-13T09:00:00+07:00' }, { account: 'Card A', date_confirmed: '2026-11-13', confirmed_balance: 1000000, confirmed_at: '2026-11-13T09:00:00+07:00' }],
  txns, cats: [{ group: 'Everyday', category: 'Groceries', counts: 'Y', active: 'Y', sort: 1 }, { group: 'Debt Payment', category: 'Loan', counts: 'N', active: 'Y', sort: 2 }], archive: [], plan: [], paid: [], summary: [], cutover: '2026-12-01' });

E.absorb(sync(true, [tx({ id: 't_000000000001' })], '2026-11-14T10:00:00+07:00'));
eq('home counts today\'s spending and the bank figure', [E.view('home', today).spentToday, E.view('home', today).cash], [100000, 4900000]);
eq('a spend entered on the phone shows at once on Home, the card and the list', (() => {
  E.localAdd({ id: 't_000000000002', kind: 'purchase', amount: 50000, payee: 'Warung', category: 'Groceries', group: 'Everyday', account: 'Card A' }, '2026-11-14T12:00:00+07:00');
  const h = E.view('home', today), c = E.view('accounts', today).cards[0];
  return [h.spentToday, c.owed, c.available, E.view('activity', today).items.length];
})(), [150000, 1050000, 8950000, 2]);
eq('a card payment lowers the bank and the card', (() => {
  E.localAdd({ id: 't_000000000003', kind: 'payment', amount: 200000, card: 'Card A', account: 'Bank A' }, '2026-11-14T12:30:00+07:00');
  const a = E.view('accounts', today);
  return [a.banks[0].tracked, a.cards[0].owed];
})(), [4700000 - 0, 850000]);
eq('editing a category on the phone moves the spending between groups', (() => {
  E.localUpdate('t_000000000002', { category: 'Loan', category_group: 'Debt Payment' }, true);
  const r = E.view('spending', today, '2026-11');
  return [r.total, r.other.map((o) => o.group)];
})(), [100000, ['Debt Payment']]);
eq('the next sync brings only what changed and keeps what is still waiting', (() => {
  E.absorb(sync(false, [tx({ id: 't_000000000004', idr_amount: 7000, updated_at: '2026-11-14T13:00:00+07:00' })], '2026-11-14T13:00:00+07:00'));
  return [E.view('activity', today).items.length, E.since()];
})(), [4, '2026-11-14T13:00:00+07:00']);
eq('the server\'s row replaces the phone\'s copy of the same entry', (() => {
  E.absorb(sync(false, [tx({ id: 't_000000000002', idr_amount: 50000, account: 'Card A', category: 'Loan', category_group: 'Debt Payment', updated_at: '2026-11-14T14:00:00+07:00' })], '2026-11-14T14:00:00+07:00'));
  return E.view('activity', today).items.filter((t) => t.id === 't_000000000002').length;
})(), 1);
eq('categories are listed in the YNAB order, hidden ones left out', E.categories().map((c) => c.category), ['Groceries', 'Loan']);
module.exports = failed;
