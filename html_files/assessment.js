// Front-end behaviour for assessment.html.
// Extracted from the page's inline <script> block. Plain classic script (not a
// module) loaded with a relative path, so it also runs when the HTML is opened
// directly in a browser.
//
// Responsibilities: the optional advisor image, the signed-in note, turning the
// expense rows into the JSON payload, the breakdown running totals, the
// submit-button gate, and the client-side calculations behind the results
// screen. Nothing on this page is sent to the server: the numbers are scored in
// the browser against expense_weight.json (served read-only by
// /api/expense-weights) and never stored anywhere.

/* ─────────────────────────────────────────────────
   BACKEND CONFIG — update these endpoints
───────────────────────────────────────────────── */
const CONFIG = {
  weightsEndpoint:'/api/expense-weights',    // GET → expense_weight.json + bucket mappings
  meEndpoint:     '/api/me',                 // GET → the signed-in user, if there is one
};

/* ─────────────────────────────────────────────────
   ADVISOR IMAGE
   The page ships with a default image. window.setAdvisorImage stays available
   for the console/parent frame, but there is no backend endpoint to fetch from.
───────────────────────────────────────────────── */
// Can also be called directly from the console or parent frame
window.setAdvisorImage = function(url, caption, subcaption) {
  const frame = document.getElementById('imageFrame');
  const img   = document.getElementById('dynamicImage');
  frame.classList.add('loading');
  img.src = url;
  img.onload = () => frame.classList.remove('loading');
  if (caption)    document.getElementById('imageCaption').textContent    = caption;
  if (subcaption) document.getElementById('imageSubcaption').textContent = subcaption;
};

/* ─────────────────────────────────────────────────
   ARE THEY SIGNED IN?
   If they are, this assessment lands on their
   dashboard instead of floating around as a lead.
───────────────────────────────────────────────── */
(async function checkSignedIn() {
  try {
    const res = await fetch(CONFIG.meEndpoint, { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !data.user) return;

    const note = document.getElementById('signedInNote');
    note.textContent = `Signed in as ${data.user.name} — results are calculated in your browser and are not saved to your account.`;
    note.hidden = false;
  } catch (_) {
    // No server, no problem — the form still works.
  }
})();

/* ─────────────────────────────────────────────────
   FORM SUBMISSION
───────────────────────────────────────────────── */
const form       = document.getElementById('assessmentForm');
const submitBtn  = document.getElementById('submitBtn');
const formStatus = document.getElementById('formStatus');

function showStatus(el, type, msg) {
  el.className = `status-msg visible ${type}`;
  el.textContent = msg;
}
function clearStatus(el) {
  el.className = 'status-msg';
  el.textContent = '';
}

/* ─────────────────────────────────────────────────
   COLLECT THE EXPENSE BUCKETS
   Each .expense-item holds one bucket: a total box, a
   frequency dropdown, and an optional breakdown.
───────────────────────────────────────────────── */
function collectExpenses() {
  const expenses = [];

  form.querySelectorAll('.expense-item').forEach(item => {
    const total = item.querySelector('.total-cell input[type="number"], .expense-row > input[type="number"]');
    if (!total) return;

    const amount = num(total.value);
    if (!(amount > 0)) return;

    const bucket = item.dataset.expense || total.name.replace(/^expense_/, '');
    const freqEl = item.querySelector('.expense-freq');

    // The optional breakdown boxes, if they were filled in.
    const detail = {};
    item.querySelectorAll('.expense-breakdown input[type="number"]').forEach(field => {
      const value = num(field.value);
      if (value > 0) detail[field.name] = value;
    });

    expenses.push({
      bucket,
      amount,
      frequency: freqEl ? freqEl.value : 'monthly',
      detail,
    });
  });

  return expenses;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearStatus(formStatus);

  // The submit button is gated, but re-check for safety
  if (!formReady()) {
    updateGate();
    showStatus(formStatus, 'error', 'Please fill in your name, email, income, and at least one expense before continuing.');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.classList.add('loading');

  try {
    // Reference data comes from the server (expense_weight.json); the math
    // itself runs right here and the numbers never leave the browser.
    const data = await getWeights();
    const result = computeAssessment(collectExpenses(), data);
    renderResults(result);
    showResults();
  } catch (err) {
    showStatus(formStatus, 'error', err.message || 'Could not calculate your results. Please try again.');
    updateGate();
  } finally {
    submitBtn.classList.remove('loading');
  }
});

// Clear field error styling on input
form.querySelectorAll('input, select, textarea').forEach(el => {
  el.addEventListener('input', () => el.style.borderColor = '');
});

/* ─────────────────────────────────────────────────
   EXPENSE BREAKDOWNS + RUNNING TOTALS
   Typing a total reveals that category's detail boxes.
   Once a detail box is edited, the total becomes a
   read-only running sum. "Enter manually" opts back out.
───────────────────────────────────────────────── */
const totals = Array.from(form.querySelectorAll('input[data-expense-total]'));
const num    = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

totals.forEach(total => {
  const item = total.closest('.expense-item');
  const breakdown = item.querySelector('.expense-breakdown');
  const fields = Array.from(breakdown.querySelectorAll('input'));

  const detailFilled = () => fields.some(f => f.value.trim() !== '');

  const refresh = () => {
    const locked = total.readOnly;
    item.classList.toggle('split-open', locked || total.value.trim() !== '');
    if (locked) {
      total.value = fields.reduce((sum, f) => sum + num(f.value), 0).toFixed(2);
    }
  };

  // Typing a bare total opens the breakdown for optional detail
  total.addEventListener('input', () => {
    if (!total.readOnly) refresh();
  });

  fields.forEach(f => {
    f.addEventListener('input', () => {
      // First edit of any detail box hands the total over to the running sum
      if (detailFilled()) total.readOnly = true;
      refresh();
    });
  });

  // Opt back out: clear the details AND the calculated total so it can be typed again
  item.querySelector('[data-expense-reset]').addEventListener('click', () => {
    total.readOnly = false;
    total.value = '';
    fields.forEach(f => { f.value = ''; });
    refresh();
    // Clearing an expense may leave the form without any amount filled
    form.dispatchEvent(new Event('change', { bubbles: true }));
  });

  refresh();
});

/* ─────────────────────────────────────────────────
   SUBMIT BUTTON GATING
   Enabled only once name, email, income and at least
   one expense box have content.
───────────────────────────────────────────────── */
const gateIds = ['firstName', 'lastName', 'email', 'householdIncome'];
const allExpenseInputs = Array.from(form.querySelectorAll('input[name^="expense_"]'))
  .filter(el => !el.name.endsWith('_freq'));

function formReady() {
  const fieldsFilled = gateIds.every(id => {
    const el = document.getElementById(id);
    return el && el.value.trim() !== '';
  });
  // Any single expense box with a real amount satisfies the requirement
  const anyExpense = allExpenseInputs.some(el => el.value.trim() !== '' && num(el.value) > 0);
  return fieldsFilled && anyExpense;
}

function updateGate() {
  const ready = formReady();
  submitBtn.disabled = !ready;
  submitBtn.setAttribute('aria-disabled', String(!ready));
}

form.addEventListener('input', updateGate);
form.addEventListener('change', updateGate);
updateGate();

/* ─────────────────────────────────────────────────
   RESULTS: CLIENT-SIDE CALCULATIONS
   The form's buckets are broad; expense_weight.json
   knows 23 finer categories with a necessity weight
   (1 = junk, 10 = unavoidable) and a typical monthly
   cost. Each bucket's number is split across those
   categories — by the filled-in breakdown boxes when
   present, otherwise proportionally to the typical
   costs — and then banded, charted, and compared to
   the national average. Nothing is sent or stored.
───────────────────────────────────────────────── */

const resultsPanel    = document.getElementById('resultsPanel');
const meterCard       = document.getElementById('meterCard');
const pieBandsEl      = document.getElementById('pieBands');
const pieFunEl        = document.getElementById('pieFun');
const necessityEl     = document.getElementById('necessityCompare');
const editBtn         = document.getElementById('editBtn');
const headingEl       = document.getElementById('assessmentHeading');

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const moneyPrecise = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Months per year → convert every entered amount to a monthly figure.
const FREQ_MULTIPLIER = { monthly: 1, yearly: 1 / 12, weekly: 52 / 12 };

const BAND_META = {
  necessity: { label: 'Necessities', color: '#0A1628' },
  optional:  { label: 'Optional',    color: '#C9A84C' },
  junk:      { label: 'Junk',        color: '#C0392B' },
};

const FUN_COLORS = ['#0A1628', '#1E3A5F', '#C9A84C', '#7A8B99', '#E8D5A3', '#C0392B', '#1A7A4A', '#9AA7B5'];

// Weight bands: 7–10 is hard to avoid, 4–6 is a judgment call, 1–3 is the
// easiest spending to trim.
function bandOf(weight) {
  if (weight >= 7) return 'necessity';
  if (weight >= 4) return 'optional';
  return 'junk';
}

/* ── Reference data (served from expense_weight.json) ── */
let weightData = null;
let weightPromise = null;

function getWeights() {
  if (weightData) return Promise.resolve(weightData);
  if (!weightPromise) {
    weightPromise = fetch(CONFIG.weightsEndpoint, { credentials: 'same-origin' })
      .then(res => {
        if (!res.ok) throw new Error('The national-average data could not be loaded. Start the site from the server to see the comparison.');
        return res.json();
      })
      .then(data => {
        weightData = data;
        return data;
      })
      .catch(err => {
        weightPromise = null;      // let a later submit retry
        throw err;
      });
  }
  return weightPromise;
}

// Warm the cache on load; failures stay quiet until the person submits.
getWeights().catch(() => {});

/* ── The math ── */
function computeAssessment(expenses, data) {
  const categories = new Map(data.categories.map(c => [c.name, c]));
  const allocations = new Map();   // canonical category → monthly dollars

  const add = (name, amount) => allocations.set(name, (allocations.get(name) ?? 0) + amount);

  for (const expense of expenses) {
    const bucket = data.buckets[expense.bucket];
    if (!bucket) continue;

    const multiplier = FREQ_MULTIPLIER[expense.frequency] ?? 1;
    const total = expense.amount * multiplier;
    if (!(total > 0)) continue;

    const cats = bucket.categories.map(name => categories.get(name)).filter(Boolean);
    if (cats.length === 0) continue;

    // Filled breakdown boxes, mapped to their canonical category.
    const filled = new Map();
    let filledTotal = 0;
    for (const detail of bucket.details) {
      const raw = Number(expense.detail?.[detail.field] ?? 0);
      if (!(raw > 0)) continue;
      const amount = raw * multiplier;
      filled.set(detail.category, (filled.get(detail.category) ?? 0) + amount);
      filledTotal += amount;
    }

    if (filled.size > 0) {
      const uncovered = cats.filter(c => !filled.has(c.name));

      if (uncovered.length === 0) {
        // Every category has a breakdown number — scale it to the bucket total
        // so the parts always add up to the amount that was entered.
        const scale = filledTotal > 0 ? total / filledTotal : 0;
        for (const [name, amount] of filled) add(name, amount * scale);
      } else {
        // Trust the breakdown, but keep the bucket total intact.
        const scale = filledTotal > total ? total / filledTotal : 1;
        for (const [name, amount] of filled) add(name, amount * scale);

        const remainder = Math.max(total - filledTotal, 0);
        if (remainder > 0) {
          const avgSum = uncovered.reduce((sum, c) => sum + c.average, 0);
          for (const c of uncovered) {
            add(c.name, avgSum > 0 ? remainder * c.average / avgSum : remainder / uncovered.length);
          }
        }
      }
    } else {
      // No breakdown: split the bucket in proportion to the typical costs.
      const avgSum = cats.reduce((sum, c) => sum + c.average, 0);
      for (const c of cats) {
        add(c.name, avgSum > 0 ? total * c.average / avgSum : total / cats.length);
      }
    }
  }

  const rows = Array.from(allocations.entries())
    .filter(([, amount]) => amount > 0.005)
    .map(([name, actual]) => {
      const category = categories.get(name);
      const weight = category ? category.weight : 5;
      return {
        name,
        actual,
        expected: category ? category.average : 0,
        weight,
        band: bandOf(weight),
      };
    })
    .sort((a, b) => b.actual - a.actual);

  const bands = {
    necessity: { actual: 0, expected: 0 },
    optional:  { actual: 0, expected: 0 },
    junk:      { actual: 0, expected: 0 },
  };
  for (const row of rows) {
    bands[row.band].actual += row.actual;
    bands[row.band].expected += row.expected;
  }

  return {
    rows,
    bands,
    totalActual: rows.reduce((sum, r) => sum + r.actual, 0),
    totalExpected: rows.reduce((sum, r) => sum + r.expected, 0),
  };
}

/* ── Charts: plain SVG, no libraries ── */
function arcPath(cx, cy, radius, start, end) {
  const x1 = cx + radius * Math.cos(start);
  const y1 = cy + radius * Math.sin(start);
  const x2 = cx + radius * Math.cos(end);
  const y2 = cy + radius * Math.sin(end);
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
}

function renderPie(slices) {
  const visible = slices.filter(s => s.value > 0);
  if (visible.length === 0) {
    return '<p class="pie-empty">Nothing in this part of your budget.</p>';
  }

  const total = visible.reduce((sum, s) => sum + s.value, 0);
  const size = 180;
  const c = size / 2;
  const r = c - 4;

  let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Spending split">`;

  if (visible.length === 1) {
    const only = visible[0];
    svg += `<circle cx="${c}" cy="${c}" r="${r}" fill="${only.color}" />`;
  } else {
    let angle = -Math.PI / 2;   // start at 12 o'clock
    for (const slice of visible) {
      const sweep = (slice.value / total) * Math.PI * 2;
      svg += `<path d="${arcPath(c, c, r, angle, angle + sweep)}" fill="${slice.color}" stroke="#fff" stroke-width="1.5" />`;
      angle += sweep;
    }
  }
  svg += '</svg>';

  const legend = visible.map(slice => `
    <li>
      <span class="legend-dot" style="background:${slice.color}"></span>
      <span class="legend-label">${slice.label}</span>
      <span class="legend-value">${moneyFmt.format(slice.value)} · ${Math.round(slice.value / total * 100)}%</span>
    </li>`).join('');

  return `<div class="chart-body">${svg}<ul class="pie-legend">${legend}</ul></div>`;
}

function renderMeter(result) {
  const expected = result.totalExpected;
  const actual = result.totalActual;
  if (!(expected > 0)) {
    meterCard.innerHTML = '<p class="pie-empty">Add a few expense amounts to see how you compare.</p>';
    return;
  }

  const ratio = actual / expected;
  const delta = actual - expected;
  const over = delta > 0.005;
  const markerPct = Math.min(ratio, 2) / 2 * 100;
  const difference = Math.round(Math.abs(ratio - 1) * 100);

  meterCard.innerHTML = `
    <div class="meter-head">
      <h3>What you spend vs the national typical</h3>
      <span class="meter-verdict ${over ? 'over' : 'under'}">
        ${over ? '+' : '−'}${moneyFmt.format(Math.abs(delta))} ${over ? 'over' : 'under'} (${difference}%)
      </span>
    </div>
    <div class="meter-track" role="img" aria-label="Spending is ${difference}% ${over ? 'above' : 'below'} the national typical">
      <div class="meter-fill" style="width:${markerPct}%"></div>
      <div class="meter-marker" style="left:${markerPct}%"></div>
    </div>
    <div class="meter-scale">
      <span>$0</span>
      <span class="mid">Typical ${moneyFmt.format(expected)}/mo</span>
      <span>${moneyFmt.format(expected * 2)}+</span>
    </div>
    <p class="meter-note">
      You listed ${moneyPrecise.format(actual)} a month across these categories. The national
      typical for the same categories is ${moneyPrecise.format(expected)} a month.
    </p>`;
}

function renderNecessities(rows) {
  const necessities = rows.filter(row => row.band === 'necessity');
  if (necessities.length === 0) {
    necessityEl.innerHTML = '<p class="pie-empty">No necessity spending was entered.</p>';
    return;
  }

  const actual = necessities.reduce((sum, row) => sum + row.actual, 0);
  const expected = necessities.reduce((sum, row) => sum + row.expected, 0);
  const delta = actual - expected;
  const over = delta > 0.005;

  const body = necessities.map(row => {
    const diff = row.actual - row.expected;
    const diffOver = diff > 0.005;
    const sign = Math.abs(diff) < 0.005 ? '' : diffOver ? '+' : '−';
    return `
      <tr>
        <td>${row.name}</td>
        <td class="num">${moneyFmt.format(row.actual)}</td>
        <td class="num">${moneyFmt.format(row.expected)}</td>
        <td class="num delta ${diffOver ? 'above' : diff < -0.005 ? 'below' : ''}">${sign}${moneyFmt.format(Math.abs(diff))}</td>
      </tr>`;
  }).join('');

  const verdict = Math.abs(delta) < 0.005
    ? 'right on the national average'
    : `${moneyFmt.format(Math.abs(delta))} ${over ? 'above' : 'below'} the national average`;

  necessityEl.innerHTML = `
    <table class="necessity-table">
      <thead>
        <tr><th>Category</th><th class="num">You</th><th class="num">National avg</th><th class="num">Difference</th></tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
    <p class="necessity-total">
      Necessities: ${moneyFmt.format(actual)}/mo &mdash; you are
      <strong class="${over ? 'above' : 'below'}">${verdict}</strong>
      (typical: ${moneyFmt.format(expected)}/mo).
    </p>`;
}

function renderResults(result) {
  renderMeter(result);

  pieBandsEl.innerHTML = renderPie([
    { label: BAND_META.necessity.label, value: result.bands.necessity.actual, color: BAND_META.necessity.color },
    { label: BAND_META.optional.label,  value: result.bands.optional.actual,  color: BAND_META.optional.color },
    { label: BAND_META.junk.label,      value: result.bands.junk.actual,      color: BAND_META.junk.color },
  ]);

  // Everything that isn't a necessity — games, travel, dining, subscriptions…
  const fun = result.rows
    .filter(row => row.band !== 'necessity')
    .slice(0, 7)
    .map((row, index) => ({
      label: row.name,
      value: row.actual,
      color: FUN_COLORS[index % FUN_COLORS.length],
    }));

  const funTotal = result.rows.filter(row => row.band !== 'necessity').reduce((sum, row) => sum + row.actual, 0);
  const shownTotal = fun.reduce((sum, slice) => sum + slice.value, 0);
  if (funTotal - shownTotal > 0.005) {
    fun.push({ label: 'Everything else', value: funTotal - shownTotal, color: '#D8D3C8' });
  }

  pieFunEl.innerHTML = renderPie(fun);
  renderNecessities(result.rows);
}

/* ── Showing / hiding the results screen ── */
function showResults() {
  form.hidden = true;
  resultsPanel.hidden = false;
  headingEl.textContent = 'Your snapshot';
  resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideResults() {
  resultsPanel.hidden = true;
  form.hidden = false;
  headingEl.textContent = 'Get a quick look before you sign up';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  updateGate();
}

editBtn.addEventListener('click', hideResults);
