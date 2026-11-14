// Tests for the budget ladder in apps-script/api/Core.gs. All names and numbers are invented.
const fs = require('fs'), vm = require('vm'), path = require('path');
const sb = { module: { exports: {} }, console };
vm.createContext(sb);
['Logic.gs', 'Core.gs'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/api', f), 'utf8'), sb, { filename: f }));
const C = sb.module.exports;
let failed = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); } else console.log('ok  ', name);
}

const TODAY = '2026-11-15';
const accounts = [
  { account: 'Co Bank', type: 'bank', entity: 'PT', last4: '9001', active: 'Y' },
  { account: 'Co Bank 2', type: 'bank', entity: 'PT', last4: '9002', active: 'Y' },
  { account: 'Bank A', type: 'bank', entity: 'Household', last4: '1001', active: 'Y' },
  { account: 'Bank B', type: 'bank', entity: 'Household', last4: '1002', active: 'Y' },
  { account: 'Safety', type: 'savings', entity: 'Household', last4: '1003', active: 'Y' },
  { account: 'Card Y', type: 'credit card', entity: 'Household', active: 'Y', allowed_for_new_spend: 'Y' },
  { account: 'Loan X', type: 'loan', entity: 'Household', active: 'Y', minimum: 500000, due_day: 16 },
  { account: 'Co Loan', type: 'loan', entity: 'PT', active: 'Y', minimum: 9000000 }
];
const cats = [
  { group: 'Food', category: 'Groceries', counts: 'Y', sort: 1 }, { group: 'Food', category: 'Eating out', counts: 'Y', sort: 2 },
  { group: 'Home', category: 'Rent', counts: 'Y', sort: 3 }, { group: 'Home', category: 'Utilities', counts: 'Y', sort: 4 },
  { group: 'Car', category: 'Fuel', counts: 'Y', sort: 5 }, { group: 'Fun', category: 'Fun', counts: 'Y', sort: 6 },
  { group: 'Debt payment', category: 'Loan payment', counts: 'N', sort: 7 }, { group: 'Income', category: 'Income', counts: 'N', sort: 8 }
];
const bal = (account, amount, date) => ({ account, confirmed_balance: amount, date_confirmed: date || '2026-10-01', confirmed_at: (date || '2026-10-01') + 'T09:00:00+07:00' });
const balances = [bal('Safety', 0), bal('Card Y', 1500000), bal('Loan X', 8000000), bal('Bank A', 0), bal('Co Bank', 50000000)];
let n = 0;
const tx = (o) => { n++; const day = o.date || '2026-11-03'; return Object.assign({ id: 't' + n, txn_type: 'purchase', status: 'confirmed', account: 'Bank A', idr_amount: 100000, source: 'manual', flags: '', date: day, timestamp: day + 'T10:00:00+07:00', category: '' }, o); };
const toBank = (amount, date, o) => tx(Object.assign({ txn_type: 'transfer', account: 'Co Bank', to_account: 'Bank A', idr_amount: amount, category: 'Own transfer', date }, o || {}));
const tgt = (item, amount, month, o) => Object.assign({ month: month || '2026-11', item, kind: 'target', amount_idr: amount, due_day: '', weekend: '', walls: '', match: '', active: 'Y' }, o || {});
const wall = (item, on) => ({ month: '2026-11', item, kind: 'walls', walls: on === false ? 'N' : 'Y', active: 'Y' });
function data(o) {
  const d = Object.assign({ today: TODAY, accounts, balances, cats, txns: [], budget: [], moves: [], bset: [], dorder: [], debts: [], debtBal: [], plan: [], ptIncomes: [] }, o || {});
  d.rawTxns = d.rawTxns || d.txns;
  return d;
}
const view = (o) => C.budgetView_(data(o));
const line = (v, step, name) => v.steps[step].lines.filter((l) => l.name === name)[0];
// debts out of the way unless a test wants them
const noDebts = { balances: [bal('Safety', 0), bal('Card Y', 0), bal('Loan X', 0), bal('Bank A', 0)] };

/* ---- the ladder as a plain function ---- */
let f = C.fillLadder_([{ id: 'a', step: 1, need: 100 }, { id: 'b', step: 2, need: 200 }, { id: 'c', step: 4, need: 300 }], [{ id: 'i1', date: '2026-11-02', amount: 250 }]);
eq('one income runs down the slots in order and stops when the money is gone', f.funded, { a: 100, b: 150, c: 0 });
f = C.fillLadder_([{ id: 'a', step: 1, need: 100 }, { id: 'b', step: 2, need: 200 }, { id: 'c', step: 4, need: 300 }], [{ id: 'i2', date: '2026-11-09', amount: 400 }, { id: 'i1', date: '2026-11-02', amount: 250 }]);
eq('incomes are taken in date order whatever order they are listed in, and a part funded slot is topped up by the next income', f.funded, { a: 100, b: 200, c: 300 });
eq('partial funding is recorded per income', f.alloc.map((a) => a.income + ':' + a.slot + ':' + a.amount), ['i1:a:100', 'i1:b:150', 'i2:b:50', 'i2:c:300']);
f = C.fillLadder_([{ id: 'a', step: 1, need: 100 }, { id: 'w', step: 6, need: null }], [{ id: 'i1', date: '2026-11-02', amount: 1000 }]);
eq('a slot with no limit takes everything that is left', f.funded, { a: 100, w: 900 });
f = C.fillLadder_([{ id: 'a', step: 1, need: 100 }], [{ id: 'i1', date: '2026-11-02', amount: 160 }]);
eq('money with nowhere to go is reported as left over', [f.leftover, f.unspent.i1], [60, 60]);
eq('no income funds nothing', C.fillLadder_([{ id: 'a', step: 1, need: 100 }], []).funded, { a: 0 });

/* ---- what counts as budget income ---- */
let inc = C.budgetIncomes_([
  toBank(5000000, '2026-11-02'),
  tx({ txn_type: 'income', account: 'Bank B', idr_amount: 700000, category: 'Income', date: '2026-11-04', payee: 'Side job' }),
  tx({ txn_type: 'income', account: 'Co Bank', idr_amount: 40000000, category: 'Income', date: '2026-11-05' }),
  tx({ txn_type: 'transfer', account: 'Co Bank', to_account: 'Co Bank 2', idr_amount: 3000000, date: '2026-11-05' }),
  tx({ txn_type: 'transfer', account: 'Bank A', to_account: 'Bank B', idr_amount: 2000000, date: '2026-11-05' }),
  tx({ txn_type: 'held_in', account: 'Bank A', idr_amount: 900000, category: 'Held: Orders', date: '2026-11-06' }),
  tx({ txn_type: 'transfer', account: 'Co Bank', to_account: 'Bank A', idr_amount: 800000, category: 'Held: Orders', date: '2026-11-06' }),
  tx({ txn_type: 'transfer', account: 'Co Bank', to_account: 'Bank A', idr_amount: 600000, date: '2026-11-07', status: 'void' }),
  tx({ txn_type: 'transfer', account: 'Co Bank', to_account: '', idr_amount: 600000, date: '2026-11-07' })
], accounts, []);
eq('income is a PT transfer into a personal bank and an income entry into a personal bank, nothing else', inc.map((i) => i.amount + ' ' + i.source), ['5000000 transfer', '700000 income']);
inc = C.budgetIncomes_([toBank(5000000, '2026-11-02'), tx({ txn_type: 'income', account: 'Bank A', idr_amount: 5000000, category: 'Income', date: '2026-11-03' })], accounts, []);
eq('the same money seen as a transfer and as an income entry counts once', inc.length, 1);
inc = C.budgetIncomes_([toBank(5000000, '2026-11-02'), tx({ txn_type: 'income', account: 'Bank A', idr_amount: 5000000, category: 'Income', date: '2026-11-20' })], accounts, []);
eq('two equal amounts weeks apart are two incomes', inc.length, 2);
const manual = tx({ id: 'mm1', txn_type: 'transfer', account: 'Co Bank', to_account: 'Bank A', idr_amount: 4200000, date: '2026-11-09', timestamp: '2026-11-09T10:00:00+07:00' });
const email = tx({ id: 'ee1', txn_type: 'transfer', source: 'email', status: 'auto', account: 'Co Bank', to_account: '', idr_amount: 4200000, date: '2026-11-09', timestamp: '2026-11-09T10:05:00+07:00' });
inc = C.budgetIncomes_([manual, email], accounts, []);
eq('a typed transfer and its bank email are one income, and the typed one carries the destination', inc.map((i) => i.id + ' ' + i.to), ['mm1 Bank A']);
inc = C.budgetIncomes_([], accounts, [{ id: 'pt_1', date: '2026-11-04', amount: 3000000, to: 'Bank A' }]);
eq('a partner sees PT transfers the server sends without account names', inc.map((i) => i.amount + ' ' + i.from), ['3000000 Company account']);

/* ---- targets, steps and funding in date order ---- */
let v = view({
  budget: [tgt('Groceries', 1000000), wall('Groceries'), tgt('Rent', 2000000, '2026-11', { due_day: 1 }), tgt('Fun', 500000)],
  txns: [toBank(2500000, '2026-11-03')], balances: noDebts.balances
});
eq('no consumer debt and income: steps fill 1, 2, 4 in order', [line(v, 1, 'Groceries').funded, line(v, 2, 'Rent').funded, line(v, 4, 'Fun').funded], [1000000, 1500000, 0]);
eq('plan total and funded', [v.planTarget, v.planFunded, v.waiting], [3500000, 2500000, 1000000]);
eq('the first unfunded step is shown in plain words', v.stage.text, 'Step 2 of the plan: bills and minimum payments.');
v = view({
  budget: [tgt('Groceries', 1000000), wall('Groceries'), tgt('Rent', 2000000, '2026-11', { due_day: 1 }), tgt('Fun', 500000)],
  txns: [toBank(2500000, '2026-11-03'), toBank(1000000, '2026-11-10')], balances: noDebts.balances
});
eq('the second income tops up the part funded bill, then the next step', [line(v, 2, 'Rent').funded, line(v, 4, 'Fun').funded, v.waiting], [2000000, 500000, 0]);
eq('each income shows where it went, by step', v.incomes.map((i) => i.parts.map((p) => p.step + ':' + p.amount + (p.next ? 'n' : ''))), [['1:1000000', '2:1500000'], ['2:500000', '4:500000']]);
eq('with the plan covered the surplus is not lost', v.incomes[1].unallocated + v.incomes[1].parts.reduce((s, p) => s + p.amount, 0), 1000000);

v = view({ budget: [tgt('Groceries', 1000000), tgt('Rent', 2000000, '2026-11', { due_day: 1 }), wall('Rent')], txns: [toBank(1500000, '2026-11-03')], balances: noDebts.balances });
eq('a Four Walls category is step 1 even if it has a due day', [line(v, 1, 'Rent').funded, line(v, 4, 'Groceries').funded], [1500000, 0]);

/* ---- Left, spending and Home's number ---- */
v = view({
  budget: [tgt('Groceries', 1000000), wall('Groceries'), tgt('Fun', 500000), tgt('Rent', 2000000, '2026-11', { due_day: 1 })],
  txns: [toBank(10000000, '2026-11-02'), tx({ category: 'Groceries', idr_amount: 300000, date: '2026-11-05' }), tx({ category: 'Fun', idr_amount: 650000, account: 'Card Y', date: '2026-11-06' }), tx({ category: 'Rent', idr_amount: 2000000, date: '2026-11-01' })],
  balances: noDebts.balances
});
eq('Left is funded minus spent; a card counts like cash', [line(v, 1, 'Groceries').left, line(v, 4, 'Fun').left, line(v, 2, 'Rent').left], [700000, -150000, 0]);
eq('Left to spend adds the positive Left of step 1 and step 4 only (not bills, not overspent)', v.leftToSpend, 700000);
v = view({ budget: [tgt('Groceries', 1000000)], txns: [toBank(1000000, '2026-11-02'), tx({ category: 'Groceries', idr_amount: 100000, account: 'Co Bank', date: '2026-11-05' }), tx({ category: 'Debt payment', idr_amount: 1, date: '2026-11-05' })], balances: noDebts.balances });
eq('spending from a company account does not touch the category', line(v, 4, 'Groceries').spent, 0);
v = view({ budget: [tgt('Groceries', 1000000)], txns: [tx({ category: 'Fuel', idr_amount: 90000, date: '2026-11-05' })], balances: noDebts.balances });
eq('spending in a category with no target is reported, not hidden', v.unbudgeted, 90000);

/* ---- carry-over and card overspend across months ---- */
const b3 = [tgt('Groceries', 1000000, '2026-10'), tgt('Fun', 500000, '2026-10')];
let run = C.budgetRun_(data({ budget: b3, balances: noDebts.balances, txns: [toBank(1500000, '2026-10-05'), tx({ category: 'Groceries', idr_amount: 400000, date: '2026-10-10' }), tx({ category: 'Fun', idr_amount: 800000, date: '2026-10-12' }), toBank(1500000, '2026-11-04')] }));
eq('a positive Left carries into the next month', run.res['2026-11'].lines['cat:Groceries'].carryIn, 600000);
eq('a negative Left becomes card overspend and the category starts at 0', [run.res['2026-11'].overIn, run.res['2026-11'].lines['cat:Fun'].carryIn], [300000, 0]);
v = C.budgetView_(data({ budget: b3, balances: noDebts.balances, txns: [toBank(1500000, '2026-10-05'), tx({ category: 'Groceries', idr_amount: 400000, date: '2026-10-10' }), tx({ category: 'Fun', idr_amount: 800000, date: '2026-10-12' }), toBank(2000000, '2026-11-04')] }));
eq('overspend is covered (step 3) before everyday and shows Left = carried + funded', [v.steps[3].lines[0].funded, line(v, 4, 'Groceries').left, line(v, 4, 'Fun').funded], [300000, 1600000, 500000]);
eq('Left on a carried category adds what was kept', line(v, 4, 'Groceries').left, 600000 + 1000000);

run = C.budgetRun_(data({ budget: b3, balances: noDebts.balances, txns: [toBank(1500000, '2026-10-05'), tx({ category: 'Fun', idr_amount: 1200000, date: '2026-10-12' }), toBank(100000, '2026-11-04')] }));
eq('overspend that income could not cover yet is still owed next month', [run.res['2026-11'].overIn, run.res['2026-12'].overIn], [700000, 600000]);

/* ---- snowball ---- */
const debtBal = [bal('Card Y', 1500000), bal('Loan X', 8000000), bal('Safety', 0)];
v = view({ budget: [tgt('Fun', 100000)], txns: [toBank(3000000, '2026-11-02')], balances: debtBal });
eq('minimums are step 2, funded before everyday', [line(v, 2, 'Loan X').funded, line(v, 4, 'Fun').funded], [500000, 100000]);
eq('smallest balance is the focus; what is left after next month steps 1, 2 and 4 goes to the snowball', [v.focus, v.steps[6].lines.map((l) => l.name + ':' + l.funded)], ['Card Y', ['Card Y:1500000', 'Loan X:300000']]);
eq('the stage names the focus debt', v.stage.text, 'Step 6 of the plan: paying off one debt at a time. Focus: Card Y.');
eq('the money flows to the next debt when the focus debt is full', v.steps[6].lines.map((l) => l.target), [1500000, 7500000]);
v = view({ budget: [tgt('Fun', 100000)], txns: [toBank(3000000, '2026-11-02')], balances: debtBal, dorder: [{ at: 'x', order: JSON.stringify(['Loan X', 'Card Y']) }] });
eq('a pinned debt goes first even with the bigger balance', [v.focus, v.steps[6].lines.map((l) => l.name + ':' + l.funded)], ['Loan X', ['Loan X:1800000', 'Card Y:0']]);
const snow = C.budgetRun_(data({ budget: [tgt('Fun', 100000, '2026-10')], balances: debtBal, txns: [toBank(3000000, '2026-10-02'), tx({ txn_type: 'payment', account: 'Bank A', to_account: 'Card Y', idr_amount: 1500000, date: '2026-10-20' }), toBank(3000000, '2026-11-02')] }));
eq('after the focus debt is paid off its minimum frees up and the next debt becomes the focus', snow.res['2026-11'].lines['debt:Loan X'].focus, true);
eq('a paid off debt has no more minimum or snowball line', [snow.res['2026-11'].lines['min:Card Y'], snow.res['2026-11'].lines['debt:Card Y']], [undefined, undefined]);
eq('the order helper: pinned first, then smallest, paid off and unknown last', C.orderDebts_([{ name: 'A', balance: 9 }, { name: 'B', balance: 3 }, { name: 'C', balance: 0 }, { name: 'D', balance: null }, { name: 'E', balance: 5 }], ['E']).map((x) => x.name).join(''), 'EBACD');
// all consumer debt gone: full emergency fund, then wealth
v = view({ budget: [tgt('Fun', 100000)], txns: [toBank(2000000, '2026-11-02')], balances: noDebts.balances, bset: [{ key: 'full_target', value: 1500000 }, { key: 'starter_target', value: 500000 }] });
eq('with no debt left, step 6 builds the full emergency fund, then wealth', [v.stage.text, v.steps[6].lines.map((l) => l.kind + ':' + l.funded)], ['Step 6 of the plan: building the full emergency fund.', ['full:1000000', 'wealth:300000']]);
v = view({ budget: [tgt('Fun', 100000)], txns: [toBank(2000000, '2026-11-02')], balances: noDebts.balances });
eq('with no emergency target either, the rest is wealth', [v.stage.text, v.steps[6].lines.map((l) => l.kind + ':' + l.funded)], ['Step 6 of the plan: growing wealth.', ['wealth:1800000']]);

/* ---- emergency fund (step 5) ---- */
const bs = [{ key: 'starter_target', value: 2000000 }, { key: 'buffer_account', value: 'Safety' }];
v = view({ budget: [tgt('Fun', 100000)], txns: [toBank(3000000, '2026-11-02')], balances: [bal('Safety', 600000, '2026-11-01'), bal('Card Y', 1500000), bal('Loan X', 8000000)], bset: bs });
eq('step 5 tops up the buffer account to the starter target, after step 4', [line(v, 5, 'Emergency fund').target, line(v, 5, 'Emergency fund').funded, line(v, 4, 'Fun').funded], [1400000, 1400000, 100000]);
eq('what is left after step 5 goes to the snowball', v.steps[6].funded, 400000);
v = view({ budget: [tgt('Fun', 100000)], txns: [toBank(5000000, '2026-11-02')], balances: [bal('Safety', 600000, '2026-11-01'), bal('Card Y', 1500000), bal('Loan X', 8000000)], bset: bs });
eq('step 5 stops at the target and step 6 takes over', [line(v, 5, 'Emergency fund').funded, v.steps[6].lines[0].funded > 0, v.stage.step], [1400000, true, 6]);
v = view({ budget: [tgt('Fun', 100000)], txns: [toBank(5000000, '2026-11-02')], balances: [bal('Safety', 600000, '2026-11-01'), bal('Card Y', 1500000), bal('Loan X', 8000000)], bset: [{ key: 'starter_target', value: 2000000 }] });
eq('a starter target with no buffer account still sets money aside', line(v, 5, 'Emergency fund').target, 2000000);

/* ---- next month and the last-month switch ---- */
const planB = [tgt('Groceries', 1000000), wall('Groceries'), tgt('Fun', 500000)];
v = view({ budget: planB, txns: [toBank(2000000, '2026-11-02')], balances: noDebts.balances });
eq('income beyond this month goes to next month steps 1, 2 and 4 first', [v.waiting, v.nextCovered.funded, v.nextCovered.target, v.nextCovered.pct], [0, 500000, 1500000, 33]);
eq('the income shows the next month share', v.incomes[0].parts.map((p) => p.step + ':' + p.amount + (p.next ? 'n' : '')), ['1:1000000', '4:500000', '1:500000n']);
v = view({ budget: planB, txns: [toBank(4000000, '2026-11-02')], balances: noDebts.balances, bset: [{ key: 'starter_target', value: 1000000 }] });
eq('next month is covered before the emergency fund and the snowball', [v.nextCovered.pct, v.nextCovered.full, v.steps[5].lines[0].funded], [100, true, 1000000]);
eq('next month first, then step 5: nothing is skipped', v.incomes[0].parts.map((p) => p.step + (p.next ? 'n' : '')).join(','), '1,4,1n,4n,5');
// switch: income in month M only funds month M+1
v = view({ budget: planB, txns: [toBank(1500000, '2026-11-02')], balances: noDebts.balances, bset: [{ key: 'last_month', value: 'Y', at: '2026-11-01T08:00:00+07:00' }] });
eq('with last month funds this month on, this month income does not fund this month', [v.planFunded, v.waiting], [0, 1500000]);
eq('it funds next month instead, and the meter says so', [v.nextCovered.pct, v.incomes[0].fundsMonth], [100, '2026-12']);
v = view({ budget: planB, txns: [toBank(1500000, '2026-10-20'), toBank(1500000, '2026-11-02')], balances: noDebts.balances, bset: [{ key: 'last_month', value: 'Y', at: '2026-10-01T08:00:00+07:00' }] });
eq('last month income pays this month once the switch has been on since then', [v.planFunded, v.waiting, v.nextCovered.pct], [1500000, 0, 100]);
v = view({ budget: planB, txns: [toBank(1500000, '2026-10-20')], balances: noDebts.balances, bset: [{ key: 'last_month', value: 'Y', at: '2026-11-01T08:00:00+07:00' }] });
eq('income from before the switch was turned on still funds its own month', [v.planFunded], [0]);
eq('settings are read latest row first', C.budgetSettings_([{ key: 'last_month', value: 'Y', at: '2026-10-05T00:00:00+07:00' }, { key: 'last_month', value: 'N', at: '2026-11-02T00:00:00+07:00' }, { key: 'starter_target', value: 100 }, { key: 'starter_target', value: 250 }]).starter_target, 250);

/* ---- moves ---- */
v = view({ budget: planB, txns: [toBank(1500000, '2026-11-02'), tx({ category: 'Fun', idr_amount: 100000, date: '2026-11-04' })], balances: noDebts.balances, moves: [{ id: 'mv1', date: '2026-11-06', month: '2026-11', from: 'Groceries', to: 'Fun', amount_idr: 200000 }] });
eq('a move takes from one category and gives to another, after the ladder', [line(v, 1, 'Groceries') && 0, v.categories.filter((c) => c.name === 'Groceries')[0].left, v.categories.filter((c) => c.name === 'Fun')[0].left], [0, 800000, 600000]);
const mrun = C.budgetRun_(data({ budget: planB, balances: noDebts.balances, txns: [toBank(1500000, '2026-11-02')], moves: [{ id: 'mv1', date: '2026-11-06', month: '2026-11', from: 'Groceries', to: 'Fun', amount_idr: 200000 }] }));
eq('a move carries into next month with the rest of the Left', [mrun.res['2026-12'].lines['cat:Groceries'].carryIn, mrun.res['2026-12'].lines['cat:Fun'].carryIn], [800000, 700000]);
v = view({ budget: planB, balances: noDebts.balances, txns: [], moves: [{ id: 'mv2', date: '2026-11-06', month: '2026-11', from: 'Groceries', to: 'Fuel', amount_idr: 50000 }] });
eq('a move into a category with no target still shows there', v.categories.filter((c) => c.name === 'Fuel')[0].left, 50000);

/* ---- the old Plan tab ---- */
const plan = [
  { month: '2026-10', item: 'Rent', kind: 'fixed', amount_idr: 9000000, due_day: 1, category: 'Rent', active: 'Y', weekend: 'before' },
  { month: '2026-10', item: 'Car service', kind: 'nonmonthly', target_idr: 6000000, every_months: 12, category: 'Fuel', active: 'Y' },
  { month: '2026-10', item: 'Flexible', kind: 'flexible', amount_idr: 6000000, active: 'Y' }
];
let t = C.monthTargets_(data({ plan }), '2026-11');
eq('old fixed bills become bills with their due day, set-asides become monthly targets, flexible goes', Object.keys(t).map((k) => k + ':' + t[k].amount + ':' + t[k].dueDay), ['Rent:9000000:1', 'Fuel:500000:null']);
v = view({ plan, txns: [toBank(9000000, '2026-11-02')], balances: noDebts.balances });
eq('an old bill is funded as a step 2 bill', [line(v, 2, 'Rent').funded, line(v, 2, 'Rent').due], [9000000, '2026-10-30']);
t = C.monthTargets_(data({ plan, budget: [tgt('Rent', 8000000)] }), '2026-11');
eq('a new target for the same category replaces the old row', [t.Rent.amount, t.Rent.dueDay], [8000000, null]);
t = C.monthTargets_(data({ plan, budget: [tgt('Rent', 0, '2026-11', { active: 'N' })] }), '2026-11');
eq('removing a target also removes the old row for it', Object.keys(t), ['Fuel']);
t = C.monthTargets_(data({ budget: [tgt('Fun', 500000, '2026-10'), tgt('Fun', 700000, '2026-12')] }), '2026-11');
eq('a target planned for a later month does not change this month', t.Fun.amount, 500000);
t = C.monthTargets_(data({ budget: [tgt('Fun', 500000, '2026-10'), tgt('Fun', 700000, '2026-12')] }), '2026-12');
eq('and applies from that month on', t.Fun.amount, 700000);

/* ---- a partner sees the same budget ---- */
v = view({ budget: planB, balances: noDebts.balances, txns: [], ptIncomes: [{ id: 'pt_9', date: '2026-11-02', amount: 1500000, to: 'Bank A' }] });
eq('PT transfers sent by the server fund the plan on a partner phone', v.planFunded, 1500000);

/* ---- nothing set yet ---- */
v = view({ balances: noDebts.balances, txns: [toBank(1000000, '2026-11-02')] });
eq('with no targets the budget is not ready but still lists the income', [v.ready, v.incomes.length, v.stage.text], [false, 1, 'Add targets to start the plan.']);

/* ---- Plan next month ---- */
const hist = [];
['2026-08', '2026-09', '2026-10'].forEach((m, i) => hist.push(tx({ category: 'Fun', idr_amount: [300000, 450000, 600000][i], date: m + '-10' })));
hist.push(tx({ category: 'Fuel', idr_amount: 200000, date: '2026-11-04' }));
let pn = C.planNextView_(data({ budget: [tgt('Groceries', 1000000, '2026-10')], txns: hist, balances: noDebts.balances, cutover: '2026-06-01' }));
eq('review lists budgeted categories first, with this month target and the 3 month average as the suggestion', pn.rows.map((r) => r.category + ':' + r.lastTarget + ':' + r.suggested), ['Groceries:1000000:0', 'Fun:0:450000', 'Fuel:0:200000']);
eq('a category with spending only this month uses it as the first suggestion', pn.rows[2].spent, 200000);
pn = C.planNextView_(data({ budget: [tgt('Fun', 500000, '2026-10'), tgt('Fun', 650000, '2026-12')], balances: noDebts.balances }));
eq('what next month is already set to shows in the review', [pn.rows[0].lastTarget, pn.rows[0].nextTarget, pn.nextMonth], [500000, 650000, '2026-12']);

/* ---- writes ---- */
const wo = { who: 'AJ', at: '2026-11-15T09:00:00+07:00', today: TODAY, accounts, prev: { Fun: { amount: 400000 } }, id: 'mv_new' };
let w = C.buildBudgetWrite_('set_target', { category: 'Fun', amount: '500000', dueDay: '' }, wo);
eq('set target adds a row for this month and keeps the old amount for the audit line', [w.writes[0].tab, w.writes[0].rows[0].month, w.writes[0].rows[0].amount_idr, w.audit[0].before, w.audit[0].after], ['Budget', '2026-11', 500000, 400000, 500000]);
eq('a target of 0 removes it', C.buildBudgetWrite_('set_target', { category: 'Fun', amount: 0 }, wo).writes[0].rows[0].active, 'N');
eq('a bad target says why', C.buildBudgetWrite_('set_target', { category: 'Fun', amount: 'abc' }, wo).error, 'Type the monthly target as a number. Type 0 to remove it.');
eq('a bad due day says why', C.buildBudgetWrite_('set_target', { category: 'Fun', amount: 5, dueDay: 40 }, wo).error, 'Type the due day as a number from 1 to 31.');
eq('Four Walls on and off', [C.buildBudgetWrite_('set_four_walls', { category: 'Fun', on: true }, wo).writes[0].rows[0].walls, C.buildBudgetWrite_('set_four_walls', { category: 'Fun', on: false }, wo).writes[0].rows[0].walls], ['Y', 'N']);
w = C.buildBudgetWrite_('move_money', { from: 'Fun', to: 'Fuel', amount: 50000, id: 'mv_abc' }, wo);
eq('a move is its own row with the id the phone made', [w.writes[0].tab, w.writes[0].rows[0].id, w.writes[0].rows[0].amount_idr], ['BudgetMoves', 'mv_abc', 50000]);
eq('a move needs two different categories and an amount', [C.buildBudgetWrite_('move_money', { from: 'Fun', to: 'Fun', amount: 5 }, wo).error, C.buildBudgetWrite_('move_money', { from: 'Fun', to: 'Fuel', amount: 0 }, wo).error], ['Choose two different categories.', 'Type the amount to move as a number above zero.']);
w = C.buildBudgetWrite_('set_debt_order', { order: ['Loan X', 'Card Y', 'loan x'] }, wo);
eq('a debt order is saved once per debt, in order', C.latestDebtOrder_([w.writes[0].rows[0]]), ['Loan X', 'Card Y']);
w = C.buildBudgetWrite_('set_budget_settings', { starterTarget: 3000000, bufferAccount: 'Safety', lastMonth: true }, wo);
eq('settings rows', w.writes[0].rows.map((r) => r.key + '=' + r.value), ['starter_target=3000000', 'buffer_account=Safety', 'last_month=Y']);
eq('the buffer account must be a bank account', C.buildBudgetWrite_('set_budget_settings', { bufferAccount: 'Card Y' }, wo).error, 'Choose a bank account from your list.');
w = C.buildBudgetWrite_('plan_next_month', { items: [{ category: 'Fun', amount: 600000, walls: false }, { category: 'Rent', amount: 9000000, dueDay: 1, weekend: 'before', walls: true }] }, wo);
eq('plan next month adds target rows for next month, the Four Walls changes and a reviewed marker', [w.writes[0].rows.map((r) => r.kind + ':' + r.item + ':' + r.month), w.writes[1].rows[0].key + '=' + w.writes[1].rows[0].value], [['target:Fun:2026-12', 'target:Rent:2026-12', 'walls:Fun:2026-11', 'walls:Rent:2026-11'], 'reviewed=2026-12']);
eq('plan next month with nothing says so', C.buildBudgetWrite_('plan_next_month', { items: [] }, wo).error, 'There is nothing to save yet. Set at least one target.');
const saved = [].concat(w.writes[0].rows);
v = view({ budget: saved, balances: noDebts.balances, txns: [toBank(10000000, '2026-12-01')], today: '2026-12-02' });
eq('rows written by plan next month fill the plan, in the right step', [line(v, 1, 'Rent') && line(v, 1, 'Rent').funded, line(v, 4, 'Fun').funded], [9000000, 600000]);

/* ---- Account: wealth ---- */
let wv = C.wealthView_(data({ txns: [], balances: [bal('Co Bank', 50000000), bal('Bank A', 4000000), bal('Card Y', 1500000), bal('Loan X', 8000000), bal('Co Loan', 20000000)], role: 'owner' }));
eq('wealth: company cash, personal cash, debts and net worth (company loan counted, not in the snowball)', [wv.company, wv.personal, wv.owe, wv.companyOwed, wv.netWorth], [50000000, 4000000, 9500000, 20000000, 24500000]);
eq('debts are listed in snowball order', wv.debts.map((x) => x.name), ['Card Y', 'Loan X']);
wv = C.wealthView_(data({ txns: [], balances: [bal('Bank A', 4000000), bal('Card Y', 1500000)], role: 'partner', accounts: accounts.filter((a) => a.entity !== 'PT') }));
eq('a partner gets no company line', [wv.company, wv.companyOwed, wv.netWorth], [null, null, 2500000]);

/* ---- a debt's balance at the start of a month ---- */
run = C.budgetRun_(data({ budget: [tgt('Fun', 100000, '2026-10')], balances: [bal('Card Y', 2000000, '2026-10-01'), bal('Safety', 0)], txns: [tx({ account: 'Card Y', category: 'Fun', idr_amount: 400000, date: '2026-11-05' }), tx({ txn_type: 'payment', account: 'Bank A', to_account: 'Card Y', idr_amount: 1000000, date: '2026-10-20' })] }));
eq('a card owes at the start of a month what was carried in, not that month spending', [run.res['2026-10'].debts[0].balance, run.res['2026-11'].debts[0].balance], [2000000, 1000000]);

console.log(failed ? failed + ' budget test(s) failed' : 'Budget tests passed');
module.exports = failed;
