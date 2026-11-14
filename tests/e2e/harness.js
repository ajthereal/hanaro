// A pretend Hanaro server for browser tests: the real Logic.gs and Api.gs run against an in-memory Sheet.
// All data is invented. Serves docs/ and answers POST /exec the way the Apps Script web app does.
const fs = require('fs'), vm = require('vm'), path = require('path'), http = require('http'), crypto = require('crypto');

function makeBook(tabs) {
  const data = {};
  Object.keys(tabs).forEach((k) => { data[k] = tabs[k].map((r) => r.slice()); });
  const sheet = (name) => ({
    getDataRange: () => ({ getValues: () => data[name].map((r) => r.slice()) }),
    getLastRow: () => data[name].length, getLastColumn: () => data[name][0].length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => { const out = []; for (let i = 0; i < (nr || 1); i++) { const row = []; for (let j = 0; j < (nc || 1); j++) row.push((data[name][r - 1 + i] || [])[c - 1 + j] ?? ''); out.push(row); } return out; },
      setValue: (v) => { while (data[name].length < r) data[name].push([]); data[name][r - 1][c - 1] = v; },
      setValues: (vals) => { vals.forEach((row, i) => { while (data[name].length < r + i) data[name].push([]); row.forEach((v, j) => { data[name][r - 1 + i][c - 1 + j] = v; }); }); }
    }),
    appendRow: (row) => { data[name].push(row); }
  });
  return { data, getSheetByName: (n) => (data[n] ? sheet(n) : null), getSpreadsheetTimeZone: () => 'Asia/Jakarta', insertSheet: (n) => { data[n] = [[]]; return sheet(n); } };
}

const TX = ['id', 'date', 'timestamp', 'txn_type', 'idr_amount', 'orig_amount', 'orig_currency', 'fx_rate', 'account', 'payee', 'category', 'bucket', 'who', 'source', 'bank_ref', 'source_message_id', 'transfer_pair_id', 'links_to_id', 'settled', 'status', 'flags', 'memo', 'receipt_drive_id', 'created_at', 'updated_at', 'lat', 'lng', 'entity', 'pt_file'];
const row = (o) => TX.map((k) => (o[k] === undefined ? '' : o[k]));

function seed() {
  const now = Date.now(), jak = (ms) => new Date(ms + 7 * 3600000).toISOString().slice(0, 19) + '+07:00', day = (ms) => jak(ms).slice(0, 10);
  const H = 3600000, D = 24 * H;
  const t = (id, ago, o) => row(Object.assign({ id, date: day(now - ago), timestamp: jak(now - ago), source: 'email', settled: 'Y', status: 'confirmed', txn_type: 'purchase' }, o));
  return {
    Transactions: [TX,
      t('t_aaaaaaaaaa01', 2 * H, { idr_amount: 86500, account: 'Card A', payee: 'WARUNG BAKSO', category: 'Eating out', bucket: 'Food', status: 'confirmed' }),
      t('t_aaaaaaaaaa02', 3 * H, { idr_amount: 214830, account: 'Card A', payee: 'SIR GREEK', status: 'auto', flags: 'pay_now' }),
      t('t_aaaaaaaaaa03', 1 * D, { idr_amount: 450000, account: 'Bank A', payee: 'ALFAMART', category: 'Groceries', bucket: 'Food' }),
      t('t_aaaaaaaaaa04', 2 * D, { idr_amount: 1200000, account: 'Bank A', payee: 'PLN PREPAID', category: 'Utilities', bucket: 'Home' }),
      t('t_aaaaaaaaaa05', 3 * D, { idr_amount: 5000000, account: 'Bank A', payee: 'TRANSFER TO BANK B', txn_type: 'transfer', status: 'auto' }),
      t('t_aaaaaaaaaa06', 4 * D, { idr_amount: 15000000, account: 'Bank A', payee: 'ACME PAYROLL', txn_type: 'income', category: 'Income' }),
      t('t_aaaaaaaaaa07', 5 * D, { idr_amount: 77000, account: 'Bank PT', payee: 'OFFICE SUPPLY', category: 'Operational Office', bucket: 'Business', entity: 'Business' }),
      t('t_aaaaaaaaaa08', 6 * D, { idr_amount: 38000, account: 'Bank A', payee: 'COFFEE SHOP', category: 'Eating out', bucket: 'Food', source: 'manual', who: 'AJ' }),
      t('t_aaaaaaaaaa09', 1 * H, { idr_amount: '', account: '', payee: 'Unreadable bank notice', status: 'needs_review', txn_type: '', memo: 'Could not read this email: no amount found' })
    ],
    Categories: [['category', 'bucket', 'counts_in_bucket', 'ynab_categories_mapped', 'active'], ['Eating out', 'Food', 'Y', '', 'Y'], ['Groceries', 'Food', 'Y', '', 'Y'], ['Utilities', 'Home', 'Y', '', 'Y'], ['Fuel', 'Car', 'Y', '', 'Y'], ['Operational Office', 'Business', 'Y', '', 'Y'], ['Own transfer', '', 'Y', '', 'Y'], ['Income', '', 'Y', '', 'Y'], ['Held: Customer order', '', 'HELD', '', 'Y']],
    Rules: [['rule_id', 'match_type', 'match_text', 'category', 'bucket', 'auto_confirm', 'times_used']],
    Audit: [['timestamp', 'who', 'action', 'tab', 'row_id', 'field', 'before', 'after']],
    Log: [['timestamp', 'component', 'level', 'message', 'detail']],
    Summary: [['key', 'value', 'updated_at'], ['last_sync_ok', jak(now - 20 * 60000), ''], ['last_backup_ok', jak(now - 9 * H), '']],
    Accounts: [['account', 'type', 'entity', 'owner', 'last4', 'active', 'allowed_for_new_spend', 'carries_balance', 'pay_within_days'],
      ['Card A', 'credit card', 'Household', 'AJ', '1111', 'Y', 'N', 'Y', 1], ['Bank A', 'bank', 'Household', 'AJ', '2222', 'Y', 'Y', '', ''], ['Bank B', 'bank', 'Household', 'Cynthia', '3333', 'Y', 'Y', '', ''], ['Bank PT', 'bank', 'PT', 'AJ', '4444', 'Y', 'Y', '', '']],
    Buckets: [['bucket', 'month', 'cap_idr', 'owner', 'set_by']],
    Balances: [['date_confirmed', 'account', 'confirmed_balance', 'method', 'entered_by'], [day(now - 5 * D), 'Bank A', 12000000, 'manual', 'AJ'], [day(now - 1 * D), 'Bank B', 3500000, 'manual', 'Cynthia']],
    Bills: [['bill', 'amount_idr', 'due_day', 'active', 'last_paid']],
    Debts: [['debt', 'entity', 'minimum', 'due_day', 'balance_idr', 'effective_rate_annual', 'weekend'], ['Loan X', 'Household', 500000, 16, 8000000, 0.12, 'before'], ['Card Y', 'Household', 100000, 20, 1500000, 0.36, '']],
    Inbox_Raw: [['message_id', 'received_at', 'sender', 'subject', 'parser', 'parse_status', 'parse_error', 'processed_at', 'transaction_id'], ['m1', jak(now - 20 * 60000), 'bca@bca.co.id', 'x', 'bca', 'parsed', '', '', 't_aaaaaaaaaa01']],
    Plan: [['month', 'item', 'kind', 'amount_idr', 'due_day', 'target_idr', 'every_months', 'category', 'active', 'set_by', 'match', 'weekend'],
      [day(now).slice(0, 7), 'Rent', 'fixed', 9000000, 1, '', '', '', 'Y', 'AJ', 'landlord', 'before'], [day(now).slice(0, 7), 'Flexible', 'flexible', 6000000, '', '', '', '', 'Y', 'AJ', '', '']]
  };
}

function createServer(opts) {
  opts = opts || {};
  const book = makeBook(seed()), props = {}, cacheData = {}, files = [];
  const sb = {
    console, Date, JSON, Math, Object, Number, String, isNaN, Array,
    Utilities: {
      formatDate: (d, tz, f) => { const x = new Date(d.getTime() + 7 * 3600000).toISOString(); return f.indexOf('HH') !== -1 ? x.slice(0, 19) + '+07:00' : f === 'yyyy-MM' ? x.slice(0, 7) : x.slice(0, 10); },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      base64Decode: (s) => Buffer.from(s, 'base64'), newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }
    },
    SpreadsheetApp: { openById: () => book },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (k in cacheData ? cacheData[k] : null), put: (k, v) => { cacheData[k] = String(v); }, remove: (k) => { delete cacheData[k]; }, putAll: (o) => { Object.keys(o).forEach((k) => { cacheData[k] = String(o[k]); }); }, getAll: (ks) => { const o = {}; ks.forEach((k) => { if (k in cacheData) o[k] = cacheData[k]; }); return o; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ text: s, setMimeType() { return this; } }) },
    DriveApp: { getFoldersByName: () => ({ hasNext: () => true, next: () => { const put = (b) => { files.push(b); return { getId: () => 'file_' + files.length }; }; const inbox = { createFile: put }; return { createFile: put, getFoldersByName: (n) => ({ hasNext: () => n === '_Inbox', next: () => inbox }), createFolder: () => inbox }; } }) },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 500, getContentText: () => '' }) },
    ScriptApp: {}
  };
  vm.createContext(sb);
  const codeDir = opts.codeDir || path.join(__dirname, '../../apps-script/api');
  ['Logic.gs', 'Core.gs', 'Api.gs', 'YnabImport.gs', 'Migrate.gs'].forEach((f) => { if (fs.existsSync(path.join(codeDir, f))) vm.runInContext(fs.readFileSync(path.join(codeDir, f), 'utf8'), sb, { filename: f }); }); // Core.gs is missing in the old server code
  const KEYS = { aj: 'aj_test_key_' + 'a'.repeat(30), cynthia: 'cynthia_test_key_' + 'b'.repeat(26) };
  Object.keys(KEYS).forEach((who) => { props['HASH_' + who] = vm.runInContext('sha_(' + JSON.stringify(KEYS[who]) + ')', sb); });
  const log = { posts: [] };
  const docs = path.join(__dirname, '../../docs');
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/exec')) {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = {}; try { parsed = JSON.parse(body); } catch (e) {}
        log.posts.push({ action: parsed.action, id: parsed.id, ops: parsed.ops && parsed.ops.length });
        const delay = typeof opts.delay === 'function' ? opts.delay(parsed) : 0;
        setTimeout(() => {
          sb.__post = { postData: { contents: body } };
          const out = vm.runInContext('doPost(__post)', sb);
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out.text);
        }, delay);
      });
      return;
    }
    let f = req.url.split('?')[0]; if (f === '/') f = '/index.html';
    const full = path.join(docs, f);
    if (!full.startsWith(docs) || !fs.existsSync(full)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(full)] || 'application/octet-stream' }); res.end(fs.readFileSync(full));
  });
  return { server, book, KEYS, log, files, sb };
}
module.exports = { createServer, TX };
