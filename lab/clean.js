// The test range pages share one origin, so remove what secrets.html planted: this page must start clean.
// (A file, not an inline script: this page's security policy allows scripts from this site only.)
for (const k of ['auth_token', 'access_token']) localStorage.removeItem(k);
document.cookie = 'session=; path=/; max-age=0';
document.getElementById('click').onclick = e => { const b = e.target; b.dataset.n = (+b.dataset.n || 0) + 1; b.textContent = `Clicked ${b.dataset.n}×`; };
