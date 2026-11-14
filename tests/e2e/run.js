// Browser test: the real app in a phone-size Chromium against the pretend server. Usage: node tests/e2e/run.js [screenshot-folder]
const { createServer } = require('./harness');
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const shots = process.argv[2] || path.join(require('os').tmpdir(), 'hanaro-shots');
fs.mkdirSync(shots, { recursive: true });
let failed = 0;
const ok = (name, cond, extra) => { if (cond) console.log('ok  ', name); else { failed++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const S = createServer(); await new Promise((r) => S.server.listen(0, r));
  const base = 'http://localhost:' + S.server.address().port;
  const browser = await chromium.launch();
  async function phone(who) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await ctx.addInitScript((c) => { try { if (!localStorage.getItem('hanaro.url')) { localStorage.setItem('hanaro.url', c.url); localStorage.setItem('hanaro.key', c.key); } } catch (e) {} }, { url: base + '/exec', key: S.KEYS[who] });
    const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
    page.errs = errs; page.ctx = ctx; return page;
  }
  const shot = (page, n) => page.screenshot({ path: path.join(shots, n + '.png') });
  const rows = () => S.book.data.Transactions;
  const col = (r, k) => r[rows()[0].indexOf(k)];
  const byPayee = (p) => rows().slice(1).filter((r) => col(r, 'payee') === p);

  const page = await phone('aj');
  await page.goto(base + '/'); await page.waitForSelector('.big .n');
  await sleep(400); await shot(page, '01-home');
  ok('home shows spent today', (await page.textContent('.big .n')).length > 0);

  // Nav has the five places
  const navLabels = await page.$$eval('nav button', (b) => b.map((x) => x.getAttribute('aria-label')));
  ok('nav is Home, Activity, Add, Spending, Accounts', JSON.stringify(navLabels) === JSON.stringify(['Home', 'Activity', 'Add transaction', 'Spending', 'Accounts']), navLabels);

  // Add a spend with the calculator keypad
  await page.click('#addBtn'); await page.waitForSelector('#sheet:not([hidden])');
  for (const k of ['4', '5', 'L', '+', '5', 'L']) await page.click('#keypad [data-k="' + k + '"]');
  ok('keypad adds up', (await page.inputValue('#addAmount')).includes('+'), await page.inputValue('#addAmount'));
  await page.click('#keypad [data-k="done"]');
  await page.fill('#addPayee', 'Test Bakery'); await page.click('#catBtn'); await page.waitForSelector('#picker:not([hidden])');
  await shot(page, '02-picker');
  ok('picker lists the categories under their groups', (await page.$$eval('#pickList .pgroup', (e) => e.map((x) => x.textContent))).includes('Food'));
  ok('no Family/Business switch or PT filing box on the Add screen', (await page.$$('#entFam, #entBiz, #addPt, #moreBtn')).length === 0);
  await page.click('#pickList [data-cat="Groceries"]');
  await shot(page, '03-add');
  await page.click('#addSave'); await sleep(1800);
  let r1 = byPayee('Test Bakery');
  ok('spend saved once with the typed sum', r1.length === 1 && Number(col(r1[0], 'idr_amount')) === 50000, r1.map((r) => col(r, 'idr_amount')));
  ok('entry id made on the phone', /^t_[0-9a-f]{12}$/.test(col(r1[0], 'id')));

  // Transfer
  await page.click('#addBtn'); await page.waitForSelector('#sheet:not([hidden])');
  await page.click('#kindTransfer'); for (const k of ['1', '0', '0', 'L']) await page.click('#keypad [data-k="' + k + '"]');
  await page.click('#keypad [data-k="done"]');
  await page.click('#accBtn'); await page.waitForSelector('#picker:not([hidden])'); await page.click('#pickList [data-cat="Bank A"]');
  await page.click('#toBtn'); await page.waitForSelector('#picker:not([hidden])'); await page.click('#pickList [data-cat="Bank B"]');
  await shot(page, '04-transfer');
  await page.click('#addSave'); await sleep(1800);
  const tr = rows().slice(1).filter((r) => col(r, 'txn_type') === 'transfer' && col(r, 'source') === 'manual');
  ok('transfer saved as an own transfer', tr.length === 1 && col(tr[0], 'category') === 'Own transfer' && Number(col(tr[0], 'idr_amount')) === 100000, tr.length);

  // Card payment
  await page.click('#addBtn'); await page.waitForSelector('#sheet:not([hidden])');
  await page.click('#kindPay'); for (const k of ['2', '1', '4', '8', '3', '0']) await page.click('#keypad [data-k="' + k + '"]');
  await page.click('#keypad [data-k="done"]');
  await page.click('#accBtn'); await page.waitForSelector('#picker:not([hidden])'); await page.click('#pickList [data-cat="Bank A"]');
  await page.click('#toBtn'); await page.waitForSelector('#picker:not([hidden])'); await page.click('#pickList [data-cat="Card A"]');
  await page.click('#addSave'); await sleep(1800);
  ok('card payment saved', rows().slice(1).some((r) => col(r, 'txn_type') === 'payment' && col(r, 'source') === 'manual' && Number(col(r, 'idr_amount')) === 214830));

  // Foreign currency is only for spending
  await page.click('#addBtn'); await page.waitForSelector('#sheet:not([hidden])');
  await page.selectOption('#addCur', 'SGD'); await page.click('#kindGot');
  ok('switching to Received puts the currency back to rupiah', (await page.inputValue('#addCur')) === 'IDR' && await page.$eval('#addCur', (e) => e.disabled));
  await page.click('#addCancel');

  // Activity, edit, delete and undo
  await page.click('nav [data-go="activity"]'); await page.waitForSelector('.arow'); await sleep(300); await shot(page, '05-activity');
  await page.click('.arow[data-edit]:has-text("Test Bakery")'); await page.waitForSelector('#txnEdit:not([hidden])');
  await page.fill('#teAmtIn', '65000'); await shot(page, '06-edit');
  await page.click('#teSave'); await sleep(1800);
  ok('edited amount reached the Sheet', Number(col(byPayee('Test Bakery')[0], 'idr_amount')) === 65000);
  await page.click('.arow[data-edit]:has-text("Test Bakery")'); await page.waitForSelector('#txnEdit:not([hidden])');
  await page.click('#teDelete'); await page.click('.dbox .primary'); await sleep(1500);
  ok('delete voids the row, never removes it', byPayee('Test Bakery').length === 1 && col(byPayee('Test Bakery')[0], 'status') === 'void');
  ok('deleted entry is gone from Activity', (await page.$$('.arow:has-text("Test Bakery")')).length === 0);
  await shot(page, '07-deleted-undo');
  await page.click('.toast .ta'); await sleep(1800);
  ok('undo brings it back', col(byPayee('Test Bakery')[0], 'status') === 'confirmed' && (await page.$$('.arow:has-text("Test Bakery")')).length === 1);

  // Offline: entries are kept and sent once when the connection returns
  await page.ctx.setOffline(true);
  await page.click('#addBtn'); await page.waitForSelector('#sheet:not([hidden])');
  for (const k of ['2', '5', 'L']) await page.click('#keypad [data-k="' + k + '"]');
  await page.click('#keypad [data-k="done"]'); await page.fill('#addPayee', 'Offline Kiosk'); await page.click('#catBtn'); await page.click('#pickList [data-cat="Eating out"]');
  await page.click('#addSave'); await sleep(800);
  ok('offline entry is kept on the phone', byPayee('Offline Kiosk').length === 0 && JSON.parse(await page.evaluate(() => localStorage.getItem('hanaro.queue'))).length === 1);
  ok('an entry made offline shows at once in the app and in the totals', await page.evaluate(() => window.HanaroEngine.view('activity', '').items.some((i) => i.payee === 'Offline Kiosk') && window.HanaroEngine.view('home', new Date().toISOString().slice(0, 10)).spentToday >= 25000));
  ok('pill says it is waiting, not a scary error', /waiting/.test(await page.textContent('#syncPill')), await page.textContent('#syncPill'));
  await shot(page, '08-offline');
  await page.ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await sleep(2500);
  ok('it is sent exactly once after reconnecting', byPayee('Offline Kiosk').length === 1);

  // A reply lost after the server saved: the phone sends again, still only one row
  let dropped = false;
  await page.route('**/exec', async (route) => {
    const body = route.request().postData() || '';
    if (!dropped && /"action":"add_txn"/.test(body) && /Lost Reply/.test(body)) { dropped = true; await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  await page.click('#addBtn'); await page.waitForSelector('#sheet:not([hidden])');
  for (const k of ['7', 'L']) await page.click('#keypad [data-k="' + k + '"]');
  await page.click('#keypad [data-k="done"]'); await page.fill('#addPayee', 'Lost Reply'); await page.click('#catBtn'); await page.click('#pickList [data-cat="Eating out"]');
  await page.click('#addSave'); await sleep(800);
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); await sleep(2500);
  ok('lost reply then retry saves one row, not two', byPayee('Lost Reply').length === 1, byPayee('Lost Reply').length);

  // Spending report and plan
  await page.click('nav [data-go="spending"]'); await page.waitForSelector('.crow'); await sleep(400); await shot(page, '09-spending-report');
  ok('report lists categories', (await page.$$('.crow')).length >= 2);
  await page.click('[data-stab="plan"]'); await page.waitForSelector('.prow2'); await sleep(300); await shot(page, '10-spending-plan');
  await page.click('[data-stab="report"]'); await page.waitForSelector('.crow');
  await page.click('.crow:has-text("Groceries")'); await page.waitForSelector('[data-clearcat]'); await shot(page, '11-category-drill');
  ok('tapping a category opens Activity filtered to it', (await page.$$('.arow')).length >= 1);

  // Accounts
  await page.click('nav [data-go="accounts"]'); await page.waitForSelector('[data-bank]'); await sleep(600); await shot(page, '12-accounts');
  await page.click('[data-bank="0"]'); await page.fill('.dbox .di', '13500000'); await page.click('.dbox .primary'); await sleep(1800);
  const bal = S.book.data.Balances.slice(1).filter((r) => r[1] === 'Bank A').pop();
  ok('balance typed in a dialog reached the Sheet', Number(bal[2]) === 13500000, bal);
  await page.click('[data-card="0"]'); await page.click('.dbox button:has-text("Set limit")'); await page.fill('.dbox .di', '9000000'); await page.click('.dbox .primary'); await sleep(1800);
  const AH = S.book.data.Accounts[0], cardRow = S.book.data.Accounts.find((r) => r[0] === 'Card A');
  ok('card limit typed in a dialog reached the Sheet', Number(cardRow[AH.indexOf('credit_limit')]) === 9000000, cardRow);
  ok('the card now shows what is still available', /available of/.test(await page.textContent('[data-card="0"]')), await page.textContent('[data-card="0"]'));
  await shot(page, '13-accounts-after');

  // Review
  await page.click('nav [data-go="home"]'); await page.waitForSelector('[data-go-review]'); await page.click('[data-go-review]'); await page.waitForSelector('.card[data-id], .card.empty'); await sleep(300); await shot(page, '14-review');

  ok('no browser errors on the way', page.errs.length === 0, page.errs.slice(0, 3));

  // Cynthia never sees company items
  const cy = await phone('cynthia');
  await cy.goto(base + '/'); await cy.waitForSelector('.big .n'); await cy.click('nav [data-go="activity"]'); await cy.waitForSelector('.arow'); await sleep(300);
  ok('Cynthia does not see the company entry', (await cy.$$('.arow:has-text("OFFICE SUPPLY")')).length === 0);
  ok('AJ does see it', (await page.evaluate(() => window.HanaroEngine.view('activity', '').items.some((i) => i.payee === 'OFFICE SUPPLY'))));
  await shot(cy, '15-cynthia-activity');
  await cy.click('#addBtn'); await cy.waitForSelector('#sheet:not([hidden])'); await cy.click('#accBtn'); await cy.waitForSelector('#picker:not([hidden])');
  ok('Cynthia cannot pick the company account', (await cy.$$('#pickList [data-cat="Bank PT"]')).length === 0);

  // Small phone width
  const sm = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await sm.addInitScript((c) => { try { localStorage.setItem('hanaro.url', c.url); localStorage.setItem('hanaro.key', c.key); } catch (e) {} }, { url: base + '/exec', key: S.KEYS.aj });
  const sp = await sm.newPage(); await sp.goto(base + '/'); await sp.waitForSelector('.big .n'); await sleep(500);
  ok('no sideways scrolling at 320 px', await sp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), await sp.evaluate(() => document.documentElement.scrollWidth));
  await shot(sp, '16-small-home');
  await sp.click('#addBtn'); await sp.waitForSelector('#sheet:not([hidden])'); await sleep(300); await shot(sp, '17-small-add');
  ok('Add screen fits at 320 px', await sp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  await browser.close(); S.server.close();
  console.log(failed ? failed + ' FAILED' : 'All e2e passed'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
