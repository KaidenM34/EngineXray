// What the page itself exposes: the .wasm files it loaded, its global variables, its browser storage, its console.

// .wasm files the page fetched. Resource timing lists every URL the document loaded, so this works after the fact.
// (Files loaded inside a worker or from a blob: URL don't appear; the panel also takes a URL or a file.)
export function wasmUrls() {
  const urls = performance.getEntriesByType('resource').map(e => e.name).filter(u => /\.wasm(\?|#|$)/i.test(u));
  return [...new Set(urls)];
}

// Engine files the page's own scripts mention, for games that load their engine inside a worker or build the URL at
// runtime (both hide it from the resource list). Template parts like `${hash}` are dropped, so the guess is the plain
// file name; the panel offers it as a one-click scan and says it's a guess.
// EngineX-ray's own file, when it's loaded as a script (the test range does this). Its detection lists contain miner
// and tracker names, so it must never scan itself.
export const SELF_URL = (document.currentScript?.src ?? '').split('?')[0];

export async function scriptHints() {
  const scripts = performance.getEntriesByType('resource')
    .filter(e => e.initiatorType === 'script' && new URL(e.name).origin === location.origin).map(e => e.name);
  for (const s of document.scripts) if (s.src && new URL(s.src).origin === location.origin) scripts.push(s.src);
  const wasm = new Map(), workers = new Set(), texts = [];
  const queue = [...new Set(scripts)].filter(u => !(SELF_URL && u.split('?')[0] === SELF_URL)).slice(0, 25), done = new Set();
  while (queue.length && done.size < 40) {
    const src = queue.shift();
    if (done.has(src)) continue; done.add(src);
    let text = '';
    try { text = await (await fetch(src)).text(); } catch { continue; }
    if (text.length > 5e6) continue;
    texts.push([src.split('/').pop().split('?')[0] || src, text]);
    for (const m of text.matchAll(/["'`]([^"'`\s]*?\.wasm)[^"'`\s]*["'`]/g)) {
      const raw = m[1], plain = raw.replace(/\$\{[^}]*\}/g, '').replace(/-+(?=\.wasm$)/, '');
      try { wasm.set(new URL(plain, src).href, { from: src.split('/').pop().split('?')[0], raw, guessed: raw !== plain }); } catch {}
    }
    for (const m of text.matchAll(/new (?:Shared)?Worker\(\s*(?:new URL\()?\s*["'`]([^"'`]+)["'`]/g)) {
      workers.add(m[1]);
      try { const u = new URL(m[1].replace(/\$\{[^}]*\}/g, ''), src); if (u.origin === location.origin) queue.push(u.href); } catch {} // read worker code too
    }
  }
  return { wasm: [...wasm].map(([url, info]) => ({ url, ...info })), workers: [...workers], texts };
}

// Third-party scripts the page loaded, re-read where the browser allows it (CDNs that send CORS headers). These are
// the same files the page already downloaded, usually straight from cache; scripts that don't allow it are skipped.
export async function thirdPartyScriptTexts({ max = 30, maxBytes = 3e6 } = {}) {
  const urls = [...new Set(performance.getEntriesByType('resource')
    .filter(e => e.initiatorType === 'script' && new URL(e.name).origin !== location.origin).map(e => e.name))].slice(0, max);
  const out = [];
  await Promise.all(urls.map(async url => {
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
      if (!res.ok) return;
      const text = await res.text();
      if (text.length <= maxBytes) out.push([new URL(url).hostname + '/' + url.split('/').pop().split('?')[0], text]);
    } catch {}
  }));
  return out;
}

export async function fetchWasm(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Globals the page added, compared against a blank window from a throwaway iframe.
export function pageGlobals() {
  let baseline = new Set();
  try {
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    document.documentElement.append(frame);
    baseline = new Set(Object.getOwnPropertyNames(frame.contentWindow));
    frame.remove();
  } catch {}
  const out = [];
  for (const name of Object.getOwnPropertyNames(window)) {
    if (baseline.has(name) || /^(on|webkit)/.test(name) || name === 'EngineXray') continue;
    let value, type;
    try { value = window[name]; type = describeType(value); } catch { type = 'unreadable'; }
    out.push({ name, type, notes: notesFor(name, value) });
  }
  // The interesting ones first: engine handles and hook-looking names.
  return out.sort((a, b) => b.notes.length - a.notes.length || a.name.localeCompare(b.name));
}

function describeType(v) {
  if (v === null) return 'null';
  if (typeof v === 'function') return /^class\b/.test(Function.prototype.toString.call(v)) ? 'class' : 'function';
  if (typeof v !== 'object') return typeof v;
  if (v instanceof WebAssembly.Memory) return `WebAssembly.Memory (${Math.round(v.buffer.byteLength / 1048576)} MB)`;
  if (v instanceof WebAssembly.Instance) return 'WebAssembly.Instance';
  if (Array.isArray(v)) return `array[${v.length}]`;
  return 'object' + (v.constructor && v.constructor !== Object ? ` (${v.constructor.name})` : '');
}

function notesFor(name, v) {
  const notes = [];
  if (/^__/.test(name)) notes.push('double-underscore name: often a hidden hook or debug switch');
  if (/module|engine|game|wasm|unity|godot|emscripten|player|level|mod/i.test(name)) notes.push('engine-related name');
  if (v && typeof v === 'object') {
    let keys = [];
    try { keys = Object.keys(v).slice(0, 400); } catch {}
    if (keys.some(k => /^HEAP(U8|8|32|F32)$/.test(k)) || v.HEAPU8) notes.push('looks like an Emscripten Module (has HEAP views)');
    if (typeof v.readdir === 'function' && typeof v.writeFile === 'function') notes.push('looks like an Emscripten FS (virtual file system)');
    if (typeof v.callMain === 'function') notes.push('has callMain(): the engine\'s main() with command-line arguments');
    if (typeof v.SendMessage === 'function') notes.push('has SendMessage(): Unity\'s JS → C# bridge');
    for (const k of keys) {
      let x; try { x = v[k]; } catch { continue; }
      if (x instanceof WebAssembly.Memory) { notes.push(`.${k} is the engine's memory`); break; }
      if (x instanceof WebAssembly.Instance) { notes.push(`.${k} is a WebAssembly instance`); break; }
      if (typeof x === 'function' && /^_?[A-Z]{2,}_/.test(k)) { notes.push(`.${k}(): exported engine function`); break; }
    }
    const hooky = keys.filter(k => /command|parity|flow|hook|callback|handler/i.test(k));
    if (hooky.length) notes.push('has hook-like properties: ' + hooky.slice(0, 5).join(', '));
  }
  return notes;
}

// Browser storage, where game files and saves live.
export async function storageReport() {
  const out = { estimate: null, opfs: [], indexedDB: [], localStorage: [], caches: [] };
  try {
    const e = await navigator.storage.estimate();
    out.estimate = { usage: e.usage, quota: e.quota, details: e.usageDetails ?? null };
  } catch {}
  try {
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) out.opfs.push({ name, ...(await walk(handle)) });
  } catch (e) { out.opfsError = String(e.message || e); }
  try { out.indexedDB = (await indexedDB.databases()).map(d => `${d.name} (v${d.version})`); } catch {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out.localStorage.push({ key: k, bytes: (localStorage.getItem(k) ?? '').length });
    }
  } catch {}
  try { out.caches = await caches.keys(); } catch {}
  return out;
}

// Size and file count of an OPFS entry, plus its first-level children (capped, so a 2,000-file game pack stays fast).
async function walk(handle, depth = 0, budget = { files: 8000 }) {
  if (handle.kind === 'file') {
    try { return { kind: 'file', bytes: (await handle.getFile()).size, files: 1 }; } catch { return { kind: 'file', bytes: 0, files: 1 }; }
  }
  let bytes = 0, files = 0;
  const children = [];
  for await (const [name, child] of handle.entries()) {
    if (budget.files <= 0) { children.push({ name: '…(stopped counting)', kind: 'note' }); break; }
    const info = await walk(child, depth + 1, budget);
    bytes += info.bytes; files += info.files;
    if (child.kind === 'file') budget.files--;
    if (depth < 1) children.push({ name, kind: child.kind, bytes: info.bytes, files: info.files });
  }
  return { kind: 'directory', bytes, files, children };
}

// Console recorder: keeps the last lines the page prints, from the moment it's switched on.
export function consoleRecorder(max = 3000) {
  const lines = [], originals = {};
  let on = false;
  return {
    lines,
    get on() { return on; },
    start() {
      if (on) return; on = true;
      for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        originals[level] = console[level];
        console[level] = (...args) => {
          let text; try { text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '); } catch { text = args.join(' '); }
          lines.push({ t: Math.round(performance.now()), level, text: text.slice(0, 1000) });
          if (lines.length > max) lines.splice(0, lines.length - max);
          return originals[level].apply(console, args);
        };
      }
    },
    stop() {
      if (!on) return; on = false;
      for (const [level, fn] of Object.entries(originals)) console[level] = fn;
    },
  };
}
