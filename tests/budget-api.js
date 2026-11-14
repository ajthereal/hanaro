// Tests for the budget actions in apps-script/api/Api.gs, run against the pretend Sheet from the e2e harness. All data is invented.
const vm = require('vm');
const { createServer } = require('./e2e/harness');
const S = createServer();
let failed = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { failed++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); } else console.log('ok  ', name); };
function call(who, action, args) {
  S.sb.__post = { postData: { contents: JSON.stringify(Object.assign({ key: S.KEYS[who], action }, args || {})) } };
  return JSON.parse(vm.runInContext('doPost(__post)', S.sb).text);
}
const tab = (n) => S.book.data[n] || [];
const rowsOf = (n) => { const t = tab(n); return t.slice(1).map((r) => { const o = {}; t[0].forEach((k, i) => { o[k] = r[i]; }); return o; }); };
const audits = () => rowsOf('Audit').filter((a) => /target|walls|move|debt_order|budget_settings|plan_next/.test(a.action));
const month = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);
const next = vm.runInContext('nextMonth_("' + month + '")', S.sb);

let r = call('aj', 'set_target', { category: 'Groceries', amount: 1200000 });
eq('set target answers saved and makes the Budget tab with its headers', [r.ok, r.data && r.data.saved, tab('Budget')[0].join(',')], [true, true, 'month,item,kind,amount_idr,due_day,weekend,walls,match,active,set_by,at']);
eq('the row says who, when and what', [rowsOf('Budget')[0].item, rowsOf('Budget')[0].amount_idr, rowsOf('Budget')[0].set_by, rowsOf('Budget')[0].month], ['Groceries', 1200000, 'AJ', month]);
eq('the change is in the Audit tab', audits().map((a) => a.action + ':' + a.row_id + ':' + a.after), ['set_target:Groceries:1200000']);
call('aj', 'set_target', { category: 'Groceries', amount: 1500000 });
eq('a second change adds a row, never overwrites, and the audit line keeps the old amount', [rowsOf('Budget').length, audits()[1].before, audits()[1].after], [2, 1200000, 1500000]);
r = call('aj', 'set_target', { category: 'Groceries', amount: 'lots' });
eq('a bad amount is refused with a plain message and no retry', [r.ok, r.error, !!r.retry, rowsOf('Budget').length], [false, 'Type the monthly target as a number. Type 0 to remove it.', false, 2]);
r = call('cynthia', 'set_target', { category: 'Fun', amount: 300000 });
eq('both people can set a category target', r.ok, true);

r = call('aj', 'set_four_walls', { category: 'Groceries', on: true });
eq('Four Walls is a row too', [r.ok, rowsOf('Budget').filter((x) => x.kind === 'walls').map((x) => x.item + x.walls)], [true, ['GroceriesY']]);

r = call('aj', 'move_money', { id: 'mv_aaaaaaaaaaaa', from: 'Groceries', to: 'Fun', amount: 100000, memo: 'Party' });
call('aj', 'move_money', { id: 'mv_aaaaaaaaaaaa', from: 'Groceries', to: 'Fun', amount: 100000, memo: 'Party' });
eq('a move is saved once even if the phone sends it twice', [r.ok, rowsOf('BudgetMoves').length, rowsOf('BudgetMoves')[0].from, rowsOf('BudgetMoves')[0].amount_idr], [true, 1, 'Groceries', 100000]);
r = call('aj', 'move_money', { id: 'mv_bbbbbbbbbbbb', from: 'Groceries', to: 'Groceries', amount: 100 });
eq('a move to the same category is refused', [r.ok, r.error], [false, 'Choose two different categories.']);

r = call('cynthia', 'set_budget_settings', { starterTarget: 1000000 });
eq('settings are for AJ only', [r.ok, r.error], [false, 'Only AJ can change this part of the budget.']);
r = call('cynthia', 'set_debt_order', { order: ['Card Y'] });
eq('the debt order is for AJ only', r.ok, false);
r = call('aj', 'set_budget_settings', { starterTarget: 5000000, fullTarget: 20000000, bufferAccount: 'Bank B', lastMonth: false });
eq('settings are appended one row per setting', [r.ok, rowsOf('BudgetSettings').map((x) => x.key + '=' + x.value)], [true, ['starter_target=5000000', 'full_target=20000000', 'buffer_account=Bank B', 'last_month=N']]);
r = call('aj', 'set_budget_settings', { bufferAccount: 'Card A' });
eq('the buffer account must be a bank account', [r.ok, r.error], [false, 'Choose a bank account from your list.']);
r = call('aj', 'set_debt_order', { order: ['Loan X', 'Card Y'] });
eq('debt order saved', [r.ok, rowsOf('DebtOrder')[0].order], [true, '["Loan X","Card Y"]']);

r = call('aj', 'plan_next_month', { items: [{ category: 'Groceries', amount: 1600000, walls: true }, { category: 'Rent', amount: 9000000, dueDay: 1, weekend: 'before' }, { category: 'Fun', amount: 400000 }] });
const planned = rowsOf('Budget').filter((x) => x.month === next);
eq('plan next month writes a target per category for next month', [r.ok, planned.map((x) => x.item + ':' + x.amount_idr)], [true, ['Groceries:1600000', 'Rent:9000000', 'Fun:400000']]);
eq('and marks the review as done', rowsOf('BudgetSettings').filter((x) => x.key === 'reviewed').map((x) => String(x.value)), [next]);
eq('every plan row is audited', audits().filter((a) => a.action === 'plan_next_month').length, 4);
r = call('aj', 'plan_next_month', { items: [{ category: 'Rent', amount: 'x' }] });
eq('one bad row refuses the whole save, so nothing half saves', [r.ok, rowsOf('Budget').filter((x) => x.month === next).length], [false, 3]);

r = call('aj', 'batch', { ops: [{ action: 'set_target', category: 'Fuel', amount: 250000 }, { action: 'move_money', id: 'mv_cccccccccccc', from: 'Fun', to: 'Fuel', amount: 1 }] });
eq('budget changes can travel in a batch', [r.ok, r.data.results.map((x) => x.ok)], [true, [true, true]]);

// What a phone reads
let sy = call('aj', 'sync', {}).data;
eq('sync carries the budget tabs and the version marker', [sy.budgetV, sy.budget.length > 5, sy.moves.length, sy.bset.length > 0, sy.dorder.length, Array.isArray(sy.debts), Array.isArray(sy.ptIncomes)], [1, true, 2, true, 1, true, true]);
// Moving money from the company account is budget income, and a partner is told about it without account names
call('aj', 'add_txn', { id: 't_abcdef012345', kind: 'transfer', amount: 4000000, account: 'Bank PT', toAccount: 'Bank A' });
sy = call('aj', 'sync', {}).data;
eq('the owner computes company transfers from the entries themselves', sy.ptIncomes, []);
sy = call('cynthia', 'sync', {}).data;
eq('a partner receives the company transfer as a plain income line', [sy.ptIncomes.length, sy.ptIncomes[0] && sy.ptIncomes[0].amount, sy.ptIncomes[0] && sy.ptIncomes[0].to], [1, 4000000, 'Bank A']);
eq('and no company account name is in what she receives', JSON.stringify(sy).indexOf('Bank PT'), -1);
eq('and no debt order', sy.dorder, []);
console.log(failed ? failed + ' budget API test(s) failed' : 'Budget API tests passed');
module.exports = failed;
