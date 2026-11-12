// The new app against the OLD server code (before this update). It must stay usable until the new server code is pasted.
// Usage: node tests/e2e/compat.js <folder with the old Api.gs and Logic.gs>
const { createServer } = require('./harness');
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0; const ok = (n, c, x) => { if (c) console.log('ok  ', n); else { failed++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
(async () => {
  const S = createServer({ codeDir: process.argv[2] }); await new Promise((r) => S.server.listen(0, r));
  const base = 'http://localhost:' + S.server.address().port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx.addInitScript((c) => { try { localStorage.setItem('hanaro.url', c.url); localStorage.setItem('hanaro.key', c.key); } catch (e) {} }, { url: base + '/exec', key: S.KEYS.aj });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  const rows = () => S.book.data.Transactions, col = (r, k) => r[rows()[0].indexOf(k)];
  await page.goto(base + '/'); await page.waitForSelector('.big .n'); await sleep(500);
  ok('home loads on the old server', true);
  await page.click('#addBtn'); await page.waitForSelector('#sheet:not([hidden])');
  ok('Transfer and card payment are hidden on the old server', (await page.$eval('#kindTransfer', (e) => e.hidden)) && (await page.$eval('#kindPay', (e) => e.hidden)));
  for (const k of ['3', '0', 'L']) await page.click('#keypad [data-k="' + k + '"]');
  await page.click('#keypad [data-k="done"]'); await page.fill('#addPayee', 'Old Server Cafe'); await page.click('#catBtn'); await page.click('#pickList [data-cat="Eating out"]');
  await page.click('#addSave'); await sleep(2000);
  const r = rows().slice(1).filter((x) => col(x, 'payee') === 'Old Server Cafe');
  ok('an entry saves on the old server, once', r.length === 1 && Number(col(r[0], 'idr_amount')) === 30000, r.length);
  await page.click('nav [data-go="activity"]'); await page.waitForSelector('.arow'); await sleep(300);
  ok('Activity shows it', (await page.$$('.arow:has-text("Old Server Cafe")')).length === 1);
  await page.click('nav [data-go="spending"]'); await sleep(1200);
  ok('Spending shows the plan, no tabs, on the old server', (await page.$$('[data-stab]')).length === 0 && (await page.$$('.prow2')).length > 0);
  await page.click('nav [data-go="accounts"]'); await sleep(1500);
  ok('Accounts falls back to the old Status screen', (await page.textContent('#view')).includes('Email sync'), (await page.textContent('#view')).slice(0, 120));
  ok('no browser errors', errs.length === 0, errs.slice(0, 3));
  await browser.close(); S.server.close(); console.log(failed ? failed + ' FAILED' : 'Compat passed'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
