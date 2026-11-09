/**
 * One-time YNAB history import (add to Apps Script project B, next to Api.gs and Logic.gs).
 * Reads YNAB only. Never writes to YNAB. Safe to run again: rows already imported are skipped.
 *
 * Setup: Project Settings > Script Properties > add YNAB_TOKEN (a YNAB personal access token).
 * Run importYnab from the editor. When it says done, delete YNAB_TOKEN and revoke the token in YNAB.
 *
 * It does two jobs:
 *  1. Copies every transaction into Archive_YNAB, so history carries on.
 *  2. Learns payee -> category from that history and adds rules, so new bank emails are
 *     categorised from day one. Existing rules are never changed.
 */
var YNAB_API = 'https://api.ynab.com/v1';

function ynabGet_(path, token) {
  var res = UrlFetchApp.fetch(YNAB_API + path, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code === 401) throw new Error('YNAB rejected the token. Create a new personal access token in YNAB and paste it as YNAB_TOKEN.');
  if (code === 429) throw new Error('YNAB says too many requests. Wait an hour and run importYnab again.');
  if (code !== 200) throw new Error('YNAB returned an error (' + code + ') for ' + path + '. Run importYnab again; nothing is lost.');
  return JSON.parse(res.getContentText()).data;
}

/** Turns one YNAB plan's raw data into flat Archive_YNAB rows. Splits become one row per part. */
function flattenYnab_(planName, txns, accounts, groups) {
  var acct = {}; (accounts || []).forEach(function (a) { acct[a.id] = a.name; });
  var grp = {}; (groups || []).forEach(function (g) { (g.categories || []).forEach(function (c) { grp[c.id] = g.name; }); });
  var out = [];
  function add(id, t, amount, payee, catId, catName, memo) {
    var milli = Number(amount) || 0, idr = Math.round(milli / 1000);
    out.push({
      ynab_id: id, date: t.date, account: acct[t.account_id] || t.account_name || '',
      payee: payee || '', category_group: grp[catId] || '', category: catName || '', memo: memo || '',
      outflow: idr < 0 ? -idr : 0, inflow: idr > 0 ? idr : 0,
      transfer_account: t.transfer_account_id ? (acct[t.transfer_account_id] || 'transfer') : '',
      cleared: t.cleared || '', plan: planName
    });
  }
  (txns || []).forEach(function (t) {
    if (t.deleted) return;
    if (t.subtransactions && t.subtransactions.length) {
      t.subtransactions.forEach(function (s, i) {
        if (s.deleted) return;
        add(t.id + '#' + (i + 1), t, s.amount, s.payee_name || t.payee_name, s.category_id, s.category_name, s.memo || t.memo);
      });
    } else {
      add(t.id, t, t.amount, t.payee_name, t.category_id, t.category_name, t.memo);
    }
  });
  return out;
}

/** categories: Categories tab rows (category, bucket, ynab_categories_mapped). Returns { 'YNAB name': {category, bucket} }. */
function ynabCategoryMap_(categories) {
  var map = {};
  (categories || []).forEach(function (r) {
    String(r.ynab_categories_mapped || '').split(';').forEach(function (n) {
      n = n.trim();
      if (n) map[n] = { category: r.category, bucket: r.bucket };
    });
  });
  return map;
}

/**
 * Learns payee -> category from spending rows. A payee needs 2 or more purchases and one category
 * in at least 70% of them. 3 or more purchases and 80% makes it trusted (auto_confirm Y).
 * Payees that already have a rule are left alone. Names under 4 letters, bank or wallet names, and
 * top-ups or catch-up entries are skipped, because a 'contains' rule on them would match unrelated emails.
 * Returns rule objects ready for the Rules tab.
 */
var GENERIC_PAYEE_ = /\b(bca|bri|bni|cimb|uob|jenius|gopay|ovo|dana|top up|topup|catch up|purchases|spending|transfer|starting balance|reconcil)/;
function learnRulesFromHistory_(rows, catMap, existingRules) {
  var have = {};
  (existingRules || []).forEach(function (r) { var k = ruleKey(r.match_text); if (k) have[k] = true; });
  var by = {};
  rows.forEach(function (r) {
    if (!r.outflow || r.transfer_account || !r.payee) return;
    var m = catMap[r.category];
    if (!m || m.category === 'Debt payment' || m.category === 'Own transfer') return;
    var k = ruleKey(r.payee);
    if (k.length < 4 || GENERIC_PAYEE_.test(k) || have[k]) return;
    var b = by[k] || (by[k] = { n: 0, cats: {}, last: {} });
    b.n++;
    b.cats[m.category] = (b.cats[m.category] || 0) + 1;
    if (!b.last.date || r.date >= b.last.date) b.last = { date: r.date, category: m.category };
    b.bucket = b.bucket || {}; b.bucket[m.category] = m.bucket || '';
  });
  var out = [];
  Object.keys(by).sort().forEach(function (k) {
    var b = by[k];
    if (b.n < 2) return;
    var top = null;
    Object.keys(b.cats).forEach(function (c) {
      if (top === null || b.cats[c] > b.cats[top] || (b.cats[c] === b.cats[top] && c === b.last.category)) top = c;
    });
    var share = b.cats[top] / b.n;
    if (share < 0.7) return;
    out.push({ match_type: 'contains', match_text: k, category: top, bucket: b.bucket[top] || '',
      auto_confirm: (b.n >= 3 && share >= 0.8) ? 'Y' : 'N', times_used: b.n });
  });
  return out;
}

/** Run once from the editor. */
function importYnab() {
  var token = PropertiesService.getScriptProperties().getProperty('YNAB_TOKEN');
  if (!token) throw new Error('YNAB_TOKEN is missing. Add it in Project Settings > Script Properties, then run importYnab again.');
  var book = book_();
  var seen = {};
  rows_(book, 'Archive_YNAB').forEach(function (r) { seen[r.ynab_id] = true; });
  var stamp = nowIso_();
  var allRows = [], plans = ynabGet_('/budgets', token).budgets;
  plans.forEach(function (p) {
    var accounts = ynabGet_('/budgets/' + p.id + '/accounts', token).accounts;
    var groups = ynabGet_('/budgets/' + p.id + '/categories', token).category_groups;
    var txns = ynabGet_('/budgets/' + p.id + '/transactions', token).transactions;
    allRows = allRows.concat(flattenYnab_(p.name, txns, accounts, groups));
  });
  var fresh = allRows.filter(function (r) { return !seen[r.ynab_id]; });
  fresh.forEach(function (r) { r.imported_at = stamp; });
  fresh.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  for (var i = 0; i < fresh.length; i += 500) append_(book, 'Archive_YNAB', fresh.slice(i, i + 500));
  audit_(book, NAMES.system, 'import_ynab', 'Archive_YNAB', '', 'rows', '', fresh.length + ' new, ' + (allRows.length - fresh.length) + ' already there');

  var rules = learnRulesFromHistory_(allRows, ynabCategoryMap_(rows_(book, 'Categories')), rows_(book, 'Rules'));
  rules.forEach(function (r) { r.rule_id = 'r_' + Utilities.getUuid().replace(/-/g, '').slice(0, 8); });
  append_(book, 'Rules', rules);
  audit_(book, NAMES.system, 'learn_rules_ynab', 'Rules', '', 'rows', '', rules.length + ' payee rules added from history');
  Logger.log('Done. ' + fresh.length + ' transactions added, ' + rules.length + ' payee rules added. Now delete YNAB_TOKEN and revoke the token in YNAB.');
}

/**
 * Payee suggestions for the Add screen, from the imported YNAB history plus the learned rules.
 * One entry per place: { p: name, c: usual category, n: times }. Places seen only once are kept too, so typing a name you have used before always finds it.
 */
function buildPayeeHints_(archive, catMap, rules) {
  var by = {};
  (archive || []).forEach(function (r) {
    var name = String(r.payee || '').trim(), m = catMap[r.category];
    if (!name || !m || !(Number(r.outflow) > 0) || r.transfer_account || /^(transfer|starting balance|reconciliation)/i.test(name)) return;
    var k = ruleKey(name);
    if (k.length < 3) return;
    var b = by[k] || (by[k] = { p: name, n: 0, cats: {}, names: {} });
    b.n++; b.cats[m.category] = (b.cats[m.category] || 0) + 1; b.names[name] = (b.names[name] || 0) + 1;
  });
  var out = Object.keys(by).map(function (k) {
    var b = by[k], top = Object.keys(b.cats).sort(function (x, y) { return b.cats[y] - b.cats[x]; })[0];
    var nm = Object.keys(b.names).sort(function (x, y) { return b.names[y] - b.names[x]; })[0];
    return { p: nm, c: top, n: b.n };
  });
  var have = {}; out.forEach(function (h) { have[ruleKey(h.p)] = true; });
  (rules || []).forEach(function (r) {
    var k = ruleKey(r.match_text);
    if (!k || have[k] || !r.category) return;
    out.push({ p: k.replace(/\b\w/g, function (c) { return c.toUpperCase(); }), c: r.category, n: Number(r.times_used) || 1 });
  });
  return out.sort(function (a, b) { return b.n - a.n; }).slice(0, 1500);
}

if (typeof module !== 'undefined') {
  module.exports = { buildPayeeHints_: buildPayeeHints_, flattenYnab_: flattenYnab_, ynabCategoryMap_: ynabCategoryMap_, learnRulesFromHistory_: learnRulesFromHistory_ };
}
