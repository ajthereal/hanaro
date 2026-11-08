# Hanaro

A small family money app: bank emails are captured into a private Google Sheet, and a phone app shows
"Safe to spend per day".

This repository holds code only. No keys, links, balances or personal data are stored here.

- `apps-script/capture`: reads bank emails and writes them to the Sheet (has Gmail access).
- `apps-script/api`: the app's API (no Gmail access). Hashed keys, two roles, every edit written to the Audit tab.
- `docs`: the installable phone app (GitHub Pages serves this folder).
- `tests`: run `node tests/run.js` before every change.

Setup values (the Sheet ID in each Apps Script project, the app link and each person's key) are entered once in the
Apps Script project or on the device and are never committed.
