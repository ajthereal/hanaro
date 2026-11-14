/**
 * Hanaro core: the sums behind the three main screens (spending, bank balances, cards).
 * Pure functions, no Google services and no browser calls, so the same file runs in Apps Script (project B),
 * on the phone (docs/core.js is built from Logic.gs + this file by tools/bundle.js) and in the Node tests.
 * Needs the helpers in Logic.gs (num_, dayOf_, countsAsSpend_, brandOf_, ...).
 */

/* ---------- accounts ---------- */

/** What kind of account a row is: 'bank' (cash side), 'card' (owed) or 'loan' (owed). Anything else is not tracked. */
function kindOf_(a) {
  var t = String((a && a.type) || '').toLowerCase();
  if (t === 'bank' || t === 'savings') return 'bank';
  if (t === 'credit card') return 'card';
  if (t === 'loan') return 'loan';
  return '';
}

function acctKey_(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

/**
 * The Accounts row a transaction's account text points to. Exact name first. Bank emails write the account as
 * "BCA ...99", so a trailing run of digits is matched to the end of a bank account's last4. "Cash" and anything
 * unknown give null, never a guess.
 */
function resolveAccount_(accounts, name) {
  var n = acctKey_(name);
  if (!n || n === 'cash') return null;
  var i, a;
  for (i = 0; i < accounts.length; i++) if (acctKey_(accounts[i].account) === n) return accounts[i];
  var m = String(name).match(/\.\.\.\s*(\d{2,4})\s*$/);
  if (m) {
    var brand = brandOf_(name);
    for (i = 0; i < accounts.length; i++) {
      a = accounts[i];
      var l4 = String(a.last4 || '');
      if (kindOf_(a) !== 'bank' || !l4 || l4.slice(-m[1].length) !== m[1]) continue;
      var ab = brandOf_(a.account);
      if (!brand || !ab || ab === brand) return a;
    }
  }
  return null;
}

/**
 * The card a card payment went to: the card typed in the app, then "Payment to X" in the payee, then the one active
 * card of that bank (the one still used for new spending breaks a tie). More than one possible card gives null,
 * and the Accounts screen says how many payments could not be assigned.
 */
function cardForPayment_(t, accounts) {
  var a = resolveAccount_(accounts, t.to_account);
  if (a && kindOf_(a) === 'card') return a;
  var m = String(t.payee || '').match(/^Payment to (.+)$/);
  if (m) { a = resolveAccount_(accounts, m[1]); if (a && kindOf_(a) === 'card') return a; }
  var brand = brandOf_(t.payee), cands = [];
  if (!brand) return null;
  accounts.forEach(function (x) { if (kindOf_(x) === 'card' && x.active !== 'N' && brandOf_(x.account) === brand) cands.push(x); });
  if (cands.length === 1) return cands[0];
  var live = cands.filter(function (x) { return String(x.allowed_for_new_spend).toUpperCase() === 'Y'; });
  return live.length === 1 ? live[0] : null;
}

/**
 * What one entry does to the balance of each account it touches: a bank balance goes up or down,
 * a card or loan "owed" amount goes up or down. Only live rows count (auto or confirmed).
 */
function effects_(t, accounts) {
  if (t.status !== 'auto' && t.status !== 'confirmed') return [];
  var amt = num_(t.idr_amount);
  if (!amt) return [];
  var out = [], from = resolveAccount_(accounts, t.account), fk = from ? kindOf_(from) : '', type = t.txn_type;
  function add(a, d) { if (a && kindOf_(a)) out.push({ account: a.account, kind: kindOf_(a), delta: d }); }
  if (type === 'purchase' || type === 'held_out') { if (from) add(from, fk === 'bank' ? -amt : amt); }
  else if (type === 'income' || type === 'held_in') { if (from) add(from, fk === 'bank' ? amt : -amt); }
  else if (type === 'transfer') {
    if (from) add(from, fk === 'bank' ? -amt : amt);
    var to = resolveAccount_(accounts, t.to_account);
    if (to) add(to, kindOf_(to) === 'bank' ? amt : -amt);
  } else if (type === 'payment') {
    if (from && fk === 'bank') add(from, -amt);
    var card = cardForPayment_(t, accounts);
    if (card) add(card, -amt);
  }
  return out;
}

/** Is this entry newer than the confirmed balance? Same day: only if it has a real time after the confirmation time. */
function afterConfirm_(t, conf) {
  var d = dayOf_(t), c = day_(conf.date_confirmed);
  if (d > c) return true;
  if (d < c) return false;
  var at = Date.parse(conf.confirmed_at || ''), ts = Date.parse(t.timestamp || '');
  return !isNaN(at) && !isNaN(ts) && !/T12:00:00[+-]\d{2}:\d{2}$/.test(String(t.timestamp)) && ts > at;
}

/**
 * Per account: the last confirmed figure, what has moved since, and the tracked figure (confirmed + moved).
 * Accounts with no confirmation are left out, never guessed. A confirmed figure for a card or loan is what is owed.
 */
function trackedAll_(accounts, balances, txns) {
  var latest = latestBalances_(balances || []), out = {};
  accounts.forEach(function (a) {
    var b = latest[a.account];
    if (!b || !kindOf_(a)) return;
    out[a.account] = { account: a.account, kind: kindOf_(a), confirmed: num_(b.confirmed_balance), date: day_(b.date_confirmed), conf: b, moved: 0, tracked: 0 };
  });
  var unassigned = 0;
  (txns || []).forEach(function (t) {
    if (t.txn_type === 'payment' && (t.status === 'auto' || t.status === 'confirmed') && !cardForPayment_(t, accounts)) unassigned++;
    effects_(t, accounts).forEach(function (e) {
      var r = out[e.account];
      if (r && afterConfirm_(t, r.conf)) r.moved += e.delta;
    });
  });
  Object.keys(out).forEach(function (k) { out[k].tracked = out[k].confirmed + out[k].moved; delete out[k].conf; });
  out._unassignedPayments = unassigned;
  return out;
}

/**
 * Clearing: the bank-email reader is Hanaro's link to the bank, the way YNAB has cleared transactions.
 * A typed entry is cleared when its bank email arrives (the two are merged into one row). Typed entries still waiting
 * for an email, on an account whose emails Hanaro reads, are "not seen at the bank yet". A bank email with no typed entry
 * is a possibly forgotten entry, and sits in Review. Returns { perAccount: {account: {count, amount, old}}, count, amount, old }.
 */
function clearing_(txns, accounts, today) {
  var reads = {}, per = {}, total = { count: 0, amount: 0, old: 0 };
  txns.forEach(function (t) {
    if (t.source !== 'email') return;
    var a = resolveAccount_(accounts, t.account);
    if (a) reads[a.account] = true;
  });
  txns.forEach(function (t) {
    if (t.source !== 'manual' || (t.status !== 'confirmed' && t.status !== 'auto')) return;
    if (t.txn_type !== 'purchase' && t.txn_type !== 'transfer' && t.txn_type !== 'payment') return;
    var a = resolveAccount_(accounts, t.account);
    if (!a || !reads[a.account]) return;
    var age = daysBetween_(dayOf_(t), today);
    if (age > 30) return;
    var p = per[a.account] = per[a.account] || { count: 0, amount: 0, old: 0 };
    p.count++; p.amount += num_(t.idr_amount);
    total.count++; total.amount += num_(t.idr_amount);
    if (age >= 2) { p.old++; total.old++; }
  });
  return { perAccount: per, count: total.count, amount: total.amount, old: total.old };
}

/**
 * Banks, cards and loans for the Accounts screen. Cards show owed, limit, available and the next due date.
 * Nothing is guessed: no confirmed figure shows as unknown, no limit shows as not set.
 */
function accountsView_(a) {
  var accounts = a.accounts || [], today = a.today, partner = a.role === 'partner', pt = ptAccounts_(accounts);
  var tr = trackedAll_(accounts, a.balances, a.txns || []), clr = clearing_(a.txns || [], accounts, today);
  var settled = settledPayNow(a.txns || []);
  var banks = [], cards = [], loans = [], cash = 0, owed = 0, limit = 0, available = 0, unknown = 0, cardsNoLimit = 0;
  accounts.forEach(function (x) {
    var k = kindOf_(x);
    if (!k || x.active === 'N' || (partner && pt[x.account])) return;
    var r = tr[x.account], isPt = x.entity === 'PT';
    var base = { account: x.account, type: x.type, entity: x.entity || '', owner: x.owner || '', confirmed: r ? r.confirmed : null, tracked: r ? r.tracked : null,
      moved: r ? r.moved : 0, date: r ? r.date : null, ageDays: r ? Math.max(0, daysBetween_(r.date, today)) : null,
      pending: (clr.perAccount[x.account] || { count: 0 }).count, pendingAmount: (clr.perAccount[x.account] || { amount: 0 }).amount, pendingOld: (clr.perAccount[x.account] || { old: 0 }).old };
    if (k === 'bank') {
      if (!r) unknown++; else if (!isPt) cash += r.tracked;
      banks.push(base);
    } else if (k === 'card') {
      var lim = has_(x.credit_limit) && num_(x.credit_limit) > 0 ? num_(x.credit_limit) : null;
      base.limit = lim; base.owed = r ? r.tracked : null;
      base.available = (lim !== null && r) ? lim - r.tracked : null;
      base.util = (lim !== null && r) ? Math.round(r.tracked / lim * 100) : null;
      base.dueDay = has_(x.due_day) && x.due_day !== '' ? Number(x.due_day) : null;
      base.due = base.dueDay ? bankDay_(nextDue_(today, base.dueDay), x.weekend || '') : null;
      base.payNow = Number(x.pay_within_days) > 0;
      var open = (a.txns || []).filter(function (t) { return liveTxn_(t) && t.account === x.account && flagsOf_(t).indexOf('pay_now') !== -1 && !settled[t.id]; });
      base.unpaidCount = open.length; base.unpaidTotal = open.reduce(function (s, t) { return s + num_(t.idr_amount); }, 0);
      if (!r) unknown++; else if (!isPt) { owed += r.tracked; if (lim !== null) { limit += lim; available += lim - r.tracked; } else cardsNoLimit++; }
      cards.push(base);
    } else {
      base.owed = r ? r.tracked : null;
      if (!r) unknown++; else if (!isPt) owed += r.tracked;
      loans.push(base);
    }
  });
  var notes = [];
  if (unknown) notes.push(unknown + ' account' + (unknown === 1 ? ' has' : 's have') + ' no confirmed figure yet, so the totals are not complete.');
  if (cardsNoLimit) notes.push(cardsNoLimit + ' card' + (cardsNoLimit === 1 ? ' has' : 's have') + ' no limit set.');
  if (tr._unassignedPayments) notes.push(tr._unassignedPayments + ' card payment' + (tr._unassignedPayments === 1 ? '' : 's') + ' could not be matched to one card. Open it and choose the card.');
  return { banks: banks, cards: cards, loans: loans, cash: cash, owed: owed, limit: limit, available: available, notes: notes,
    uncleared: { count: clr.count, amount: clr.amount, old: clr.old }, unassigned: tr._unassignedPayments || 0 };
}

/* ---------- categories and spending ---------- */

var NOT_SPEND_GROUP_ = /debt payment|income tracking|buffer|credit card payments|held for others/i;

/** Lookups from the Categories rows: the group of a category name (only when the name is unique) and which groups are not everyday spending. */
function catIndex_(cats) {
  var byName = {}, dup = {}, notSpend = {};
  (cats || []).forEach(function (c) {
    if (!c.category) return;
    if (byName[c.category] !== undefined && byName[c.category] !== c.group) dup[c.category] = true;
    byName[c.category] = c.group || '';
    if (String(c.counts).toUpperCase() === 'N' || (c.counts === undefined && NOT_SPEND_GROUP_.test(c.group || ''))) notSpend[c.group] = true;
  });
  Object.keys(dup).forEach(function (k) { byName[k] = ''; });
  return { byName: byName, notSpend: notSpend };
}

function groupOf_(t, idx) {
  if (t.category_group) return t.category_group;
  if (!t.category) return 'No category yet';
  return idx.byName[t.category] || '';
}

/** Does this entry count as everyday spending? Not company-account rows, not debt payments, buffer or income groups. */
function spendCounts_(t, ctx) {
  if (!countsAsSpend_(t) || ctx.pt[t.account]) return false;
  return !ctx.idx.notSpend[groupOf_(t, ctx.idx)];
}

function spendTotalsG_(txns, accounts, cats, today) {
  var ctx = { pt: ptAccounts_(accounts), idx: catIndex_(cats) };
  var wk = weekStart_(today), mo = today.slice(0, 7), r = { today: 0, week: 0, month: 0, todayCount: 0 };
  txns.forEach(function (t) {
    if (!spendCounts_(t, ctx)) return;
    var d = dayOf_(t), n = num_(t.idr_amount);
    if (d.slice(0, 7) === mo) r.month += n;
    if (d >= wk && d <= today) r.week += n;
    if (d === today) { r.today += n; r.todayCount++; }
  });
  r.avgPerDay = Math.round(r.month / Math.max(1, Number(today.slice(8, 10))));
  return r;
}

/**
 * Spending for one month, by category group then category, in YNAB's own groups.
 * Months before the cutover month (and before this month) come from the YNAB archive, which carries one total per
 * month, group and category. This month and later come from Hanaro's own entries. The two are never mixed in a month.
 */
function spendReport_(a) {
  var month = a.month, today = a.today, accounts = a.accounts || [];
  var ctx = { pt: ptAccounts_(accounts), idx: catIndex_(a.cats) };
  var curMonth = today.slice(0, 7), cutMonth = /^\d{4}-\d{2}/.test(String(a.cutover || '')) ? String(a.cutover).slice(0, 7) : curMonth;
  var archiveUntil = cutMonth < curMonth ? cutMonth : curMonth; // months strictly before this come from the archive
  var live = (a.txns || []).filter(function (t) { return spendCounts_(t, ctx); });
  var months = {};
  live.forEach(function (t) { months[dayOf_(t).slice(0, 7)] = true; });
  (a.archive || []).forEach(function (r) { if (r.month) months[String(r.month).slice(0, 7)] = true; });
  months[month] = true;

  function build(month) {
    var byCat = {}, other = {}, days = {}, total = 0, fromArchive = month < archiveUntil;
    function addCat(group, cat, n, count) {
      group = group || 'Other'; cat = cat || 'No category yet';
      var k = group + '|' + cat;
      byCat[k] = byCat[k] || { group: group, category: cat, amount: 0, count: 0 };
      byCat[k].amount += n; byCat[k].count += count; total += n;
    }
    if (fromArchive) {
      (a.archive || []).forEach(function (r) {
        if (String(r.month).slice(0, 7) !== month) return;
        var n = num_(r.spent), g = String(r.group || '');
        if (!n) return;
        if (ctx.idx.notSpend[g] || NOT_SPEND_GROUP_.test(g)) { other[g] = (other[g] || 0) + n; return; }
        addCat(g, r.category, n, num_(r.count));
      });
    } else {
      (a.txns || []).forEach(function (t) {
        var d = dayOf_(t);
        if (d.slice(0, 7) !== month || !countsAsSpend_(t) || ctx.pt[t.account]) return;
        var g = groupOf_(t, ctx.idx), n = num_(t.idr_amount);
        if (ctx.idx.notSpend[g]) { other[g] = (other[g] || 0) + n; return; }
        addCat(g, t.category, n, 1);
        days[d] = (days[d] || 0) + n;
      });
    }
    return { byCat: byCat, other: other, days: days, total: total, fromArchive: fromArchive };
  }

  var cur = build(month), groups = {};
  Object.keys(cur.byCat).forEach(function (k) {
    var c = cur.byCat[k];
    groups[c.group] = groups[c.group] || { group: c.group, amount: 0, categories: [] };
    groups[c.group].amount += c.amount; groups[c.group].categories.push({ category: c.category, amount: c.amount, count: c.count });
  });
  var groupList = Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (x, y) { return y.amount - x.amount; });
  groupList.forEach(function (g) { g.categories.sort(function (x, y) { return y.amount - x.amount; }); g.pct = cur.total ? Math.round(g.amount / cur.total * 100) : 0; });
  var dim = daysInMonth_(month), series = [];
  for (var i = 1; i <= dim; i++) series.push(cur.days[month + '-' + (i < 10 ? '0' : '') + i] || 0);
  var isNow = month === curMonth, upTo = isNow ? Number(today.slice(8, 10)) : dim, thisSame = 0;
  for (var j = 0; j < upTo; j++) thisSame += series[j];
  var pm = prevMonth_(month), prev = build(pm);
  var biggest = cur.fromArchive ? [] : (a.txns || []).filter(function (t) { return spendCounts_(t, ctx) && dayOf_(t).slice(0, 7) === month; })
    .sort(function (x, y) { return num_(y.idr_amount) - num_(x.idr_amount); }).slice(0, 5)
    .map(function (t) { return { id: t.id, date: dayOf_(t), payee: t.payee, category: t.category, group: groupOf_(t, ctx.idx), amount: num_(t.idr_amount) }; });
  var otherList = Object.keys(cur.other).map(function (g) { return { group: g, amount: cur.other[g] }; }).sort(function (x, y) { return y.amount - x.amount; });
  return { month: month, months: Object.keys(months).sort().reverse(), total: cur.total, groups: groupList, other: otherList, series: cur.fromArchive ? [] : series,
    avgPerDay: cur.fromArchive ? 0 : Math.round(thisSame / Math.max(1, upTo)), prevMonth: pm, prevTotal: prev.total, hasPrev: prev.total > 0,
    biggest: biggest, fromArchive: cur.fromArchive, empty: !groupList.length };
}


/** One total per month, group and category from the flat YNAB archive rows. Transfers between accounts are left out. Spent = outflow - inflow. */
function archiveMonthly_(rows) {
  var by = {}, out = [];
  (rows || []).forEach(function (r) {
    if (!r.date || String(r.transfer_account || '') !== '') return;
    var m = String(r.date).slice(0, 7), g = r.category_group || '', c = r.category || '', k = m + '|' + g + '|' + c;
    var n = num_(r.outflow) - num_(r.inflow);
    if (!by[k]) { by[k] = { month: m, group: g, category: c, spent: 0, count: 0 }; out.push(by[k]); }
    by[k].spent += n; by[k].count++;
  });
  return out;
}

/** The oldest rows first, newer than `since` (an updated_at stamp). No `since` returns everything. Rows with no stamp are always sent. */
function changedSince_(rows, since) {
  if (!since) return rows;
  return rows.filter(function (r) { return !r.updated_at || String(r.updated_at) > String(since); });
}

/* ---------- Home ---------- */

/** Everything Home shows: spent today, this week and this month, bank total, card owed and available, what needs a person. */
function homeView_(d) {
  var txns = dropMatchedManual_(d.txns || []), accounts = d.accounts || [], today = d.today;
  var sp = spendTotalsG_(txns, accounts, d.cats, today);
  var av = accountsView_({ accounts: accounts, balances: d.balances, txns: txns, today: today, role: d.role });
  var items = reviewItems(txns), settled = settledPayNow(txns);
  var owed = txns.filter(function (t) { return liveTxn_(t) && flagsOf_(t).indexOf('pay_now') !== -1 && !settled[t.id]; });
  var kinds = { confirm: 0, unread: 0, duplicate: 0, pay_now: 0 };
  items.forEach(function (i) { kinds[i.kind] = (kinds[i.kind] || 0) + 1; });
  var summary = {}; (d.summary || []).forEach(function (r) { summary[r.key] = r.value; });
  return {
    today: today, spentToday: sp.today, spentTodayCount: sp.todayCount, spentWeek: sp.week, spentMonth: sp.month, avgPerDay: sp.avgPerDay,
    cash: av.cash, owed: av.owed, limit: av.limit, available: av.available, needsBalances: av.banks.concat(av.cards).filter(function (x) { return x.confirmed === null; }).length,
    toPayCount: owed.length, toPayTotal: owed.reduce(function (s, t) { return s + num_(t.idr_amount); }, 0),
    reviewCount: items.length, reviewKinds: kinds, uncleared: av.uncleared, lastSync: summary.last_sync_ok || null
  };
}

/* ---------- lists the screens read ---------- */

function slim_(t, settled, ctx) {
  var f = flagsOf_(t);
  return {
    id: t.id, date: dayOf_(t), timestamp: t.timestamp, type: t.txn_type, amount: t.idr_amount === '' ? null : Number(t.idr_amount),
    account: t.account, toAccount: t.to_account || '', payee: t.payee, category: t.category, group: t.category_group || '', bucket: t.bucket, status: t.status, memo: t.memo, source: t.source,
    payNow: f.indexOf('pay_now') !== -1, paid: !!(settled && settled[t.id]), links: t.links_to_id || '', who: t.who || '', by: byOf_(t, ctx),
    cleared: t.source === 'email', receipt: !!t.receipt_drive_id, entity: t.entity || '', origAmount: has_(t.orig_amount) && t.orig_amount !== '' ? Number(t.orig_amount) : null, origCurrency: t.orig_currency || '', est: f.indexOf('fx_est') !== -1, ptFile: String(t.pt_file).toUpperCase() === 'Y',
    lat: has_(t.lat) && t.lat !== '' ? Number(t.lat) : null, lng: has_(t.lng) && t.lng !== '' ? Number(t.lng) : null,
    matched: f.indexOf('matched') !== -1, dateOnly: dateOnly_(t)
  };
}

function ownersCtx_(d) {
  var ctx = { pt: ptAccounts_(d.accounts), owners: {} };
  d.accounts.forEach(function (x) { ctx.owners[x.account] = x.owner; if (x.last4 && x.type === 'bank') ctx.owners['BCA ...' + x.last4] = x.owner; });
  return ctx;
}

function reviewList_(d) {
  var settled = settledPayNow(d.txns), byId = {};
  d.txns.forEach(function (t) { byId[t.id] = t; });
  return reviewItems(d.txns).slice(0, 100).map(function (i) {
    var o = { kind: i.kind, txn: slim_(i.t, settled) };
    if (i.kind === 'duplicate' && byId[i.t.links_to_id]) o.other = slim_(byId[i.t.links_to_id], settled);
    return o;
  });
}

function activityList_(d) {
  var settled = settledPayNow(d.txns), ctx = ownersCtx_(d);
  return d.txns.filter(function (t) { return t.status !== 'void'; })
    .sort(function (x, y) { return Date.parse(y.timestamp) - Date.parse(x.timestamp); }).slice(0, 150)
    .map(function (t) { return slim_(t, settled, ctx); });
}

if (typeof module !== 'undefined') {
  module.exports = { kindOf_: kindOf_, resolveAccount_: resolveAccount_, cardForPayment_: cardForPayment_, effects_: effects_, trackedAll_: trackedAll_, clearing_: clearing_,
    accountsView_: accountsView_, archiveMonthly_: archiveMonthly_, changedSince_: changedSince_, catIndex_: catIndex_, spendTotalsG_: spendTotalsG_, spendReport_: spendReport_, homeView_: homeView_, slim_: slim_, reviewList_: reviewList_, activityList_: activityList_ };
}
