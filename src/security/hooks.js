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

// Form fields whose contents are personal enough to flag when a third party reads or receives them.
const SENSITIVE_FIELD = /pass|card|cc-|cvc|cvv|ssn|social|iban|account|routing/i;
function fieldInfo(el) {
  const type = (el.type || el.tagName || '').toLowerCase();
  const name = el.name || el.id || el.getAttribute?.('autocomplete') || '';
  const sensitive = type === 'password' || type === 'email' || type === 'tel' || SENSITIVE_FIELD.test(`${name} ${el.getAttribute?.('autocomplete') ?? ''}`);
  return { label: `${type} field${name ? ` "${String(name).slice(0, 30)}"` : ''}`, sensitive };
}
function bodyText(body) {
  try {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) return [...body].map(([k, v]) => `${k}=${typeof v === 'string' ? v : ''}`).join('&');
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body.slice ? body.slice(0, 200000) : body);
  } catch {}
  return ''; // Blobs and streams are counted but not read
}

export function createWatcher() {
  const restore = [];
  const events = [];                // fingerprinting calls: { tech, script, detail, t }
  const sockets = [];               // { url, script, sent: [], received: [] }
  const workers = [];               // { url, script }
  const requests = [];              // data leaving the page: { host, url, method, bytes, kind, script, typed }
  const fieldReads = [];            // scripts reading personal form fields: { script, field, sensitive }
  const keyListeners = [];          // scripts listening to keystrokes: { script, type, target }
  const typed = new Map();          // what's in each field you typed in while watching: value -> { label, sensitive }
  const typedBy = new WeakMap();    // field -> its value in `typed`, so only the current value is checked
  const listeners = new Set();
  let on = false, quiet = 0, startedAt = 0;
  const changed = () => listeners.forEach(fn => fn());

  const record = (tech, detail = '') => {
    if (quiet) return; // EngineX-ray's own analysis, not the page
    events.push({ tech, script: callerScript(), detail: String(detail).slice(0, 200), t: Math.round(performance.now()) });
    if (events.length > 5000) events.splice(0, 1000);
    changed();
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

  // Which of the fields you typed in does this outgoing text carry? Checked as-is, URL-encoded and lowercased.
  function typedIn(text) {
    if (!typed.size || !text) return [];
    const hay = text.length > 200000 ? text.slice(0, 200000) : text;
    let lower;
    const hits = [];
    for (const [value, field] of typed) {
      if (hay.includes(value) || hay.includes(encodeURIComponent(value)) || (lower ??= hay.toLowerCase()).includes(value.toLowerCase())) hits.push(field);
    }
    return hits;
  }
  // Never throws: it runs inside the page's own fetch/XHR calls.
  function noteRequest(url, method, body, kind, script) {
    if (quiet || timedFetch.busy) return; // EngineX-ray's own requests
    try {
      const u = new URL(url, location.href);
      if (!/^(https?|wss?):$/.test(u.protocol)) return;
      const text = bodyText(body);
      let query = u.search; try { query = decodeURIComponent(query.replace(/\+/g, ' ')); } catch {}
      const fields = [...new Set([...typedIn(query), ...typedIn(text)])];
      requests.push({ host: u.hostname, url: (u.origin + u.pathname).slice(0, 160), method, bytes: (body?.size ?? body?.byteLength ?? text.length) + u.search.length, kind, script: script ?? callerScript(), typed: fields });
      if (requests.length > 3000) requests.splice(0, 500);
      changed();
    } catch {}
  }

  function start() {
    if (on) return; on = true; startedAt = Date.now();
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
      ws.send = function (data) { if (entry.sent.length < 8) entry.sent.push(String(data).slice(0, 300)); noteRequest(entry.url, 'WS', data, 'websocket', entry.script); return send.call(this, data); };
      ws.addEventListener('message', e => { if (entry.received.length < 8) { entry.received.push(String(e.data).slice(0, 300)); changed(); } });
      changed();
    });
    wrapConstructor(window, 'Worker', (w, args) => { workers.push({ url: String(args[0]), script: callerScript() }); changed(); });
    wrapConstructor(window, 'SharedWorker', (w, args) => { workers.push({ url: String(args[0]), script: callerScript() }); changed(); });

    // Data leaving the page: fetch, XHR, beacons (and WebSocket messages above). Images, pixels and scripts come
    // from the resource timeline instead (no body, and no way to tell which script asked for them).
    const fetch0 = window.fetch;
    window.fetch = function (input, init) {
      try { noteRequest(input instanceof Request ? input.url : String(input), String(init?.method ?? input?.method ?? 'GET').toUpperCase(), init?.body, 'fetch'); } catch {}
      return fetch0.apply(this, arguments);
    };
    restore.push(() => { window.fetch = fetch0; });
    const xhrTarget = new WeakMap(), open0 = XMLHttpRequest.prototype.open, send0 = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) { xhrTarget.set(this, [String(method).toUpperCase(), String(url)]); return open0.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (body) { const t = xhrTarget.get(this); if (t) noteRequest(t[1], t[0], body, 'xhr'); return send0.apply(this, arguments); };
    restore.push(() => { XMLHttpRequest.prototype.open = open0; XMLHttpRequest.prototype.send = send0; });
    if (navigator.sendBeacon) {
      const beacon0 = Navigator.prototype.sendBeacon;
      Navigator.prototype.sendBeacon = function (url, data) { noteRequest(String(url), 'POST', data, 'beacon'); return beacon0.apply(this, arguments); };
      restore.push(() => { Navigator.prototype.sendBeacon = beacon0; });
    }
    try {
      const po = new PerformanceObserver(list => {
        for (const e of list.getEntries()) if (!['fetch', 'xmlhttprequest', 'beacon'].includes(e.initiatorType)) noteRequest(e.name, 'GET', null, e.initiatorType, '(page)');
      });
      po.observe({ type: 'resource' });
      restore.push(() => po.disconnect());
    } catch {}

    // What you type, so outgoing requests can be checked for it. Our listener reads the raw value getter, so it
    // never shows up as a "field read" itself.
    const value0 = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const areaValue0 = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    const onInput = e => {
      const el = e.target;
      const d = el instanceof HTMLInputElement ? value0 : el instanceof HTMLTextAreaElement ? areaValue0 : null;
      if (!d) return;
      // Only the field's current value: requests are checked when they're sent, so a search box that sends every
      // prefix is still caught, and short leftovers like "test" can't match unrelated traffic later.
      const v = d.get.call(el), old = typedBy.get(el);
      if (old != null) typed.delete(old);
      if (v && v.length >= 5 && v.length < 200) { typed.set(v, fieldInfo(el)); typedBy.set(el, v); } else typedBy.delete(el);
    };
    const addEvent0 = EventTarget.prototype.addEventListener;
    addEvent0.call(document, 'input', onInput, true);
    restore.push(() => document.removeEventListener('input', onInput, true));

    // Scripts reading personal form fields (passwords, email, phone, card numbers).
    const reads = new WeakMap();
    Object.defineProperty(HTMLInputElement.prototype, 'value', { ...value0, get() {
      const v = value0.get.call(this);
      if (v && !quiet) try {
        const n = reads.get(this) ?? 0;
        if (n < 20) { const f = fieldInfo(this); if (f.sensitive) { reads.set(this, n + 1); fieldReads.push({ script: callerScript(), field: f.label, sensitive: f.sensitive }); changed(); } }
      } catch {}
      return v;
    } });
    restore.push(() => Object.defineProperty(HTMLInputElement.prototype, 'value', value0));

    // Scripts that start listening to keystrokes. (Listeners added before watching began aren't visible.)
    EventTarget.prototype.addEventListener = function (type) {
      if (!quiet && /^(key(down|up|press)|input|paste)$/.test(type)) try {
        const target = this === document ? 'document' : this === window ? 'window' : this instanceof Element ? `<${this.tagName.toLowerCase()}${this.type ? ` type=${this.type}` : ''}>` : 'object';
        keyListeners.push({ script: callerScript(), type, target }); changed();
      } catch {}
      return addEvent0.apply(this, arguments);
    };
    restore.push(() => { EventTarget.prototype.addEventListener = addEvent0; });
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
  // Per destination: how many requests, how much was sent, and which of your typed fields showed up in them.
  function byHost() {
    const out = new Map();
    for (const r of requests) {
      const x = out.get(r.host) ?? { host: r.host, requests: 0, bytes: 0, typed: new Map(), kinds: new Set() };
      x.requests++; x.bytes += r.bytes || 0; x.kinds.add(r.kind);
      for (const f of r.typed) x.typed.set(f.label, f.sensitive);
      out.set(r.host, x);
    }
    return [...out.values()].sort((a, b) => b.typed.size - a.typed.size || b.bytes - a.bytes || b.requests - a.requests);
  }

  // Run fn without recording: used for EngineX-ray's own work (its checks read navigator too).
  const quietly = fn => { quiet++; try { return fn(); } finally { quiet--; } };

  return { start, stop, quietly, get on() { return on; }, get startedAt() { return startedAt; }, get typedCount() { return typed.size; },
    events, sockets, workers, requests, fieldReads, keyListeners, byScript, byHost, onChange: fn => listeners.add(fn) };
}
