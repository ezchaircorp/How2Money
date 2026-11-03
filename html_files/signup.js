// Front-end behaviour for signup.html.
// Extracted from the page's inline <script> block. Plain classic script (not a
// module) loaded with a relative path, so it also runs when the HTML is opened
// directly in a browser.
//
// Responsibilities: posting the new account to /api/signup, showing the status
// message, and sending the person to log in once it succeeds.

const form = document.getElementById('signupForm');
const status = document.getElementById('formStatus');
const submitBtn = document.getElementById('submitBtn');

function showStatus(type, msg) {
  status.className = `status-msg visible ${type}`;
  status.textContent = msg;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  status.className = 'status-msg';
  status.textContent = '';

  const name = form.name.value.trim();
  const email = form.email.value.trim();
  const password = form.password.value;

  if (!name || !email || !password) {
    showStatus('error', 'Please fill in your name, email, and password.');
    return;
  }

  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, confirm }),
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      showStatus('success', data.message || 'Account created!');
      form.reset();
      // Give the message a beat, then send them to log in.
      setTimeout(() => { window.location.href = 'login.html'; }, 1200);
    } else {
      showStatus('error', data.error || 'Something went wrong. Please try again.');
    }
  } catch (err) {
    showStatus('error', 'Could not reach the server. Is it running?');
  } finally {
    submitBtn.disabled = false;
  }
});

// Clear the invalid outline as soon as they start fixing the field.
form.querySelectorAll('input').forEach((el) => {
  el.addEventListener('input', () => el.classList.remove('invalid'));
});
