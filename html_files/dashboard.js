// Front-end behaviour for dashboard.html.
// Plain classic script (not a module) loaded with a relative path, so it also
// runs when the HTML is opened directly in a browser.
//
// The dashboard is in prototype mode: there is no login check and no logout.
// It reads and writes the shared prototype profile through the public
// /api/prototype/* endpoints. The server keeps that data in the local
// prototype_data_storage.xlsx workbook, so this page works without Postgres.
// The default tab is the stats view, which renders its charts with plain SVG.
// When personal profiles are wired up later, only the CONFIG URLs need to
// change.

/* ─────────────────────────────────────────────────
   BACKEND CONFIG — update these endpoints
───────────────────────────────────────────────── */
const CONFIG = {
  profileEndpoint:           '/api/prototype/profile',
  statsEndpoint:             '/api/prototype/stats',
  transactionEndpoint:       '/api/prototype/transactions',
  removeTransactionEndpoint: '/api/prototype/transactions/remove',
  monthlySetupEndpoint:      '/api/prototype/monthly-setup',
  bigPictureEndpoint:        '/api/prototype/big-picture',
};

/* ─────────────────────────────────────────────────
   STATE
───────────────────────────────────────────────── */
const state = {
  profile: {},
  buckets: [],
  monthly: [],
  transactions: [],
  bigPicture: { entries: [], totals: {} },
  statsPeriod: 'six',
  stats: null,
  statsRequest: 0,
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

const BIG_PICTURE_FIELDS = [
  {
    category: 'income', label: 'Income',
    inputId: 'bigPictureIncome', frequencyId: 'bigPictureIncomeFreq',
    monthlyId: 'bigPictureIncomeMonthly',
  },
  {
    category: 'debt_payment', label: 'Debt payments',
    inputId: 'bigPictureDebt', frequencyId: 'bigPictureDebtFreq',
    monthlyId: 'bigPictureDebtMonthly',
  },
  {
    category: 'schooling', label: 'Schooling expenses',
    inputId: 'bigPictureSchooling', frequencyId: 'bigPictureSchoolingFreq',
    monthlyId: 'bigPictureSchoolingMonthly',
  },
  {
    category: 'insurance', label: 'Insurance',
    inputId: 'bigPictureInsurance', frequencyId: 'bigPictureInsuranceFreq',
    monthlyId: 'bigPictureInsuranceMonthly',
  },
  {
    category: 'savings', label: 'Savings goals',
    inputId: 'bigPictureSavings', frequencyId: 'bigPictureSavingsFreq',
    monthlyId: 'bigPictureSavingsMonthly',
  },
];

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
   STATS CHARTS
   Plain SVG/HTML so the page still has no chart library or build step.
───────────────────────────────────────────────── */
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgNode(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function chartText(svg, x, y, text, className, anchor = 'middle') {
  const node = svgNode('text', { x, y, class: className, 'text-anchor': anchor });
  node.textContent = text;
  svg.appendChild(node);
  return node;
}

function compactMoney(value) {
  const abs = Math.abs(value);
  if (abs >= 1000) return `$${(value / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  if (abs >= 100) return `$${Math.round(value)}`;
  return money.format(value);
}

function niceCeil(value) {
  if (!(value > 0)) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function periodWord(period) {
  return { week: 'Weekly', month: 'Monthly', six: 'Six-month', year: 'Yearly' }[period] || 'Six-month';
}

function chartEmpty(holder, message) {
  holder.innerHTML = '';
  holder.appendChild(el('p', 'chart-empty', message));
}

function renderSpendingChart(series) {
  const holder = document.getElementById('spendingChart');
  holder.innerHTML = '';

  if (!Array.isArray(series) || series.length === 0) {
    chartEmpty(holder, 'No spending data for this period yet.');
    return;
  }

  const W = 720;
  const H = 280;
  const left = 58;
  const right = 14;
  const top = 16;
  const bottom = 44;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const plotBottom = top + plotH;

  const maxValue = Math.max(...series.map(point => Math.max(num(point.total), num(point.expected))), 1);
  const yMax = niceCeil(maxValue * 1.08);
  const yFor = value => plotBottom - (value / yMax) * plotH;
  const xCenter = index => left + ((index + 0.5) / series.length) * plotW;

  const svg = svgNode('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': 'Bar chart of spending against the budget for each point in the selected period',
  });

  for (let step = 0; step <= 4; step += 1) {
    const value = (yMax * step) / 4;
    const y = yFor(value);
    svg.appendChild(svgNode('line', { x1: left, y1: y, x2: W - right, y2: y, class: 'chart-grid-line' }));
    chartText(svg, left - 8, y + 3, compactMoney(value), 'chart-axis-label', 'end');
  }

  const expectedPoints = series
      .map((point, index) => `${xCenter(index)},${yFor(num(point.expected))}`)
      .join(' ');
  svg.appendChild(svgNode('polyline', { points: expectedPoints, class: 'chart-line' }));

  const barWidth = Math.max(2, Math.min(34, (plotW / series.length) * 0.62));
  const showValues = series.length <= 12;

  series.forEach((point, index) => {
    const total = num(point.total);
    const expected = num(point.expected);
    const kind = total <= 0 ? 'empty' : total > expected + 0.005 ? 'over' : 'under';
    const y = yFor(total);
    const height = Math.max(total > 0 ? 1 : 0, plotBottom - y);

    const bar = svgNode('rect', {
      x: xCenter(index) - barWidth / 2,
      y: plotBottom - height,
      width: barWidth,
      height,
      rx: 1,
      class: `chart-bar ${kind}`,
    });
    const title = svgNode('title');
    title.textContent = `${point.label}: ${money.format(total)} spent · ${money.format(expected)} budget`;
    bar.appendChild(title);
    svg.appendChild(bar);

    if (showValues && total > 0) {
      chartText(svg, xCenter(index), plotBottom - height - 5, compactMoney(total), 'chart-value');
    }
  });

  const labelEvery = series.length > 16 ? Math.ceil(series.length / 8) : 1;
  series.forEach((point, index) => {
    if (index % labelEvery !== 0 && index !== series.length - 1) return;
    chartText(svg, xCenter(index), H - 14, point.label, 'chart-label');
  });

  holder.appendChild(svg);
}

function renderRecurringChart(totals) {
  const holder = document.getElementById('recurringChart');
  const legend = document.getElementById('recurringLegend');
  holder.innerHTML = '';
  legend.innerHTML = '';

  const actual = num(totals.actual);
  const recurring = num(totals.recurring);
  const oneTime = num(totals.oneTime);

  if (actual <= 0) {
    chartEmpty(holder, 'No spending in this period yet.');
    return;
  }

  const share = Math.min(1, Math.max(0, recurring / actual));
  const cx = 100;
  const cy = 100;
  const radius = 70;
  const circumference = 2 * Math.PI * radius;

  const svg = svgNode('svg', {
    viewBox: '0 0 200 200',
    class: 'donut',
    role: 'img',
    'aria-label': `Recurring spending is ${Math.round(share * 100)} percent of the total`,
  });
  svg.appendChild(svgNode('circle', { cx, cy, r: radius, class: 'donut-track' }));

  if (recurring > 0) {
    svg.appendChild(svgNode('circle', {
      cx, cy, r: radius,
      class: 'donut-recurring',
      transform: `rotate(-90 ${cx} ${cy})`,
      'stroke-dasharray': `${circumference * share} ${circumference}`,
    }));
  }

  if (oneTime > 0) {
    svg.appendChild(svgNode('circle', {
      cx, cy, r: radius,
      class: 'donut-onetime',
      transform: `rotate(-90 ${cx} ${cy})`,
      'stroke-dasharray': `${circumference * (1 - share)} ${circumference}`,
      'stroke-dashoffset': `${-circumference * share}`,
    }));
  }

  chartText(svg, cx, cy - 2, compactMoney(actual), 'donut-total');
  chartText(svg, cx, cy + 18, 'total spent', 'donut-sub');
  holder.appendChild(svg);

  for (const [name, amount, className] of [
    ['Recurring', recurring, 'recurring'],
    ['One-time', oneTime, 'onetime'],
  ]) {
    const row = el('div', 'donut-legend-row');
    const label = el('span', 'name');
    label.appendChild(el('i', `dot ${className}`));
    label.appendChild(document.createTextNode(name));
    row.appendChild(label);
    row.appendChild(el('span', '', `${money.format(amount)} · ${Math.round((amount / actual) * 100)}%`));
    legend.appendChild(row);
  }
}

function renderBudgetChart(categories) {
  const holder = document.getElementById('budgetChart');
  holder.innerHTML = '';

  const rows = (Array.isArray(categories) ? categories : [])
      .filter(category => num(category.actual) > 0 || num(category.expected) > 0);

  if (rows.length === 0) {
    chartEmpty(holder, 'Set a monthly budget or add a transaction to compare them here.');
    return;
  }

  const maxValue = Math.max(...rows.map(category => Math.max(num(category.actual), num(category.expected))), 1);

  for (const row of rows) {
    const actual = num(row.actual);
    const expected = num(row.expected);
    const difference = num(row.difference);
    const kind = Math.abs(difference) < 0.005 ? 'flat' : difference > 0 ? 'over' : 'under';

    const wrap = el('div', 'budget-row');
    const head = el('div', 'budget-head');
    head.appendChild(el('span', 'budget-name', row.label || prettyKey(row.bucket)));
    head.appendChild(el('span', `delta ${kind}`, signedMoney(difference)));
    wrap.appendChild(head);

    const track = el('div', 'budget-track');
    const fill = el('div', `budget-fill ${kind}`);
    fill.style.width = `${Math.min(100, (actual / maxValue) * 100)}%`;
    track.appendChild(fill);

    if (expected > 0) {
      const marker = el('div', 'budget-marker');
      marker.style.left = `${Math.min(100, (expected / maxValue) * 100)}%`;
      marker.title = `Budget ${money.format(expected)}`;
      track.appendChild(marker);
    }

    wrap.appendChild(track);

    const meta = el('div', 'budget-meta');
    meta.appendChild(el('span', '', `Spent ${money.format(actual)}`));
    meta.appendChild(el('span', '', `Budget ${money.format(expected)}`));
    wrap.appendChild(meta);

    holder.appendChild(wrap);
  }
}

function renderStatsSummary(totals) {
  const holder = document.getElementById('statsSummary');
  holder.innerHTML = '';

  const actual = num(totals.actual);
  const expected = num(totals.expected);
  const difference = num(totals.difference);
  const kind = Math.abs(difference) < 0.005 ? 'flat' : difference > 0 ? 'over' : 'under';
  const count = Number(totals.transactionCount) || 0;

  const cards = [
    {
      label: 'Total spent',
      value: money.format(actual),
      sub: `${count} transaction${count === 1 ? '' : 's'} this period`,
      cls: '',
    },
    {
      label: 'Budget',
      value: money.format(expected),
      sub: totals.budgetSource === 'big_picture'
          ? 'From the Big Picture plan'
          : expected > 0 ? 'From the monthly setup' : 'Set a budget in Big Picture',
      cls: '',
    },
    {
      label: kind === 'over' ? 'Over budget' : kind === 'under' ? 'Under budget' : 'On budget',
      value: signedMoney(difference),
      sub: 'Actual minus budget',
      cls: kind,
    },
    {
      label: 'Recurring',
      value: `${Math.round(num(totals.recurringShare) * 100)}%`,
      sub: `${money.format(num(totals.recurring))} recurring`,
      cls: '',
    },
  ];

  for (const card of cards) {
    const node = el('div', `stat-card ${card.cls}`.trim());
    node.appendChild(el('span', 'stat-label', card.label));
    node.appendChild(el('span', 'stat-value', card.value));
    node.appendChild(el('span', 'stat-sub', card.sub));
    holder.appendChild(node);
  }
}

function renderStats(data) {
  const totals = data.totals || {};
  const range = data.range || {};
  document.getElementById('statsRange').textContent = range.label
      ? `${range.label} · ${periodWord(data.period)} view`
      : `${periodWord(data.period)} view`;

  renderStatsSummary(totals);
  renderSpendingChart(data.series);
  renderRecurringChart(totals);
  renderBudgetChart(data.categories);
}

async function loadStats() {
  const status = document.getElementById('statsStatus');
  const request = ++state.statsRequest;
  clearStatus(status);

  try {
    const result = await api(`${CONFIG.statsEndpoint}?period=${encodeURIComponent(state.statsPeriod)}`);
    if (request !== state.statsRequest) return;

    if (!result.ok) {
      showStatus(status, 'error', result.data.error || 'Could not load spending stats.');
      return;
    }

    state.stats = result.data;
    renderStats(result.data);
  } catch (_) {
    if (request !== state.statsRequest) return;
    showStatus(status, 'error', 'Could not reach the server for spending stats. Is it running?');
  }
}

function setStatsPeriod(period) {
  state.statsPeriod = ['week', 'month', 'six', 'year'].includes(period) ? period : 'six';
  document.querySelectorAll('.period-btn').forEach(button => {
    button.classList.toggle('active', button.dataset.period === state.statsPeriod);
  });
  loadStats();
}

/* ─────────────────────────────────────────────────
   RENDERING — PROFILE + TRANSACTIONS
───────────────────────────────────────────────── */
function renderProfile() {
  const profile = state.profile || {};
  const bigPicture = state.bigPicture || {};
  const bigPictureTotals = bigPicture.totals || {};
  const bigPictureBudget = bigPictureTotals.configured
      ? money.format(num(bigPictureTotals.budget))
      : 'Not set';

  document.getElementById('profileName').textContent = profile.display_name || 'Prototype profile';
  document.getElementById('profileEmail').textContent = 'Shared demo profile — no account needed.';

  const list = document.getElementById('profileList');
  list.innerHTML = '';

  const rows = [
    ['Mode', 'Prototype (shared)'],
    ['Big Picture budget', bigPictureBudget],
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
    const noteWrap = el('span', 'tx-note-wrap');
    noteWrap.appendChild(el('span', 'tx-note', t.note || 'No note'));
    if (t.recurring) noteWrap.appendChild(el('span', 'recurring-badge', 'Recurring'));
    lines.appendChild(noteWrap);
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
   RENDERING — BIG PICTURE
 ───────────────────────────────────────────────── */
function bigPictureEntry(category) {
  const entries = Array.isArray(state.bigPicture?.entries) ? state.bigPicture.entries : [];
  return entries.find(entry => entry.category === category) || null;
}

// Unsaved planner inputs survive a transaction add/remove, just like the
// monthly setup drafts.
function captureBigPictureDrafts() {
  const drafts = new Map();
  for (const field of BIG_PICTURE_FIELDS) {
    const input = document.getElementById(field.inputId);
    const frequency = document.getElementById(field.frequencyId);
    if (!input || !frequency) continue;
    drafts.set(field.category, { amount: input.value, frequency: frequency.value });
  }
  return drafts;
}

function renderBigPicture(drafts = null) {
  for (const field of BIG_PICTURE_FIELDS) {
    const input = document.getElementById(field.inputId);
    const frequency = document.getElementById(field.frequencyId);
    if (!input || !frequency) continue;

    const entry = bigPictureEntry(field.category);
    const draft = drafts ? drafts.get(field.category) : null;
    const amount = draft ? num(draft.amount) : num(entry?.amount);
    input.value = amount > 0 ? amount.toFixed(2) : '';
    frequency.value = draft
        ? draft.frequency
        : (entry?.frequency === 'yearly' ? 'yearly' : 'monthly');
  }

  updateBigPictureSummary();
}

function bigPictureFormValues() {
  const values = {};
  for (const field of BIG_PICTURE_FIELDS) {
    const input = document.getElementById(field.inputId);
    const frequency = document.getElementById(field.frequencyId);
    const amount = Math.max(0, num(input?.value));
    const freq = frequency?.value === 'yearly' ? 'yearly' : 'monthly';
    values[field.category] = {
      amount,
      frequency: freq,
      monthly: amount * (MONTHLY_MULTIPLIER[freq] ?? 1),
    };
  }
  return values;
}

function updateBigPictureSummary() {
  const values = bigPictureFormValues();

  for (const field of BIG_PICTURE_FIELDS) {
    const monthly = document.getElementById(field.monthlyId);
    if (monthly) monthly.textContent = `${money.format(values[field.category].monthly)} / mo`;
  }

  const income = values.income.monthly;
  const recurring =
      values.debt_payment.monthly + values.schooling.monthly + values.insurance.monthly;
  const savings = values.savings.monthly;
  const budget = income - recurring - savings;

  document.getElementById('bigPictureIncomeValue').textContent = money.format(income);
  document.getElementById('bigPictureRecurringValue').textContent = money.format(recurring);
  document.getElementById('bigPictureSavingsValue').textContent = money.format(savings);
  document.getElementById('bigPictureBudgetValue').textContent = money.format(budget);

  const budgetCard = document.getElementById('bigPictureBudgetCard');
  budgetCard.classList.toggle('over', budget < -0.005);

  const formula = document.getElementById('bigPictureFormula');
  const hint = document.getElementById('bigPictureHint');

  if (income <= 0 && recurring <= 0 && savings <= 0) {
    formula.className = 'big-picture-formula';
    formula.textContent = 'Enter income to calculate the monthly budget.';
    hint.textContent = 'No planner amounts yet';
    return;
  }

  if (budget < -0.005) {
    formula.className = 'big-picture-formula negative';
    formula.textContent =
        `${money.format(income)} income − ${money.format(recurring)} recurring payments − ` +
        `${money.format(savings)} savings = ${money.format(budget)} budget. ` +
        'That is over income, so the Stats tab treats the budget as $0 until this is balanced.';
    hint.textContent = 'Budget is over income';
    return;
  }

  formula.className = 'big-picture-formula';
  formula.textContent =
      `${money.format(income)} income − ${money.format(recurring)} recurring payments − ` +
      `${money.format(savings)} savings = ${money.format(budget)} budget per month.`;
  hint.textContent = 'This budget drives the Stats tab';
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
    big_picture: {
      entries: [],
      totals: {
        income: 0, debt_payment: 0, schooling: 0, insurance: 0,
        recurring: 0, savings: 0, budget: 0, configured: false,
      },
    },
    transactions: [],
  };
}

function applyProfile(data, options = {}) {
  const drafts = options.preserveMonthlyDrafts ? captureMonthlyDrafts() : null;
  const bigPictureDrafts = options.preserveBigPictureDrafts ? captureBigPictureDrafts() : null;

  state.profile = data.profile || {};
  state.buckets = Array.isArray(data.buckets) && data.buckets.length ? data.buckets : FALLBACK_BUCKETS;
  state.monthly = normalizeMonthly(data.monthly, state.buckets, drafts);
  state.bigPicture = data.big_picture || { entries: [], totals: {} };
  state.transactions = Array.isArray(data.transactions) ? data.transactions : [];

  renderProfile();
  renderTransactions();
  renderMonthly();
  renderBigPicture(bigPictureDrafts);

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
  for (const panel of ['stats', 'bigPicture', 'transaction', 'monthly']) {
    const active = panel === name;
    const section = document.getElementById(`${panel}Panel`);
    const tab = document.getElementById(`${panel}Tab`);
    if (section) section.hidden = !active;
    if (tab) {
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }
  }

  if (name === 'stats') loadStats();
}

document.querySelectorAll('.option-tab').forEach(tab => {
  tab.addEventListener('click', () => showPanel(tab.dataset.panel));
});

document.querySelectorAll('.period-btn').forEach(button => {
  button.addEventListener('click', () => setStatsPeriod(button.dataset.period));
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
  const recurring = document.getElementById('transactionRecurring').checked;

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
        recurring,
      }),
    });

    if (!result.ok) {
      showStatus(status, 'error', result.data.error || 'Could not save that transaction.');
      return;
    }

    applyProfile(result.data, { preserveMonthlyDrafts: true, preserveBigPictureDrafts: true });
    clearLoadWarning();
    document.getElementById('transactionAmount').value = '';
    document.getElementById('transactionNote').value = '';
    document.getElementById('transactionRecurring').checked = false;
    updateTransactionHint();
    showStatus(status, 'success', `${money.format(amount)} added to ${selected.label}.`);
    loadStats();
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

    applyProfile(result.data, { preserveMonthlyDrafts: true, preserveBigPictureDrafts: true });
    clearLoadWarning();
    showStatus(status, 'success', 'Transaction removed.');
    loadStats();
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

    applyProfile(result.data, { preserveBigPictureDrafts: true });
    clearLoadWarning();
    showStatus(status, 'success', 'Monthly setup saved.');
    loadStats();
  } catch (_) {
    showStatus(status, 'error', 'Could not reach the server. Is it running?');
  } finally {
    button.disabled = false;
  }
});

/* ─────────────────────────────────────────────────
   START
───────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────
   BIG PICTURE
 ───────────────────────────────────────────────── */
for (const eventName of ['input', 'change']) {
  document.getElementById('bigPictureForm').addEventListener(eventName, (event) => {
    const target = event.target;
    if (target instanceof Element && target.matches('[data-big-category], [data-big-frequency]')) {
      updateBigPictureSummary();
    }
  });
}

document.getElementById('bigPictureForm').addEventListener('submit', async (event) => {
  event.preventDefault();

  const status = document.getElementById('bigPictureStatus');
  const button = document.getElementById('saveBigPictureBtn');
  clearStatus(status);

  const values = bigPictureFormValues();
  const entries = [];
  for (const field of BIG_PICTURE_FIELDS) {
    const value = values[field.category];
    if (!(value.amount > 0)) continue;
    entries.push({
      category: field.category,
      amount: value.amount,
      frequency: value.frequency,
    });
  }

  button.disabled = true;

  try {
    const result = await api(CONFIG.bigPictureEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });

    if (!result.ok) {
      showStatus(status, 'error', result.data.error || 'Could not save the Big Picture.');
      return;
    }

    applyProfile(result.data, { preserveMonthlyDrafts: true });
    clearLoadWarning();
    showStatus(status, 'success', 'Big Picture saved. The Stats tab now uses this budget.');
    loadStats();
  } catch (_) {
    showStatus(status, 'error', 'Could not reach the server. Is it running?');
  } finally {
    button.disabled = false;
  }
});

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

  loadStats();
}

init();