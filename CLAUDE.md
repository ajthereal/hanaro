# Hanaro: rules for working in this repo

Family money app for AJ and Cynthia. English UI only. Plain error messages; never fail silently.

- This repo is PUBLIC. Code only. Never commit: tokens, the Sheet ID or Apps Script URLs, real balances, names of people, account or card numbers, or real email samples. Test samples must be invented.
- Data lives in the Google Sheet "Hanaro Money Master" (Drive). History is append-only; every edit is written to the Audit tab.
- Never write to YNAB. Reading only, for migration.
- Apps Script project A (Gmail) is in apps-script/capture. Project B (API, no Gmail) goes in apps-script/api.
- Parsers: every change must keep `node tests/run.js` passing. A known-sender email that cannot be parsed must become needs_review, never skipped.
- The meaning behind the name is private. Do not explain it anywhere in the repo or the app.
- Commits: small, plain messages. Scheduled tasks run on Sonnet.
