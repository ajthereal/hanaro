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

/** Purchases that still count as money out: not void, not unread, not duplicate. */
function countsAsSpend_(t) {
  return t.txn_type === 'purchase' && (t.status === 'auto' || t.status === 'confirmed');
}

/**
 * Pay-now purchases (cards that must be paid the same day) are settled when a card payment of
 * the same amount follows within 24 hours, or when the person marked them paid.
 * Returns { purchaseId: true } for the settled ones.
 */
function settledPayNow(txns) {
  var payments = txns.filter(function (t) { return t.txn_type === 'payment' && liveTxn_(t); })
    .map(function (t) { return { t: t, ms: Date.parse(t.timestamp), used: false }; });
  var out = {};
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

/** Everything the Home screen shows. d = { txns, accounts, buckets, balances, bills, debts, summary, today } */
function computeHome(d) {
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
  var ob = obligationsUntil_(today, horizon, d.bills || [], d.debts || []);
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

  var notes = [], safe = null, needs = [];
  if (!counted) needs.push('balances');
  if (!capped.length) needs.push('caps');
  if (counted) {
    var cashSide = cash - obTotal - Math.max(heldTotal, 0);
    var basis = capped.length ? Math.min(bucketsLeft, cashSide) : cashSide;
    safe = Math.max(0, Math.floor(basis / days / 1000) * 1000);
    if (cashSide < 0) notes.push('Cash is below the bills and minimums due before ' + monthName_(horizon) + '.');
    else notes.push('Bills and minimums are covered until ' + monthName_(horizon) + '. Money that has not landed never counts.');
    if (!capped.length) notes.push('Set bucket caps to include them in this number.');
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
    : (capped.length ? 'Every bucket is under 80%. Nice and steady.' : 'Add bucket caps in Status to see how each area is doing.');

  var items = reviewItems(d.txns);
  return {
    today: today, horizon: horizon, days: days, safeToSpend: safe, needs: needs, notes: notes,
    buckets: buckets, insight: insight, cash: counted ? cash : null, obligations: ob,
    heldTotal: heldTotal, heldByType: heldByType,
    debtDown: Math.round(paidNow - newCard), debtCost: cost === null ? null : Math.round(cost),
    reviewCount: items.length, payNowCount: items.filter(function (i) { return i.kind === 'pay_now'; }).length,
    lastSync: summary.last_sync_ok || null
  };
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
  module.exports = { computeHome: computeHome, reviewItems: reviewItems, settledPayNow: settledPayNow, bucketForCategory: bucketForCategory, ruleKey: ruleKey, nextDue_: nextDue_, firstOfNextMonth_: firstOfNextMonth_ };
}
