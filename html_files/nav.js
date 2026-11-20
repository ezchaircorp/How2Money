// Shared nav behaviour for every page.
// Plain classic script, loaded with a relative path like the others.
//
// When someone is signed in, the nav button turns into "Log out" and shows
// who they are. Signed-out visitors keep the page's normal Log in / Sign up
// button. With no server running, nothing changes.

(async function showSignedInNav() {
  const button = document.querySelector('nav .nav-cta');
  if (!button) return;

  let user = null;
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    user = data.ok ? data.user : null;
  } catch {
    return;
  }
  if (!user) return;

  button.textContent = 'Log out';
  button.href = 'index.html';
  button.title = `Signed in as ${user.name} (${user.email})`;

  button.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {
      // Even if the request fails, send them home; the next page re-checks.
    }
    window.location.href = 'index.html';
  });

  // Tell the page, so it can show the person's own details.
  document.dispatchEvent(new CustomEvent('h2m:signed-in', { detail: user }));
})();
