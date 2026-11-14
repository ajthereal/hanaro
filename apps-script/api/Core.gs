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
function emailAccounts_(txns, accounts) {
  var reads = {};
  txns.forEach(function (t) {
    if (t.source !== 'email') return;
    var a = resolveAccount_(accounts, t.account);
    if (a) reads[a.account] = true;
  });
  return reads;
}

/** Is this typed entry still waiting for its bank email? Only on accounts whose emails Hanaro reads, for entries up to 30 days old. */
function waitingForBank_(t, accounts, reads, today) {
  if (t.source !== 'manual' || (t.status !== 'confirmed' && t.status !== 'auto')) return false;
  if (t.txn_type !== 'purchase' && t.txn_type !== 'transfer' && t.txn_type !== 'payment') return false;
  var a = resolveAccount_(accounts, t.account);
  return !!(a && reads[a.account] && daysBetween_(dayOf_(t), today) <= 30);
}

function clearing_(txns, accounts, today) {
  var reads = emailAccounts_(txns, accounts), per = {}, total = { count: 0, amount: 0, old: 0 };
  txns.forEach(function (t) {
    if (!waitingForBank_(t, accounts, reads, today)) return;
    var a = resolveAccount_(accounts, t.account);
    var age = daysBetween_(dayOf_(t), today);
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
  var settled = settledPayNow(d.txns), ctx = ownersCtx_(d), reads = emailAccounts_(d.txns, d.accounts || []);
  return d.txns.filter(function (t) { return t.status !== 'void'; })
    .sort(function (x, y) { return Date.parse(y.timestamp) - Date.parse(x.timestamp); }).slice(0, 150)
    .map(function (t) { var o = slim_(t, settled, ctx); o.waiting = d.today ? waitingForBank_(t, d.accounts || [], reads, d.today) : false; return o; });
}

/* ---------- Budget (v3): the ladder, categories, moves and the debt snowball ---------- */
/*
 * Money flow: a transfer from a company (PT) account to a personal account, and any income entry into a personal account,
 * is budget income. Every income runs down a ladder and fills the plan top to bottom:
 *   1 Four Walls, 2 bills and minimums, 3 card overspend, 4 everyday, 5 starter emergency fund, 6 debt snowball
 * (after the last consumer debt: full emergency fund, then wealth). Left over money goes to next month's steps 1, 2 and 4
 * before steps 5 and 6. A category's Left = carried in + funded + moved - spent. A positive Left carries over; a negative Left
 * becomes card overspend (step 3) next month and the category starts at 0.
 * Everything here is pure: the same code runs in Apps Script, in the tests and on the phone.
 */

var BUDGET_TABS_ = {
  Budget: ['month', 'item', 'kind', 'amount_idr', 'due_day', 'weekend', 'walls', 'match', 'active', 'set_by', 'at'],
  BudgetMoves: ['id', 'date', 'month', 'from', 'to', 'amount_idr', 'memo', 'set_by', 'at'],
  BudgetSettings: ['key', 'value', 'set_by', 'at'],
  DebtOrder: ['at', 'order', 'set_by']
};
var BUDGET_V_ = 1;
var STEP_NAMES_ = { 1: 'Four Walls', 2: 'Bills and minimums', 3: 'Card overspend', 4: 'Everyday', 5: 'Emergency fund', 6: 'Debt snowball' };

function ymOf_(s) { return String(s || '').slice(0, 7); }
function nextMonth_(ym) {
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) + 1;
  if (m > 12) { m = 1; y++; }
  return y + '-' + (m < 10 ? '0' : '') + m;
}
function monthsBetween_(a, b) {
  var out = [], m = a, guard = 0;
  while (m <= b && guard++ < 80) { out.push(m); m = nextMonth_(m); }
  return out;
}
function monthsBack_(ym, n) { var m = ym; for (var i = 0; i < n; i++) m = prevMonth_(m); return m; }
function lastDayOf_(ym) { return ym + '-' + daysInMonth_(ym); }

/**
 * Fills a list of slots, in the order given, from a list of incomes taken in date order.
 * slots: [{ id, step, need }] (need null means no limit). incomes: [{ id, date, amount }].
 * Returns { funded: {slotId: amount}, alloc: [{ income, slot, step, amount }], leftover, unspent: {incomeId: amount} }.
 * Each income runs down the whole list before the next income starts, so a partly funded slot is topped up by the next income.
 */
function fillLadder_(slots, incomes) {
  var rem = {}, funded = {}, alloc = [], leftover = 0, unspent = {};
  slots.forEach(function (s) { rem[s.id] = (s.need === null || s.need === undefined) ? Infinity : Math.max(0, num_(s.need)); funded[s.id] = 0; });
  incomes.slice().sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  }).forEach(function (inc) {
    var money = Math.max(0, num_(inc.amount));
    for (var i = 0; i < slots.length && money > 0; i++) {
      var s = slots[i], give = Math.min(money, rem[s.id]);
      if (give <= 0) continue;
      rem[s.id] -= give; funded[s.id] += give; money -= give;
      alloc.push({ income: inc.id, slot: s.id, step: s.step, amount: give });
    }
    unspent[inc.id] = money; leftover += money;
  });
  return { funded: funded, alloc: alloc, leftover: leftover, unspent: unspent };
}

/* ----- reading the budget rows ----- */

function budgetSettings_(rows) {
  var s = { starter_target: 0, full_target: 0, buffer_account: '', last_month: false, lastMonthFrom: '', reviewed: '' };
  (rows || []).forEach(function (r) {
    var k = String(r.key), v = r.value;
    if (k === 'starter_target') s.starter_target = Math.max(0, num_(v));
    else if (k === 'full_target') s.full_target = Math.max(0, num_(v));
    else if (k === 'buffer_account') s.buffer_account = String(v === undefined || v === null ? '' : v);
    else if (k === 'last_month') { var on = String(v).toUpperCase() === 'Y'; s.last_month = on; s.lastMonthFrom = on ? ymOf_(r.at) : ''; }
    else if (k === 'reviewed') s.reviewed = ymOf_(v);
  });
  return s;
}

/** Latest target row per category effective in or before the month (a later row of the same month wins). Removed ones are kept so they can be told from never set. */
function budgetTargets_(rows, month) {
  var best = {};
  (rows || []).forEach(function (r) {
    if (String(r.kind) !== 'target' || !r.item) return;
    var m = ymOf_(r.month);
    if (m > month) return;
    var cur = best[r.item];
    if (!cur || m >= ymOf_(cur.month)) best[r.item] = r;
  });
  return best;
}
function activeTarget_(r) { return !!r && String(r.active).toUpperCase() !== 'N' && num_(r.amount_idr) > 0; }
function budgetWalls_(rows) {
  var w = {};
  (rows || []).forEach(function (r) { if (String(r.kind) === 'walls' && r.item) w[r.item] = String(r.walls).toUpperCase() === 'Y'; });
  return w;
}

/** The old Plan tab, read as targets until a category has a target of its own: fixed bills are step 2 bills, non-monthly items are set-asides. Flexible is dropped. */
function legacyTargets_(plan, month, explicit) {
  var out = {};
  planLatest_(plan || [], month).forEach(function (r) {
    var cat = String(r.category || r.item || ''), amt = 0, due = null;
    if (!cat || explicit[cat]) return;
    if (r.kind === 'fixed' && num_(r.amount_idr) > 0) { amt = num_(r.amount_idr); due = has_(r.due_day) && r.due_day !== '' ? Number(r.due_day) : null; }
    else if (r.kind === 'nonmonthly' && num_(r.target_idr) > 0) amt = Math.ceil(num_(r.target_idr) / Math.max(1, num_(r.every_months) || 12));
    else return;
    if (out[cat]) { out[cat].amount += amt; if (out[cat].dueDay === null) out[cat].dueDay = due; return; }
    out[cat] = { category: cat, amount: amt, dueDay: due, weekend: String(r.weekend || ''), match: String(r.match || ''), legacy: true };
  });
  return out;
}

/** What each category is set to for a month: { category: { category, amount, dueDay, weekend, match, legacy } }. */
function monthTargets_(d, month) {
  var ex = budgetTargets_(d.budget, month), out = {};
  Object.keys(ex).forEach(function (k) {
    if (!activeTarget_(ex[k])) return;
    var r = ex[k];
    out[k] = { category: k, amount: num_(r.amount_idr), dueDay: has_(r.due_day) && r.due_day !== '' ? Number(r.due_day) : null, weekend: String(r.weekend || ''), match: '', legacy: false };
  });
  var lg = legacyTargets_(d.plan, month, ex);
  Object.keys(lg).forEach(function (k) { out[k] = lg[k]; });
  return out;
}

/** The first month that has a target (or an old plan item), or '' when there is no budget yet. Capped at a year back. */
function budgetStart_(d, cur) {
  var m = '';
  (d.budget || []).forEach(function (r) { if (String(r.kind) === 'target' && activeTarget_(r)) { var x = ymOf_(r.month); if (!m || x < m) m = x; } });
  (d.plan || []).forEach(function (r) {
    if ((r.kind === 'fixed' || r.kind === 'nonmonthly') && String(r.active).toUpperCase() !== 'N') { var x = ymOf_(r.month); if (x && (!m || x < m)) m = x; }
  });
  if (!m) return '';
  var floor = monthsBack_(cur, 11);
  if (m < floor) m = floor;
  return m < cur ? m : cur;
}

/* ----- income, spending, debts ----- */

/**
 * Budget income: a transfer from a PT account to a personal bank account, and any income entry into a personal bank account.
 * Money held for others is never income. An income entry for the same amount within 3 days of a PT transfer into the same
 * account is the same money seen from the other side and counts once. `extra` carries PT transfers that a partner's phone
 * cannot see (the server sends them without any account name). Returns rows in date order.
 */
function budgetIncomes_(txns, accounts, extra) {
  var pt = ptAccounts_(accounts), skip = {}, tr = [], inc = [], out = [], used = {};
  findMatches_(txns || []).forEach(function (p) { skip[p.email.id] = true; });
  (txns || []).forEach(function (t) {
    if (skip[t.id] || (t.status !== 'auto' && t.status !== 'confirmed')) return;
    var amt = num_(t.idr_amount);
    if (amt <= 0) return;
    if (t.txn_type === 'transfer') {
      if (!pt[t.account]) return;
      var to = resolveAccount_(accounts, t.to_account);
      if (!to || kindOf_(to) !== 'bank' || pt[to.account]) return;
      if (String(t.category || '').indexOf('Held:') === 0) return;
      tr.push({ id: t.id, date: dayOf_(t), amount: amt, from: t.account, to: to.account, source: 'transfer' });
    } else if (t.txn_type === 'income') {
      var a = resolveAccount_(accounts, t.account);
      if (!a || kindOf_(a) !== 'bank' || pt[a.account]) return;
      inc.push({ id: t.id, date: dayOf_(t), amount: amt, from: t.payee || '', to: a.account, source: 'income' });
    }
  });
  (extra || []).forEach(function (e) {
    if (num_(e.amount) > 0) tr.push({ id: e.id, date: day_(e.date), amount: num_(e.amount), from: 'Company account', to: e.to || '', source: 'transfer' });
  });
  inc.forEach(function (i) {
    var twin = null;
    for (var k = 0; k < tr.length; k++) {
      var x = tr[k];
      if (used[x.id] || x.amount !== i.amount || Math.abs(daysBetween_(x.date, i.date)) > 3 || (x.to && i.to && x.to !== i.to)) continue;
      twin = x; break;
    }
    if (twin) used[twin.id] = true; else out.push(i);
  });
  out = out.concat(tr);
  out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  return out;
}

/** Day by day change of every account's balance: { account: [{ day, delta }] }. */
function deltasByAccount_(txns, accounts) {
  var m = {};
  (txns || []).forEach(function (t) {
    var day = dayOf_(t);
    effects_(t, accounts).forEach(function (e) { (m[e.account] = m[e.account] || []).push({ day: day, delta: e.delta }); });
  });
  return m;
}
function sumDeltas_(list, from, to) {
  var s = 0;
  (list || []).forEach(function (x) { if ((!from || x.day >= from) && (!to || x.day <= to)) s += x.delta; });
  return s;
}

/** Payments made toward each card or loan in a month (card payments and transfers to the debt). { account: amount } */
function debtPaid_(txns, accounts, month) {
  var out = {};
  (txns || []).forEach(function (t) {
    if ((t.status !== 'auto' && t.status !== 'confirmed') || ymOf_(dayOf_(t)) !== month) return;
    var a = null;
    if (t.txn_type === 'payment') a = cardForPayment_(t, accounts);
    else if (t.txn_type === 'transfer') { a = resolveAccount_(accounts, t.to_account); if (a && kindOf_(a) === 'bank') a = null; }
    if (a) out[a.account] = (out[a.account] || 0) + num_(t.idr_amount);
  });
  return out;
}

/**
 * Every non-company card, loan and Debts-tab debt: its tracked balance now, its minimum and due day, and the day by day changes
 * so the balance at the start of any month can be worked out. A card's balance at the start of a month is what was carried in,
 * not this month's new spending (that is paid out of the category it was spent in).
 */
function debtBase_(d) {
  var accounts = d.accounts || [], txns = d.txns || [], tr = trackedAll_(accounts, d.balances, txns), dl = deltasByAccount_(txns, accounts);
  var byName = {}, latest = {}, out = [], seen = {};
  (d.debts || []).forEach(function (r) { if (r.debt) byName[acctKey_(r.debt)] = r; });
  (d.debtBal || []).forEach(function (r) {
    if (!r.debt || !has_(r.balance_idr)) return;
    var c = latest[acctKey_(r.debt)];
    if (!c || String(r.date_confirmed) >= String(c.date_confirmed)) latest[acctKey_(r.debt)] = r;
  });
  accounts.forEach(function (x) {
    var k = kindOf_(x);
    if ((k !== 'card' && k !== 'loan') || x.active === 'N' || x.entity === 'PT') return;
    var key = acctKey_(x.account), dr = byName[key] || null, r = tr[x.account];
    seen[key] = true;
    var min = has_(x.minimum) && x.minimum !== '' ? num_(x.minimum) : (dr && has_(dr.minimum) ? num_(dr.minimum) : 0);
    var due = has_(x.due_day) && x.due_day !== '' ? Number(x.due_day) : (dr && has_(dr.due_day) && dr.due_day !== '' ? Number(dr.due_day) : null);
    out.push({ name: x.account, kind: k, tracked: r ? r.tracked : null, minimum: min, dueDay: due, weekend: String((dr && dr.weekend) || x.weekend || ''),
      rate: dr && has_(dr.effective_rate_annual) ? rate_(dr.effective_rate_annual) : null, deltas: dl[x.account] || [], extra: false });
  });
  (d.debts || []).forEach(function (r) {
    var key = acctKey_(r.debt);
    if (!r.debt || seen[key] || String(r.entity) === 'PT') return;
    var lb = latest[key], bal = lb ? num_(lb.balance_idr) : (has_(r.balance_idr) ? num_(r.balance_idr) : null);
    out.push({ name: r.debt, kind: 'loan', tracked: bal, minimum: has_(r.minimum) ? num_(r.minimum) : 0, dueDay: has_(r.due_day) && r.due_day !== '' ? Number(r.due_day) : null,
      weekend: String(r.weekend || ''), rate: has_(r.effective_rate_annual) ? rate_(r.effective_rate_annual) : null, deltas: [], extra: true });
  });
  return out;
}

/** Snowball order: debts the owner pinned first (in his order), then smallest balance first. Paid off and unknown balances last. */
function orderDebts_(list, pinned) {
  var pos = {};
  (pinned || []).forEach(function (n, i) { if (pos[acctKey_(n)] === undefined) pos[acctKey_(n)] = i; });
  return list.slice().sort(function (a, b) {
    var ra = a.balance === null ? 2 : a.balance === 0 ? 1 : 0, rb = b.balance === null ? 2 : b.balance === 0 ? 1 : 0;
    if (ra !== rb) return ra - rb;
    var pa = pos[acctKey_(a.name)], pb = pos[acctKey_(b.name)];
    if (pa !== undefined || pb !== undefined) { if (pa === undefined) return 1; if (pb === undefined) return -1; return pa - pb; }
    if (a.balance !== b.balance) return (a.balance || 0) - (b.balance || 0);
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}
function latestDebtOrder_(rows) {
  var last = null;
  (rows || []).forEach(function (r) { last = r; });
  if (!last) return [];
  try { var o = JSON.parse(last.order); return Array.isArray(o) ? o.map(String) : []; } catch (e) { return []; }
}

/** The debts as they stand at the start of a month (or now), in snowball order. */
function debtsAt_(base, month, pinned, nowMonth) {
  var list = base.map(function (b) {
    var bal = b.tracked === null ? null : Math.max(0, b.tracked - (month >= nowMonth && b.extra ? 0 : sumDeltas_(b.deltas, month + '-01', '')));
    return { name: b.name, kind: b.kind, balance: bal, owed: b.tracked === null ? null : Math.max(0, b.tracked), minimum: b.minimum, dueDay: b.dueDay, weekend: b.weekend, rate: b.rate };
  });
  return orderDebts_(list, pinned);
}

/* ----- the month by month run ----- */

function catOrderOf_(cats) {
  var o = {}, list = (cats || []).map(function (c, i) { return { c: c, i: i }; });
  list.sort(function (a, b) { return (Number(a.c.sort || 0) - Number(b.c.sort || 0)) || (a.i - b.i); });
  list.forEach(function (x, n) { if (x.c.category && o[x.c.category] === undefined) o[x.c.category] = n; });
  return o;
}
function dueOf_(month, dueDay, weekend) {
  if (dueDay === null || dueDay === undefined || dueDay === '') return null;
  return bankDay_(dueIn_(Number(month.slice(0, 4)), Number(month.slice(5, 7)), dueDay), weekend || '');
}

/** The ladder for every month from the first budget month to next month. Returns { months: {ym: result}, ... }, see budgetView_. */
function budgetRun_(d) {
  var today = d.today, cur = ymOf_(today), nxt = nextMonth_(cur), accounts = d.accounts || [], txns = d.txns || [];
  var settings = budgetSettings_(d.bset), start = budgetStart_(d, cur), ready = !!start;
  if (!start) start = cur;
  var months = monthsBetween_(start, nxt), walls = budgetWalls_(d.budget), order = catOrderOf_(d.cats);
  var ctx = { pt: ptAccounts_(accounts), idx: catIndex_(d.cats) };
  var incomes = budgetIncomes_(d.rawTxns || txns, accounts, d.ptIncomes), pinned = latestDebtOrder_(d.dorder);
  var base = debtBase_({ accounts: accounts, balances: d.balances, txns: txns, debts: d.debts, debtBal: d.debtBal });
  var dl = deltasByAccount_(txns, accounts), buf = acctKey_(settings.buffer_account) ? resolveAccount_(accounts, settings.buffer_account) : null;
  var tr = trackedAll_(accounts, d.balances, txns), bufNow = buf && tr[buf.account] ? tr[buf.account].tracked : 0, bufD = buf ? (dl[buf.account] || []) : [];
  var spent = {};
  txns.forEach(function (t) {
    if (!spendCounts_(t, ctx)) return;
    var m = ymOf_(dayOf_(t)), c = t.category || '';
    if (!c) return;
    (spent[m] = spent[m] || {})[c] = (spent[m][c] || 0) + num_(t.idr_amount);
  });
  var movesBy = {};
  (d.moves || []).forEach(function (r) {
    var m = ymOf_(r.month || r.date), a = num_(r.amount_idr);
    if (!r.from || !r.to || a <= 0) return;
    (movesBy[m] = movesBy[m] || []).push({ from: String(r.from), to: String(r.to), amount: a });
  });
  function fundMonth(inc) {
    var m = ymOf_(inc.date);
    return settings.last_month && settings.lastMonthFrom && m >= settings.lastMonthFrom ? nextMonth_(m) : m;
  }
  var incByFund = {};
  incomes.forEach(function (i) { var f = fundMonth(i); (incByFund[f] = incByFund[f] || []).push(i); });

  var st = { carry: {}, over: 0, prefund: {}, emg: 0 }, res = {}, incAlloc = {};
  incomes.forEach(function (i) { incAlloc[i.id] = { income: i, fundMonth: fundMonth(i), parts: [], unallocated: 0 }; });

  /** Slots and lines for one month. only124: just steps 1, 2 and 4 (next month's share of an income). */
  function build(M, only124) {
    var targets = monthTargets_(d, M), lines = {}, slots = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }, pre = st.prefund[M] || {};
    function mk(key, o) {
      var l = Object.assign({ key: key, kind: 'cat', name: '', group: '', step: 4, target: 0, funded: pre[key] || 0, carryIn: 0, moved: 0, spent: 0, left: 0, paid: 0, dueDay: null, due: null, legacy: false, walls: false }, o);
      lines[key] = l; return l;
    }
    function catLine(c) {
      var k = 'cat:' + c;
      if (lines[k]) return lines[k];
      var t = targets[c], w = !!walls[c];
      return mk(k, { name: c, group: ctx.idx.byName[c] || '', step: w ? 1 : (t && t.dueDay !== null ? 2 : 4), target: t ? t.amount : 0, dueDay: t ? t.dueDay : null,
        due: t ? dueOf_(M, t.dueDay, t.weekend) : null, legacy: !!(t && t.legacy), walls: w, carryIn: st.carry[c] || 0, spent: ((spent[M] || {})[c]) || 0 });
    }
    Object.keys(targets).forEach(catLine);
    Object.keys(st.carry).forEach(function (c) { if (st.carry[c] > 0) catLine(c); });
    var cl = Object.keys(lines).map(function (k) { return lines[k]; }).sort(function (a, b) {
      var oa = order[a.name] === undefined ? 1e6 : order[a.name], ob = order[b.name] === undefined ? 1e6 : order[b.name];
      return oa - ob || (a.name < b.name ? -1 : 1);
    });
    var debts = debtsAt_(base, M, pinned, cur);
    var allClear = debts.length > 0 ? debts.every(function (x) { return x.balance === 0; }) : true;
    var mins = [];
    debts.forEach(function (x) {
      if (x.minimum <= 0 || x.balance === 0) return;
      var l = mk('min:' + x.name, { kind: 'min', name: x.name, group: 'Minimum payments', step: 2, target: x.balance === null ? x.minimum : Math.min(x.minimum, x.balance), dueDay: x.dueDay, due: dueOf_(M, x.dueDay, x.weekend), balance: x.balance });
      mins.push(l);
    });
    function slot(l, step) { slots[step].push({ id: M + '|' + l.key, step: step, need: Math.max(0, l.target - (pre[l.key] || 0)), key: l.key, line: l }); }
    cl.filter(function (l) { return l.step === 1 && l.target > 0; }).forEach(function (l) { slot(l, 1); });
    var bills = cl.filter(function (l) { return l.step === 2 && l.target > 0; }).concat(mins);
    bills.sort(function (a, b) { var da = a.due || '9999', db = b.due || '9999'; return da < db ? -1 : da > db ? 1 : 0; });
    bills.forEach(function (l) { slot(l, 2); });
    if (!only124) {
      var o3 = mk('over', { kind: 'over', name: 'Card overspend from earlier months', step: 3, target: st.over });
      if (o3.target > 0) slot(o3, 3); else delete lines.over;
    }
    cl.filter(function (l) { return l.step === 4 && l.target > 0; }).forEach(function (l) { slot(l, 4); });
    if (only124) return { lines: lines, slots: slots, debts: debts, allClear: allClear };
    var held = (buf ? Math.max(0, bufNow - sumDeltas_(bufD, nextMonth_(M) + '-01', '')) : 0) + st.emg;
    if (settings.starter_target > 0) {
      var e = mk('emg', { kind: 'emg', name: 'Emergency fund', group: 'Savings', step: 5, target: Math.max(0, settings.starter_target - held), balance: held, goal: settings.starter_target });
      slot(e, 5);
    }
    if (!allClear) {
      var left = true;
      debts.forEach(function (x) {
        if (x.balance === null || x.balance === 0) return;
        var l = mk('debt:' + x.name, { kind: 'debt', name: x.name, group: 'Debts', step: 6, target: Math.max(0, x.balance - (x.minimum > 0 ? Math.min(x.minimum, x.balance) : 0)), balance: x.balance, minimum: x.minimum, focus: false });
        if (left && x.balance > 0) { l.focus = true; left = false; }
        slot(l, 6);
      });
    } else {
      if (settings.full_target > 0) {
        var starterNeed = settings.starter_target > 0 ? Math.max(0, settings.starter_target - held) : 0;
        var f = mk('full', { kind: 'full', name: 'Full emergency fund', group: 'Savings', step: 6, target: Math.max(0, settings.full_target - held - starterNeed), balance: held, goal: settings.full_target });
        slot(f, 6);
      }
      slot(mk('wealth', { kind: 'wealth', name: 'Wealth', group: 'Savings', step: 6, target: 0 }), 6);
      slots[6][slots[6].length - 1].need = null;
    }
    return { lines: lines, slots: slots, debts: debts, allClear: allClear };
  }

  months.forEach(function (M) {
    var NM = nextMonth_(M), cur1 = build(M, false), nextB = settings.last_month && settings.lastMonthFrom ? null : build(NM, true);
    var ladder = [];
    [1, 2, 3, 4].forEach(function (s) { ladder = ladder.concat(cur1.slots[s]); });
    if (nextB) [1, 2, 4].forEach(function (s) { ladder = ladder.concat(nextB.slots[s]); });
    [5, 6].forEach(function (s) { ladder = ladder.concat(cur1.slots[s]); });
    var fill = fillLadder_(ladder, incByFund[M] || []), slotById = {};
    ladder.forEach(function (s) { slotById[s.id] = s; });
    Object.keys(cur1.lines).forEach(function (k) { var f = fill.funded[M + '|' + k]; if (f) cur1.lines[k].funded += f; });
    if (nextB) {
      st.prefund[NM] = st.prefund[NM] || {};
      Object.keys(nextB.lines).forEach(function (k) { var f = fill.funded[NM + '|' + k]; if (f) st.prefund[NM][k] = (st.prefund[NM][k] || 0) + f; });
    }
    fill.alloc.forEach(function (a) {
      var sl = slotById[a.slot], ia = incAlloc[a.income];
      ia.parts.push({ step: a.step, month: sl.id.slice(0, 7), name: sl.line ? sl.line.name : '', amount: a.amount, next: sl.id.slice(0, 7) !== M });
    });
    Object.keys(fill.unspent).forEach(function (id) { if (incAlloc[id]) incAlloc[id].unallocated = fill.unspent[id]; });

    // moves between categories, applied after the ladder
    (movesBy[M] || []).forEach(function (mv) {
      function ensure(c) { var k = 'cat:' + c; if (!cur1.lines[k]) { cur1.lines[k] = { key: k, kind: 'cat', name: c, group: ctx.idx.byName[c] || '', step: walls[c] ? 1 : 4, target: 0, funded: 0, carryIn: st.carry[c] || 0, moved: 0, spent: (spent[M] || {})[c] || 0, left: 0, paid: 0, dueDay: null, due: null, legacy: false, walls: !!walls[c] }; } return cur1.lines[k]; }
      ensure(mv.from).moved -= mv.amount; ensure(mv.to).moved += mv.amount;
    });
    var paid = debtPaid_(txns, accounts, M), over = 0, step3 = (cur1.lines.over ? cur1.lines.over.funded : 0), carry = {};
    Object.keys(cur1.lines).forEach(function (k) {
      var l = cur1.lines[k];
      if (l.kind === 'cat') {
        l.left = l.carryIn + l.funded + l.moved - l.spent;
        if (l.left > 0) carry[l.name] = l.left; else if (l.left < 0) over += -l.left;
      } else if (l.kind === 'min') { l.paid = paid[l.name] || 0; l.left = l.funded - l.paid; }
      else if (l.kind === 'debt') l.paid = paid[l.name] || 0;
    });
    var emgFunded = (cur1.lines.emg ? cur1.lines.emg.funded : 0) + (cur1.lines.full ? cur1.lines.full.funded : 0), movedIn = 0;
    bufD.forEach(function (x) { if (x.delta > 0 && ymOf_(x.day) === M) movedIn += x.delta; });
    // carry into next month
    var overOwed = Math.max(0, st.over - step3);
    res[M] = { month: M, lines: cur1.lines, debts: cur1.debts, allClear: cur1.allClear, overIn: st.over, overOut: overOwed + over, carryOut: carry };
    st.carry = carry; st.over = overOwed + over; st.emg = Math.max(0, st.emg + emgFunded - movedIn);
  });
  return { months: months, res: res, ready: ready, start: start, cur: cur, nxt: nxt, settings: settings, incomes: incomes, incAlloc: incAlloc, base: base, pinned: pinned, walls: walls, ctx: ctx, spent: spent };
}

/** One month in the shape the screens use. a = the data (see budgetRun_), a.month defaults to this month. */
function budgetView_(a) {
  var run = budgetRun_(a), cur = run.cur, M = a.month && run.res[a.month] ? a.month : cur, r = run.res[M], settings = run.settings;
  var steps = {};
  [1, 2, 3, 4, 5, 6].forEach(function (n) { steps[n] = { step: n, name: STEP_NAMES_[n], target: 0, funded: 0, lines: [] }; });
  var keys = Object.keys(r.lines).map(function (k) { return r.lines[k]; });
  keys.forEach(function (l) {
    var s = steps[l.step];
    if (l.kind === 'cat' && l.target <= 0 && l.carryIn === 0 && l.funded === 0 && l.moved === 0) return;
    s.lines.push(l);
    if (l.step <= 4) { s.target += l.target; s.funded += Math.min(l.funded, Math.max(l.target, 0)); }
    else { s.target += l.target; s.funded += l.funded; }
  });
  [1, 2, 3, 4].forEach(function (n) { steps[n].lines.sort(function (x, y) { if (n === 2) { var dx = x.due || '9999', dy = y.due || '9999'; return dx < dy ? -1 : dx > dy ? 1 : 0; } return 0; }); });
  var planTarget = steps[1].target + steps[2].target + steps[3].target + steps[4].target, planFunded = steps[1].funded + steps[2].funded + steps[3].funded + steps[4].funded;
  var leftToSpend = 0, spentMonth = 0, catLines = [];
  keys.forEach(function (l) {
    if (l.kind !== 'cat') return;
    if (l.target > 0 || l.carryIn !== 0 || l.funded || l.moved) {
      catLines.push(l);
      if (l.step === 1 || l.step === 4) leftToSpend += Math.max(0, l.left);
    }
  });
  // next month covered: steps 1, 2 and 4 of next month that income has already paid for
  var nr = run.res[run.nxt], nTarget = 0, nFunded = 0;
  if (nr) Object.keys(nr.lines).forEach(function (k) { var l = nr.lines[k]; if (l.step === 1 || l.step === 2 || l.step === 4) { nTarget += l.target; nFunded += Math.min(l.funded, l.target); } });
  var nextCovered = { target: nTarget, funded: nFunded, pct: nTarget > 0 ? Math.min(100, Math.floor(nFunded / nTarget * 100)) : null, full: nTarget > 0 && nFunded >= nTarget };
  // where the money in this month's income went
  var incomes = run.incomes.filter(function (i) { return ymOf_(i.date) === M; }).map(function (i) {
    var ia = run.incAlloc[i.id], byStep = {}, list = [];
    ia.parts.forEach(function (p) {
      var k = p.step + (p.next ? 'n' : ''), x = byStep[k];
      if (!x) { x = byStep[k] = { step: p.step, next: p.next, name: STEP_NAMES_[p.step], amount: 0 }; list.push(x); }
      x.amount += p.amount;
    });
    return { id: i.id, date: i.date, amount: i.amount, from: i.from, to: i.to, source: i.source, fundsMonth: ia.fundMonth, parts: list, unallocated: ia.unallocated };
  });
  var focus = null;
  r.debts.forEach(function (x) { if (!focus && x.balance > 0) focus = x.name; });
  // the stage in plain words
  var stage = { step: 1, text: 'Add targets to start the plan.' };
  if (run.ready) {
    var first = 0;
    [1, 2, 3, 4].forEach(function (n) { if (!first && steps[n].target > steps[n].funded) first = n; });
    var emg = r.lines.emg;
    if (!first && emg && emg.target > emg.funded) first = 5;
    if (!first) first = 6;
    var txt = { 1: 'Step 1 of the plan: covering the Four Walls.', 2: 'Step 2 of the plan: bills and minimum payments.', 3: 'Step 3 of the plan: covering card overspend from earlier months.', 4: 'Step 4 of the plan: everyday categories.', 5: 'Step 5 of the plan: building the starter emergency fund.' };
    if (first === 6) txt[6] = !r.allClear ? 'Step 6 of the plan: paying off one debt at a time.' + (focus ? ' Focus: ' + focus + '.' : '')
      : (settings.full_target > 0 && r.lines.full && r.lines.full.target > 0 ? 'Step 6 of the plan: building the full emergency fund.' : 'Step 6 of the plan: growing wealth.');
    stage = { step: first, text: txt[first] };
  }
  var spentAll = run.spent[M] || {}, unbudgeted = 0;
  Object.keys(spentAll).forEach(function (c) { if (!r.lines['cat:' + c]) unbudgeted += spentAll[c]; });
  return {
    month: M, ready: run.ready, steps: steps, categories: catLines, planTarget: planTarget, planFunded: planFunded, waiting: Math.max(0, planTarget - planFunded),
    leftToSpend: leftToSpend, nextCovered: nextCovered, incomes: incomes, stage: stage, focus: focus, debts: r.debts, allClear: r.allClear,
    settings: settings, overspendOwed: r.overIn, unbudgeted: unbudgeted, nextMonth: run.nxt, reviewedNext: settings.reviewed === run.nxt,
    walls: run.walls, hasIncome: incomes.length > 0
  };
}

/** Spending by category for a month: from the YNAB archive before the live months, from entries after. { category: { amount, group } } */
function catSpendMonth_(a, month, ctx) {
  var curMonth = ymOf_(a.today), cutMonth = /^\d{4}-\d{2}/.test(String(a.cutover || '')) ? String(a.cutover).slice(0, 7) : curMonth, out = {};
  var archiveUntil = cutMonth < curMonth ? cutMonth : curMonth;
  function fromArchive() {
    (a.archive || []).forEach(function (r) {
      if (ymOf_(r.month) !== month) return;
      var n = num_(r.spent), g = String(r.group || '');
      if (!n || ctx.idx.notSpend[g] || NOT_SPEND_GROUP_.test(g) || !r.category) return;
      out[r.category] = out[r.category] || { amount: 0, group: g }; out[r.category].amount += n;
    });
  }
  function fromLive() {
    (a.txns || []).forEach(function (t) {
      if (ymOf_(dayOf_(t)) !== month || !spendCounts_(t, ctx) || !t.category) return;
      out[t.category] = out[t.category] || { amount: 0, group: groupOf_(t, ctx.idx) }; out[t.category].amount += num_(t.idr_amount);
    });
  }
  if (month < archiveUntil) { fromArchive(); if (!Object.keys(out).length) fromLive(); } else fromLive();
  return out;
}

/** The monthly review: every category with this month's target and spending, the 3 month average as a suggestion, and what next month is set to. */
function planNextView_(a) {
  var run = budgetRun_(a), cur = run.cur, nxt = run.nxt, ctx = run.ctx, r = run.res[cur], rows = {}, order = catOrderOf_(a.cats);
  var curT = monthTargets_(a, cur), nxtT = monthTargets_(a, nxt), prior = [monthsBack_(cur, 1), monthsBack_(cur, 2), monthsBack_(cur, 3)];
  var spend = {}; prior.concat([cur]).forEach(function (m) { spend[m] = catSpendMonth_(a, m, ctx); });
  function ok(c) { var g = ctx.idx.byName[c] || ''; return c && c !== 'Income' && c.indexOf('Held:') !== 0 && !ctx.idx.notSpend[g] && !NOT_SPEND_GROUP_.test(g); }
  function add(c) { if (!rows[c] && ok(c)) rows[c] = true; }
  Object.keys(curT).forEach(add); Object.keys(nxtT).forEach(add);
  prior.concat([cur]).forEach(function (m) { Object.keys(spend[m]).forEach(add); });
  var out = Object.keys(rows).map(function (c) {
    var vals = [], sum = 0;
    prior.forEach(function (m) { var s = spend[m][c]; if (s && s.amount > 0) { vals.push(s.amount); sum += s.amount; } });
    var avg = vals.length ? sum / vals.length : ((spend[cur][c] || { amount: 0 }).amount), sug = avg > 0 ? Math.round(avg / 10000) * 10000 : 0;
    var t = curT[c], nt = nxtT[c], ln = r && r.lines['cat:' + c];
    return { category: c, group: ctx.idx.byName[c] || '', lastTarget: t ? t.amount : 0, spent: (spend[cur][c] || { amount: 0 }).amount, suggested: sug, nextTarget: nt ? nt.amount : 0,
      dueDay: nt ? nt.dueDay : (t ? t.dueDay : null), weekend: nt ? nt.weekend : (t ? t.weekend : ''), walls: !!run.walls[c], budgeted: !!(t || nt), left: ln ? ln.left : 0, months: vals.length };
  });
  out.sort(function (x, y) {
    if (x.budgeted !== y.budgeted) return x.budgeted ? -1 : 1;
    if (x.budgeted) { var ox = order[x.category] === undefined ? 1e6 : order[x.category], oy = order[y.category] === undefined ? 1e6 : order[y.category]; return ox - oy; }
    return y.suggested - x.suggested;
  });
  return { month: cur, nextMonth: nxt, rows: out, reviewed: run.settings.reviewed === nxt, totalNext: out.reduce(function (s, x) { return s + x.nextTarget; }, 0) };
}

/** Company cash, personal cash, debts in snowball order and net worth, for the Account screen. */
function wealthView_(a) {
  var accounts = a.accounts || [], today = a.today, partner = a.role === 'partner';
  var av = accountsView_({ accounts: accounts, balances: a.balances, txns: a.txns || [], today: today, role: a.role });
  var base = debtBase_({ accounts: accounts, balances: a.balances, txns: a.txns || [], debts: a.debts, debtBal: a.debtBal });
  var debts = debtsAt_(base, ymOf_(today), latestDebtOrder_(a.dorder), ymOf_(today)), owe = 0, unknown = 0;
  debts.forEach(function (x) { if (x.owed === null) unknown++; else owe += x.owed; });
  var ptCash = 0, ptOwed = 0, ptUnknown = 0;
  if (!partner) {
    av.banks.forEach(function (b) { if (b.entity === 'PT') { if (b.tracked === null) ptUnknown++; else ptCash += b.tracked; } });
    av.cards.concat(av.loans).forEach(function (x) { if (x.entity === 'PT') { if (x.owed === null) ptUnknown++; else ptOwed += x.owed; } });
  }
  var held = Math.max(0, heldFrom_(a.txns || []).total);
  return { company: partner ? null : ptCash, personal: av.cash, debts: debts, owe: owe, companyOwed: partner ? null : ptOwed, held: held,
    netWorth: (partner ? 0 : ptCash - ptOwed) + av.cash - owe - held, focus: (debts.filter(function (x) { return x.balance > 0; })[0] || {}).name || null,
    unknown: unknown + ptUnknown, partner: partner };
}

/* ----- writing: the rows each budget action adds (used by the server and, to show a change at once, by the phone) ----- */

var WALLS_NONE_ = 'Choose a category.';
function cleanName_(v, max) { return String(v === undefined || v === null ? '' : v).trim().slice(0, max || 60); }
function dueDayOk_(v) {
  if (v === '' || v === null || v === undefined) return { ok: true, v: '' };
  var n = Number(v);
  return (isNaN(n) || n < 1 || n > 31 || Math.round(n) !== n) ? { ok: false } : { ok: true, v: n };
}

/**
 * Checks one budget action and returns the rows to add: { error } or { writes: [{ tab, rows }], audit: [{ action, tab, row, field, before, after }] }.
 * o = { who, at, today, accounts, prev (this month's targets, for the audit line), id }.
 */
function buildBudgetWrite_(action, req, o) {
  var month = ymOf_(o.today), by = o.who, at = o.at, prev = o.prev || {}, audit = [], rows = [];
  function tgtRow(cat, amount, dueDay, weekend, m) {
    return { month: m, item: cat, kind: 'target', amount_idr: amount, due_day: dueDay, weekend: weekend || '', walls: '', match: '', active: amount > 0 ? 'Y' : 'N', set_by: by, at: at };
  }
  if (action === 'set_target') {
    var cat = cleanName_(req.category), amt = Number(req.amount), dd = dueDayOk_(req.dueDay), wk = String(req.weekend || ''), m = /^\d{4}-\d{2}$/.test(String(req.month || '')) ? req.month : month;
    if (!cat) return { error: 'Choose a category.' };
    if (req.amount === '' || req.amount === null || req.amount === undefined || isNaN(amt) || amt < 0) return { error: 'Type the monthly target as a number. Type 0 to remove it.' };
    if (!dd.ok) return { error: 'Type the due day as a number from 1 to 31.' };
    if (['', 'before', 'after'].indexOf(wk) === -1) return { error: 'Choose what to do when the due day is a weekend.' };
    amt = Math.round(amt);
    rows.push(tgtRow(cat, amt, dd.v, wk, m));
    audit.push({ action: 'set_target', tab: 'Budget', row: cat, field: 'amount_idr', before: prev[cat] ? prev[cat].amount : '', after: amt });
    return { writes: [{ tab: 'Budget', rows: rows }], audit: audit };
  }
  if (action === 'set_four_walls') {
    var c2 = cleanName_(req.category);
    if (!c2) return { error: 'Choose a category.' };
    var on = req.on === true || String(req.on).toUpperCase() === 'Y' || String(req.on) === 'true';
    rows.push({ month: month, item: c2, kind: 'walls', amount_idr: '', due_day: '', weekend: '', walls: on ? 'Y' : 'N', match: '', active: 'Y', set_by: by, at: at });
    audit.push({ action: 'set_four_walls', tab: 'Budget', row: c2, field: 'walls', before: o.wallsBefore === undefined ? '' : (o.wallsBefore ? 'Y' : 'N'), after: on ? 'Y' : 'N' });
    return { writes: [{ tab: 'Budget', rows: rows }], audit: audit };
  }
  if (action === 'move_money') {
    var from = cleanName_(req.from), to = cleanName_(req.to), mv = Number(req.amount), id = cleanName_(req.id, 40) || o.id;
    if (!from || !to) return { error: 'Choose where the money comes from and where it goes.' };
    if (from === to) return { error: 'Choose two different categories.' };
    if (req.amount === '' || isNaN(mv) || mv <= 0) return { error: 'Type the amount to move as a number above zero.' };
    if (!id) return { error: 'The app sent a move without an id. Please update the app.' };
    mv = Math.round(mv);
    var memo = cleanName_(req.memo, 80);
    return { writes: [{ tab: 'BudgetMoves', rows: [{ id: id, date: day_(req.date) || o.today, month: month, from: from, to: to, amount_idr: mv, memo: memo, set_by: by, at: at }] }],
      audit: [{ action: 'move_money', tab: 'BudgetMoves', row: id, field: from + ' > ' + to, before: '', after: mv }], moveId: id };
  }
  if (action === 'set_debt_order') {
    var ord = req.order;
    if (!Array.isArray(ord)) return { error: 'Send the debts as a list.' };
    var seen = {}, clean = [];
    ord.forEach(function (n) { var s = cleanName_(n); if (s && !seen[acctKey_(s)]) { seen[acctKey_(s)] = true; clean.push(s); } });
    if (clean.length > 40) return { error: 'That is too many debts to order.' };
    return { writes: [{ tab: 'DebtOrder', rows: [{ at: at, order: JSON.stringify(clean), set_by: by }] }], audit: [{ action: 'set_debt_order', tab: 'DebtOrder', row: at, field: 'order', before: '', after: clean.join(' > ') }] };
  }
  if (action === 'set_budget_settings') {
    var set = [];
    function put(k, v, before) { set.push({ key: k, value: v, set_by: by, at: at }); audit.push({ action: 'set_budget_settings', tab: 'BudgetSettings', row: k, field: 'value', before: before === undefined ? '' : before, after: v }); }
    var cur = o.settings || {};
    ['starterTarget', 'fullTarget'].forEach(function (f) {
      if (req[f] === undefined) return;
      var n = Number(req[f]);
      if (req[f] === '' || isNaN(n) || n < 0) { set = null; return; }
      if (set) put(f === 'starterTarget' ? 'starter_target' : 'full_target', Math.round(n), f === 'starterTarget' ? cur.starter_target : cur.full_target);
    });
    if (set === null) return { error: 'Type the target as a number. Type 0 for none.' };
    if (req.bufferAccount !== undefined) {
      var ba = cleanName_(req.bufferAccount);
      if (ba) {
        var acc = resolveAccount_(o.accounts || [], ba);
        if (!acc || kindOf_(acc) !== 'bank') return { error: 'Choose a bank account from your list.' };
        ba = acc.account;
      }
      put('buffer_account', ba, cur.buffer_account);
    }
    if (req.lastMonth !== undefined) {
      var lm = req.lastMonth === true || String(req.lastMonth).toUpperCase() === 'Y' || String(req.lastMonth) === 'true';
      put('last_month', lm ? 'Y' : 'N', cur.last_month ? 'Y' : 'N');
    }
    if (!set.length) return { error: 'There is nothing to save.' };
    return { writes: [{ tab: 'BudgetSettings', rows: set }], audit: audit };
  }
  if (action === 'plan_next_month') {
    var items = req.items, pm = /^\d{4}-\d{2}$/.test(String(req.month || '')) ? req.month : nextMonth_(month), wr = [];
    if (!Array.isArray(items) || !items.length) return { error: 'There is nothing to save yet. Set at least one target.' };
    if (items.length > 250) return { error: 'That is too many categories at once.' };
    if (pm < month) return { error: 'That month has already passed.' };
    for (var i = 0; i < items.length; i++) {
      var it = items[i], ic = cleanName_(it.category), ia = Number(it.amount), idd = dueDayOk_(it.dueDay), iw = String(it.weekend || '');
      if (!ic) return { error: 'One of the categories has no name.' };
      if (it.amount === '' || it.amount === null || it.amount === undefined || isNaN(ia) || ia < 0) return { error: 'Type the target for ' + ic + ' as a number.' };
      if (!idd.ok) return { error: 'The due day for ' + ic + ' must be from 1 to 31.' };
      if (['', 'before', 'after'].indexOf(iw) === -1) iw = '';
      ia = Math.round(ia);
      rows.push(tgtRow(ic, ia, idd.v, iw, pm));
      audit.push({ action: 'plan_next_month', tab: 'Budget', row: ic + ' ' + pm, field: 'amount_idr', before: prev[ic] ? prev[ic].amount : '', after: ia });
      if (it.walls === true || it.walls === false) wr.push({ month: month, item: ic, kind: 'walls', amount_idr: '', due_day: '', weekend: '', walls: it.walls ? 'Y' : 'N', match: '', active: 'Y', set_by: by, at: at });
    }
    var writes = [{ tab: 'Budget', rows: rows.concat(wr) }, { tab: 'BudgetSettings', rows: [{ key: 'reviewed', value: pm, set_by: by, at: at }] }];
    audit.push({ action: 'plan_next_month', tab: 'BudgetSettings', row: 'reviewed', field: 'value', before: '', after: pm });
    return { writes: writes, audit: audit };
  }
  return { error: 'The app asked for something this version does not know. Please refresh the app.' };
}

if (typeof module !== 'undefined') {
  module.exports = { kindOf_: kindOf_, resolveAccount_: resolveAccount_, cardForPayment_: cardForPayment_, effects_: effects_, trackedAll_: trackedAll_, clearing_: clearing_,
    accountsView_: accountsView_, archiveMonthly_: archiveMonthly_, changedSince_: changedSince_, catIndex_: catIndex_, spendTotalsG_: spendTotalsG_, spendReport_: spendReport_, homeView_: homeView_, slim_: slim_, reviewList_: reviewList_, activityList_: activityList_,
    fillLadder_: fillLadder_, budgetRun_: budgetRun_, budgetView_: budgetView_, planNextView_: planNextView_, wealthView_: wealthView_, budgetIncomes_: budgetIncomes_, buildBudgetWrite_: buildBudgetWrite_,
    budgetSettings_: budgetSettings_, monthTargets_: monthTargets_, orderDebts_: orderDebts_, latestDebtOrder_: latestDebtOrder_, debtBase_: debtBase_, nextMonth_: nextMonth_, BUDGET_TABS_: BUDGET_TABS_, BUDGET_V_: BUDGET_V_, STEP_NAMES_: STEP_NAMES_ };
}
