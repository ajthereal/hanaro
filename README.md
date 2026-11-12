# Hanaro

A small family money app. Bank emails are captured into a private Google Sheet, and a phone app shows what was
spent today, where the money went this month, accounts, debts and net worth. Entries can be typed in the app too
(spending, income, transfers, card payments, money held for others), edited, deleted and undone.

This repository holds code only. No keys, links, balances or personal data are stored here.

- `apps-script/capture`: reads bank emails and writes them to the Sheet (has Gmail access).
- `apps-script/api`: the app's API (no Gmail access). Hashed keys, two roles, every edit written to the Audit tab.
- `docs`: the installable phone app (GitHub Pages serves this folder).
- `tests`: run `node tests/run.js` before every change. `node tests/e2e/run.js` drives the real app in a phone-size
  browser against a pretend server (needs Playwright). `node tests/e2e/compat.js <folder>` checks the app against an
  older copy of the API code.
- `tools/bundle.js`: joins the API files into one `Code.gs` for pasting into Apps Script.

How saving works: every entry gets its own id on the phone and is kept there until the server confirms it, so a
lost connection or a repeated send never loses or doubles an entry. Delete hides a row (it stays in the history).

Setup values (the Sheet ID in each Apps Script project, the app link and each person's key) are entered once in the
Apps Script project or on the device and are never committed.
