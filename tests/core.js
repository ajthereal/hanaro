// Tests for apps-script/api/Core.gs (tracked balances, cards, clearing, spending). All numbers and names are invented.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const sb = { module: { exports: {} }, console };
vm.createContext(sb);
['Logic.gs', 'Core.gs'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/api', f), 'utf8'), sb, { filename: f }));
const C = sb.module.exports;
let failed = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); } else console.log('ok  ', name);
}
const acc = [
  { account: 'Bank A', type: 'bank', last4: '1199', owner: 'AJ', active: 'Y' },
  { account: 'Bank B', type: 'bank', last4: '5577', owner: 'AJ', active: 'Y' },
  { account: 'Card A', type: 'credit card', owner: 'AJ', active: 'Y', credit_limit: 10000000, due_day: 16, allowed_for_new_spend: 'Y' },
  { account: 'Card B', type: 'credit card', owner: 'AJ', active: 'Y', allowed_for_new_spend: 'Y' }
];
const bal = [
  { account: 'Bank A', date_confirmed: '2026-11-10', confirmed_balance: 5000000, confirmed_at: '2026-11-10T09:00:00+07:00' },
  { account: 'Card A', date_confirmed: '2026-11-10', confirmed_balance: 2000000, confirmed_at: '2026-11-10T09:00:00+07:00' }
];
const tx = (o) => Object.assign({ txn_type: 'purchase', status: 'confirmed', account: 'Bank A', idr_amount: 100000, source: 'manual', flags: '', timestamp: '2026-11-11T10:00:00+07:00' }, o);

eq('account kinds', acc.map(C.kindOf_), ['bank', 'bank', 'card', 'card']);
eq('bank email name finds the bank by last4', (C.resolveAccount_(acc, 'Bank A ...99') || {}).account, 'Bank A');
eq('unknown and Cash resolve to nothing', [C.resolveAccount_(acc, 'Cash'), C.resolveAccount_(acc, 'Nowhere')], [null, null]);

const t1 = C.trackedAll_(acc, bal, [
  tx({ id: 'a', idr_amount: 100000 }),
  tx({ id: 'b', txn_type: 'income', idr_amount: 300000 }),
  tx({ id: 'c', status: 'void', idr_amount: 999 }),
  tx({ id: 'd', timestamp: '2026-11-09T10:00:00+07:00', idr_amount: 777 }), // before confirmation
  tx({ id: 'e', account: 'Card A', idr_amount: 400000 }),
  tx({ id: 'f', txn_type: 'payment', account: 'Bank A', to_account: 'Card A', idr_amount: 250000 }),
  tx({ id: 'g', txn_type: 'transfer', account: 'Bank A', to_account: 'Bank B', idr_amount: 50000 })
]);
eq('bank tracked = confirmed + income - spend - payment - transfer out', t1['Bank A'].tracked, 5000000 + 300000 - 100000 - 250000 - 50000);
eq('card owed = confirmed + spend - payment', t1['Card A'].tracked, 2000000 + 400000 - 250000);
eq('an account with no confirmed figure is not tracked', t1['Bank B'], undefined);

const view = C.accountsView_({ accounts: acc, balances: bal.concat([{ account: 'Card B', date_confirmed: '2026-11-10', confirmed_balance: 1, confirmed_at: '2026-11-10T09:00:00+07:00' }]), txns: [tx({ id: 'e', account: 'Card A', idr_amount: 400000 })], today: '2026-11-14' });
const ca = view.cards.filter((c) => c.account === 'Card A')[0], cb = view.cards.filter((c) => c.account === 'Card B')[0];
eq('card available = limit - owed', [ca.owed, ca.limit, ca.available, ca.util], [2400000, 10000000, 7600000, 24]);
eq('card without a limit shows none and is noted', [cb.limit, cb.available, view.notes.some((n) => /no limit/.test(n))], [null, null, true]);

const clr = C.clearing_([
  tx({ id: 'm1', timestamp: '2026-11-13T10:00:00+07:00' }),
  tx({ id: 'e1', source: 'email', status: 'auto', account: 'Bank A ...99', idr_amount: 5 })
], acc, '2026-11-14');
eq('a typed entry with no bank email yet is counted as not seen at the bank', [clr.count, clr.amount, clr.old], [1, 100000, 0]);

const arch = [{ month: '2026-09', group: 'Everyday', category: 'Groceries', spent: 900000, count: 7 }, { month: '2026-09', group: 'Debt Payment', category: 'Loan', spent: 500000, count: 1 }];
const rep = C.spendReport_({ month: '2026-09', today: '2026-11-14', cutover: '2026-11-01', accounts: acc, txns: [], cats: [], archive: arch });
eq('older months come from the archive and keep debt payments apart', [rep.fromArchive, rep.total, rep.other.length], [true, 900000, 1]);
const rep2 = C.spendReport_({ month: '2026-11', today: '2026-11-14', cutover: '2026-11-01', accounts: acc, cats: [{ group: 'Everyday', category: 'Groceries' }],
  txns: [tx({ id: 'x', category: 'Groceries', idr_amount: 120000 })], archive: arch });
eq('this month comes from Hanaro entries by group', [rep2.fromArchive, rep2.total, rep2.groups[0].group], [false, 120000, 'Everyday']);

module.exports = failed;
