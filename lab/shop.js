// Test range: pretends this page uses jQuery 1.12.4. Only the version number is set (it's what EngineX-ray reads);
// no jQuery code is loaded.
window.jQuery = window.$ = function () {};
jQuery.fn = { jquery: '1.12.4' };
// The form must never really submit.
document.getElementById('login').addEventListener('submit', e => { e.preventDefault(); document.getElementById('log').textContent += '\n(form submit blocked: this is a test page)'; });
