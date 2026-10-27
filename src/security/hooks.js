// "Watch this page": wraps a few browser APIs so the Security tab can see what scripts do from now on. Every wrapper
// calls the original and returns its result unchanged; stop() puts the originals back. Nothing is blocked or sent.

// The script that made the current call: the first http(s) URL in the stack that isn't EngineX-ray itself. (From a
// bookmark our frames have no URL; loaded as a file, they carry this script's own URL, which is skipped.)
function callerScript() {
  const stack = new Error().stack ?? '';
  for (const line of stack.split('\n').slice(1)) {
    const m = /(https?:\/\/[^\s)]+?)(?::\d+){1,2}\)?\s*$/.exec(line);
    if (m && !(SELF_URL && m[1].split('?')[0] === SELF_URL)) return m[1];
  }
  return '(inline script)';
}

export function createWatcher() {
  const restore = [];
  const events = [];                // { tech, script, detail, t }
  const sockets = [];               // { url, script, sent: [], received: [] }
  const workers = [];               // { url, script }
  const listeners = new Set();
  let on = false, quiet = 0;

  const record = (tech, detail = '') => {
    if (quiet) return; // EngineX-ray's own analysis, not the page
    events.push({ tech, script: callerScript(), detail: String(detail).slice(0, 200), t: Math.round(performance.now()) });
    if (events.length > 5000) events.splice(0, 1000);
    listeners.forEach(fn => fn());
  };
  const wrapMethod = (proto, name, tech, filter) => {
    if (!proto || typeof proto[name] !== 'function') return;
    const original = proto[name];
    proto[name] = function (...args) {
      if (!filter || filter.apply(this, args)) record(tech, typeof args[0] === 'string' || typeof args[0] === 'number' ? args[0] : '');
      return original.apply(this, args);
    };
    restore.push(() => { proto[name] = original; });
  };
  const wrapGetter = (proto, name, tech) => {
    const d = proto && Object.getOwnPropertyDescriptor(proto, name);
    if (!d?.get) return;
    Object.defineProperty(proto, name, { ...d, get() { record(tech, name); return d.get.call(this); } });
    restore.push(() => Object.defineProperty(proto, name, d));
  };
  const wrapConstructor = (owner, name, onNew) => {
    const Original = owner[name];
    if (typeof Original !== 'function') return;
    owner[name] = new Proxy(Original, { construct(target, args, newTarget) {
      const obj = Reflect.construct(target, args, newTarget === owner[name] ? target : newTarget);
      try { onNew(obj, args); } catch {}
      return obj;
    } });
    restore.push(() => { owner[name] = Original; });
  };

  function start() {
    if (on) return; on = true;
    // fingerprinting
    wrapMethod(HTMLCanvasElement.prototype, 'toDataURL', 'canvas readback');
    wrapMethod(HTMLCanvasElement.prototype, 'toBlob', 'canvas readback');
    wrapMethod(CanvasRenderingContext2D.prototype, 'getImageData', 'canvas readback');
    wrapMethod(CanvasRenderingContext2D.prototype, 'measureText', 'font probing (measureText)');
    for (const GL of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!GL) continue;
      wrapMethod(GL.prototype, 'getParameter', 'GPU model (WebGL)', p => p === 0x9245 || p === 0x9246);
      wrapMethod(GL.prototype, 'getExtension', 'GPU model (WebGL)', n => n === 'WEBGL_debug_renderer_info');
    }
    wrapConstructor(window, 'OfflineAudioContext', () => record('audio fingerprint (OfflineAudioContext)'));
    for (const prop of ['hardwareConcurrency', 'deviceMemory', 'plugins', 'mimeTypes']) wrapGetter(Navigator.prototype, prop, 'device details (navigator)');
    if (window.NavigatorUAData) wrapMethod(NavigatorUAData.prototype, 'getHighEntropyValues', 'device details (navigator)');
    if (window.MediaDevices) wrapMethod(MediaDevices.prototype, 'enumerateDevices', 'camera/mic list (enumerateDevices)');
    wrapMethod(Navigator.prototype, 'getBattery', 'battery status');
    wrapConstructor(window, 'RTCPeerConnection', () => record('WebRTC (can reveal local IP)'));
    // networking and threads
    wrapConstructor(window, 'WebSocket', (ws, args) => {
      const entry = { url: String(args[0]), script: callerScript(), sent: [], received: [] };
      sockets.push(entry);
      const send = ws.send;
      ws.send = function (data) { if (entry.sent.length < 8) entry.sent.push(String(data).slice(0, 300)); listeners.forEach(fn => fn()); return send.call(this, data); };
      ws.addEventListener('message', e => { if (entry.received.length < 8) { entry.received.push(String(e.data).slice(0, 300)); listeners.forEach(fn => fn()); } });
      listeners.forEach(fn => fn());
    });
    wrapConstructor(window, 'Worker', (w, args) => { workers.push({ url: String(args[0]), script: callerScript() }); listeners.forEach(fn => fn()); });
    wrapConstructor(window, 'SharedWorker', (w, args) => { workers.push({ url: String(args[0]), script: callerScript() }); listeners.forEach(fn => fn()); });
  }
  function stop() {
    if (!on) return; on = false;
    while (restore.length) restore.pop()();
  }

  // Per script: which fingerprinting techniques it used, and how often.
  function byScript() {
    const out = new Map();
    for (const e of events) {
      if (!out.has(e.script)) out.set(e.script, new Map());
      const techs = out.get(e.script);
      techs.set(e.tech, (techs.get(e.tech) ?? 0) + 1);
    }
    return out;
  }

  // Run fn without recording: used for EngineX-ray's own work (its checks read navigator too).
  const quietly = fn => { quiet++; try { return fn(); } finally { quiet--; } };

  return { start, stop, quietly, get on() { return on; }, events, sockets, workers, byScript, onChange: fn => listeners.add(fn) };
}
