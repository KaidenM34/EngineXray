(() => {
// ---- wasm.js ----
// WebAssembly binary reader: just enough of the format (spec "Binary Format") to list what a module imports and
// exports, how big its memory is, how many functions it has, and the text hidden in its data segments.
// No dependencies. Works on a few hundred MB without trouble because it only walks section headers and data bytes.

const KINDS = ['function', 'table', 'memory', 'global', 'tag'];

function reader(bytes) {
  let pos = 0;
  const r = {
    get pos() { return pos; }, set pos(p) { pos = p; },
    byte() { if (pos >= bytes.length) throw new Error('unexpected end of file'); return bytes[pos++]; },
    u32() { // unsigned LEB128
      let result = 0, shift = 0, b;
      do { b = r.byte(); result += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
      return result;
    },
    skipLeb() { while (r.byte() & 0x80); },
    bytes(n) { const out = bytes.subarray(pos, pos + n); pos += n; return out; },
    name() { return new TextDecoder().decode(r.bytes(r.u32())); },
    limits() {
      const flags = r.byte();
      const min = r.u32(), max = flags & 1 ? r.u32() : null;
      return { min, max, shared: !!(flags & 2), is64: !!(flags & 4) };
    },
    // constant expression (data/elem offsets, globals): read opcodes up to `end` (0x0b)
    constExpr() {
      for (;;) {
        const op = r.byte();
        if (op === 0x0b) return;
        if (op === 0x41 || op === 0x42 || op === 0x23 || op === 0xd2) r.skipLeb();
        else if (op === 0x43) pos += 4;
        else if (op === 0x44) pos += 8;
        else if (op === 0xd0) r.byte();
        else if (op === 0xfd) { r.skipLeb(); pos += 16; } // v128.const
      }
    },
  };
  return r;
}

function parseWasm(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error('not a WebAssembly file');
  const r = reader(bytes);
  r.pos = 4;
  const version = bytes[4] | bytes[5] << 8 | bytes[6] << 16 | bytes[7] << 24;
  r.pos = 8;
  const out = {
    size: bytes.length, version, imports: [], exports: [], memories: [], tables: 0, globals: 0,
    functions: { imported: 0, defined: 0 }, customSections: [], data: [], dataBytes: 0, functionNames: 0,
    sections: [],
  };
  while (r.pos < bytes.length) {
    const id = r.byte(), len = r.u32(), start = r.pos, end = start + len;
    out.sections.push({ id, size: len });
    try {
      if (id === 0) {
        const name = r.name();
        out.customSections.push({ name, size: end - r.pos });
        if (name === 'name') out.functionNames = countFunctionNames(r, end);
      } else if (id === 2) {
        for (let n = r.u32(); n--;) {
          const module = r.name(), field = r.name(), kind = r.byte();
          const imp = { module, name: field, kind: KINDS[kind] ?? `kind${kind}` };
          if (kind === 0) { r.skipLeb(); out.functions.imported++; }
          else if (kind === 1) { r.byte(); r.limits(); }
          else if (kind === 2) { imp.limits = r.limits(); out.memories.push({ ...imp.limits, imported: `${module}.${field}` }); }
          else if (kind === 3) { r.byte(); r.byte(); }
          else if (kind === 4) { r.byte(); r.skipLeb(); }
          out.imports.push(imp);
        }
      } else if (id === 3) {
        out.functions.defined = r.u32();
      } else if (id === 4) {
        out.tables += r.u32();
      } else if (id === 5) {
        for (let n = r.u32(); n--;) out.memories.push(r.limits());
      } else if (id === 6) {
        out.globals += r.u32();
      } else if (id === 7) {
        for (let n = r.u32(); n--;) {
          const name = r.name(), kind = r.byte(), index = r.u32();
          out.exports.push({ name, kind: KINDS[kind] ?? `kind${kind}`, index });
        }
      } else if (id === 11) {
        for (let n = r.u32(); n--;) {
          const flags = r.u32();
          if (flags === 2) r.u32();
          if (flags !== 1) r.constExpr();
          const size = r.u32();
          out.data.push({ start: r.pos, size });
          out.dataBytes += size;
          r.pos += size;
        }
      }
    } catch (e) {
      out.warning = `section ${id} could not be read fully (${e.message})`;
    }
    r.pos = end;
  }
  out.bytes = bytes; // kept for string search
  return out;
}

// The "name" custom section: subsection 1 lists function names (debug builds and many engines keep it).
function countFunctionNames(r, end) {
  while (r.pos < end) {
    const sub = r.byte(), len = r.u32(), next = r.pos + len;
    if (sub === 1) return r.u32();
    r.pos = next;
  }
  return 0;
}

// Printable ASCII runs inside the data segments (where C/C++/Rust string literals end up), or the whole file if a
// module has no data segments. Returns up to `limit` matches for `filter` (a RegExp or plain substring).
function findStrings(mod, { minLength = 6, filter = null, limit = 500 } = {}) {
  const ranges = mod.data.length ? mod.data : [{ start: 0, size: mod.bytes.length }];
  const test = !filter ? () => true : filter instanceof RegExp ? s => filter.test(s) : s => s.toLowerCase().includes(String(filter).toLowerCase());
  const found = [], seen = new Set();
  let total = 0;
  for (const { start, size } of ranges) {
    let runStart = -1;
    for (let i = start, endAt = start + size; i <= endAt; i++) {
      const c = i < endAt ? mod.bytes[i] : 0;
      const printable = c >= 0x20 && c < 0x7f || c === 0x09;
      if (printable) { if (runStart < 0) runStart = i; continue; }
      if (runStart >= 0 && i - runStart >= minLength) {
        total++;
        if (found.length < limit) {
          const s = String.fromCharCode(...mod.bytes.subarray(runStart, Math.min(i, runStart + 400)));
          if (!seen.has(s) && test(s)) { seen.add(s); found.push(s); }
        }
      }
      runStart = -1;
    }
  }
  return { strings: found, total };
}

// ---- detect.js ----
// Engine fingerprints: what toolchain built a .wasm file, judged from its imports/exports and the page's globals.
// Each rule returns evidence strings; the engine with the most evidence wins. Evidence is shown, so a guess is never
// presented as fact.

const RULES = [
  {
    engine: 'Unity WebGL',
    test: (m, g, s) => [
      g.has('createUnityInstance') && 'page has createUnityInstance()',
      g.has('unityInstance') && 'page has unityInstance',
      s.some(x => /UnityLoader|unity\.framework|UnityEngine/i.test(x)) && 'strings mention Unity',
    ],
  },
  {
    engine: 'Godot',
    test: (m, g, s) => [
      g.has('Engine') && typeof window.Engine?.isWebGLAvailable === 'function' && 'page has Godot Engine class',
      m.imports.some(i => /^godot/i.test(i.name)) && 'imports named godot*',
      s.some(x => /godot/i.test(x)) && 'strings mention Godot',
    ],
  },
  {
    engine: 'Rust (wasm-bindgen)',
    test: m => [
      m.imports.some(i => i.name.startsWith('__wbg_') || i.name.startsWith('__wbindgen')) && 'imports __wbg_* / __wbindgen*',
      m.imports.some(i => /_bg\.js$|__wbindgen_placeholder__/.test(i.module)) && 'import module is a *_bg.js shim',
      m.exports.some(e => e.name.startsWith('__wbindgen')) && 'exports __wbindgen*',
    ],
  },
  {
    engine: 'Go',
    test: m => [
      m.imports.some(i => i.module === 'go' || i.module === 'gojs') && 'imports from "go"/"gojs"',
      m.exports.some(e => e.name === 'run' || e.name === 'resume') && m.imports.some(i => /runtime\./.test(i.name)) && 'Go runtime imports',
    ],
  },
  {
    engine: 'Emscripten (C/C++)',
    test: (m, g) => [
      m.imports.some(i => /^(emscripten_|__syscall_|_emscripten_)/.test(i.name)) && 'imports emscripten_* / __syscall_*',
      m.imports.some(i => i.module === 'wasi_snapshot_preview1') && 'uses WASI imports (fd_write, ...)',
      m.exports.some(e => /^(_?malloc|_?free|stackAlloc|__wasm_call_ctors)$/.test(e.name)) && 'exports malloc/free/__wasm_call_ctors',
      g.has('Module') && 'page has a global Module',
    ],
  },
];

function detectEngine(mod, globals, strings) {
  const g = new Set(globals.map(x => x.name));
  const results = RULES.map(rule => ({ engine: rule.engine, evidence: rule.test(mod, g, strings).filter(Boolean) }))
    .filter(r => r.evidence.length)
    .sort((a, b) => b.evidence.length - a.evidence.length);
  // Unity and Godot are themselves built with Emscripten: name the specific engine, keep Emscripten as the toolchain.
  const top = results[0];
  return { best: top ? top.engine : 'Unknown', matches: results };
}

// Things a modder usually wants to know first, pulled from the export list.
function interestingExports(mod) {
  const groups = {
    'Engine API (custom exports)': e => !/^(_?(malloc|free|memcpy|memset|strlen)|__|dyn(Call)?_|stack|emscripten_|_emscripten|_?fflush|_?setThrew|__errno|_?htons|_?ntohs|_?htonl|orig\$)/.test(e.name) && e.kind === 'function',
    'Memory and tables': e => e.kind === 'memory' || e.kind === 'table',
    'Runtime / toolchain': e => /^(__|dyn|stack|emscripten_|_emscripten)/.test(e.name),
  };
  const out = {};
  for (const [label, test] of Object.entries(groups)) out[label] = mod.exports.filter(test).map(e => `${e.name} (${e.kind})`);
  return out;
}

// The JavaScript functions the engine calls back into, by readable name. wasm-bindgen (Rust) imports look like
// "__wbg_netOpen_4a03ab156448a940": the middle part is the JS function's real name. Emscripten imports from "env" are
// named after the JS library function directly (e.g. "_emscripten_webgl_create_context", "invoke_vii" for exceptions).
function bridgeFunctions(mod) {
  const names = new Set();
  for (const i of mod.imports) {
    if (i.kind !== 'function') continue;
    const bindgen = /^__wbg_(.+?)(_[0-9a-f]{16})?$/.exec(i.name);
    if (bindgen) { names.add(bindgen[1]); continue; }
    if (i.module === 'env' && !/^(invoke_|__syscall_|_?emscripten_|__cxa_|_tzset|_mmap|_munmap|_abort|abort|_localtime|__assert|_gmtime|_setitimer|_dlopen|_dlsym)/.test(i.name)) names.add(i.name);
  }
  return [...names].sort();
}

// Search presets for the Strings tab: the kinds of text that pointed the way in bo1fun.
const STRING_PRESETS = {
  'Settings / cvars': /^[a-z][a-z0-9]*_[a-z0-9_]{2,}$/,
  'File paths': /\.(cfg|json|ini|txt|gsc|csc|lua|js|ff|pak|pk3|iwd|bin|dat|png|wav|ogg)\b|\/[\w.-]+\//i,
  'Commands (+set, exec, ...)': /^\+?(set|seta|exec|bind|map|devmap|connect|cmd)\b|%s|command/i,
  'Mod / script hooks': /mod|hook|script|plugin|lua|addon/i,
  'Errors and asserts': /error|fail|assert|cannot|could not|invalid/i,
  'URLs': /https?:\/\//,
};

// ---- page.js ----
// What the page itself exposes: the .wasm files it loaded, its global variables, its browser storage, its console.

// .wasm files the page fetched. Resource timing lists every URL the document loaded, so this works after the fact.
// (Files loaded inside a worker or from a blob: URL don't appear; the panel also takes a URL or a file.)
function wasmUrls() {
  const urls = performance.getEntriesByType('resource').map(e => e.name).filter(u => /\.wasm(\?|#|$)/i.test(u));
  return [...new Set(urls)];
}

// Engine files the page's own scripts mention, for games that load their engine inside a worker or build the URL at
// runtime (both hide it from the resource list). Template parts like `${hash}` are dropped, so the guess is the plain
// file name; the panel offers it as a one-click scan and says it's a guess.
async function scriptHints() {
  const scripts = performance.getEntriesByType('resource')
    .filter(e => e.initiatorType === 'script' && new URL(e.name).origin === location.origin).map(e => e.name);
  for (const s of document.scripts) if (s.src && new URL(s.src).origin === location.origin) scripts.push(s.src);
  const wasm = new Map(), workers = new Set();
  for (const src of [...new Set(scripts)].slice(0, 25)) {
    let text = '';
    try { text = await (await fetch(src)).text(); } catch { continue; }
    if (text.length > 5e6) continue;
    for (const m of text.matchAll(/["'`]([^"'`\s]*?\.wasm)[^"'`\s]*["'`]/g)) {
      const raw = m[1], plain = raw.replace(/\$\{[^}]*\}/g, '').replace(/-+(?=\.wasm$)/, '');
      try { wasm.set(new URL(plain, src).href, { from: src.split('/').pop().split('?')[0], raw, guessed: raw !== plain }); } catch {}
    }
    for (const m of text.matchAll(/new (?:Shared)?Worker\(\s*(?:new URL\()?\s*["'`]([^"'`]+)["'`]/g)) workers.add(m[1]);
  }
  return { wasm: [...wasm].map(([url, info]) => ({ url, ...info })), workers: [...workers] };
}

async function fetchWasm(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Globals the page added, compared against a blank window from a throwaway iframe.
function pageGlobals() {
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
async function storageReport() {
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
function consoleRecorder(max = 3000) {
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

// ---- main.js ----
// EngineX-ray: click the bookmark on a browser game and see what's under the hood.
// Built by make.sh into one script (engine-xray.js) and a bookmarklet; the modules above are pasted in front of this.

(async () => {
  if (window.EngineXray) { window.EngineXray.toggle(); return; }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const mb = n => n == null ? '?' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
  const pagesMb = p => p == null ? 'no limit' : mb(p * 65536);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const state = { files: [], globals: [], storage: null, hints: { wasm: [], workers: [] }, tab: 'overview', stringQuery: '', stringPreset: null, onlyInteresting: true };
  const recorder = consoleRecorder();

  // ---- panel shell ----
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel { width: min(460px, calc(100vw - 32px)); height: min(80vh, 760px); display: flex; flex-direction: column;
      background: #0e0f12; color: #e8e8ea; border: 1px solid #2c2f36; border-radius: 12px; overflow: hidden;
      font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; box-shadow: 0 18px 50px rgba(0,0,0,.55); }
    .panel.hidden { display: none; }
    header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #15171c; cursor: move; user-select: none; }
    header b { color: #5cf2c8; font-size: 15px; letter-spacing: .3px; } header span { color: #8a8f99; flex: 1; font-size: 12px; }
    header button { background: none; border: 0; color: #8a8f99; font-size: 16px; cursor: pointer; }
    nav { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 10px; border-bottom: 1px solid #22252b; }
    nav button { background: #1b1e24; color: #c8cbd1; border: 1px solid #2c2f36; border-radius: 6px; padding: 4px 9px; cursor: pointer; font: inherit; }
    nav button.on { background: #5cf2c8; color: #0b0c0e; border-color: #5cf2c8; font-weight: 700; }
    main { flex: 1; overflow: auto; padding: 12px; }
    h3 { margin: 14px 0 6px; font-size: 13px; color: #5cf2c8; text-transform: uppercase; letter-spacing: .6px; }
    h3:first-child { margin-top: 0; }
    .card { background: #15171c; border: 1px solid #23262d; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
    .big { font-size: 18px; font-weight: 750; color: #fff; }
    .dim { color: #8a8f99; } .warn { color: #ffcc66; } .ok { color: #5cf2c8; }
    .kv { display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px; }
    ul { margin: 4px 0; padding-left: 18px; } li { margin: 2px 0; word-break: break-word; }
    code, .mono { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .list { font: 12px/1.5 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-all; }
    input[type=text] { width: 100%; background: #0b0c0e; color: #fff; border: 1px solid #2c2f36; border-radius: 6px; padding: 7px 9px; font: inherit; }
    .row { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; align-items: center; }
    .chip { background: #1b1e24; color: #c8cbd1; border: 1px solid #2c2f36; border-radius: 99px; padding: 3px 9px; cursor: pointer; font: inherit; font-size: 12px; }
    .chip.on { border-color: #5cf2c8; color: #5cf2c8; }
    .btn { background: #5cf2c8; color: #0b0c0e; border: 0; border-radius: 6px; padding: 7px 12px; font-weight: 700; cursor: pointer; font: inherit; font-weight: 700; }
    .btn.ghost { background: #1b1e24; color: #e8e8ea; border: 1px solid #2c2f36; }
    table { width: 100%; border-collapse: collapse; } td { vertical-align: top; padding: 4px 6px; border-top: 1px solid #22252b; }
    td:first-child { font: 12px ui-monospace, Menlo, monospace; color: #fff; white-space: nowrap; }
    .tip { border-left: 3px solid #5cf2c8; padding: 4px 0 4px 9px; margin: 6px 0; }
    .lvl-warn { color: #ffcc66; } .lvl-error { color: #ff7a7a; }
  </style>
  <div class="panel">
    <header><b>EngineX-ray</b><span class="status">scanning…</span><button class="close" title="Close">✕</button></header>
    <nav></nav>
    <main></main>
  </div>`;
  document.documentElement.append(host);
  const $ = s => shadow.querySelector(s);
  const status = t => { $('.status').textContent = t; };

  // drag by the header
  $('header').addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = host.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = ev => { host.style.left = Math.max(0, ev.clientX - dx) + 'px'; host.style.top = Math.max(0, ev.clientY - dy) + 'px'; host.style.right = 'auto'; };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
  $('.close').onclick = () => $('.panel').classList.add('hidden');

  const TABS = { overview: 'Overview', wasm: 'Engine file', strings: 'Strings', globals: 'Globals', storage: 'Storage', console: 'Console', report: 'Report' };
  function renderNav() {
    $('nav').innerHTML = Object.entries(TABS).map(([k, v]) => `<button data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${v}</button>`).join('');
    $('nav').querySelectorAll('button').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; render(); });
  }
  function render() {
    renderNav();
    const view = { overview, wasm, strings, globals, storage, console: consoleTab, report }[state.tab];
    $('main').innerHTML = view();
    wire[state.tab]?.();
  }
  const wire = {};

  // ---- scanning ----
  async function addWasm(url, bytes) {
    if (state.files.some(f => f.url === url)) return; // already scanned
    try {
      status(`reading ${url.split('/').pop()}…`);
      const mod = parseWasm(bytes ?? await fetchWasm(url));
      const sample = findStrings(mod, { minLength: 6, limit: 4000 }).strings;
      state.files.push({ url, mod, sample, engine: detectEngine(mod, state.globals, sample) });
    } catch (e) {
      state.files.push({ url, error: e.message });
    }
    status(`${state.files.length} engine file${state.files.length === 1 ? '' : 's'} · ${state.globals.length} globals`);
  }
  async function scan() {
    status('scanning…');
    state.globals = pageGlobals();
    for (const url of wasmUrls()) await addWasm(url);
    state.hints = await scriptHints();
    state.storage = await storageReport();
    status(`${state.files.length} engine file${state.files.length === 1 ? '' : 's'} · ${state.globals.length} globals`);
    render();
  }

  // ---- tabs ----
  function overview() {
    let h = '';
    if (!state.files.length) {
      h += `<div class="card"><div class="big">No .wasm file found yet</div><p class="dim">Some games only load their engine after you press Play or pick a level. Start the game, then click the bookmark again. If the engine loads inside a worker or an iframe, paste its URL below or open the iframe's page directly.</p></div>`;
    }
    for (const f of state.files) {
      if (f.error) { h += `<div class="card"><div class="warn">${esc(f.url)}</div><div>${esc(f.error)}</div></div>`; continue; }
      const m = f.mod, mem = m.memories[0];
      h += `<div class="card">
        <div class="dim mono">${esc(f.url.split('/').pop())}</div>
        <div class="big">${esc(f.engine.best)}</div>
        <ul>${(f.engine.matches[0]?.evidence ?? ['no fingerprint matched']).map(e => `<li>${esc(e)}</li>`).join('')}</ul>
        ${f.engine.matches.length > 1 ? `<div class="dim">Also matches: ${f.engine.matches.slice(1).map(x => esc(x.engine)).join(', ')}</div>` : ''}
        <h3>Size</h3><div class="kv">
          <span class="dim">file</span><span>${mb(m.size)}</span>
          <span class="dim">functions</span><span>${m.functions.defined.toLocaleString()} defined, ${m.functions.imported} imported${m.functionNames ? ` (${m.functionNames.toLocaleString()} have debug names)` : ''}</span>
          <span class="dim">exports / imports</span><span>${m.exports.length} / ${m.imports.length}</span>
          <span class="dim">memory</span><span>${mem ? `${pagesMb(mem.min)} start, max ${pagesMb(mem.max)}${mem.shared ? ', shared (threads)' : ''}${mem.imported ? ' · provided by the page' : ''}` : 'none'}</span>
          <span class="dim">data</span><span>${mb(m.dataBytes)} in ${m.data.length} segments</span>
          ${m.customSections.length ? `<span class="dim">extra sections</span><span>${m.customSections.map(c => esc(c.name)).join(', ')}</span>` : ''}
        </div></div>`;
    }
    const unscanned = state.hints.wasm.filter(x => !state.files.some(f => f.url === x.url));
    if (unscanned.length || state.hints.workers.length) {
      h += `<h3>Mentioned in the page's scripts</h3><div class="card">`;
      h += unscanned.map((x, i) => `<div class="row"><span class="mono">${esc(x.raw)}</span><span class="dim">in ${esc(x.from)}${x.guessed ? ' · name is a guess (built at runtime)' : ''}</span><button class="btn hint" data-i="${state.hints.wasm.indexOf(x)}">Scan</button></div>`).join('');
      if (state.hints.workers.length) h += `<div class="dim">Web workers: ${state.hints.workers.map(w => `<code>${esc(w)}</code>`).join(', ')}. Engines often run inside these, which is why their files don't show up in the page's list.</div>`;
      h += `</div>`;
    }
    h += `<h3>Where to start</h3>${tips().map(t => `<div class="tip">${t}</div>`).join('') || '<div class="dim">Nothing stood out yet.</div>'}`;
    h += `<h3>Scan another engine file</h3><div class="row"><input type="text" class="url" placeholder="https://…/game.wasm"><button class="btn add">Scan</button><button class="btn ghost pick">From file…</button><input type="file" class="file" accept=".wasm" hidden></div>`;
    return h;
  }
  wire.overview = () => {
    $('.add').onclick = async () => { const u = $('.url').value.trim(); if (u) { await addWasm(new URL(u, location.href).href); status('done'); render(); } };
    shadow.querySelectorAll('.hint').forEach(b => b.onclick = async () => { b.textContent = 'Reading…'; await addWasm(state.hints.wasm[+b.dataset.i].url); render(); });
    $('.pick').onclick = () => $('.file').click();
    $('.file').onchange = async e => { const f = e.target.files[0]; if (f) { await addWasm(f.name, new Uint8Array(await f.arrayBuffer())); status('done'); render(); } };
  };

  function tips() {
    const t = [];
    const hooks = state.globals.filter(g => g.name.startsWith('__'));
    if (hooks.length) t.push(`<b>Hidden-looking globals:</b> ${hooks.slice(0, 8).map(g => `<code>${esc(g.name)}</code>`).join(', ')}. Double-underscore names are often test hooks or debug switches. Check the Globals tab.`);
    const engines = state.globals.filter(g => g.notes.some(n => /Emscripten Module|callMain|SendMessage|engine's memory|WebAssembly instance/.test(n)));
    if (engines.length) t.push(`<b>Engine handles on the page:</b> ${engines.slice(0, 6).map(g => `<code>${esc(g.name)}</code>`).join(', ')}. You can call into the engine from the console through these.`);
    for (const f of state.files.filter(f => f.mod)) {
      const api = interestingExports(f.mod)['Engine API (custom exports)'];
      if (api.length) t.push(`<b>${api.length} custom engine functions</b> are exported (e.g. ${api.slice(0, 4).map(a => `<code>${esc(a.split(' ')[0])}</code>`).join(', ')}). These are the game's own entry points. Engine file tab.`);
      const cvars = f.sample.filter(s => STRING_PRESETS['Settings / cvars'].test(s)).length;
      if (cvars > 20) t.push(`<b>${cvars.toLocaleString()} setting-like names</b> in the engine's text (like <code>fs_game</code>-style cvars). If the engine takes command-line options, these are the knobs. Strings tab → Settings.`);
      if (f.mod.imports.some(i => /^__syscall_open|fd_read|__syscall_openat/.test(i.name))) t.push('The engine reads files through a virtual file system: look for the folder it reads from in Storage.');
    }
    if (!state.files.length && state.hints.wasm.length) t.push(`<b>The engine file is named in the page's scripts</b> but wasn't in the page's resource list (it probably loads inside a worker). Use its Scan button above.`);
    for (const f of state.files.filter(f => f.mod)) {
      const bridge = bridgeFunctions(f.mod);
      if (bridge.length > 10) t.push(`<b>${bridge.length} JavaScript bridge functions</b> the engine calls (e.g. ${bridge.slice(0, 4).map(b => `<code>${esc(b)}</code>`).join(', ')}). Wrapping one of these on the page is often the quickest way in. Engine file tab.`);
    }
    const opfs = state.storage?.opfs ?? [];
    if (opfs.length) t.push(`<b>Game data in private storage (OPFS):</b> ${opfs.map(o => `<code>${esc(o.name)}</code> ${mb(o.bytes)}`).join(', ')}. Files here are what the engine actually loads, and they can be written from the page.`);
    if (state.storage?.indexedDB?.length) t.push(`<b>IndexedDB:</b> ${state.storage.indexedDB.map(esc).join(', ')}. Saves and settings often live here.`);
    return t;
  }

  function wasm() {
    const f = state.files.filter(x => x.mod);
    if (!f.length) return '<div class="dim">No engine file scanned.</div>';
    let h = '';
    for (const { url, mod } of f) {
      h += `<div class="dim mono">${esc(url.split('/').pop())}</div>`;
      for (const [label, list] of Object.entries(interestingExports(mod))) {
        if (!list.length) continue;
        h += `<h3>${esc(label)} (${list.length})</h3><div class="list">${list.slice(0, 400).map(esc).join('\n')}${list.length > 400 ? '\n…' : ''}</div>`;
      }
      const bridge = bridgeFunctions(mod);
      if (bridge.length) h += `<h3>JS bridge: functions the engine calls on the page (${bridge.length})</h3><p class="dim">These are the page's JavaScript functions the engine depends on. Wrapping one from the console is the easiest way to watch or change what the engine does (networking, input, saving, rendering).</p><div class="list">${bridge.slice(0, 300).map(esc).join('\n')}${bridge.length > 300 ? '\n…' : ''}</div>`;
      const byModule = {};
      for (const i of mod.imports) (byModule[i.module] ??= []).push(i.name + (i.kind !== 'function' ? ` (${i.kind})` : ''));
      h += `<h3>Imports: what the engine asks the browser for</h3>`;
      for (const [m, names] of Object.entries(byModule)) h += `<div class="card"><b class="mono">${esc(m)}</b> <span class="dim">${names.length}</span><div class="list dim">${names.slice(0, 120).map(esc).join('\n')}${names.length > 120 ? '\n…' : ''}</div></div>`;
    }
    return h;
  }

  function strings() {
    let h = `<div class="row">${Object.keys(STRING_PRESETS).map(p => `<button class="chip ${state.stringPreset === p ? 'on' : ''}" data-p="${esc(p)}">${esc(p)}</button>`).join('')}</div>
      <input type="text" class="q" placeholder="Search the engine's text (e.g. mod, cheat, console, save)" value="${esc(state.stringQuery)}">
      <div class="results"></div>`;
    return h;
  }
  wire.strings = () => {
    const run = () => {
      const files = state.files.filter(x => x.mod);
      const filter = state.stringPreset ? STRING_PRESETS[state.stringPreset] : state.stringQuery || null;
      if (!filter) { $('.results').innerHTML = '<p class="dim">Pick a preset or type something.</p>'; return; }
      let h = '';
      for (const f of files) {
        const { strings, total } = findStrings(f.mod, { minLength: 4, filter, limit: 300 });
        const shown = strings.filter(s => filter instanceof RegExp ? filter.test(s) : true);
        h += `<h3>${esc(f.url.split('/').pop())}: ${shown.length}${shown.length >= 300 ? '+' : ''} matches <span class="dim">(of ${total.toLocaleString()} strings)</span></h3><div class="list">${shown.map(esc).join('\n')}</div>`;
      }
      $('.results').innerHTML = h || '<p class="dim">No engine file scanned.</p>';
    };
    shadow.querySelectorAll('.chip').forEach(c => c.onclick = () => { state.stringPreset = state.stringPreset === c.dataset.p ? null : c.dataset.p; state.stringQuery = ''; render(); });
    $('.q').oninput = debounce(e => { state.stringQuery = e.target.value; state.stringPreset = null; shadow.querySelectorAll('.chip').forEach(c => c.classList.remove('on')); run(); }, 250);
    run();
  };

  function globals() {
    const list = state.onlyInteresting ? state.globals.filter(g => g.notes.length) : state.globals;
    return `<div class="row"><label><input type="checkbox" class="only" ${state.onlyInteresting ? 'checked' : ''}> only the interesting ones</label>
      <span class="dim">${list.length} of ${state.globals.length}</span><button class="btn ghost rescan">Rescan</button></div>
      <table>${list.map(g => `<tr><td>${esc(g.name)}</td><td><span class="dim">${esc(g.type)}</span>${g.notes.length ? `<ul>${g.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</td></tr>`).join('')}</table>`;
  }
  wire.globals = () => {
    $('.only').onchange = e => { state.onlyInteresting = e.target.checked; render(); };
    $('.rescan').onclick = () => { state.globals = pageGlobals(); render(); };
  };

  function storage() {
    const s = state.storage;
    if (!s) return '<div class="dim">Reading…</div>';
    let h = `<div class="card kv"><span class="dim">used</span><span>${mb(s.estimate?.usage)} of ${mb(s.estimate?.quota)}</span>
      ${s.estimate?.details ? Object.entries(s.estimate.details).map(([k, v]) => `<span class="dim">${esc(k)}</span><span>${mb(v)}</span>`).join('') : ''}</div>`;
    h += `<h3>Private file storage (OPFS)</h3>`;
    h += s.opfs.length ? s.opfs.map(o => `<div class="card"><b class="mono">${esc(o.name)}</b> <span class="dim">${o.kind === 'file' ? mb(o.bytes) : `${mb(o.bytes)} · ${o.files.toLocaleString()} files`}</span>
      ${o.children?.length ? `<div class="list dim">${o.children.slice(0, 40).map(c => `${c.kind === 'directory' ? '📁' : '·'} ${esc(c.name)}  ${c.bytes != null ? mb(c.bytes) : ''}`).join('\n')}</div>` : ''}</div>`).join('') : `<div class="dim">${esc(s.opfsError ?? 'empty')}</div>`;
    h += `<h3>IndexedDB</h3><div class="list">${s.indexedDB.length ? s.indexedDB.map(esc).join('\n') : '<span class="dim">none</span>'}</div>`;
    h += `<h3>localStorage (${s.localStorage.length})</h3><div class="list">${s.localStorage.slice(0, 60).map(k => `${esc(k.key)}  <span class="dim">${mb(k.bytes)}</span>`).join('\n') || '<span class="dim">none</span>'}</div>`;
    h += `<h3>Cache Storage</h3><div class="list">${s.caches.length ? s.caches.map(esc).join('\n') : '<span class="dim">none</span>'}</div>`;
    h += `<div class="row"><button class="btn ghost restore">Rescan storage</button></div>`;
    return h;
  }
  wire.storage = () => { $('.restore').onclick = async () => { state.storage = null; render(); state.storage = await storageReport(); render(); }; };

  function consoleTab() {
    return `<div class="row"><button class="btn rec">${recorder.on ? 'Stop recording' : 'Start recording'}</button><button class="btn ghost clr">Clear</button>
      <span class="dim">${recorder.lines.length} lines</span></div>
      <input type="text" class="cq" placeholder="Filter lines">
      <div class="list lines"></div>
      <p class="dim">Records what the page prints from now on. Engines often log their startup options, loaded files and errors, which tells you where the hooks are.</p>`;
  }
  wire.console = () => {
    const show = () => {
      const q = $('.cq').value.toLowerCase();
      const rows = recorder.lines.filter(l => !q || l.text.toLowerCase().includes(q)).slice(-300);
      $('.lines').innerHTML = rows.map(l => `<span class="lvl-${l.level}">${esc(l.text)}</span>`).join('\n');
    };
    $('.rec').onclick = () => { recorder.on ? recorder.stop() : recorder.start(); render(); };
    $('.clr').onclick = () => { recorder.lines.length = 0; render(); };
    $('.cq').oninput = debounce(show, 200);
    show();
    if (recorder.on) { const id = setInterval(() => { if (state.tab !== 'console' || !shadow.contains($('.lines'))) return clearInterval(id); show(); }, 1000); }
  };

  function reportMarkdown() {
    const lines = [`# EngineX-ray report: ${location.host}${location.pathname}`, '', `Scanned ${new Date().toISOString()}`, ''];
    for (const f of state.files) {
      if (f.error) { lines.push(`## ${f.url}`, '', `Error: ${f.error}`, ''); continue; }
      const m = f.mod;
      lines.push(`## ${f.url.split('/').pop()}`, '', `- Engine: **${f.engine.best}** (${(f.engine.matches[0]?.evidence ?? []).join('; ')})`,
        `- Size: ${mb(m.size)}, ${m.functions.defined} functions, ${m.exports.length} exports, ${m.imports.length} imports`,
        `- Memory: ${m.memories.map(x => `${pagesMb(x.min)}–${pagesMb(x.max)}${x.shared ? ' shared' : ''}`).join(', ') || 'none'}`, '');
      for (const [label, list] of Object.entries(interestingExports(m))) if (list.length) lines.push(`### ${label}`, '', list.slice(0, 100).map(x => `- \`${x}\``).join('\n'), '');
    }
    lines.push('## Interesting globals', '', ...state.globals.filter(g => g.notes.length).map(g => `- \`${g.name}\` (${g.type}): ${g.notes.join('; ')}`), '');
    const s = state.storage;
    if (s) lines.push('## Storage', '', `- Used ${mb(s.estimate?.usage)} of ${mb(s.estimate?.quota)}`, ...s.opfs.map(o => `- OPFS \`${o.name}\`: ${mb(o.bytes)}${o.files ? `, ${o.files} files` : ''}`),
      ...s.indexedDB.map(d => `- IndexedDB ${d}`), `- localStorage: ${s.localStorage.length} keys`, '');
    lines.push('## Where to start', '', ...tips().map(t => '- ' + t.replace(/<[^>]+>/g, '')), '', '_Made with EngineX-ray_');
    return lines.join('\n');
  }
  function report() {
    return `<p>A Markdown summary of everything above, for your notes or a GitHub issue.</p>
      <div class="row"><button class="btn copy">Copy report</button><button class="btn ghost save">Download .md</button><span class="dim done"></span></div>
      <div class="list dim">${esc(reportMarkdown())}</div>`;
  }
  wire.report = () => {
    $('.copy').onclick = async () => { try { await navigator.clipboard.writeText(reportMarkdown()); $('.done').textContent = 'Copied.'; } catch { $('.done').textContent = 'Copy blocked: use Download.'; } };
    $('.save').onclick = () => {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([reportMarkdown()], { type: 'text/markdown' })), download: `enginexray-${location.host}.md` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
  };

  window.EngineXray = {
    toggle() { $('.panel').classList.toggle('hidden'); },
    state, rescan: scan, report: reportMarkdown,
    addWasm: async (url, bytes) => { await addWasm(url, bytes); render(); },
  };
  render();
  await scan();
})();

})();
