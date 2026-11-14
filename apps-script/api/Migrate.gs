/**
 * One-time move to Hanaro v2 (run migrateToV2 from the Apps Script editor, after pasting the new API code).
 * - Categories become exactly the groups and categories in YNAB. The old Categories tab is kept as Categories_old.
 * - New columns are added where needed. Nothing is deleted. Every step is written to the Audit tab.
 * - Payee rules are rebuilt from the YNAB history with the new categories. The old Rules tab is kept as Rules_old.
 * - A Hanaro entry whose old category does not exist in YNAB's list loses that category and waits in Review.
 * Safe to run again: it only adds what is missing.
 */

/** Category rows from YNAB's category groups. Deleted groups and the "Inflow" master group are skipped; hidden ones stay but are not offered. */
function categoryRowsFromYnab_(groups) {
  var out = [], n = 0;
  (groups || []).forEach(function (g) {
    if (g.deleted || /^internal master category$/i.test(g.name)) return;
    (g.categories || []).forEach(function (c) {
      if (c.deleted) return;
      n++;
      out.push({ group: g.name, category: c.name, counts: NOT_SPEND_GROUP_.test(g.name) ? 'N' : 'Y', active: (g.hidden || c.hidden) ? 'N' : 'Y', sort: n, ynab_id: c.id });
    });
  });
  return out;
}

/** Payee -> group and category, from the flat archive rows. Same thresholds as the old learner: 2+ purchases, one category in 70%, trusted at 3+ and 80%. */
function rulesFromArchive_(rows, existing, cats) {
  var have = {}, known = {};
  (existing || []).forEach(function (r) { var k = ruleKey(r.match_text); if (k) have[k] = true; });
  (cats || []).forEach(function (c) { known[c.group + '|' + c.category] = true; });
  var by = {};
  rows.forEach(function (r) {
    if (!r.outflow || r.transfer_account || !r.payee || !r.category) return;
    var gk = (r.category_group || '') + '|' + r.category;
    if (cats && cats.length && !known[gk]) return;
    if (NOT_SPEND_GROUP_.test(r.category_group || '')) return;
    var k = ruleKey(r.payee);
    if (k.length < 4 || GENERIC_PAYEE_.test(k) || have[k]) return;
    var b = by[k] || (by[k] = { n: 0, c: {}, last: {} });
    b.n++; b.c[gk] = (b.c[gk] || 0) + 1;
    if (!b.last.date || r.date >= b.last.date) b.last = { date: r.date, gk: gk };
  });
  var out = [];
  Object.keys(by).sort().forEach(function (k) {
    var b = by[k];
    if (b.n < 2) return;
    var top = null;
    Object.keys(b.c).forEach(function (x) { if (top === null || b.c[x] > b.c[top] || (b.c[x] === b.c[top] && x === b.last.gk)) top = x; });
    var share = b.c[top] / b.n;
    if (share < 0.7) return;
    var parts = top.split('|');
    out.push({ match_type: 'contains', match_text: k, category: parts.slice(1).join('|'), category_group: parts[0], bucket: '', auto_confirm: (b.n >= 3 && share >= 0.8) ? 'Y' : 'N', times_used: b.n });
  });
  return out;
}

/** What to do with each Hanaro entry that has a category: keep it (and fill in its group when the name is in one group only), or send it to Review. */
function entryFixes_(txns, cats) {
  var idx = {}, dup = {};
  cats.forEach(function (c) { if (idx[c.category] !== undefined && idx[c.category] !== c.group) dup[c.category] = true; idx[c.category] = c.group; });
  var fixes = [];
  txns.forEach(function (t) {
    if (!t.category || t.status === 'void' || t.txn_type !== 'purchase') return;
    if (t.category_group) return;
    if (idx[t.category] === undefined) fixes.push({ id: t.id, _row: t._row, clear: true });
    else if (!dup[t.category]) fixes.push({ id: t.id, _row: t._row, group: idx[t.category] });
    else fixes.push({ id: t.id, _row: t._row, clear: true });
  });
  return fixes;
}

function addColumns_(book, tab, names) {
  var sh = book.getSheetByName(tab);
  if (!sh) return;
  names.forEach(function (c) { ensurePlanColumn_(sh, c); });
}

function migrateToV2() {
  var token = PropertiesService.getScriptProperties().getProperty('YNAB_TOKEN');
  if (!token) throw new Error('YNAB_TOKEN is missing. Add it in Project Settings > Script Properties, then run migrateToV2 again.');
  var book = book_(), who = NAMES.system || 'system';
  addColumns_(book, 'Transactions', ['category_group', 'to_account']);
  addColumns_(book, 'Accounts', ['credit_limit']);
  addColumns_(book, 'Balances', ['confirmed_at', 'tracked', 'difference']);

  // 1. Categories exactly as in YNAB
  var plans = ynabGet_('/budgets', token).budgets, groups = [];
  plans.forEach(function (p) { groups = groups.concat(ynabGet_('/budgets/' + p.id + '/categories', token).category_groups); });
  var rows = categoryRowsFromYnab_(groups);
  if (!rows.length) throw new Error('YNAB sent no categories, so nothing was changed.');
  var cur = book.getSheetByName('Categories'), hdr = cur ? cur.getRange(1, 1, 1, cur.getLastColumn()).getValues()[0] : [];
  if (hdr.indexOf('group') === -1) {
    if (cur) { if (book.getSheetByName('Categories_old')) throw new Error('A tab called Categories_old already exists. Rename or remove it, then run again.'); cur.setName('Categories_old'); }
    var sh = book.insertSheet('Categories');
    sh.getRange(1, 1, 1, 6).setValues([['group', 'category', 'counts', 'active', 'sort', 'ynab_id']]);
    append_(book, 'Categories', rows);
    audit_(book, who, 'migrate_categories', 'Categories', '', 'rows', '', rows.length + ' categories copied from YNAB; the old tab is Categories_old');
  }
  var cats = rows_(book, 'Categories');

  // 2. Rules rebuilt from the YNAB history
  var rsh = book.getSheetByName('Rules');
  if (rsh && rsh.getRange(1, 1, 1, rsh.getLastColumn()).getValues()[0].indexOf('category_group') === -1) {
    if (book.getSheetByName('Rules_old')) throw new Error('A tab called Rules_old already exists. Rename or remove it, then run again.');
    rsh.setName('Rules_old');
    var nr = book.insertSheet('Rules');
    nr.getRange(1, 1, 1, 8).setValues([['rule_id', 'match_type', 'match_text', 'category', 'category_group', 'bucket', 'auto_confirm', 'times_used']]);
    var arch = book.getSheetByName('Archive_YNAB') ? rows_(book, 'Archive_YNAB') : [];
    var rules = rulesFromArchive_(arch, [], cats);
    rules.forEach(function (r) { r.rule_id = 'r_' + Utilities.getUuid().replace(/-/g, '').slice(0, 8); });
    append_(book, 'Rules', rules);
    audit_(book, who, 'migrate_rules', 'Rules', '', 'rows', '', rules.length + ' payee rules rebuilt from YNAB history; the old tab is Rules_old');
  }

  // 3. Hanaro entries with an old category
  var fixes = entryFixes_(rowsTail_(book, 'Transactions', TX_WINDOW), cats);
  var tsh = book.getSheetByName('Transactions'), th = tsh.getRange(1, 1, 1, tsh.getLastColumn()).getValues()[0];
  var iCat = th.indexOf('category') + 1, iGrp = th.indexOf('category_group') + 1, iSt = th.indexOf('status') + 1, iUp = th.indexOf('updated_at') + 1, now = nowIso_(), cleared = 0, grouped = 0;
  fixes.forEach(function (f) {
    if (f.clear) { tsh.getRange(f._row, iCat).setValue(''); tsh.getRange(f._row, iGrp).setValue(''); tsh.getRange(f._row, iSt).setValue('auto'); cleared++; }
    else { tsh.getRange(f._row, iGrp).setValue(f.group); grouped++; }
    tsh.getRange(f._row, iUp).setValue(now);
  });
  audit_(book, who, 'migrate_entries', 'Transactions', '', 'rows', '', grouped + ' entries got their group, ' + cleared + ' went to Review for a new category');

  // 4. The day Hanaro's own entries replace the YNAB history in reports
  var summary = rows_(book, 'Summary').filter(function (r) { return r.key === 'cutover_date'; });
  if (!summary.length) setSummary_(book, 'cutover_date', '2026-12-01');
  bump_();
  Logger.log('Done. ' + rows.length + ' categories. ' + grouped + ' entries grouped, ' + cleared + ' sent to Review.');
}
