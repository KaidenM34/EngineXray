// Test range only: a "Run EngineX-ray" button, so the range can be demoed without installing the bookmark.
// It loads the same engine-xray.js the bookmark contains (make.sh copies it here).
const b = Object.assign(document.createElement('button'), { textContent: 'Run EngineX-ray' });
b.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:10;background:#5cf2c8;color:#0b0c0e;border:0;border-radius:8px;padding:10px 14px;font:800 14px system-ui;cursor:pointer';
b.onclick = () => {
  if (window.EngineXray) return window.EngineXray.toggle();
  const s = document.createElement('script');
  s.src = 'engine-xray.js?' + Date.now();
  document.body.append(s);
};
document.body.append(b);
