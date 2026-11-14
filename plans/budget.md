# Budget and income: v3 plan

Decided with the owner on 15 Nov 2026. This replaces the Spending > Plan tab (Fixed / Non-monthly / Flexible).
Real amounts, names and targets are never written here or in code; they are entered in the app and live in the Sheet.

## The idea in one paragraph

The company account is the family's wealth. The monthly budget is a separate pot that is fed from it.
Every time money moves from a company account to a personal account, that money is budget income, and Hanaro
fills the plan with it straight away, top to bottom, in a fixed priority order (Ramsey style). Money left in a
category stays there next month. Overspending on a credit card becomes a debt line that the next income covers
first. The long-term goal is "last month's income pays this month" (YNAB's age of money); until then the plan is
filled as money lands.

## Money flow

1. Commission lands in a company account (accounts with entity = PT). This is **wealth**, not budget income.
2. Company bills (the business loan auto-debit and any other PT-paid item) are paid by the company. The budget
   never sees them.
3. **Budget income** = a transfer from a PT account to a personal account, plus any `income` entry into a
   personal account. Held / pass-through money (customer orders, tickets) never counts.
4. Each budget income runs down the ladder below and funds categories.

## The ladder (fill order)

Every budget income in the month is applied, in date order, to the first step that is not yet fully funded.

| Step | What | Funded up to |
|---|---|---|
| 1 | **Four Walls**: categories marked essential (food at home, utilities, housing, transport) | this month's target |
| 2 | **Bills and minimums**: bills with due dates (earliest due first), minimum payments on every non-PT debt | the amount due |
| 3 | **Card overspend**: overspending carried from earlier months | the full amount |
| 4 | **Everyday**: every other spending category with a target, including set-asides for yearly costs and the business categories paid from personal money | this month's target |
| 5 | **Emergency fund**: top-up of the buffer account until it reaches the starter target (set in the app) | the target |
| 6 | **Debt snowball**: everything left goes to one focus debt | the debt's balance |

Debt snowball order: debts the owner pins first (in his order), then smallest balance first. When the focus debt
is paid off, its minimum rolls into the next one. Company debts are not in the snowball.

After every non-company consumer debt is gone, step 6 becomes "Full emergency fund" (3 to 6 months, target in the
app), then "Wealth" (move to company / invest). Show the current stage in plain words, for example
"Step 6 of the plan: paying off one debt at a time. Focus: <debt name>".

Manual changes: the family can move money between categories ("Move money": from, to, amount). Moves are stored
append-only and applied after the ladder. Nothing is ever moved without a row in the Sheet.

## Category numbers (per month)

- **Target**: monthly amount, copied from last month until changed.
- **Funded**: what the ladder (plus moves) put in this month.
- **Spent**: spending in that category this month (any account, including credit cards, excluding PT accounts).
- **Left** = carried in from last month + funded − spent.
- At month end a positive Left carries over. A negative Left becomes card overspend (step 3 next month) and the
  category starts the new month at 0. (Cash overspending is treated the same way, kept simple.)

Credit cards: card spending counts against its category at once, exactly like cash. Paying the card from a bank
account is not spending. The same-day pay reminder for the miles card stays as it is. Balances carried on cards
are debts in the snowball.

## Toward "last month funds this month"

Once the current month is fully funded, extra income first funds steps 1 to 4 of **next month** before going to
steps 5 and 6. Show a meter: "Next month covered: X%". When next month is 100% covered on the 1st, offer the
setting "Use last month's income for this month" (a switch in the Budget tab). With it on, income in month M only
funds month M+1.

## Screens

Tabs: **Home, Budget, Spending, Activity, Account** (floating nav, five items).

**Home**
- Hero number: **Left to spend this month** = sum of positive Left across step 1 and step 4 categories
  (not bills, debt or savings).
- Under it: every budgeted category with its Left and a thin bar. Pinned categories first, then by group.
  Tapping a category opens its transactions. Overspent rows in red.
- If the ladder is not fully funded: "Waiting for income: Rp X of this month's plan is not covered yet."
- Spent today stays as a small line (personal accounts only, as now).

**Budget** (new)
- Top card: "This month's plan" funded / total, and "Next month covered: X%".
- Income this month: each budget income with date and a "where it went" breakdown by step.
- Sections for steps 1 to 6, each category row: Target, Left, bar. Tap → detail sheet with target edit,
  move money, and its transactions.
- Step 6 shows the debts in snowball order with balance, minimum and the focus debt highlighted; drag or arrows
  to pin the order.
- "Plan next month" button: list of categories with last month's target, spent and a suggested target
  (3-month average); change any number, then Save. This is the monthly review (about 10 minutes).
- Settings in this tab: starter emergency fund target, buffer account, which categories are Four Walls,
  "last month funds this month" switch.

**Spending**: the current Report view, unchanged in idea. Rows open their transactions; a category row also
links to the same category in Budget.

**Activity**: unchanged.

**Account**: adds a **Wealth** card on top: company cash, personal cash, debts (in snowball order), net worth.

## Migration from the current Plan

- Fixed bills → step 2 bills (keep due day, weekend rule and payee words).
- Non-monthly → step 4 set-aside categories (target / months as the monthly target).
- Flexible → removed. The suggested targets screen helps set per-category targets the first time.
- Old Plan rows stay in the Sheet (append-only); new kinds are added beside them.

## Rules for the build

- All sums live in `apps-script/api/Core.gs` so the phone works them out itself (rebuild `docs/core.js`).
  The ladder must be a pure function with tests: incomes in date order, partial funding, carry-over,
  overspend on a card, snowball rollover, next-month funding, the "last month" switch.
- The phone must keep working against the old API until the new Code.gs is pasted. Budget then shows one
  plain line: "Budget needs the new server code. Paste Code.gs into Apps Script to turn it on."
  `node tests/e2e/compat.js` must pass.
- `node tests/run.js` and `node tests/e2e/run.js` pass before every push.
- English UI. Plain error messages. No real data in the repo.
