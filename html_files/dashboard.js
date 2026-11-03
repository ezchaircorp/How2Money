// Front-end behaviour for dashboard.html.
// Plain classic script (not a module) loaded with a relative path, so it also
// runs when the HTML is opened directly in a browser.
//
// The dashboard is in prototype mode: there is no login check and no logout.
// It reads and writes the shared prototype profile through the public
// /api/prototype/* endpoints. The server keeps that data in the local
// prototype_data_storage.xlsx workbook, so this page works without Postgres.
// When personal profiles are wired up later, only the CONFIG URLs need to
// change.

/* ─────────────────────────────────────────────────
   BACKEND CONFIG — update these endpoints
───────────────────────────────────────────────── */
const CONFIG = {
  profileEndpoint:           '/api/prototype/profile',
  transactionEndpoint:       '/api/prototype/transactions',
  removeTransactionEndpoint: '/api/prototype/transactions/remove',
  monthlySetupEndpoint:      '/api/prototype/monthly-setup',
};

/* ─────────────────────────────────────────────────
   STATE
───────────────────────────────────────────────── */
const state = {
  profile: {},
  buckets: [],
  monthly: [],
  transactions: [],
};

// Readable names for the optional breakdown fields in the assessment. These
// are also the fine-grained transaction categories (Fast Food, Shopping, ...).
const DETAIL_LABELS = {
  expense_housing_rent: 'Rent / Mortgage',
  expense_housing_taxes: 'Property Taxes & Fees',
  expense_housing_repairs: 'Repairs & Maintenance',
  expense_housing_utilities: 'Utilities',
  expense_transportation_gas: 'Gas & Fuel',
  expense_transportation_transit: 'Transit, Rideshare & Parking',
  expense_transportation_auto: 'Auto Repairs & Upkeep',
  expense_food_groceries: 'Groceries',
  expense_food_restaurants: 'Restaurants',
  expense_food_fast_food: 'Fast Food',
  expense_subscriptions_entertainment_recurring: 'Recurring Subscriptions',
  expense_subscriptions_entertainment_onetime: 'Items & Events',
  expense_family_childcare: 'Childcare',
  expense_family_kids: "Kids' Activities",
  expense_family_support: 'Child Support',
  expense_pets_food: 'Pet Food & Supplies',
  expense_pets_vet: 'Vet Care',
  expense_pets_grooming: 'Grooming & Boarding',
};

const FREQUENCIES = [
  ['monthly', 'Monthly'],
  ['yearly', 'Yearly'],
  ['weekly', 'Weekly'],
];

const MONTHLY_MULTIPLIER = {
  monthly: 1,
  yearly: 1 / 12,
  weekly: 52 / 12,
};

// Used when the profile API is unavailable. It mirrors the 11 buckets in
// database/expense_categories.ts so the forms still render and the page still
// shows how to add a transaction. Saving will fail until the server is back.
const FALLBACK_BUCKETS = [
  {
    bucket: 'housing', label: 'Housing',
    detailFields: [
      'expense_housing_rent', 'expense_housing_taxes',
      'expense_housing_repairs', 'expense_housing_utilities',
    ],
  },
  {
    bucket: 'transportation', label: 'Transportation',
    detailFields: [
      'expense_transportation_gas', 'expense_transportation_transit',
      'expense_transportation_auto',
    ],
  },
  {
    bucket: 'food', label: 'Food',
    detailFields: [
      'expense_food_groceries', 'expense_food_restaurants',
      'expense_food_fast_food',
    ],
  },
  { bucket: 'travel', label: 'Travel', detailFields: [] },
  {
    bucket: 'subscriptions_entertainment', label: 'Subscriptions & Entertainment',
    detailFields: [
      'expense_subscriptions_entertainment_recurring',
      'expense_subscriptions_entertainment_onetime',
    ],
  },
  { bucket: 'shopping', label: 'Shopping', detailFields: [] },
  { bucket: 'health_self_care', label: 'Health & Self-Care', detailFields: [] },
  { bucket: 'education', label: 'Education', detailFields: [] },
  { bucket: 'work_professional', label: 'Work & Professional', detailFields: [] },
  {
    bucket: 'family_pets', label: 'Family & Pets',
    detailFields: [
      'expense_family_childcare', 'expense_family_kids',
      'expense_family_support', 'expense_pets_food',
      'expense_pets_vet', 'expense_pets_grooming',
    ],
  },
  { bucket: 'household', label: 'Household', detailFields: [] },
];

/* ─────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────── */
const money = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD',
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

function todayString() {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function formatDate(value) {
  if (!value) return '';
  const text = value instanceof Date
    ? value
    : (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatWhen(value) {
  if (!value) return 'Not saved yet';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Not saved yet';

  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' min ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' hr ago';
  return formatDate(value);
}

function signedMoney(value) {
  if (Math.abs(value) < 0.005) return money.format(0);
  return (value > 0 ? '+' : '-') + money.format(Math.abs(value));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function prettyKey(key) {
  return String(key || '')
    .replace(/^expense_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty body is fine */ }
  return { ok: res.ok, status: res.status, data };
}

function showStatus(target, type, msg) {
  target.className = `status-msg visible ${type}`;
  target.textContent = msg;
}

function clearStatus(target) {
  target.className = 'status-msg';
  target.textContent = '';
}

function clearLoadWarning() {
  const status = document.getElementById('loadStatus');
  if (status) clearStatus(status);
}

function labelForBucket(bucket) {
  const found = state.buckets.find(b => b.bucket === bucket);
  return found ? found.label : prettyKey(bucket);
}

function categoryLabel(category, bucket) {
  return DETAIL_LABELS[category] || labelForBucket(bucket) || prettyKey(category);
}

/* ─────────────────────────────────────────────────
   RENDERING — PROFILE + TRANSACTIONS
───────────────────────────────────────────────── */
function renderProfile() {
  const profile = state.profile || {};

  document.getElementById('profileName').textContent = profile.display_name || 'Prototype profile';
  document.getElementById('profileEmail').textContent = 'Shared demo profile — no account needed.';

  const list = document.getElementById('profileList');
  list.innerHTML = '';

  const rows = [
    ['Mode', 'Prototype (shared)'],
    ['Expected per month', money.format(num(profile.total_monthly))],
    ['Actual this month', money.format(num(profile.actual_month))],
    ['Transactions this month', String(Number(profile.transaction_count) || 0)],
    ['Categories set', `${Number(profile.category_count) || 0} of ${state.buckets.length}`],
    ['Last updated', formatWhen(profile.updated_at)],
  ];

  for (const [key, value] of rows) {
    const li = el('li');
    li.appendChild(el('span', 'k', key));
    li.appendChild(el('span', 'v', value));
    list.appendChild(li);
  }

  document.getElementById('profileCard').hidden = false;
}

function renderTransactions() {
  const list = document.getElementById('transactionsList');
  list.innerHTML = '';

  if (state.transactions.length === 0) {
    list.appendChild(el('li', 'empty-note', 'No transactions yet. Add one in the left panel and it will show up here.'));
    document.getElementById('transactionsCard').hidden = false;
    return;
  }

  for (const t of state.transactions) {
    const li = el('li', 'history-item');

    const head = el('div', 'history-window');
    head.appendChild(el('span', 'when',
      `${formatDate(t.spent_on)} · ${categoryLabel(t.category, t.bucket)}`));
    head.appendChild(el('span', 'total', money.format(num(t.amount))));
    li.appendChild(head);

    const lines = el('div', 'history-lines transaction-meta');
    lines.appendChild(el('span', 'tx-note', t.note || 'No note'));
    const remove = el('button', 'btn-remove', 'Remove');
    remove.type = 'button';
    remove.dataset.removeTransaction = t.id;
    lines.appendChild(remove);
    li.appendChild(lines);

    list.appendChild(li);
  }

  document.getElementById('transactionsCard').hidden = false;
}

/* ─────────────────────────────────────────────────
   RENDERING — TRANSACTION CATEGORY PICKER
───────────────────────────────────────────────── */
function transactionCategories() {
  const groups = [];
  for (const bucket of state.buckets) {
    const fields = Array.isArray(bucket.detailFields) ? bucket.detailFields : [];
    const items = fields.length
      ? fields.map(key => ({ key, label: DETAIL_LABELS[key] || prettyKey(key) }))
      : [{ key: bucket.bucket, label: bucket.label }];
    groups.push({ bucket, items });
  }
  return groups;
}

function renderTransactionCategories() {
  const select = document.getElementById('transactionCategory');
  const previous = select.value;
  select.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a category';
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);

  for (const group of transactionCategories()) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.bucket.label;

    for (const item of group.items) {
      const option = document.createElement('option');
      option.value = item.key;
      option.dataset.bucket = group.bucket.bucket;
      option.textContent = item.label;
      optgroup.appendChild(option);
    }

    select.appendChild(optgroup);
  }

  if (previous && Array.from(select.options).some(option => option.value === previous)) {
    select.value = previous;
  }
}

function selectedTransactionCategory() {
  const select = document.getElementById('transactionCategory');
  const option = select.selectedOptions[0];
  return {
    category: select.value,
    bucket: option ? option.dataset.bucket || '' : '',
    label: option ? option.textContent : '',
  };
}

function updateTransactionHint() {
  const selected = selectedTransactionCategory();
  const amount = num(document.getElementById('transactionAmount').value);
  const date = document.getElementById('transactionDate').value;
  const hint = document.getElementById('transactionHint');

  if (!selected.category) {
    hint.textContent = 'Choose a category and enter an amount.';
    return;
  }

  hint.textContent = amount > 0
    ? `Adds ${money.format(amount)} to ${selected.label}${date ? ` on ${formatDate(date)}` : ''}.`
    : `Pick an amount for ${selected.label}.`;
}

/* ─────────────────────────────────────────────────
   RENDERING — MONTHLY SETUP
───────────────────────────────────────────────── */
// Unsaved monthly inputs survive a transaction add/remove so switching tabs
// in the middle of a setup edit doesn't quietly throw the edit away.
function captureMonthlyDrafts() {
  const drafts = new Map();
  for (const tr of document.querySelectorAll('#monthlyBody tr')) {
    const input = tr.querySelector('.monthly-input');
    const frequency = tr.querySelector('.monthly-freq');
    if (!input || !frequency) continue;
    drafts.set(tr.dataset.bucket, { amount: input.value, frequency: frequency.value });
  }
  return drafts;
}

function normalizeMonthly(monthly, buckets, drafts = null) {
  const byBucket = new Map((Array.isArray(monthly) ? monthly : []).map(m => [m.bucket, m]));

  return buckets.map(bucket => {
    const row = byBucket.get(bucket.bucket) || {};
    const draft = drafts ? drafts.get(bucket.bucket) : null;
    return {
      bucket: bucket.bucket,
      label: row.label || bucket.label,
      categories: row.categories || bucket.categories || [],
      weight: row.weight ?? bucket.weight ?? 0,
      expected: draft ? num(draft.amount) : num(row.expected),
      frequency: draft ? draft.frequency : (row.frequency || 'monthly'),
      expectedMonthly: num(row.expectedMonthly),
      actual: num(row.actual),
      transactionCount: Number(row.transactionCount) || 0,
      detail: row.detail || {},
      updated_at: row.updated_at || null,
    };
  });
}

function renderMonthly() {
  const body = document.getElementById('monthlyBody');
  body.innerHTML = '';

  for (const row of state.monthly) {
    const tr = el('tr');
    tr.dataset.bucket = row.bucket;
    tr.dataset.actual = String(row.actual);

    const nameCell = el('td');
    nameCell.appendChild(el('span', 'plan-name', row.label));
    if (row.transactionCount > 0) {
      nameCell.appendChild(el('span', 'plan-cats',
        `${row.transactionCount} transaction${row.transactionCount === 1 ? '' : 's'} this month`));
    }
    tr.appendChild(nameCell);

    const expectedCell = el('td', 'num');
    const amount = document.createElement('input');
    amount.type = 'number';
    amount.className = 'monthly-input';
    amount.min = '0';
    amount.step = '0.01';
    amount.inputMode = 'decimal';
    amount.placeholder = '0.00';
    amount.value = row.expected > 0 ? row.expected.toFixed(2) : '';
    amount.setAttribute('aria-label', `${row.label} expected monthly amount`);
    expectedCell.appendChild(amount);
    tr.appendChild(expectedCell);

    const frequencyCell = el('td');
    const frequency = document.createElement('select');
    frequency.className = 'monthly-freq';
    frequency.setAttribute('aria-label', `${row.label} frequency`);
    for (const [value, label] of FREQUENCIES) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      frequency.appendChild(option);
    }
    frequency.value = MONTHLY_MULTIPLIER[row.frequency] ? row.frequency : 'monthly';
    frequencyCell.appendChild(frequency);
    tr.appendChild(frequencyCell);

    const actualCell = el('td', 'num actual-value', money.format(row.actual));
    actualCell.title = 'Actual spending this month';
    tr.appendChild(actualCell);

    const diffCell = el('td', 'num delta-cell');
    tr.appendChild(diffCell);

    body.appendChild(tr);
  }

  updateMonthlyTotals();
}

function monthlyTotals() {
  const rows = Array.from(document.querySelectorAll('#monthlyBody tr'));
  let expected = 0;
  let actual = 0;
  let count = 0;

  for (const tr of rows) {
    const amount = num(tr.querySelector('.monthly-input').value);
    const frequency = tr.querySelector('.monthly-freq').value;
    expected += amount * (MONTHLY_MULTIPLIER[frequency] ?? 1);
    actual += num(tr.dataset.actual);
    if (amount > 0) count += 1;
  }

  return { rows, expected, actual, count };
}

function updateMonthlyRow(tr) {
  const amount = num(tr.querySelector('.monthly-input').value);
  const frequency = tr.querySelector('.monthly-freq').value;
  const expectedMonthly = amount * (MONTHLY_MULTIPLIER[frequency] ?? 1);
  const actual = num(tr.dataset.actual);
  const cell = tr.querySelector('.delta-cell');

  cell.innerHTML = '';
  cell.className = 'num delta-cell';

  if (amount <= 0) {
    cell.textContent = '—';
    return;
  }

  const difference = actual - expectedMonthly;
  const kind = Math.abs(difference) < 0.005 ? 'flat' : (difference > 0 ? 'over' : 'under');
  const badge = el('span', `delta ${kind}`, signedMoney(difference));
  badge.title = 'Actual minus expected for this month';
  cell.appendChild(badge);
}

function updateMonthlyTotals() {
  const { rows, expected, actual, count } = monthlyTotals();

  document.getElementById('monthlyTotals').textContent =
    `Expected ${money.format(expected)} / month · Actual ${money.format(actual)} this month`;
  document.getElementById('monthlyHint').textContent =
    count ? `${count} of ${rows.length} categories set` : 'No expected amounts yet';

  for (const tr of rows) updateMonthlyRow(tr);
}

/* ─────────────────────────────────────────────────
   APPLYING A PAYLOAD
───────────────────────────────────────────────── */
function fallbackPayload() {
  return {
    profile: {
      key: 'prototype',
      display_name: 'Prototype profile',
      category_count: 0,
      total_monthly: '0.00',
      actual_month: '0.00',
      transaction_count: 0,
      updated_at: null,
    },
    buckets: FALLBACK_BUCKETS,
    monthly: [],
    transactions: [],
  };
}

function applyProfile(data, options = {}) {
  const drafts = options.preserveMonthlyDrafts ? captureMonthlyDrafts() : null;

  state.profile = data.profile || {};
  state.buckets = Array.isArray(data.buckets) && data.buckets.length ? data.buckets : FALLBACK_BUCKETS;
  state.monthly = normalizeMonthly(data.monthly, state.buckets, drafts);
  state.transactions = Array.isArray(data.transactions) ? data.transactions : [];

  renderProfile();
  renderTransactions();
  renderMonthly();

  if (document.getElementById('transactionCategory').options.length === 0) {
    renderTransactionCategories();
  }
  if (!document.getElementById('transactionDate').value) {
    document.getElementById('transactionDate').value = todayString();
  }
  updateTransactionHint();
}

/* ─────────────────────────────────────────────────
   TABS
───────────────────────────────────────────────── */
function showPanel(name) {
  const transaction = name === 'transaction';
  const transactionTab = document.getElementById('transactionTab');
  const monthlyTab = document.getElementById('monthlyTab');

  document.getElementById('transactionPanel').hidden = !transaction;
  document.getElementById('monthlyPanel').hidden = transaction;

  transactionTab.classList.toggle('active', transaction);
  monthlyTab.classList.toggle('active', !transaction);
  transactionTab.setAttribute('aria-selected', String(transaction));
  monthlyTab.setAttribute('aria-selected', String(!transaction));
}

document.querySelectorAll('.option-tab').forEach(tab => {
  tab.addEventListener('click', () => showPanel(tab.dataset.panel));
});

/* ─────────────────────────────────────────────────
   TRANSACTION FORM
───────────────────────────────────────────────── */
document.getElementById('transactionDate').value = todayString();
document.getElementById('transactionCategory').addEventListener('change', updateTransactionHint);
document.getElementById('transactionAmount').addEventListener('input', updateTransactionHint);
document.getElementById('transactionDate').addEventListener('change', updateTransactionHint);

document.getElementById('transactionForm').addEventListener('submit', async (event) => {
  event.preventDefault();

  const status = document.getElementById('transactionStatus');
  clearStatus(status);

  const selected = selectedTransactionCategory();
  const amount = num(document.getElementById('transactionAmount').value);
  const spentOn = document.getElementById('transactionDate').value || todayString();
  const note = document.getElementById('transactionNote').value.trim();

  if (!selected.category || !selected.bucket) {
    showStatus(status, 'error', 'Pick a category first.');
    return;
  }

  if (!(amount > 0)) {
    showStatus(status, 'error', 'Enter an amount greater than zero.');
    return;
  }

  const button = document.getElementById('transactionBtn');
  button.disabled = true;

  try {
    const result = await api(CONFIG.transactionEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: selected.category,
        bucket: selected.bucket,
        amount,
        spent_on: spentOn,
        note,
      }),
    });

    if (!result.ok) {
      showStatus(status, 'error', result.data.error || 'Could not save that transaction.');
      return;
    }

    applyProfile(result.data, { preserveMonthlyDrafts: true });
    clearLoadWarning();
    document.getElementById('transactionAmount').value = '';
    document.getElementById('transactionNote').value = '';
    updateTransactionHint();
    showStatus(status, 'success', `${money.format(amount)} added to ${selected.label}.`);
  } catch (_) {
    showStatus(status, 'error', 'Could not reach the server. Is it running?');
  } finally {
    button.disabled = false;
  }
});

// One listener handles every Remove button, including the ones rendered after
// an add.
document.getElementById('transactionsList').addEventListener('click', async (event) => {
  const target = event.target;
  const button = target instanceof Element ? target.closest('[data-remove-transaction]') : null;
  if (!button) return;

  const status = document.getElementById('transactionStatus');
  const id = button.dataset.removeTransaction;
  clearStatus(status);
  button.disabled = true;

  try {
    const result = await api(CONFIG.removeTransactionEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_id: id }),
    });

    if (!result.ok) {
      showStatus(status, 'error', result.data.error || 'Could not remove that transaction.');
      return;
    }

    applyProfile(result.data, { preserveMonthlyDrafts: true });
    clearLoadWarning();
    showStatus(status, 'success', 'Transaction removed.');
  } catch (_) {
    showStatus(status, 'error', 'Could not reach the server. Is it running?');
  } finally {
    button.disabled = false;
  }
});

/* ─────────────────────────────────────────────────
   MONTHLY SETUP
───────────────────────────────────────────────── */
document.getElementById('monthlyBody').addEventListener('input', (event) => {
  const target = event.target;
  if (target instanceof Element && target.matches('.monthly-input, .monthly-freq')) {
    updateMonthlyTotals();
  }
});

document.getElementById('monthlyBody').addEventListener('change', (event) => {
  const target = event.target;
  if (target instanceof Element && target.matches('.monthly-input, .monthly-freq')) {
    updateMonthlyTotals();
  }
});

document.getElementById('saveMonthlyBtn').addEventListener('click', async () => {
  const status = document.getElementById('monthlyStatus');
  const button = document.getElementById('saveMonthlyBtn');
  clearStatus(status);

  const entries = [];
  for (const tr of document.querySelectorAll('#monthlyBody tr')) {
    const amount = num(tr.querySelector('.monthly-input').value);
    if (!(amount > 0)) continue;
    entries.push({
      bucket: tr.dataset.bucket,
      amount,
      frequency: tr.querySelector('.monthly-freq').value,
    });
  }

  button.disabled = true;

  try {
    const result = await api(CONFIG.monthlySetupEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });

    if (!result.ok) {
      showStatus(status, 'error', result.data.error || 'Could not save the monthly setup.');
      return;
    }

    applyProfile(result.data);
    clearLoadWarning();
    showStatus(status, 'success', 'Monthly setup saved.');
  } catch (_) {
    showStatus(status, 'error', 'Could not reach the server. Is it running?');
  } finally {
    button.disabled = false;
  }
});

/* ─────────────────────────────────────────────────
   START
───────────────────────────────────────────────── */
async function init() {
  const loading = document.getElementById('loadingState');
  const content = document.getElementById('dashContent');
  const loadStatus = document.getElementById('loadStatus');

  try {
    const result = await api(CONFIG.profileEndpoint);
    if (!result.ok) {
      throw new Error(result.data.error || 'Could not load the prototype profile.');
    }
    applyProfile(result.data);
  } catch (err) {
    // Keep the dashboard usable even when the profile API is down. The forms
    // stay visible with empty fallback categories, and saving reports its own
    // error instead of hiding the page behind a generic error card.
    applyProfile(fallbackPayload());
    showStatus(loadStatus, 'error',
      'The saved profile could not load. The forms are still visible, but saving will fail until the server is running.');
    console.error(err);
  } finally {
    loading.hidden = true;
    content.hidden = false;
  }
}

init();
