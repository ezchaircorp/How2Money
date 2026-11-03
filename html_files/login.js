// Front-end behaviour for login.html.
// Extracted from the page's inline <script> block. Plain classic script (not a
// module) loaded with a relative path, so it also runs when the HTML is opened
// directly in a browser.
//
// Responsibilities: posting the credentials to /api/login, showing the status
// message, and honouring the ?next= page the dashboard sends people back with.

const form = document.getElementById('loginForm');
const status = document.getElementById('formStatus');
const submitBtn = document.getElementById('submitBtn');

// Where to go after signing in. The dashboard sends people here with
// ?next=dashboard.html so they land back where they started.
function nextPage() {
  const params = new URLSearchParams(window.location.search);
  const next = params.get('next');
  // Only ever send them to a page of this site.
  return (next && /^[a-z0-9_-]+\.html$/i.test(next)) ? next : 'dashboard.html';
}

function showStatus(type, msg) {
  status.className = `status-msg visible ${type}`;
  status.textContent = msg;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  status.className = 'status-msg';
  status.textContent = '';

  const email = form.email.value.trim();
  const password = form.password.value;

  if (!email || !password) {
    showStatus('error', 'Please enter your email and password.');
    return;
  }

  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      showStatus('success', data.message || 'Logged in!');
      // Straight to the dashboard — that is what people log in for.
      setTimeout(() => { window.location.href = nextPage(); }, 700);
    } else {
      showStatus('error', data.error || 'Invalid email or password.');
    }
  } catch (err) {
    showStatus('error', 'Could not reach the server. Is it running?');
  } finally {
    submitBtn.disabled = false;
  }
});

form.querySelectorAll('input').forEach((el) => {
  el.addEventListener('input', () => el.classList.remove('invalid'));
});
