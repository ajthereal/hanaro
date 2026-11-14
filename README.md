# Hanaro

A small family money app with three jobs: track spending, track bank balances, and track credit card use and limits.
Bank emails are captured into a private Google Sheet and act as the "clearing" link: a typed entry is cleared when
its bank email arrives, and a bank email nobody typed in shows up in Review as a possibly missing entry.
Entries can be typed in the app (spending, income, transfers, card payments), edited, deleted and undone.
Categories are the same groups and categories as in the budgeting app the family used before.

This repository holds code only. No keys, links, balances or personal data are stored here.

- `apps-script/capture`: reads bank emails and writes them to the Sheet (has Gmail access).
- `apps-script/api`: the app's API (no Gmail access). Hashed keys, two roles, every edit written to the Audit tab.
- `docs`: the installable phone app (GitHub Pages serves this folder).
- `tests`: run `node tests/run.js` before every change. `node tests/e2e/run.js` drives the real app in a phone-size
  browser against a pretend server (needs Playwright). `node tests/e2e/compat.js <folder>` checks the app against an
  older copy of the API code.
- `tools/bundle.js`: joins the API files into one `Code.gs` for pasting into Apps Script. `node tools/bundle.js --core > docs/core.js`
  rebuilds the copy of the sums that the phone runs (a test fails if it is out of date).
- `apps-script/api/Core.gs`: the sums (tracked balances, card owed and available, clearing, spending by group). The same code
  runs in Apps Script, on the phone and in the tests.
- `apps-script/api/Migrate.gs`: one-time move to v2 (`migrateToV2`, run from the Apps Script editor).

How the app stays fast: the phone keeps its own copy of the data (`docs/engine.js`, IndexedDB), opens from it at once and
works out every screen itself. A refresh runs behind the screen and brings only what changed. A change shows on every
screen before it is sent.

Balances: a bank balance is the last figure that was confirmed plus everything entered since. A card or loan figure is
what is owed. Nothing is guessed; an account with no confirmed figure is shown as not set.

How saving works: every entry gets its own id on the phone and is kept there until the server confirms it, so a
lost connection or a repeated send never loses or doubles an entry. Delete hides a row (it stays in the history).

Setup values (the Sheet ID in each Apps Script project, the app link and each person's key) are entered once in the
Apps Script project or on the device and are never committed.
