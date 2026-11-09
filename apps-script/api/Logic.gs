/**
 * Hanaro app logic. Pure functions, no Google services, so the same file runs in
 * Apps Script (project B) and in the Node tests (tests/run.js).
 * Inputs are plain row objects keyed by the Sheet headers. Dates are ISO strings.
 */

function num_(v) { var n = Number(v); return (v === '' || v === null || v === undefined || isNaN(n)) ? 0 : n; }
function has_(v) { return v !== '' && v !== null && v !== undefined && !isNaN(Number(v)); }
function day_(s) { return String(s || '').slice(0, 10); }
function flagsOf_(t) { return String(t.flags || '').split(',').filter(function (x) { return x; }); }

function daysBetween_(a, b) {
  return Math.round((Date.parse(day_(b) + 'T00:00:00Z') - Date.parse(day_(a) + 'T00:00:00Z')) / 86400000);
}
function addDays_(s, n) {
  var d = new Date(Date.parse(day_(s) + 'T00:00:00Z') + n * 86400000);
  return d.toISOString().slice(0, 10);
}
function firstOfNextMonth_(today) {
  var y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  m++; if (m > 12) { m = 1; y++; }
  return y + '-' + (m < 10 ? '0' : '') + m + '-01';
}
function nextDue_(today, dueDay) {
  var y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)), d = Number(dueDay);
  function mk(yy, mm) { return yy + '-' + (mm < 10 ? '0' : '') + mm + '-' + (d < 10 ? '0' : '') + d; }
  var thisMonth = mk(y, m);
  if (thisMonth >= today) return thisMonth;
  m++; if (m > 12) { m = 1; y++; }
  return mk(y, m);
}
function hasRuleFlag_(f) { return f.some(function (x) { return x.indexOf('rule:') === 0; }); }
function liveTxn_(t) { return t.status !== 'void'; }

/** { account: true } for business (PT) accounts. */
function ptAccounts_(accounts) {
  var pt = {}; (accounts || []).forEach(function (a) { if (a.entity === 'PT') pt[a.account] = true; });
  return pt;
}

/** Business or family? The tag on the entry wins; without one, a PT account means business. Anything else is family. */
function isBusiness_(t, pt) {
  var e = String(t.entity || '').toLowerCase();
  if (e === 'business') return true;
  if (e === 'family') return false;
  return !!(pt && pt[t.account]);
}

/**
 * Whose transaction: Business, AJ or Cynthia. A typed entry belongs to whoever typed it.
 * A bank email belongs to the owner of the account it came from. Business wins over both.
 * ctx = { pt: {account: true}, owners: {account: 'AJ' | 'Cynthia' | 'AJ + Cynthia' | ...} }.
 */
function byOf_(t, ctx) {
  if (isBusiness_(t, ctx && ctx.pt)) return 'Business';
  var who = String(t.who || '').trim();
  if (who === 'AJ' || who === 'Cynthia') return who;
  var o = String((ctx && ctx.owners && ctx.owners[t.account]) || '').trim();
  if (o === 'AJ' || o === 'Cynthia') return o;
  if (o.indexOf('+') !== -1) return 'AJ'; // a shared account: AJ unless Cynthia typed the entry
  return '';
}

/** Purchases that still count as money out: not void, not unread, not duplicate. */
function countsAsSpend_(t) {
  return t.txn_type === 'purchase' && (t.status === 'auto' || t.status === 'confirmed');
}

/**
 * Pay-now purchases (cards that must be paid the same day) are settled when
 *  1. the person marked them paid, or
 *  2. a card payment of the same amount follows within 24 hours, or
 *  3. one lump-sum payment covers several of them: it equals all open charges up to that moment,
 *     or the oldest charges added up in order (so paying everything at once is noticed).
 * Returns { purchaseId: true } for the settled ones.
 */
function settledPayNow(txns) {
  var payments = txns.filter(function (t) { return t.txn_type === 'payment' && liveTxn_(t); })
    .map(function (t) { return { t: t, ms: Date.parse(t.timestamp), used: false }; })
    .sort(function (a, b) { return a.ms - b.ms; });
  var out = {}, open = [];
  txns.filter(function (t) { return liveTxn_(t) && flagsOf_(t).indexOf('pay_now') !== -1; })
    .sort(function (a, b) { return Date.parse(a.timestamp) - Date.parse(b.timestamp); })
    .forEach(function (p) {
      if (flagsOf_(p).indexOf('paid') !== -1) { out[p.id] = true; return; }
      var pm = Date.parse(p.timestamp);
      for (var i = 0; i < payments.length; i++) {
        var q = payments[i];
        if (q.used || num_(q.t.idr_amount) !== num_(p.idr_amount)) continue;
        if (q.ms >= pm - 3600000 && q.ms <= pm + 86400000) { q.used = true; out[p.id] = true; return; }
      }
      open.push({ t: p, ms: pm });
    });
  // Lump sums: only exact totals count, so a coincidence with a random mix of small charges cannot settle anything.
  payments.forEach(function (q) {
    if (q.used) return;
    var amount = num_(q.t.idr_amount);
    if (!amount) return;
    var cand = open.filter(function (c) { return !out[c.t.id] && c.ms <= q.ms + 3600000; });
    if (!cand.length) return;
    var run = 0, hit = -1;
    for (var k = 0; k < cand.length; k++) { run += num_(cand[k].t.idr_amount); if (run === amount) hit = k; }
    if (hit === -1) return;
    for (var m = 0; m <= hit; m++) out[cand[m].t.id] = true;
    q.used = true;
  });
  return out;
}

/** Items that need a person, grouped by kind. */
function reviewItems(txns) {
  var settled = settledPayNow(txns);
  var items = [];
  txns.forEach(function (t) {
    if (!liveTxn_(t)) return;
    var f = flagsOf_(t);
    if (t.status === 'needs_review') items.push({ kind: 'unread', t: t });
    else if (t.status === 'possible_duplicate') items.push({ kind: 'duplicate', t: t });
    else if (f.indexOf('pay_now') !== -1 && !settled[t.id] && f.indexOf('later') === -1) items.push({ kind: 'pay_now', t: t });
    else if (t.status === 'auto' && (t.txn_type === 'purchase' || t.txn_type === 'transfer') && !hasRuleFlag_(f)) items.push({ kind: 'confirm', t: t });
  });
  items.sort(function (a, b) { return Date.parse(b.t.timestamp) - Date.parse(a.t.timestamp); });
  return items;
}

function bucketCaps_(buckets, month) {
  var best = {};
  buckets.forEach(function (b) {
    var bm = String(b.month).slice(0, 7);
    if (!b.bucket || bm > month) return;
    var cur = best[b.bucket];
    if (!cur || bm >= String(cur.month).slice(0, 7)) best[b.bucket] = b;
  });
  return best;
}

function latestBalances_(balances) {
  var best = {};
  balances.forEach(function (b) {
    if (!b.account || !has_(b.confirmed_balance)) return;
    var cur = best[b.account];
    if (!cur || String(b.date_confirmed) >= String(cur.date_confirmed)) best[b.account] = b;
  });
  return best;
}

function obligationsUntil_(today, horizon, bills, debts) {
  var list = [];
  bills.forEach(function (b) {
    if (String(b.active).toUpperCase() === 'N' || !has_(b.amount_idr) || !has_(b.due_day)) return;
    var due = nextDue_(today, b.due_day);
    if (due >= horizon) return;
    if (day_(b.last_paid).slice(0, 7) === due.slice(0, 7)) return;
    list.push({ name: b.bill, amount: num_(b.amount_idr), due: due });
  });
  debts.forEach(function (d) {
    if (d.entity !== 'Household' || !has_(d.minimum) || !has_(d.due_day)) return;
    var due = nextDue_(today, d.due_day);
    if (due >= horizon) return;
    list.push({ name: d.debt + ' minimum', amount: num_(d.minimum), due: due });
  });
  return list;
}

function rpText_(n) { return 'Rp ' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

function monthName_(iso) {
  var n = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return Number(iso.slice(8, 10)) + ' ' + n[Number(iso.slice(5, 7)) - 1];
}


/** Monday of the week containing the ISO date. */
function weekStart_(iso) {
  var dow = new Date(Date.parse(day_(iso) + 'T00:00:00Z')).getUTCDay(); // 0 = Sunday
  return addDays_(iso, -((dow + 6) % 7));
}

/**
 * What the family actually spent: purchases that are not void, unread or duplicate.
 * Business (PT) accounts, transfers, card payments and money held for others are not included.
 */
function spendTotals_(txns, accounts, today) {
  var pt = ptAccounts_(accounts);
  var wk = weekStart_(today), mo = today.slice(0, 7), r = { today: 0, week: 0, month: 0, todayCount: 0 };
  txns.forEach(function (t) {
    if (!countsAsSpend_(t) || isBusiness_(t, pt)) return;
    var d = day_(t.timestamp || t.date), n = num_(t.idr_amount);
    if (d.slice(0, 7) === mo) r.month += n;
    if (d >= wk && d <= today) r.week += n;
    if (d === today) { r.today += n; r.todayCount++; }
  });
  r.avgPerDay = Math.round(r.month / Math.max(1, Number(today.slice(8, 10))));
  return r;
}


/**
 * Manual entries and bank emails are the same purchase seen twice. Pair them when the amount is the same
 * and the times are close (entered up to 12 hours after the bank email, or up to 3 hours before it).
 * An account that is filled in on both sides must agree. Returns [{ manual: row, email: row }].
 */
function findMatches_(txns) {
  var used = {}, pairs = [];
  var man = txns.filter(function (t) { return t.source === 'manual' && t.status === 'confirmed' && t.txn_type === 'purchase' && flagsOf_(t).indexOf('matched') === -1; })
    .sort(function (a, b) { return Date.parse(a.timestamp) - Date.parse(b.timestamp); });
  var em = txns.filter(function (t) { return t.source === 'email' && t.status === 'auto' && t.txn_type === 'purchase' && flagsOf_(t).indexOf('matched') === -1; });
  man.forEach(function (m) {
    var mm = Date.parse(m.timestamp), best = null, bestScore = Infinity;
    // A purchase typed in a foreign currency carries an estimated rupiah amount. The bank's real amount can differ a little (rate, card fee).
    var foreign = !!m.orig_currency && m.orig_currency !== 'IDR' && flagsOf_(m).indexOf('fx_est') !== -1;
    em.forEach(function (e) {
      if (used[e.id]) return;
      var rel = num_(m.idr_amount) > 0 ? Math.abs(num_(e.idr_amount) - num_(m.idr_amount)) / num_(m.idr_amount) : 1;
      if (num_(e.idr_amount) !== num_(m.idr_amount) && !(foreign && rel <= 0.12)) return;
      if (m.account && e.account && m.account !== e.account) return;
      var diff = Date.parse(e.timestamp) - mm;
      if (diff < -12 * 3600000 || diff > 3 * 3600000) return;
      var score = foreign ? rel : Math.abs(diff);
      if (score < bestScore) { best = e; bestScore = score; }
    });
    if (best) { used[best.id] = true; pairs.push({ manual: m, email: best }); }
  });
  return pairs;
}

/** Hides manual entries that already have a bank email, so nothing is counted twice before the merge is saved. */
function dropMatchedManual_(txns) {
  var gone = {};
  findMatches_(txns).forEach(function (p) { gone[p.manual.id] = true; });
  return txns.filter(function (t) { return !gone[t.id]; });
}

/** One row per place: how often, how much, and what category it usually gets. */
function payeeSummary_(txns, rules) {
  var by = {};
  txns.forEach(function (t) {
    if (t.txn_type !== 'purchase' || (t.status !== 'auto' && t.status !== 'confirmed') || !t.payee) return;
    var k = ruleKey(t.payee); if (!k) return;
    var g = by[k] || (by[k] = { key: k, payee: t.payee, count: 0, total: 0, last: '', category: '', lastCat: '' });
    g.count++; g.total += num_(t.idr_amount);
    if (String(t.timestamp) >= g.last) { g.last = String(t.timestamp); g.payee = t.payee; if (t.category) g.lastCat = t.category; }
  });
  (rules || []).forEach(function (r) {
    var k = ruleKey(r.match_text);
    Object.keys(by).forEach(function (key) { if (k && key.indexOf(k) !== -1 && !by[key].rule) by[key].rule = r; });
  });
  return Object.keys(by).map(function (k) {
    var g = by[k];
    return { key: g.key, payee: g.payee, count: g.count, total: g.total, last: g.last.slice(0, 10), category: g.rule ? g.rule.category : g.lastCat, remembered: !!g.rule, trusted: !!g.rule && String(g.rule.auto_confirm).toUpperCase() === 'Y' };
  }).sort(function (a, b) { return b.count - a.count || b.total - a.total; }).slice(0, 300);
}

/** The one message sent each evening. h = computeHome result. */
function eveningText_(h) {
  var lines = ['Evening check.'];
  lines.push('Spent today: ' + rpText_(h.spentToday) + (h.spentTodayCount ? ' (' + h.spentTodayCount + ' purchase' + (h.spentTodayCount === 1 ? '' : 's') + ')' : '') + '.');
  if (h.toPayCount) lines.push('Card charges not paid yet: ' + h.toPayCount + ', total ' + rpText_(h.toPayTotal) + '. Pay that amount in one payment in myBCA and Hanaro will notice it.');
  else lines.push('No card charges waiting to be paid.');
  if (h.reviewCount) lines.push('Waiting for you in Hanaro: ' + h.reviewCount + ' item' + (h.reviewCount === 1 ? '' : 's') + '.');
  return lines.join('\n');
}

/** Everything the Home screen shows. d = { txns, accounts, buckets, balances, bills, debts, summary, today } */
function computeHome(d) {
  d = Object.assign({}, d, { txns: dropMatchedManual_(d.txns) });
  var today = d.today, month = today.slice(0, 7);
  var summary = {}; (d.summary || []).forEach(function (r) { summary[r.key] = r.value; });
  var horizon = /^\d{4}-\d{2}-\d{2}$/.test(String(summary.horizon_date || '')) && summary.horizon_date > today
    ? summary.horizon_date : firstOfNextMonth_(today);
  var days = Math.max(1, daysBetween_(today, horizon));

  var spent = {};
  d.txns.forEach(function (t) {
    if (day_(t.timestamp || t.date).slice(0, 7) !== month || !countsAsSpend_(t) || !t.bucket) return;
    spent[t.bucket] = (spent[t.bucket] || 0) + num_(t.idr_amount);
  });
  var caps = bucketCaps_(d.buckets, month);
  var names = Object.keys(caps);
  var buckets = names.map(function (n) {
    var cap = has_(caps[n].cap_idr) ? num_(caps[n].cap_idr) : null, s = spent[n] || 0;
    return { bucket: n, cap: cap, spent: s, pct: cap ? Math.round(s / cap * 100) : null, owner: caps[n].owner || '' };
  }).filter(function (b) { return b.cap !== null || b.spent > 0; });
  var capped = buckets.filter(function (b) { return b.cap !== null; });
  var bucketsLeft = capped.reduce(function (a, b) { return a + Math.max(b.cap - b.spent, 0); }, 0);

  var bal = latestBalances_(d.balances || []);
  var cashAccounts = d.accounts.filter(function (a) { return a.type === 'bank' && String(a.allowed_for_new_spend).toUpperCase() === 'Y'; });
  var cash = 0, counted = 0, oldest = null;
  cashAccounts.forEach(function (a) {
    var b = bal[a.account]; if (!b) return;
    cash += num_(b.confirmed_balance); counted++;
    if (!oldest || String(b.date_confirmed) < oldest) oldest = String(b.date_confirmed);
  });
  var bills = (d.plan && d.plan.length) ? billsFromPlan_(d.plan, d.txns, d.accounts, today, d.paid) : (d.bills || []);
  var ob = obligationsUntil_(today, horizon, bills, d.debts || []);
  var obTotal = ob.reduce(function (a, o) { return a + o.amount; }, 0);

  // Money held for other people (customer orders, convention tickets...). Never ours: it comes off cash before anything else.
  var heldBy = {}, heldTotal = 0;
  d.txns.forEach(function (t) {
    if ((t.txn_type !== 'held_in' && t.txn_type !== 'held_out') || (t.status !== 'auto' && t.status !== 'confirmed')) return;
    var sign = t.txn_type === 'held_in' ? 1 : -1, name = String(t.category || 'Other').replace(/^Held:\s*/, '');
    heldBy[name] = (heldBy[name] || 0) + sign * num_(t.idr_amount);
    heldTotal += sign * num_(t.idr_amount);
  });
  var heldByType = Object.keys(heldBy).map(function (k) { return { type: k, amount: heldBy[k] }; })
    .filter(function (x) { return x.amount !== 0; }).sort(function (a, b) { return b.amount - a.amount; });

  var planNow = computePlan_({ plan: d.plan || [], txns: d.txns, accounts: d.accounts, today: today, history: d.history, paid: d.paid });
  var hasFlex = !!planNow.flexible;
  var notes = [], safe = null, needs = [];
  if (!counted) needs.push('balances');
  if (!hasFlex && !capped.length) needs.push('plan');
  if (counted) {
    var cashSide = cash - obTotal - Math.max(heldTotal, 0);
    var basis = hasFlex ? Math.min(Math.max(planNow.flexible.left, 0), cashSide) : (capped.length ? Math.min(bucketsLeft, cashSide) : cashSide);
    safe = Math.max(0, Math.floor(basis / days / 1000) * 1000);
    if (cashSide < 0) notes.push('Cash is below the bills and minimums due before ' + monthName_(horizon) + '.');
    else notes.push('Bills and minimums are covered until ' + monthName_(horizon) + '. Money that has not landed never counts.');
    if (!hasFlex && !capped.length) notes.push('Set your Flexible number in Spending to include it in this number.');
    if (heldTotal > 0) notes.push(rpText_(heldTotal) + ' in your accounts belongs to other people and is not counted.');
    var age = daysBetween_(day_(oldest), today);
    if (age >= 3) notes.push('Balances were last confirmed ' + age + ' days ago. Update them for an accurate number.');
  }

  var paidNow = d.txns.filter(function (t) { return t.txn_type === 'payment' && liveTxn_(t) && day_(t.timestamp).slice(0, 7) === month; })
    .reduce(function (a, t) { return a + num_(t.idr_amount); }, 0);
  var cardIds = {}; d.accounts.forEach(function (a) { if (a.type === 'credit card' && String(a.carries_balance).toUpperCase() === 'Y') cardIds[a.account] = true; });
  var newCard = d.txns.filter(function (t) { return (countsAsSpend_(t) || (t.txn_type === 'held_out' && (t.status === 'auto' || t.status === 'confirmed'))) && cardIds[t.account] && day_(t.timestamp).slice(0, 7) === month; })
    .reduce(function (a, t) { return a + num_(t.idr_amount); }, 0);
  var cost = null;
  (d.debts || []).forEach(function (x) {
    if (has_(x.balance_idr) && has_(x.effective_rate_annual)) cost = (cost || 0) + num_(x.balance_idr) * num_(x.effective_rate_annual) / 12;
  });

  var hot = buckets.filter(function (b) { return b.pct !== null && b.pct >= 80; }).sort(function (a, b) { return b.pct - a.pct; })[0];
  var insight = hot ? hot.bucket + ' is at ' + hot.pct + '%. Staying under it keeps the daily number steady through ' + monthName_(horizon) + '.'
    : (capped.length ? 'Every bucket is under 80%. Nice and steady.' : 'Set your plan in Spending to see how the month is going.');

  var items = reviewItems(d.txns);
  var spend = spendTotals_(d.txns, d.accounts, today);
  var settledNow = settledPayNow(d.txns);
  var owed = d.txns.filter(function (t) { return liveTxn_(t) && flagsOf_(t).indexOf('pay_now') !== -1 && !settledNow[t.id]; });
  var billsWeek = obligationsUntil_(today, addDays_(today, 8), bills, d.debts || []);
  return {
    spentToday: spend.today, spentTodayCount: spend.todayCount, spentWeek: spend.week, spentMonth: spend.month, avgPerDay: spend.avgPerDay,
    toPayTotal: owed.reduce(function (a, t) { return a + num_(t.idr_amount); }, 0), toPayCount: owed.length,
    billsWeek: billsWeek, billsWeekTotal: billsWeek.reduce(function (a, o) { return a + o.amount; }, 0),
    today: today, horizon: horizon, days: days, safeToSpend: safe, needs: needs, notes: notes,
    buckets: buckets, insight: insight, cash: counted ? cash : null, obligations: ob,
    heldTotal: heldTotal, heldByType: heldByType,
    debtDown: Math.round(paidNow - newCard), debtCost: cost === null ? null : Math.round(cost),
    reviewCount: items.length, payNowCount: items.filter(function (i) { return i.kind === 'pay_now'; }).length,
    lastSync: summary.last_sync_ok || null,
    pacing: planNow.flexible, compare: planNow.compare, hasPlan: !!(d.plan && d.plan.length)
  };
}


/* ---------- Plan: planned amounts in three buckets (Fixed, Non-monthly, Flexible) ---------- */

function daysInMonth_(ym) {
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function prevMonth_(ym) {
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1;
  if (m < 1) { m = 12; y--; }
  return y + '-' + (m < 10 ? '0' : '') + m;
}

/** Family purchases only: not void, unread or duplicate, and never tagged Business (or from a PT account with no tag). */
function familySpend_(txns, accounts) {
  var pt = ptAccounts_(accounts);
  return (txns || []).filter(function (t) { return countsAsSpend_(t) && !isBusiness_(t, pt); })
    .map(function (t) { return { day: day_(t.timestamp || t.date), cat: t.category || '', n: num_(t.idr_amount), txt: (String(t.payee || '') + ' ' + String(t.memo || '')).toLowerCase() }; });
}

/** Latest row per item (month up to this month). Removing an item adds a row with active N. */
function planLatest_(rows, month) {
  var best = {};
  (rows || []).forEach(function (r) {
    var m = String(r.month).slice(0, 7);
    if (!r.item || m > month) return;
    var cur = best[r.item];
    if (!cur || m >= String(cur.month).slice(0, 7)) best[r.item] = r;
  });
  return Object.keys(best).map(function (k) { return best[k]; }).filter(function (r) { return String(r.active).toUpperCase() !== 'N'; });
}

/** Running total of spending for each day of a month: [day1, day1+day2, ...]. */
function cumulative_(spend, ym, upTo) {
  var out = [], run = 0;
  for (var d = 1; d <= upTo; d++) {
    var iso = ym + '-' + (d < 10 ? '0' : '') + d;
    spend.forEach(function (x) { if (x.day === iso) run += x.n; });
    out.push(run);
  }
  return out;
}

/** This month so far against the same days last month. */
function monthCompare_(txns, accounts, today) {
  var ym = today.slice(0, 7), pm = prevMonth_(ym), day = Number(today.slice(8, 10));
  var spend = familySpend_(txns, accounts), lastDays = daysInMonth_(pm);
  var thisSeries = cumulative_(spend, ym, day), lastSeries = cumulative_(spend, pm, lastDays);
  var lastSame = lastSeries[Math.min(day, lastDays) - 1] || 0, thisSame = thisSeries[day - 1] || 0;
  return { thisSpent: thisSame, lastSpent: lastSame, diff: lastSame - thisSame, thisSeries: thisSeries, lastSeries: lastSeries, hasLast: lastSeries[lastDays - 1] > 0 };
}

/** Everyday family spending for a month from the imported YNAB history (YNAB_Monthly rows), outside the planned categories. */
var NOT_EVERYDAY_ = { 'Business': 1, 'Debt payment': 1, 'Fees & interest': 1, 'Own transfer': 1, 'Income': 1, 'Other': 1 };
function historyCore_(history, ym, planned) {
  var t = 0;
  (history || []).forEach(function (r) {
    if (String(r.month).slice(0, 7) !== ym) return;
    var c = String(r.category || '');
    if (NOT_EVERYDAY_[c] || c.indexOf('Held:') === 0 || (planned && planned[c])) return;
    t += num_(r.spent_idr);
  });
  return t;
}

/** Fixed plan items as bills, so the plan is the only list of bills. A bill counts as paid once its category has the money out this month. */
function billsFromPlan_(plan, txns, accounts, today, paid) {
  var p = computePlan_({ plan: plan || [], txns: txns, accounts: accounts, today: today, paid: paid }), ym = today.slice(0, 7);
  return p.fixed.filter(function (f) { return f.dueDay !== null && f.amount > 0; })
    .map(function (f) { return { bill: f.item, amount_idr: f.amount, due_day: f.dueDay, active: 'Y', last_paid: f.status === 'paid' ? ym + '-01' : '' }; });
}

/**
 * The plan for the current month. d = { plan, txns, accounts, today }.
 * Fixed: a bill with an amount and a due day. Non-monthly: a target spread over its months, set aside each month.
 * Flexible: one number for everything that is not in the other two buckets.
 */
function computePlan_(d) {
  var today = d.today, ym = today.slice(0, 7), day = Number(today.slice(8, 10)), dim = daysInMonth_(ym);
  var items = planLatest_(d.plan, ym), spend = familySpend_(d.txns, d.accounts);
  var byCat = {}, planned = {};
  spend.forEach(function (x) { if (x.day.slice(0, 7) === ym) byCat[x.cat] = (byCat[x.cat] || 0) + x.n; });
  var fixed = [], non = [], flexRow = null, sharedCat = {};
  items.forEach(function (r) { if (r.kind === 'fixed' && r.category) sharedCat[r.category] = (sharedCat[r.category] || 0) + 1; });
  items.forEach(function (r) {
    if (r.category) planned[r.category] = true;
    var spent = r.category ? (byCat[r.category] || 0) : 0;
    if (r.kind === 'fixed') {
      var amt = num_(r.amount_idr), due = null, daysTo = null, status = 'later';
      if (has_(r.due_day) && r.due_day !== '') {
        var dd = Math.min(Number(r.due_day), dim);
        due = ym + '-' + (dd < 10 ? '0' : '') + dd; daysTo = daysBetween_(today, due);
      }
      // What counts as paid for this bill: purchases whose payee or memo has one of its keywords, plus any "Paid" taps.
      // Without keywords it falls back to the category, but only if no other fixed bill shares that category.
      var keys = String(r.match || '').toLowerCase().split(',').map(function (k) { return k.trim(); }).filter(function (k) { return k; });
      var paidAmt = 0, paidOn = '', how = '';
      if (keys.length) {
        spend.forEach(function (x) {
          if (x.day.slice(0, 7) !== ym) return;
          if (keys.some(function (k) { return x.txt.indexOf(k) !== -1; })) { paidAmt += x.n; if (x.day > paidOn) paidOn = x.day; }
        });
        how = 'keyword';
      } else if (r.category && sharedCat[r.category] === 1) { paidAmt = spent; how = 'category'; }
      (d.paid || []).forEach(function (pr) {
        if (String(pr.month).slice(0, 7) !== ym || pr.item !== r.item) return;
        paidAmt += num_(pr.amount_idr); var pd = day_(pr.paid_date); if (pd > paidOn) paidOn = pd; how = how || 'tap';
      });
      if (amt > 0 && paidAmt >= amt * 0.95) status = 'paid';
      else if (paidAmt > 0) status = 'part';
      else if (daysTo !== null && daysTo < 0) status = 'late';
      else if (daysTo !== null && daysTo <= 3) status = 'soon';
      fixed.push({ item: r.item, amount: amt, dueDay: due ? Number(due.slice(8, 10)) : null, due: due, daysTo: daysTo, spent: paidAmt, paidOn: paidOn, how: how, match: String(r.match || ''), category: r.category || '', status: status });
    } else if (r.kind === 'nonmonthly') {
      var target = num_(r.target_idr), every = Math.max(1, num_(r.every_months) || 12);
      non.push({ item: r.item, target: target, every: every, setAside: Math.ceil(target / every), spent: spent, category: r.category || '' });
    } else if (r.kind === 'flexible') flexRow = r;
  });
  var flexSpent = 0;
  spend.forEach(function (x) { if (x.day.slice(0, 7) === ym && !planned[x.cat]) flexSpent += x.n; });
  var flexible = null;
  if (flexRow) {
    var amount = num_(flexRow.amount_idr), expected = Math.round(amount * day / dim), left = amount - flexSpent, daysLeft = dim - day + 1;
    var status2 = flexSpent <= expected ? 'on' : (flexSpent <= expected * 1.1 ? 'near' : 'over');
    flexible = { amount: amount, spent: flexSpent, left: left, daysLeft: daysLeft, perDay: Math.max(0, Math.floor(left / daysLeft / 1000) * 1000),
      expected: expected, under: expected - flexSpent, dayFrac: day / dim, day: day, daysInMonth: dim, status: status2 };
  }
  // Suggestion for the flexible number: the average of the last 3 months outside the planned categories.
  // A month with no live data uses the imported YNAB history, so the first weeks do not suggest a tiny number.
  var suggest = null, ms = [], m1 = prevMonth_(ym), m2 = prevMonth_(m1), m3 = prevMonth_(m2);
  [m1, m2, m3].forEach(function (m) {
    var t = 0; spend.forEach(function (x) { if (x.day.slice(0, 7) === m && !planned[x.cat]) t += x.n; });
    if (t <= 0) t = historyCore_(d.history, m, planned);
    if (t > 0) ms.push(t);
  });
  if (ms.length) suggest = Math.round(ms.reduce(function (a, b) { return a + b; }, 0) / ms.length / 100000) * 100000;
  var plannedTotal = fixed.reduce(function (a, f) { return a + f.amount; }, 0) + non.reduce(function (a, n) { return a + n.setAside; }, 0) + (flexible ? flexible.amount : 0);
  return { month: ym, fixed: fixed, nonmonthly: non, flexible: flexible, suggestFlexible: suggest, planned: plannedTotal,
    fixedTotal: fixed.reduce(function (a, f) { return a + f.amount; }, 0), setAsideTotal: non.reduce(function (a, n) { return a + n.setAside; }, 0),
    compare: monthCompare_(d.txns, d.accounts, today) };
}

/** Bucket for a category name, from the Categories rows. */
function bucketForCategory(categories, name) {
  for (var i = 0; i < categories.length; i++) if (categories[i].category === name) return categories[i].bucket || '';
  return '';
}

/** Payee text used to remember a category for next time. */
function ruleKey(payee) {
  return String(payee || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

if (typeof module !== 'undefined') {
  module.exports = { byOf_: byOf_, isBusiness_: isBusiness_, billsFromPlan_: billsFromPlan_, historyCore_: historyCore_, computePlan_: computePlan_, monthCompare_: monthCompare_, planLatest_: planLatest_, findMatches_: findMatches_, dropMatchedManual_: dropMatchedManual_, payeeSummary_: payeeSummary_, eveningText_: eveningText_, spendTotals_: spendTotals_, weekStart_: weekStart_, computeHome: computeHome, reviewItems: reviewItems, settledPayNow: settledPayNow, bucketForCategory: bucketForCategory, ruleKey: ruleKey, nextDue_: nextDue_, firstOfNextMonth_: firstOfNextMonth_ };
}
