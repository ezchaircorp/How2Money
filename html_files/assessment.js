// Front-end behaviour for assessment.html.
// Extracted from the page's inline <script> block. Plain classic script (not a
// module) loaded with a relative path, so it also runs when the HTML is opened
// directly in a browser.
//
// Responsibilities: the optional advisor image, the signed-in note, turning the
// expense rows into the JSON payload, the breakdown running totals, and the
// submit-button gate.

/* ─────────────────────────────────────────────────
   BACKEND CONFIG — update these endpoints
───────────────────────────────────────────────── */
const CONFIG = {
  imageEndpoint:  '/api/assessment-image',   // GET → { url, caption, subcaption }
  submitEndpoint: '/api/assessment-submit',  // POST → JSON (fields + expense amounts/frequencies)
  meEndpoint:     '/api/me',                 // GET → the signed-in user, if there is one
};

/* ─────────────────────────────────────────────────
   DYNAMIC IMAGE
   Backend should respond: { url, caption, subcaption }
───────────────────────────────────────────────── */
async function loadAdvisorImage() {
  try {
    const res = await fetch(CONFIG.imageEndpoint);
    if (!res.ok) return;                         // silently keep default
    const data = await res.json();
    if (data.url) setAdvisorImage(data.url, data.caption, data.subcaption);
  } catch (_) {
    // Network error or dev environment — keep the default image
  }
}

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

loadAdvisorImage();

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
    note.textContent = `Signed in as ${data.user.name} — this assessment will be saved to your dashboard.`;
    note.hidden = false;
    document.getElementById('assessmentHeading').textContent = 'Update your financial assessment';
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
    showStatus(formStatus, 'error', 'Please fill in your name, email, income, and at least one expense before submitting.');
    return;
  }

  const payload = {
    firstName: form.firstName.value.trim(),
    lastName: form.lastName.value.trim(),
    email: form.email.value.trim(),
    householdIncome: form.householdIncome.value,
    expenses: collectExpenses(),
  };

  submitBtn.disabled = true;
  submitBtn.classList.add('loading');

  try {
    const res = await fetch(CONFIG.submitEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    let result = {};
    try { result = await res.json(); } catch (_) { /* empty body */ }

    if (!res.ok) {
      throw new Error(result.error || `Server responded with ${res.status}`);
    }

    // Success
    form.reset();
    showStatus(formStatus, 'success',
      result.message || 'Your assessment has been submitted. An advisor will contact you within one business day.');

    // Signed in? Their assessment is already on their dashboard.
    if (result.signedIn) {
      const link = document.createElement('a');
      link.href = 'dashboard.html';
      link.textContent = ' See it on your dashboard →';
      link.style.color = 'var(--gold)';
      link.style.fontWeight = '600';
      formStatus.appendChild(link);
    }

  } catch (err) {
    showStatus(formStatus, 'error', err.message || 'Something went wrong. Please try again or call us directly.');
  } finally {
    submitBtn.classList.remove('loading');
    // Re-evaluate rather than force-enable: after a reset the form is empty again
    updateGate();
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
