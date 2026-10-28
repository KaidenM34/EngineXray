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
    functions: { imported: 0, defined: 0 }, customSections: [], data: [], dataBytes: 0, functionNames: 0, names: [],
    sections: [],
  };
  while (r.pos < bytes.length) {
    const id = r.byte(), len = r.u32(), start = r.pos, end = start + len;
    out.sections.push({ id, size: len });
    try {
      if (id === 0) {
        const name = r.name();
        out.customSections.push({ name, size: end - r.pos });
        if (name === 'name') { out.names = readFunctionNames(r, end); out.functionNames = out.names.length; }
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

// The "name" custom section: subsection 1 lists function names (debug builds and many engines keep it). Capped so a
// huge debug build doesn't hold hundreds of thousands of strings.
function readFunctionNames(r, end, cap = 200000) {
  while (r.pos < end) {
    const sub = r.byte(), len = r.u32(), next = r.pos + len;
    if (sub === 1) {
      const names = [];
      for (let n = r.u32(); n-- && names.length < cap;) { r.u32(); names.push(r.name()); }
      return names;
    }
    r.pos = next;
  }
  return [];
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
// EngineX-ray's own file, when it's loaded as a script (the test range does this). Its detection lists contain miner
// and tracker names, so it must never scan itself.
const SELF_URL = (document.currentScript?.src ?? '').split('?')[0];

// fetch with a time limit. A request that never answers (a held-open connection, an extension sitting on it) would
// otherwise stall the whole scan; this one gives up and the caller skips that file. The limit covers the body too.
function timedFetch(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  // .busy marks EngineX-ray's own requests while the fetch call starts, so Live watch doesn't count them.
  timedFetch.busy = (timedFetch.busy ?? 0) + 1;
  let started;
  try { started = fetch(url, { ...opts, signal: ctrl.signal }); } finally { timedFetch.busy--; }
  return started.then(res => {
    const read = kind => () => res[kind]().finally(() => clearTimeout(timer));
    return { ok: res.ok, status: res.status, headers: res.headers, text: read('text'), arrayBuffer: read('arrayBuffer') };
  }, e => { clearTimeout(timer); throw e; });
}

// Resolved against the page and never throws: some sites hand back relative or odd script URLs.
const absUrl = u => { try { return new URL(u, location.href); } catch { return null; } };

async function scriptHints() {
  const scripts = performance.getEntriesByType('resource')
    .filter(e => e.initiatorType === 'script' && absUrl(e.name)?.origin === location.origin).map(e => e.name);
  for (const s of document.scripts) { const u = s.src && absUrl(s.src); if (u?.origin === location.origin) scripts.push(u.href); }
  const wasm = new Map(), workers = new Set(), texts = [];
  const queue = [...new Set(scripts)].filter(u => !(SELF_URL && u.split('?')[0] === SELF_URL)).slice(0, 25), done = new Set();
  while (queue.length && done.size < 40) {
    // Eight at a time, so a few slow files can't use up the step's deadline.
    const batch = [...new Set(queue.splice(0, 8))].filter(u => !done.has(u));
    batch.forEach(u => done.add(u));
    const read = await Promise.all(batch.map(src => timedFetch(src).then(r => r.text()).then(text => [src, text], () => [src, ''])));
    for (const [src, text] of read) {
    if (!text || text.length > 5e6) continue;
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
  }
  return { wasm: [...wasm].map(([url, info]) => ({ url, ...info })), workers: [...workers], texts };
}

// Third-party scripts the page loaded, re-read where the browser allows it (CDNs that send CORS headers). These are
// the same files the page already downloaded, usually straight from cache; scripts that don't allow it are skipped.
async function thirdPartyScriptTexts({ max = 30, maxBytes = 3e6 } = {}) {
  const urls = [...new Set(performance.getEntriesByType('resource')
    .filter(e => e.initiatorType === 'script' && (absUrl(e.name)?.origin ?? location.origin) !== location.origin).map(e => e.name))].slice(0, max);
  const out = [];
  await Promise.all(urls.map(async url => {
    try {
      const res = await timedFetch(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
      if (!res.ok) return;
      const text = await res.text();
      if (text.length <= maxBytes) out.push([absUrl(url).hostname + '/' + url.split('/').pop().split('?')[0], text]);
    } catch {}
  }));
  return out;
}

async function fetchWasm(url) {
  const res = await timedFetch(url, {}, 60000);
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
    let value, type, notes = [];
    try { value = window[name]; type = describeType(value); } catch { type = 'unreadable'; }
    // An embedded frame from another site shows up as a global too. The browser throws on any look inside it.
    if (type === 'unreadable' && isCrossOriginWindow(value)) type = 'frame from another site';
    try { notes = notesFor(name, value); } catch { notes = type === 'frame from another site' ? [] : ['could not be read']; }
    out.push({ name, type, notes });
  }
  // The interesting ones first: engine handles and hook-looking names.
  return out.sort((a, b) => b.notes.length - a.notes.length || a.name.localeCompare(b.name));
}

function isCrossOriginWindow(v) {
  try { return v != null && v.window === v && v !== window && (v.document, false); } catch { return true; }
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

// ---- security/lists.js ----
// Reference data for the Security tab. Kept short and well-known on purpose: every entry here is something the panel
// will name in a finding, so it has to be right. Add to these lists rather than loosening the matching.

// Browser-mining services (most are defunct, but their scripts and clones still circulate).
const MINER_DOMAINS = [
  'coinhive.com', 'coin-hive.com', 'authedmine.com', 'crypto-loot.com', 'cryptoloot.pro', 'coinimp.com', 'coinimp.net',
  'webminepool.com', 'minero.cc', 'jsecoin.com', 'ppoi.org', 'monerominer.rocks', 'cryptonoter.com', 'coinhave.com',
  'webmine.cz', 'webmine.pro', 'coinpot.co', 'hashing.win', 'mineralt.io', 'freecontent.bid', 'deepminer.net',
];

// Text that shows up inside browser miners (JS, worker scripts or wasm strings / function names).
const MINER_STRONG = /cryptonight|cryptonite|randomx|coinhive|coin-hive|cryptoloot|crypto-loot|coinimp|webminepool|deepminer|\bxmrig\b|stratum\+(tcp|ssl)|mining\.(subscribe|notify|authorize)|\bgetHashesPerSecond\b|\bhashesPerSecond\b/i;
const MINER_WEAK = /\bmonero\b|\bxmr\b|hashrate|\bnonce\b.{0,40}\btarget\b|job_id|\bgroestl\b|\bskein\b|\bjh256\b|blake256|\bsetThrottle\b/i;
// WebSocket URLs that look like a mining pool or proxy.
const POOL_URL = /pool|stratum|xmr|monero|miner|mining|hashvault|nanopool|supportxmr|minexmr/i;
// JSON-RPC methods of the stratum mining protocol (also used over WebSocket by browser miners).
const STRATUM_FRAME = /"(method|type)"\s*:\s*"(login|submit|job|getjob|keepalived|mining\.\w+)"/i;

// Little-endian byte patterns of well-known crypto tables. Finding one means the code computes that algorithm.
// CryptoNight (Monero's old proof of work) = Keccak + AES rounds + one of BLAKE-256 / Groestl / JH / Skein.
const CRYPTO_CONSTANTS = [
  { id: 'keccak', name: 'Keccak / SHA-3 round constants', bytes: [0x8a, 0x80, 0, 0, 0, 0, 0, 0x80, 0, 0x80, 0, 0x80, 0, 0, 0, 0x80] },
  { id: 'aes', name: 'AES S-box', bytes: [0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76] },
  { id: 'aes', name: 'AES T-table', bytes: [0xa5, 0x63, 0x63, 0xc6, 0x84, 0x7c, 0x7c, 0xf8] },
  { id: 'sha256k', name: 'SHA-256 round constants', bytes: [0x98, 0x2f, 0x8a, 0x42, 0x91, 0x44, 0x37, 0x71, 0xcf, 0xfb, 0xc0, 0xb5] },
  { id: 'blake256', name: 'SHA-256 / BLAKE-256 initial values', bytes: [0x67, 0xe6, 0x09, 0x6a, 0x85, 0xae, 0x67, 0xbb] },
  { id: 'blake2b', name: 'SHA-512 / BLAKE2b initial values', bytes: [0x08, 0xc9, 0xbc, 0xf3, 0x67, 0xe6, 0x09, 0x6a] },
];

// Third-party services by category. Matched on the end of the hostname.
const TRACKERS = {
  'session replay': ['hotjar.com', 'hotjar.io', 'sr-client-cfg.amplitude.com', 'api-sr.amplitude.com', 'fullstory.com', 'logrocket.com', 'logrocket.io', 'lr-ingest.io', 'clarity.ms',
    'mouseflow.com', 'smartlook.com', 'inspectlet.com', 'luckyorange.com', 'quantummetric.com', 'contentsquare.net', 'glassboxdigital.io'],
  'fingerprinting / bot detection': ['fpjs.io', 'fpcdn.io', 'fingerprint.com', 'fingerprintjs.com', 'online-metrix.net', 'iovation.com',
    'px-cdn.net', 'px-cloud.net', 'pxchk.net', 'perimeterx.net', 'humansecurity.com', 'datadome.co', 'kasada.io', 'arkoselabs.com'],
  'ads': ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adnxs.com', 'amazon-adsystem.com', 'criteo.com',
    'criteo.net', 'taboola.com', 'outbrain.com', 'adsrvr.org', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'casalemedia.com',
    'moatads.com', 'adform.net', 'bat.bing.com', 'ads-twitter.com', 'ads.linkedin.com', 'sharethrough.com', 'teads.tv', '33across.com'],
  'social pixels': ['connect.facebook.net', 'facebook.com', 'analytics.tiktok.com', 'sc-static.net', 'ct.pinterest.com', 'snap.licdn.com',
    'px.ads.linkedin.com', 'redditstatic.com', 'alb.reddit.com'],
  'analytics': ['google-analytics.com', 'googletagmanager.com', 'analytics.google.com', 'segment.io', 'segment.com', 'mixpanel.com',
    'amplitude.com', 'heap.io', 'heapanalytics.com', 'plausible.io', 'nr-data.net', 'newrelic.com', 'quantserve.com',
    'scorecardresearch.com', 'chartbeat.com', 'chartbeat.net', 'parsely.com', 'static.cloudflareinsights.com', 'cloudflareinsights.com', 'pendo.io', 'posthog.com'],
  'error monitoring': ['sentry.io', 'sentry-cdn.com', 'bugsnag.com', 'datadoghq.com', 'browser-intake-datadoghq.com'],
};

// Secret / token patterns. sev = severity when found in code or storage the page ships to every visitor.
const SECRET_PATTERNS = [
  { name: 'AWS access key ID', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, sev: 'high', means: 'Identifies an AWS account key. If its secret half is anywhere near it, anyone can use the account.' },
  { name: 'Stripe secret key', re: /\b(sk|rk)_live_[0-9a-zA-Z]{20,}\b/g, sev: 'high', means: 'Full access to a Stripe account: charges, refunds, customer data.' },
  { name: 'Stripe test secret key', re: /\b(sk|rk)_test_[0-9a-zA-Z]{20,}\b/g, sev: 'medium', means: 'A test-mode secret key. No real money, but it shows secret keys are being shipped to browsers.' },
  { name: 'Stripe publishable key', re: /\bpk_(live|test)_[0-9a-zA-Z]{20,}\b/g, sev: 'info', means: 'Publishable keys are meant to be public. Fine on its own.' },
  { name: 'GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g, sev: 'high', means: 'Access to GitHub repositories as the token\'s owner.' },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, sev: 'high', means: 'Can read or post messages in a Slack workspace.' },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, sev: 'high', means: 'Lets anyone run paid AI requests on the owner\'s account.' },
  { name: 'OpenAI-style API key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/g, sev: 'high', means: 'Lets anyone run paid AI requests on the owner\'s account.' },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, sev: 'info', means: 'Often public by design (Maps, Firebase). Safe only if it is restricted to this site in the Google Cloud console.' },
  { name: 'Private key', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g, sev: 'high', means: 'A private key should never be sent to a browser.' },
];
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const SESSION_COOKIE = /sess|\bsid\b|auth|token|jwt|login|remember|access|refresh/i;
const NOT_SESSION_COOKIE = /^(_ga|_gid|_gcl|_fbp|_fbc|__cf|cf_|_hj|ajs_|amplitude|mp_|_clck|_clsk|csrf|xsrf|_csrf|cookie_?consent|OptanonConsent)/i;
// Session-named cookies and keys that belong to analytics, ad, feedback and bot-check vendors (seen in the 20-site
// survey): they identify a visit, not a login. Reported as low, not as an exposed login session.
const VISITOR_SESSION = /^(aws-waf-token|_pin_unauth)$|^(ab\.storage|kampyle|__attentive|_parsely|optimizely|blaize|bcsession|logglytracking|gc_session|mgnisession|__milesession|s_sess$|as_session_id|cet-page_session|bf-xdomain|foxkit|ebay-rum|session_landing|_sdsat|ffsession|app_session_id|poki_session)|rum-session|session-data$/i;
const TRACKING_ID_KEYS = /^(_ga|_gid|_fbp|_fbc|ajs_anonymous_id|ajs_user_id|amplitude_id|_hjSessionUser|_clck|mp_.*_mixpanel|__hstc|hubspotutk|_uetvid|_pin_unauth|_tt_enable_cookie|_ttp)/i;

function hostCategory(hostname) {
  for (const [category, domains] of Object.entries(TRACKERS)) {
    if (domains.some(d => hostname === d || hostname.endsWith('.' + d))) return category;
  }
  return null;
}
function isMinerHost(hostname) {
  return MINER_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
}

// Another site than this page's (compared by the last two name parts, so cdn.example.com counts as example.com).
const siteOf = host => host.split('.').slice(-2).join('.');
const isThirdPartyHost = host => !!host && host !== location.hostname && siteOf(host) !== siteOf(location.hostname);

// ---- security/hooks.js ----
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

function createWatcher() {
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

// ---- security/miner.js ----
// Hidden crypto-miner detection. Evidence is combined, never trusted alone: AES and SHA tables are in plenty of normal
// software, so constants only raise the alarm together with miner text, pool traffic or known miner hosts.

// Which crypto tables a wasm file contains. Scans data segments at 4-byte steps (tables are word-aligned in memory).
function cryptoConstants(mod) {
  const found = new Map();
  const byPrefix = new Map();
  for (const c of CRYPTO_CONSTANTS) {
    const prefix = c.bytes[0] | c.bytes[1] << 8 | c.bytes[2] << 16 | (c.bytes[3] << 24 >>> 0);
    (byPrefix.get(prefix >>> 0) ?? byPrefix.set(prefix >>> 0, []).get(prefix >>> 0)).push(c);
  }
  const b = mod.bytes, view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ranges = mod.data.length ? mod.data : [{ start: 0, size: b.length }];
  for (const { start, size } of ranges) {
    for (let i = start, end = start + size - 16; i <= end; i += 4) {
      const hits = byPrefix.get(view.getUint32(i, true));
      if (!hits) continue;
      for (const c of hits) {
        if (found.has(c.id)) continue;
        let ok = true;
        for (let k = 4; k < c.bytes.length; k++) if (b[i + k] !== c.bytes[k]) { ok = false; break; }
        if (ok) found.set(c.id, c.name);
      }
    }
  }
  return found; // id -> name
}

function minerFindings({ files, hints, watcher, workerTexts }) {
  const findings = [];
  const strongText = [], weakText = [];
  const check = (where, text) => {
    const s = MINER_STRONG.exec(text); if (s) strongText.push(`"${s[0].slice(0, 60)}" in ${where}`);
    const w = MINER_WEAK.exec(text); if (w) weakText.push(`"${w[0].slice(0, 60)}" in ${where}`);
  };

  // 1. Known miner services loaded by the page.
  const hosts = performance.getEntriesByType('resource').map(e => { try { return new URL(e.name).hostname; } catch { return ''; } });
  const minerHosts = [...new Set(hosts.filter(isMinerHost))];
  if (minerHosts.length) findings.push({ sev: 'high', title: 'Loads a known browser-mining service', evidence: minerHosts,
    means: 'This page pulled code from a service that exists to mine cryptocurrency in visitors\' browsers.', todo: 'Close the tab. If it\'s your site, look for a compromised script or ad tag.' });

  // 2. Each engine file: crypto tables + miner text in its strings and function names.
  for (const f of files.filter(x => x.mod)) {
    const name = f.url.split('/').pop();
    // The file doesn't change, so its scan is done once and kept (big engines are tens of MB).
    f.minerScan ??= {
      consts: cryptoConstants(f.mod),
      strong: [...findStrings(f.mod, { minLength: 4, filter: MINER_STRONG, limit: 5 }).strings.map(s => `"${s.slice(0, 60)}" in ${name}`),
        ...(f.mod.names ?? []).filter(n => MINER_STRONG.test(n)).slice(0, 5).map(fn => `function ${fn}() in ${name}`)],
      weak: findStrings(f.mod, { minLength: 4, filter: MINER_WEAK, limit: 5 }).strings.map(s => `"${s.slice(0, 60)}" in ${name}`),
      randomxText: findStrings(f.mod, { minLength: 4, filter: /randomx|argon2/i, limit: 1 }).strings.length > 0,
    };
    const consts = f.minerScan.consts;
    strongText.push(...f.minerScan.strong); weakText.push(...f.minerScan.weak);
    const finalizer = consts.has('blake256') || weakText.some(t => /groestl|skein|jh256|blake256/i.test(t) && t.endsWith(name));
    const cryptonight = consts.has('keccak') && consts.has('aes') && finalizer;
    const randomx = consts.has('blake2b') && f.minerScan.randomxText;
    if (cryptonight || randomx) {
      findings.push({ sev: f.minerScan.strong.length ? 'high' : 'low', title: `${name}: ${cryptonight ? 'CryptoNight' : 'RandomX'}-shaped hashing code`,
        evidence: [...consts.values(), ...(randomx ? ['RandomX / Argon2 text'] : [])],
        means: cryptonight
          ? 'Keccak + AES + a BLAKE/Groestl/JH/Skein finalizer is the recipe of CryptoNight, the proof-of-work browser miners used for Monero. ' + (f.minerScan.strong.length ? 'Together with the miner text in the same file, this is very likely a miner.' : 'Crypto libraries can contain the same pieces, so on its own this is only a lead.')
          : 'BLAKE2b plus RandomX/Argon2 text is the shape of RandomX, Monero\'s current proof of work.',
        todo: f.minerScan.strong.length ? 'Treat as a miner. Watch the page to see if it connects to a pool.' : 'Check the Strings tab and watch the page for pool connections before concluding anything.' });
    } else if (consts.size) {
      findings.push({ sev: 'info', title: `${name}: contains standard crypto tables`, evidence: [...consts.values()],
        means: 'Normal for apps that hash or encrypt (downloads, saves, networking). Not a miner signal by itself.', todo: 'Nothing, unless other miner signs show up.' });
    }
  }

  // 3. Scripts and workers the page ships.
  for (const [where, text] of workerTexts) check(where, text);
  if (strongText.length) findings.push({ sev: 'high', title: 'Mining code text found', evidence: [...new Set(strongText)].slice(0, 8),
    means: 'Names of mining algorithms, miner products or mining-protocol messages appear in the page\'s code.', todo: 'Confirm by watching the page: a miner will connect to a pool and keep the CPU busy.' });
  else if (weakText.length >= 2) findings.push({ sev: 'low', title: 'Mining-related words found', evidence: [...new Set(weakText)].slice(0, 8),
    means: 'Words like "monero", "hashrate" or "job_id" appear. Common in crypto or finance apps too.', todo: 'Only a lead. Look for stronger signs.' });

  // 4. Live: pool connections and worker swarms.
  if (watcher) {
    for (const s of watcher.sockets) {
      const frames = [...s.sent, ...s.received].filter(x => STRATUM_FRAME.test(x));
      let host = ''; try { host = new URL(s.url).hostname; } catch {}
      if (frames.length) findings.push({ sev: 'high', title: 'Talks the mining (stratum) protocol', evidence: [s.url, ...frames.slice(0, 3)],
        means: 'The page sent or received mining-pool messages (login / job / submit) over a WebSocket.', todo: 'This is a miner. Close the tab; if it\'s your site, find the script that opened the socket: ' + s.script });
      else if (POOL_URL.test(s.url) || isMinerHost(host)) findings.push({ sev: 'medium', title: 'WebSocket to a pool-like address', evidence: [s.url, 'opened by ' + s.script],
        means: 'The address looks like a mining pool or proxy.', todo: 'Keep watching for stratum messages to confirm.' });
    }
    const cores = navigator.hardwareConcurrency || 4;
    if (watcher.workers.length >= Math.max(3, cores - 1)) findings.push({ sev: 'medium', title: `Started ${watcher.workers.length} workers (you have ${cores} cores)`, evidence: [...new Set(watcher.workers.map(w => w.url))].slice(0, 5),
      means: 'Miners start one worker per CPU core to use all of it. Games and video tools do this too.', todo: 'Check your CPU use (Activity Monitor). Sustained 100% on an idle page is a miner sign.' });
  }
  return findings;
}

// ---- security/privacy.js ----
// Privacy: who the page shares you with (third-party services by category), whether a script is fingerprinting your
// device (from the live watcher), and which long-lived tracking IDs are stored in your browser.

function thirdParties() {
  const first = location.hostname.split('.').slice(-2).join('.');
  const byHost = new Map();
  for (const e of performance.getEntriesByType('resource')) {
    let host; try { host = new URL(e.name).hostname; } catch { continue; }
    if (!host || host === location.hostname || host.endsWith('.' + first) || host === first) continue;
    const entry = byHost.get(host) ?? { host, category: hostCategory(host), count: 0, kinds: new Set() };
    entry.count++; entry.kinds.add(e.initiatorType);
    byHost.set(host, entry);
  }
  return [...byHost.values()].sort((a, b) => (b.category ? 1 : 0) - (a.category ? 1 : 0) || b.count - a.count);
}

const FP_TECHS = ['canvas readback', 'font probing (measureText)', 'GPU model (WebGL)', 'audio fingerprint (OfflineAudioContext)',
  'device details (navigator)', 'camera/mic list (enumerateDevices)', 'battery status', 'WebRTC (can reveal local IP)'];

function privacyFindings({ watcher, storage, cookies }) {
  const findings = [];
  const parties = thirdParties();
  const cat = c => parties.filter(p => p.category === c).map(p => p.host);

  const replay = cat('session replay');
  if (replay.length) findings.push({ sev: 'high', title: 'Session replay: your clicks and typing are recorded', evidence: replay,
    means: 'These services record mouse movement, clicks, scrolling and often keystrokes so the site can watch your visit like a video.', todo: 'Avoid typing anything sensitive here, or block the hosts with a content blocker.' });
  const fpServices = cat('fingerprinting / bot detection');
  if (fpServices.length) findings.push({ sev: 'medium', title: 'Uses a device-fingerprinting / bot-detection service', evidence: fpServices,
    means: 'These build an ID from your device\'s quirks that survives clearing cookies. Often used for fraud and bot checks.', todo: 'Expected on login and checkout pages. Elsewhere, it\'s tracking.' });
  for (const [c, sev] of [['ads', 'low'], ['social pixels', 'low'], ['analytics', 'info'], ['error monitoring', 'info']]) {
    const hosts = cat(c);
    if (hosts.length) findings.push({ sev, title: `${hosts.length} ${c} service${hosts.length > 1 ? 's' : ''}`, evidence: hosts,
      means: { ads: 'Ad networks follow you between sites to target ads.', 'social pixels': 'Tells social networks you visited, even if you never clicked a share button.', analytics: 'Measures how visitors use the site.', 'error monitoring': 'Reports crashes to the developers. Can include what was on screen.' }[c], todo: c === 'ads' || c === 'social pixels' ? 'A content blocker stops most of these.' : 'Normal for most sites.' });
  }
  const unknown = parties.filter(p => !p.category);
  if (unknown.length) findings.push({ sev: 'info', title: `${unknown.length} other third-party host${unknown.length > 1 ? 's' : ''}`, evidence: unknown.slice(0, 15).map(p => `${p.host} (${p.count})`),
    means: 'Not on the tracker lists: often CDNs, fonts or the site\'s own services on another domain.', todo: 'Nothing, unless one looks unfamiliar.' });

  // Live fingerprinting, per script.
  if (watcher) {
    for (const [script, techs] of watcher.byScript()) {
      const used = FP_TECHS.filter(t => techs.has(t) && !(t === 'font probing (measureText)' && techs.get(t) < 50));
      if (used.length >= 3) findings.push({ sev: 'high', title: 'Likely fingerprinting your device', evidence: [script, ...used.map(t => `${t} ×${techs.get(t)}`)],
        means: 'One script read several hard-to-change details of your device. Combined, they make an ID that works without cookies and across private windows.', todo: 'Use a browser with fingerprinting protection (Firefox strict mode, Brave, Safari).' });
      else if (used.length) findings.push({ sev: 'info', title: 'Read some device details', evidence: [script, ...used.map(t => `${t} ×${techs.get(t)}`)],
        means: 'Games and graphics apps read these to pick settings. One or two on their own isn\'t fingerprinting.', todo: 'Nothing.' });
    }
  }

  // Tracking IDs stored in this browser.
  const ids = [];
  // Read directly (it's instant), so a slow storage walk can't hide these.
  let keys = []; try { keys = Object.keys(localStorage); } catch { keys = (storage?.localStorage ?? []).map(k => k.key); }
  for (const k of keys) if (TRACKING_ID_KEYS.test(k)) ids.push(`localStorage ${k}`);
  for (const c of cookies) if (TRACKING_ID_KEYS.test(c.name)) ids.push(`cookie ${c.name}`);
  if (ids.length) findings.push({ sev: 'low', title: `${ids.length} tracking ID${ids.length > 1 ? 's' : ''} stored in your browser`, evidence: ids,
    means: 'Long-lived IDs that let analytics and ad services recognize you on your next visit.', todo: 'Clearing this site\'s data resets them.' });
  return findings;
}

// Fingerprinting code found by reading scripts, for pages that ran it before EngineX-ray was opened (the watcher can
// only see calls made after it's switched on). A script with 3+ different markers can read the device details a
// fingerprint is built from. Bot-detection scripts look the same, which the finding says.
const FP_MARKERS = [
  ['GPU model', /WEBGL_debug_renderer_info|UNMASKED_RENDERER_WEBGL|UNMASKED_VENDOR_WEBGL/],
  ['audio fingerprint', /OfflineAudioContext|webkitOfflineAudioContext/],
  ['canvas readback', /toDataURL[\s\S]{0,4000}fillText|fillText[\s\S]{0,4000}toDataURL/],
  ['high-entropy client hints', /getHighEntropyValues/],
  ['camera/mic list', /enumerateDevices/],
  ['hardware details', /hardwareConcurrency[\s\S]{0,4000}deviceMemory|deviceMemory[\s\S]{0,4000}hardwareConcurrency/],
  ['font probing', /(Arial|Helvetica|Verdana)[^\n]{0,400}(Courier New|Times New Roman|Georgia)[^\n]{0,400}(Comic Sans|Impact|Palatino|Garamond)/],
  ['fingerprinting library', /FingerprintJS|fingerprintjs|ClientJS|\bfpjs\b|getCanvasFingerprint|x64hash128/],
];

function staticFingerprinting(texts) {
  const findings = [];
  for (const [where, text] of texts) {
    if (!text || text.length < 200) continue;
    const hits = FP_MARKERS.filter(([, re]) => re.test(text)).map(([name]) => name);
    if (hits.length >= 3) findings.push({ sev: 'medium', title: `Fingerprinting code in ${where}`, evidence: [where, ...hits],
      means: 'This script contains the code to read several hard-to-change details of your device: what a fingerprint is built from. Bot-detection and fraud scripts look the same; on a login or checkout page that may be its purpose.',
      todo: 'Watch the page to see whether it actually runs. Browsers with fingerprinting protection (Firefox strict, Brave, Safari) blunt it.' });
  }
  return findings;
}

// What Live watch saw: your typing leaving the page, third-party scripts reading personal fields or listening to
// keystrokes, and which servers received data. Only covers what happened while watching.
const hostOfScript = s => { try { return new URL(s).hostname; } catch { return ''; } };
function watchFindings(watcher) {
  if (!watcher.startedAt) return [];
  const findings = [];
  const hosts = watcher.byHost();
  for (const h of hosts.filter(h => h.typed.size)) {
    const third = isThirdPartyHost(h.host), sensitive = [...h.typed.values()].some(Boolean);
    const cat = hostCategory(h.host);
    findings.push(third
      ? { sev: sensitive ? 'high' : 'medium', title: `What you typed was sent to ${h.host}`, evidence: [`${h.host}${cat ? ` (${cat})` : ''}`, ...[...h.typed.keys()].map(f => `from your ${f}`)],
          means: sensitive ? 'Text from a personal field (password, email, phone or card) left the page for another company\'s server.' : 'Text you typed went to another company\'s server, often search terms sent to analytics or ad partners.',
          todo: sensitive ? 'Don\'t enter real details on this page unless you trust that company with them.' : 'Avoid typing anything private into this page.' }
      : { sev: 'info', title: 'What you typed was sent to the site itself', evidence: [h.host, ...[...h.typed.keys()].map(f => `from your ${f}`)],
          means: 'Normal for search boxes, autocomplete and forms.', todo: 'Nothing.' });
  }
  const readers = new Map();
  for (const r of watcher.fieldReads) {
    const host = hostOfScript(r.script);
    if (!isThirdPartyHost(host)) continue;
    const x = readers.get(host) ?? { scripts: new Set(), fields: new Set() };
    x.scripts.add(r.script.split('?')[0]); x.fields.add(r.field); readers.set(host, x);
  }
  for (const [host, x] of readers) {
    const secret = [...x.fields].some(f => /password|card|cc-|cvc|cvv|ssn|iban/i.test(f));
    findings.push({ sev: secret ? 'high' : 'medium', title: `A script from ${host} read your ${secret ? 'password or card field' : 'personal fields'}`, evidence: [...x.scripts, ...x.fields],
      means: 'A third-party script on this page read what you entered. Session-replay and analytics tools do this; so does a card skimmer (Magecart).',
      todo: secret ? 'Don\'t enter real passwords or card numbers here unless you trust this company.' : 'Expect what you type here to be shared with that company.' });
  }
  const keyHosts = new Map();
  for (const k of watcher.keyListeners) {
    const host = hostOfScript(k.script);
    if (isThirdPartyHost(host)) (keyHosts.get(host) ?? keyHosts.set(host, new Set()).get(host)).add(`${k.type} on ${k.target}`);
  }
  for (const [host, what] of keyHosts) {
    // Listening on a form field is about what you type there; listening on the whole page is usually about whether
    // a human is present (ad verification, bot detection).
    const onField = [...what].some(w => /<(input|textarea)/.test(w));
    findings.push({ sev: onField ? 'medium' : 'low', title: `A script from ${host} listens to your keystrokes${onField ? ' in form fields' : ''}`, evidence: [...what].slice(0, 6),
      means: (onField ? 'It attached to the fields you type in. Session-replay tools and card skimmers do this to capture what you enter.' :
        'It listens on the whole page. Ad-verification and bot-detection scripts do this to check a person is there, usually noting that keys were pressed, not which.') +
        ' "What you typed was sent to…" (above, if present) shows whether your text actually left the page.',
      todo: onField ? 'Check what that company is before typing anything private here.' : 'Nothing, unless your typing also shows up in its requests.' });
  }
  const out = hosts.filter(h => isThirdPartyHost(h.host));
  if (out.length) {
    const kb = out.reduce((n, h) => n + h.bytes, 0) / 1024;
    findings.push({ sev: 'info', title: `${out.length} other server${out.length > 1 ? 's' : ''} received data while watching (${kb.toFixed(kb < 10 ? 1 : 0)} KB)`,
      evidence: out.slice(0, 8).map(h => `${h.host}: ${h.requests} request${h.requests > 1 ? 's' : ''}, ${(h.bytes / 1024).toFixed(1)} KB${hostCategory(h.host) ? ` (${hostCategory(h.host)})` : ''}`),
      means: 'Every server outside this site that the page sent something to since you started watching.', todo: 'The Live watch tab lists them all.' });
  }
  return findings;
}

// ---- security/secrets.js ----
// Tokens and secrets that page scripts can read. Values are always masked (first 4 + last 2 characters): the point is
// to show that a secret is exposed and where, never to copy it.

const mask = s => s.length <= 8 ? '•'.repeat(s.length) : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;

function b64urlJson(part) {
  try { return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='))); } catch { return null; }
}

function readCookies() {
  if (!document.cookie) return [];
  return document.cookie.split(/;\s*/).map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1) }; });
}

// sources: [{ where, text, kind }] kind = 'storage' | 'cookie' | 'code'
function secretFindings(sources, cookies) {
  const findings = [], seen = new Set();
  for (const { where, text, kind, key } of sources) {
    if (!text) continue;
    // An opaque token stored under a token-like name (access_token, auth, session...): readable by any script.
    if (kind === 'storage' && key && SESSION_COOKIE.test(key) && !NOT_SESSION_COOKIE.test(key) && /^[\w\-.~+/=]{20,}$/.test(text) && !new RegExp(JWT.source).test(text)) {
      if (VISITOR_SESSION.test(key)) { findings.push(visitorSession(where, text)); continue; }
      findings.push({ sev: 'medium', title: `Token-like value in ${where.split('[')[0]}`, evidence: [mask(text), where],
        means: 'Something stored under a login/session name. Storage like this can be read by any script on the page, so an XSS bug can steal it.',
        todo: 'If it\'s your app: keep session tokens in HttpOnly, Secure, SameSite cookies.' });
    }
    for (const p of SECRET_PATTERNS) {
      for (const m of text.matchAll(p.re)) {
        const key = p.name + m[0];
        if (seen.has(key)) continue; seen.add(key);
        findings.push({ sev: p.sev, title: `${p.name} in ${kind === 'code' ? 'the page\'s code' : kind}`, evidence: [mask(m[0]), where],
          means: p.means + (kind === 'code' ? ' It ships to every visitor in the page\'s code.' : ''),
          todo: p.sev === 'info' ? 'Check the key is restricted to this site.' : 'If it\'s your site: revoke this key now, then move it to the server. Anything sent to a browser is public.' });
      }
    }
    for (const m of text.matchAll(JWT)) {
      const token = m[0];
      if (seen.has(token)) continue; seen.add(token);
      const [h, p] = token.split('.');
      const header = b64urlJson(h), claims = b64urlJson(p);
      if (!header) continue;
      const alg = String(header.alg ?? '?');
      const exp = typeof claims?.exp === 'number' ? new Date(claims.exp * 1000) : null;
      const facts = [`alg: ${alg}`, exp ? `expires ${exp.toISOString().slice(0, 10)}${exp < new Date() ? ' (expired)' : ''}` : 'no expiry', claims?.iss ? `issuer: ${claims.iss}` : null,
        claims ? `claims: ${Object.keys(claims).slice(0, 8).join(', ')}` : null].filter(Boolean);
      const none = alg.toLowerCase() === 'none';
      // Ad-tech and analytics vendors also use JWTs, as visitor IDs. Only tokens carrying identity/permission claims
      // are login tokens; the rest are tracking IDs (still worth listing, not an account risk).
      const authLike = claims && Object.keys(claims).some(k => /^(sub|email|user(_?id|name)?|uid|role|roles|scope|scp|aud|permissions|groups|admin)$/i.test(k));
      if (!authLike) {
        findings.push({ sev: 'low', title: `${none ? 'Unsigned tracking' : 'Tracking'} token (JWT) in ${kind === 'code' ? 'the page\'s code' : kind}`, evidence: [mask(token), where, ...facts],
          means: 'A JWT with no login or permission claims: usually a visitor ID from an ad, analytics or identity vendor. It identifies your browser to them; it isn\'t a key to an account.' + (none ? ' It\'s unsigned, so it only matters if some server trusts it.' : ''),
          todo: 'Clearing this site\'s data resets it.' });
        continue;
      }
      findings.push({ sev: none ? 'high' : kind === 'code' ? 'medium' : 'medium', title: `Login token (JWT) in ${kind === 'code' ? 'the page\'s code' : kind}`,
        evidence: [mask(token), where, ...facts],
        means: (none ? 'Its algorithm is "none": it has no signature, so if the server accepts it, anyone can forge one. ' : '') +
          (kind === 'storage' ? 'Tokens in localStorage/sessionStorage can be read by any script on the page, so a single XSS bug or bad third-party script can steal the session.' :
            kind === 'cookie' ? 'This cookie isn\'t HttpOnly, so page scripts (and XSS) can read it.' : 'A token hard-coded in shipped code works for anyone who reads the code.'),
        todo: none ? 'If it\'s your app: make the server reject alg "none" and always verify signatures.' : 'If it\'s your app: keep session tokens in HttpOnly, Secure, SameSite cookies.' });
    }
  }
  // Session cookies readable by JS (HttpOnly cookies never appear in document.cookie, so these are the exposed ones).
  for (const c of cookies) {
    if (!SESSION_COOKIE.test(c.name) || NOT_SESSION_COOKIE.test(c.name) || new RegExp(JWT.source).test(c.value)) continue; // JWTs reported above
    if (c.value.length < 16 || /^(\{|%7B)/i.test(c.value)) continue; // a flag, counter or JSON blob, not a session token
    if (VISITOR_SESSION.test(c.name)) { findings.push(visitorSession(`cookie ${c.name}`, c.value)); continue; }
    findings.push({ sev: 'medium', title: `Session cookie "${c.name}" is readable by scripts`, evidence: [mask(c.value), 'document.cookie'],
      means: 'It isn\'t marked HttpOnly, so any script on the page (including an XSS attack) can read and steal it.', todo: 'If it\'s your site: set HttpOnly (and Secure, SameSite) on session cookies.' });
  }
  return findings;
}

function visitorSession(where, value) {
  return { sev: 'low', title: `Visitor session ID readable by scripts (${where.replace(/^cookie /, '').slice(0, 40)})`, evidence: [mask(value), where],
    means: 'Named like a session, but it belongs to an analytics, ad or bot-check service: it identifies this visit, not your login.', todo: 'Nothing. Clearing this site\'s data resets it.' };
}

// Everything secrets can hide in, gathered from the page. scriptTexts = [[where, text]] already fetched for hints.
function secretSources({ cookies, scriptTexts, files }) {
  const sources = [];
  for (const c of cookies) sources.push({ where: `cookie ${c.name}`, text: c.value, kind: 'cookie' });
  for (const [store, label] of [[window.localStorage, 'localStorage'], [window.sessionStorage, 'sessionStorage']]) {
    try { for (let i = 0; i < store.length; i++) { const k = store.key(i); sources.push({ where: `${label}["${k}"]`, text: store.getItem(k), kind: 'storage', key: k }); } } catch {}
  }
  [...document.scripts].filter(s => !s.src).forEach((s, i) => sources.push({ where: `inline <script> #${i + 1}`, text: s.textContent, kind: 'code' }));
  for (const [where, text] of scriptTexts) sources.push({ where, text, kind: 'code' });
  for (const f of files.filter(x => x.mod)) {
    const strings = findStrings(f.mod, { minLength: 16, filter: /AKIA|ASIA|_live_|_test_|gh[pousr]_|github_pat_|xox[baprs]-|sk-|AIza|PRIVATE KEY|eyJ/, limit: 200 }).strings;
    sources.push({ where: f.url.split('/').pop(), text: strings.join('\n'), kind: 'code' });
  }
  for (const name of Object.getOwnPropertyNames(window)) {
    let v; try { v = window[name]; } catch { continue; }
    if (typeof v === 'string' && v.length >= 16 && v.length < 10000) sources.push({ where: `window.${name}`, text: v, kind: 'code' });
  }
  return sources;
}

// ---- security/web.js ----
// Site security: how well the site protects you, from what the page already exposes. The response headers come from
// one re-read of this page (usually straight from the browser's cache); everything else is the live page.

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$|\.localhost$|\.test$/;

async function pageHeaders() {
  try {
    const res = await timedFetch(location.href, { credentials: 'include', cache: 'force-cache' }, 8000);
    const headers = new Map();
    res.headers.forEach((v, k) => headers.set(k.toLowerCase(), v));
    res.text().catch(() => {}); // only the headers are needed
    return { status: res.status, headers };
  } catch { return null; }
}

// The policy for scripts: script-src if it's set, else default-src.
function scriptPolicy(csp) {
  const directives = new Map(csp.split(';').map(d => d.trim().split(/\s+/)).filter(d => d[0]).map(([k, ...v]) => [k.toLowerCase(), v]));
  return { directives, script: directives.get('script-src') ?? directives.get('default-src') };
}

function siteSecurityFindings({ headers }) {
  const findings = [];
  const https = location.protocol === 'https:', local = LOOPBACK.test(location.hostname);
  if (!https && !local) findings.push({ sev: 'high', title: 'This page isn\'t encrypted (plain HTTP)', evidence: [location.origin],
    means: 'Anyone on the same network (café Wi-Fi, a hotel, your ISP) can read and change this page and what you send to it.', todo: 'Don\'t log in or type anything private here.' });

  const h = headers?.headers;
  if (!h) findings.push({ sev: 'info', title: 'Couldn\'t read the page\'s security headers', evidence: [location.href.split('?')[0]],
    means: 'Re-reading the page failed or timed out, so the header checks were skipped.', todo: 'Rescan, or open the page\'s Network entry in DevTools.' });
  if (h) {
    const metaCsp = [...document.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')].map(m => m.content).join('; ');
    const csp = [h.get('content-security-policy'), metaCsp].filter(Boolean).join('; ');
    if (https && !local) {
      const hsts = h.get('strict-transport-security');
      const maxAge = +(/max-age=(\d+)/i.exec(hsts ?? '')?.[1] ?? 0);
      if (!hsts) findings.push({ sev: 'low', title: 'No HSTS: the browser isn\'t told to always use HTTPS', evidence: ['Strict-Transport-Security header missing'],
        means: 'Without it, a first visit typed as plain "site.com" can be intercepted before the redirect to HTTPS (an SSL-stripping attack).', todo: 'If it\'s your site: send Strict-Transport-Security: max-age=31536000; includeSubDomains.' });
      else if (maxAge < 15552000) findings.push({ sev: 'info', title: 'HSTS is set but short', evidence: [hsts],
        means: 'The browser forgets the "HTTPS only" rule after less than six months.', todo: 'A max-age of a year (31536000) is the usual choice.' });
    }
    if (!csp) findings.push({ sev: 'low', title: 'No Content Security Policy', evidence: ['Content-Security-Policy header missing'],
      means: 'A CSP limits which scripts may run. Without one, any injected script (an XSS bug, a bad ad) runs with full access to the page.', todo: 'If it\'s your site: add a CSP, even a report-only one to start.' });
    else {
      const { script } = scriptPolicy(csp);
      const strong = script?.some(s => /^'(nonce-|sha256-|sha384-|sha512-|strict-dynamic)/.test(s));
      if (script?.includes("'unsafe-inline'") && !strong) findings.push({ sev: 'low', title: 'The CSP allows inline scripts', evidence: [`script-src ${script.join(' ')}`.slice(0, 160)],
        means: '\'unsafe-inline\' lets injected <script> tags run, which removes most of what a CSP protects against.', todo: 'If it\'s your site: switch to nonces or hashes.' });
      if (script?.some(s => s === '*' || s === 'https:' || s === 'http:')) findings.push({ sev: 'low', title: 'The CSP lets scripts load from anywhere', evidence: [`script-src ${script.join(' ')}`.slice(0, 160)],
        means: 'A wildcard source means an attacker can load their script from any server.', todo: 'If it\'s your site: list the script hosts you use.' });
      if (script?.includes("'unsafe-eval'")) findings.push({ sev: 'info', title: 'The CSP allows eval()', evidence: ["'unsafe-eval' in script-src"],
        means: 'Code can be built from strings at runtime. Often needed by older frameworks; it makes some XSS bugs easier to exploit.', todo: 'Nothing for visitors.' });
      if (!script) findings.push({ sev: 'info', title: 'The CSP doesn\'t restrict scripts', evidence: [csp.slice(0, 160)],
        means: 'The policy is there but has no script-src or default-src, so scripts aren\'t limited.', todo: 'Nothing for visitors.' });
    }
    if (!h.get('x-frame-options') && !/frame-ancestors/i.test(csp)) findings.push({ sev: 'low', title: 'Other sites can put this page in a frame (clickjacking)', evidence: ['no X-Frame-Options, no CSP frame-ancestors'],
      means: 'A malicious site can show this page invisibly under its own buttons and trick you into clicking things here.', todo: 'If it\'s your site: send X-Frame-Options: DENY or CSP frame-ancestors \'self\'.' });
    if (h.get('x-content-type-options')?.toLowerCase() !== 'nosniff') findings.push({ sev: 'info', title: 'No X-Content-Type-Options: nosniff', evidence: ['header missing'],
      means: 'Browsers may guess file types, which can turn an uploaded file into a script.', todo: 'If it\'s your site: send X-Content-Type-Options: nosniff.' });
  }

  // Mixed content: parts of an HTTPS page loaded over plain HTTP.
  if (https) {
    const plain = performance.getEntriesByType('resource').filter(e => e.name.startsWith('http:') && !LOOPBACK.test(new URL(e.name).hostname));
    const active = plain.filter(e => ['script', 'iframe', 'xmlhttprequest', 'fetch', 'link', 'css'].includes(e.initiatorType));
    if (active.length) findings.push({ sev: 'medium', title: 'Code or data loaded over plain HTTP', evidence: [...new Set(active.map(e => e.name.split('?')[0]))].slice(0, 8),
      means: 'Part of this secure page came over an unencrypted connection, so someone on the network could swap it for their own code.', todo: 'If it\'s your site: load everything over https://.' });
    const passive = plain.filter(e => !active.includes(e));
    if (passive.length) findings.push({ sev: 'low', title: 'Images or media loaded over plain HTTP', evidence: [...new Set(passive.map(e => e.name.split('?')[0]))].slice(0, 8),
      means: 'Others on the network can see which of these you loaded, and swap the pictures.', todo: 'If it\'s your site: load everything over https://.' });
  }

  // Password forms.
  for (const form of document.querySelectorAll('form')) {
    if (!form.querySelector('input[type=password]')) continue;
    let action; try { action = new URL(form.getAttribute('action') || location.href, location.href); } catch { continue; }
    const method = (form.getAttribute('method') || 'get').toLowerCase();
    const label = `${method.toUpperCase()} ${action.origin}${action.pathname}`;
    if (action.protocol === 'http:' && !LOOPBACK.test(action.hostname)) findings.push({ sev: 'high', title: 'A password form sends over plain HTTP', evidence: [label],
      means: 'The password would travel unencrypted, readable by anyone on the network.', todo: 'Don\'t use this form. If it\'s your site: post to an https:// address.' });
    if (method === 'get' && form.querySelector('input[type=password]')) findings.push({ sev: 'medium', title: 'A password form uses GET (the password goes in the URL)', evidence: [label],
      means: 'Passwords in URLs end up in browser history, server logs and analytics.', todo: 'If it\'s your site: use method="post". (Some sites submit with JavaScript instead; then this is harmless.)' });
    if (isThirdPartyHost(action.hostname)) findings.push({ sev: 'info', title: 'A password form submits to another site', evidence: [label],
      means: 'Normal for single sign-on (Google, Microsoft, a university login). Worth a look if the other site is unfamiliar.', todo: 'Check the address is who you expect.' });
  }

  // Third-party scripts without Subresource Integrity. Practical for fixed library files on public CDNs.
  const CDNS = /(^|\.)(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|code\.jquery\.com|(stackpath|maxcdn|netdna)\.bootstrapcdn\.com|ajax\.googleapis\.com|ajax\.aspnetcdn\.com|cdn\.datatables\.net)$/;
  const external = [...document.querySelectorAll('script[src]')].filter(s => (!s.type || /javascript|module/i.test(s.type)) && !s.integrity)
    .map(s => { try { return new URL(s.src, location.href); } catch { return null; } }).filter(u => u && isThirdPartyHost(u.hostname));
  const fromCdn = external.filter(u => CDNS.test(u.hostname));
  if (fromCdn.length) findings.push({ sev: 'low', title: `${fromCdn.length} library script${fromCdn.length > 1 ? 's' : ''} from a public CDN without an integrity check`, evidence: fromCdn.map(u => u.href.split('?')[0]).slice(0, 8),
    means: 'If that CDN were hacked, the changed file would run here unnoticed. An integrity="sha384-…" attribute makes the browser refuse a changed file.', todo: 'If it\'s your site: add integrity and crossorigin attributes (cdnjs and jsDelivr show them).' });
  return findings;
}

// Known-vulnerable JavaScript libraries, found from the globals they define and from version numbers in script URLs.
// Each entry: versions below `fixed` (within `major`, when given) have the issue.
const VULNS = {
  'jQuery': [
    { fixed: '1.9.0', id: 'CVE-2012-6708', what: 'XSS through selector strings', sev: 'medium' },
    { fixed: '3.0.0', id: 'CVE-2015-9251', what: 'XSS from cross-domain AJAX responses', sev: 'medium' },
    { fixed: '3.4.0', id: 'CVE-2019-11358', what: 'prototype pollution in $.extend', sev: 'medium' },
    { fixed: '3.5.0', id: 'CVE-2020-11022, CVE-2020-11023', what: 'XSS when inserting HTML', sev: 'medium' }],
  'jQuery UI': [
    { fixed: '1.13.0', id: 'CVE-2021-41182, -41183, -41184', what: 'XSS in widget options', sev: 'medium' },
    { fixed: '1.13.2', id: 'CVE-2022-31160', what: 'XSS in checkboxradio', sev: 'low' }],
  'AngularJS': [
    { fixed: '1.8.0', id: 'CVE-2020-7676', what: 'XSS through sanitizer bypass', sev: 'medium' },
    { fixed: '99.0.0', id: 'end of life', what: 'AngularJS (1.x) stopped getting security fixes in January 2022', sev: 'medium' }],
  'Bootstrap': [
    { major: 3, fixed: '3.4.1', id: 'CVE-2019-8331', what: 'XSS in tooltip/popover templates', sev: 'medium' },
    { major: 4, fixed: '4.3.1', id: 'CVE-2019-8331', what: 'XSS in tooltip/popover templates', sev: 'medium' },
    { major: 3, fixed: '99.0.0', id: 'end of life', what: 'Bootstrap 3 stopped getting fixes in 2019', sev: 'low' }],
  'Lodash': [
    { fixed: '4.17.12', id: 'CVE-2019-10744', what: 'prototype pollution in defaultsDeep', sev: 'medium' },
    { fixed: '4.17.21', id: 'CVE-2021-23337', what: 'code injection through _.template', sev: 'medium' }],
  'Underscore': [{ fixed: '1.12.1', id: 'CVE-2021-23358', what: 'code injection through _.template', sev: 'medium' }],
  'Moment': [{ fixed: '2.29.4', id: 'CVE-2022-31129', what: 'slow regex in date parsing (denial of service)', sev: 'low' }],
  'Handlebars': [{ fixed: '4.7.7', id: 'CVE-2021-23369, CVE-2021-23383', what: 'code execution when compiling untrusted templates', sev: 'medium' }],
  'DOMPurify': [
    { major: 2, fixed: '2.5.4', id: 'CVE-2024-45801', what: 'sanitizer bypass (XSS)', sev: 'medium' },
    { major: 3, fixed: '3.1.3', id: 'CVE-2024-45801', what: 'sanitizer bypass (XSS)', sev: 'medium' }],
  'Vue': [{ major: 2, fixed: '99.0.0', id: 'end of life', what: 'Vue 2 stopped getting fixes at the end of 2023', sev: 'low' }],
};
const URL_NAMES = [['jquery-ui', 'jQuery UI'], ['jquery', 'jQuery'], ['angular', 'AngularJS'], ['bootstrap', 'Bootstrap'], ['lodash', 'Lodash'], ['underscore', 'Underscore'], ['moment', 'Moment'], ['handlebars', 'Handlebars'], ['dompurify', 'DOMPurify'], ['purify', 'DOMPurify'], ['vue', 'Vue']];
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };

function detectLibraries() {
  const found = new Map(); // name -> { version, where }
  const add = (name, version, where) => { if (/^\d+\.\d+(\.\d+)?/.test(version ?? '') && !found.has(name)) found.set(name, { version: version.match(/^\d+\.\d+(\.\d+)?/)[0], where }); };
  const get = fn => { try { return fn(); } catch { return undefined; } };
  add('jQuery', get(() => window.jQuery.fn.jquery), 'window.jQuery');
  add('jQuery UI', get(() => window.jQuery.ui.version), 'jQuery.ui');
  add('AngularJS', get(() => window.angular.version.full), 'window.angular');
  add('Bootstrap', get(() => window.bootstrap?.Tooltip?.VERSION ?? window.jQuery.fn.tooltip.Constructor.VERSION), 'Bootstrap tooltip');
  if (get(() => typeof window._.cloneDeepWith === 'function')) add('Lodash', get(() => window._.VERSION), 'window._');
  else add('Underscore', get(() => window._.VERSION), 'window._');
  add('Moment', get(() => window.moment.version), 'window.moment');
  add('Handlebars', get(() => window.Handlebars.VERSION), 'window.Handlebars');
  add('DOMPurify', get(() => window.DOMPurify.version), 'window.DOMPurify');
  add('Vue', get(() => window.Vue.version), 'window.Vue');
  for (const e of performance.getEntriesByType('resource')) {
    if (e.initiatorType !== 'script') continue;
    const path = e.name.split('?')[0].toLowerCase();
    for (const [slug, name] of URL_NAMES) {
      const m = new RegExp(`(?:^|[/@._-])${slug.replace('-', '[-.]?')}(?:\\.min|\\.js|\\.slim)*[/@._-]v?(\\d+\\.\\d+\\.\\d+)`).exec(path);
      if (m) { add(name, m[1], e.name.split('?')[0].split('/').slice(-3).join('/')); break; }
    }
  }
  return found;
}

function libraryFindings() {
  const findings = [], fine = [];
  for (const [name, { version, where }] of detectLibraries()) {
    const major = +version.split('.')[0];
    const hits = (VULNS[name] ?? []).filter(v => (v.major == null || v.major === major) && cmp(version, v.fixed) < 0);
    if (!hits.length) { fine.push(`${name} ${version}`); continue; }
    const sev = hits.some(v => v.sev === 'medium') ? 'medium' : 'low';
    const latest = hits.filter(v => v.fixed !== '99.0.0').map(v => v.fixed).sort(cmp).pop();
    findings.push({ sev, title: `${name} ${version} has known security bugs`, evidence: [where, ...hits.map(v => `${v.id}: ${v.what}`)],
      means: 'An outdated library with published vulnerabilities. A bug is only exploitable if the site uses the affected feature, but attackers scan for exactly these versions.',
      todo: `If it's your site: update ${name}${latest ? ` to ${latest} or later` : ' to a supported version'}.` });
  }
  if (fine.length) findings.push({ sev: 'info', title: 'Libraries found, no known issues', evidence: fine,
    means: 'Versions EngineX-ray recognized and checked against its list of known vulnerabilities.', todo: 'Nothing.' });
  return findings;
}

// ---- security/grade.js ----
// The report card: one A–F grade for how this page treats you, the reasons behind it, and a short plain-English
// summary. Built from the same findings the Findings tab lists; nothing extra is measured here.

const REPLAY_VENDORS = [['hotjar', 'Hotjar'], ['fullstory', 'FullStory'], ['clarity.ms', 'Microsoft Clarity'], ['contentsquare', 'Contentsquare'],
  ['quantummetric', 'Quantum Metric'], ['logrocket', 'LogRocket'], ['lr-ingest', 'LogRocket'], ['mouseflow', 'Mouseflow'], ['smartlook', 'Smartlook'],
  ['luckyorange', 'Lucky Orange'], ['inspectlet', 'Inspectlet'], ['glassbox', 'Glassbox'], ['amplitude', 'Amplitude Session Replay']];
const FP_VENDORS = [['px-cloud', 'HUMAN (PerimeterX)'], ['perimeterx', 'HUMAN (PerimeterX)'], ['humansecurity', 'HUMAN (PerimeterX)'], ['px-cdn', 'HUMAN (PerimeterX)'],
  ['fpjs', 'FingerprintJS'], ['fpcdn', 'FingerprintJS'], ['fingerprint', 'FingerprintJS'], ['online-metrix', 'ThreatMetrix'], ['iovation', 'iovation'],
  ['datadome', 'DataDome'], ['kasada', 'Kasada'], ['arkoselabs', 'Arkose Labs']];
const vendorNames = (hosts, table) => [...new Set(hosts.map(h => table.find(([k]) => h.includes(k))?.[1] ?? h))];
const list = names => names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

function gradeReport(security, parties) {
  const deductions = [];
  const take = (points, why, area) => { if (points > 0) deductions.push({ points: Math.round(points), why, area }); };
  const cat = c => parties.filter(p => p.category === c).map(p => p.host);
  const sec = name => security[name] ?? [];
  const count = (items, sev) => items.filter(f => f.sev === sev).length;

  // Recording and fingerprinting
  const replay = vendorNames(cat('session replay'), REPLAY_VENDORS);
  if (replay.length) take(25, `Records your clicks, scrolling and typing (${list(replay)})`, 'recording');
  const fpHosts = cat('fingerprinting / bot detection');
  const fpCode = sec('Privacy').filter(f => /fingerprint/i.test(f.title) && f.sev !== 'info');
  const fpNames = vendorNames(fpHosts, FP_VENDORS);
  if (fpHosts.length || fpCode.length) take(10, `Builds a device fingerprint${fpNames.length ? ` (${list(fpNames)})` : ''}`, 'fingerprinting');

  // Trackers
  const ads = cat('ads').length, social = cat('social pixels').length;
  take(Math.min(20, Math.ceil(ads / 2)), `${ads} ad-network server${ads === 1 ? '' : 's'} see your visit`, 'trackers');
  take(Math.min(8, social * 2), `${social} social-media tracker${social === 1 ? '' : 's'} (they know you visited, even without a click)`, 'trackers');
  if (parties.length > 100) take(8, `${parties.length} outside servers loaded by one page`, 'trackers');
  else if (parties.length > 50) take(4, `${parties.length} outside servers loaded by one page`, 'trackers');

  // Miner, leaks, site security, live watch
  const miner = sec('Crypto-miner');
  if (count(miner, 'high')) take(60, 'Contains a hidden crypto-miner', 'miner');
  else if (count(miner, 'low') + count(miner, 'medium')) take(5, 'Has mining-related code (unconfirmed)', 'miner');
  const secrets = sec('Secrets & tokens');
  take(Math.min(50, count(secrets, 'high') * 25), `${count(secrets, 'high')} exposed key${count(secrets, 'high') === 1 ? '' : 's'} or forgeable token${count(secrets, 'high') === 1 ? '' : 's'}`, 'leaks');
  take(Math.min(12, count(secrets, 'medium') * 4), `${count(secrets, 'medium')} login token${count(secrets, 'medium') === 1 ? '' : 's'} readable by any script on the page`, 'leaks');
  const site = sec('Site security');
  for (const f of site.filter(f => f.sev === 'high')) take(20, f.title, 'site');
  for (const f of site.filter(f => f.sev === 'medium')) take(8, f.title, 'site');
  take(Math.min(9, count(site, 'low') * 3), `${count(site, 'low')} missing protection${count(site, 'low') === 1 ? '' : 's'} (${site.filter(f => f.sev === 'low').map(f => shortName(f.title)).join(', ')})`, 'site');
  const watch = sec('Live watch');
  for (const f of watch.filter(f => f.sev === 'high')) take(20, f.title, 'watch');
  for (const f of watch.filter(f => f.sev === 'medium')) take(10, f.title, 'watch');

  const score = Math.max(0, 100 - deductions.reduce((n, d) => n + d.points, 0));
  const letter = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
  deductions.sort((a, b) => b.points - a.points);

  // The summary: the few facts a person would want to know. Problems first, worst first; the all-clear lines last.
  const summary = [], fine = [];
  if (count(miner, 'high')) summary.push('Runs a hidden crypto-miner on your computer.');
  for (const f of watch.filter(f => f.sev === 'high')) summary.push(f.title + '.');
  if (replay.length) summary.push(`Records your clicks, scrolling and typing (${list(replay)}).`);
  const highLeaks = secrets.filter(f => f.sev === 'high');
  if (highLeaks.length) summary.push(`Exposes ${highLeaks.length === 1 ? 'a secret' : `${highLeaks.length} secrets`}: ${[...new Set(highLeaks.map(f => f.title.replace(/ in (the page's code|storage|cookie)$/, '')))].join(', ')}.`);
  else fine.push('No leaked keys or forgeable login tokens found.');
  const siteBad = site.filter(f => f.sev === 'high' || f.sev === 'medium');
  if (siteBad.length) summary.push(`Site security: ${siteBad.slice(0, 2).map(f => lowerFirst(f.title)).join('; ')}.`);
  else fine.push(count(site, 'low') ? `Site security is mostly fine; missing ${site.filter(f => f.sev === 'low').slice(0, 2).map(f => shortName(f.title)).join(' and ')}.` : 'Site security checks passed.');
  if (fpNames.length || fpCode.length) summary.push(`Fingerprints your device${fpNames.length ? ` with ${list(fpNames)}` : ''}${fpNames.some(n => /HUMAN|DataDome|Kasada|Arkose|ThreatMetrix|iovation/.test(n)) ? ', usually to block bots' : ''}.`);
  if (ads + social) summary.push(`Shares your visit with ${[ads && `${ads} ad-network server${ads === 1 ? '' : 's'}`, social && `${social} social tracker${social === 1 ? '' : 's'}`].filter(Boolean).join(' and ')}.`);
  else fine.push('No ad networks or social trackers loaded (before any cookie banner click).');
  summary.push(...fine);

  // One tile per area for the report card.
  const tile = (area, label, bad, warn, text) => ({ area, label, state: bad ? 'bad' : warn ? 'warn' : 'good', text });
  const lowSite = count(site, 'low'), watched = !!watch.length;
  const tiles = [
    tile('recording', 'Session recording', replay.length, false, replay.length ? list(replay) : 'None found'),
    tile('fingerprinting', 'Fingerprinting', false, fpHosts.length || fpCode.length, fpNames.length ? list(fpNames) : fpCode.length ? 'Fingerprinting code' : 'None found'),
    tile('trackers', 'Trackers', ads > 20, ads + social > 0, `${ads} ad · ${social} social · ${parties.length} outside server${parties.length === 1 ? '' : 's'}`),
    tile('site', 'Site security', siteBad.length, lowSite > 0, siteBad.length ? `${siteBad.length} problem${siteBad.length > 1 ? 's' : ''}` : lowSite ? `${lowSite} missing protection${lowSite > 1 ? 's' : ''}` : 'Looks fine'),
    tile('leaks', 'Leaked secrets', highLeaks.length, count(secrets, 'medium'), highLeaks.length ? `${highLeaks.length} exposed` : count(secrets, 'medium') ? `${count(secrets, 'medium')} readable token${count(secrets, 'medium') > 1 ? 's' : ''}` : 'None found'),
    tile('miner', 'Crypto-miner', count(miner, 'high'), count(miner, 'low') + count(miner, 'medium'), count(miner, 'high') ? 'Found' : 'None found'),
    tile('watch', 'Live watch', watch.some(f => f.sev === 'high'), watch.some(f => f.sev === 'medium'), watched ? `${watch.filter(f => f.sev !== 'info').length} issue${watch.filter(f => f.sev !== 'info').length === 1 ? '' : 's'} seen` : 'Not switched on'),
  ];
  if (!watched) tiles.at(-1).state = 'off'; // grey until Live watch has been switched on
  return { score, letter, deductions, summary: summary.slice(0, 5), tiles };
}

// Lowercase the first letter, unless it starts a name or acronym ("jQuery", "HSTS").
const lowerFirst = t => /^[A-Z]{2}|^[a-z]/.test(t) ? t : t[0].toLowerCase() + t.slice(1);

// "No HSTS: the browser isn't told…" -> "HSTS", for compact lists.
function shortName(title) {
  if (/HSTS/.test(title)) return 'HSTS';
  if (/Content Security Policy|CSP/.test(title)) return /inline/.test(title) ? 'a strict CSP' : 'a CSP';
  if (/frame/.test(title)) return 'clickjacking protection';
  if (/integrity/.test(title)) return 'script integrity checks';
  if (/known security bugs/.test(title)) return 'library updates';
  return title.split(/[:(]/)[0].toLowerCase();
}

// ---- main.js ----
// EngineX-ray: click the bookmark on any page and see how it treats you: a privacy and security report card, the
// evidence behind it, and a live watch of where your data goes. Engine tools for WebAssembly games live under Advanced.
// Built by make.sh into one script (engine-xray.js) and a bookmarklet; the modules above are pasted in front of this.

(async () => {
  if (window.EngineXray) { window.EngineXray.toggle(); return; }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // Evidence comes from page code and can be huge (minified bundles), so one line never shows more than 160 characters.
  const clip = e => { e = String(e); return e.length > 160 ? e.slice(0, 160) + '…' : e; };
  const mb = n => n == null ? '?' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
  const pagesMb = p => p == null ? 'no limit' : mb(p * 65536);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const state = { files: [], globals: [], storage: null, hints: { wasm: [], workers: [] }, skipped: [], tab: 'report', adv: 'overview', focus: null, stringQuery: '', stringPreset: null, onlyInteresting: true };
  const recorder = consoleRecorder();
  const watcher = createWatcher();
  state.security = null;

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
    .finding { border-left: 4px solid #8a8f99; }
    .finding.high { border-left-color: #ff5c5c; } .finding.medium { border-left-color: #ffb347; } .finding.low { border-left-color: #ffe066; }
    .sev { display: inline-block; font-size: 11px; font-weight: 800; letter-spacing: .5px; padding: 1px 7px; border-radius: 4px; margin-right: 6px; background: #2c2f36; color: #c8cbd1; text-transform: uppercase; }
    .sev.high { background: #ff5c5c; color: #160404; } .sev.medium { background: #ffb347; color: #1a0f00; } .sev.low { background: #ffe066; color: #1a1500; }
    .summary { display: flex; gap: 8px; flex-wrap: wrap; margin: 6px 0 10px; } .watching { color: #5cf2c8; font-weight: 700; }
    .grade { display: flex; gap: 14px; align-items: center; }
    .letter { width: 74px; height: 74px; flex: none; border-radius: 16px; display: grid; place-items: center; font-size: 46px; font-weight: 900; color: #0b0c0e; }
    .letter.A { background: #5cf2c8; } .letter.B { background: #9be36b; } .letter.C { background: #ffe066; } .letter.D { background: #ffb347; } .letter.F { background: #ff5c5c; }
    .site { font-size: 15px; font-weight: 750; color: #fff; word-break: break-all; } .score { color: #8a8f99; }
    .said { margin: 10px 0 0; padding: 0; list-style: none; } .said li { padding: 3px 0 3px 16px; position: relative; }
    .said li::before { content: '•'; position: absolute; left: 3px; color: #5cf2c8; }
    .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 8px 0; }
    .tile { background: #15171c; border: 1px solid #23262d; border-left: 4px solid #5cf2c8; border-radius: 8px; padding: 7px 9px; cursor: pointer; text-align: left; color: inherit; font: inherit; }
    .tile.warn { border-left-color: #ffb347; } .tile.off { border-left-color: #4a4e57; } .tile.bad { border-left-color: #ff5c5c; } .tile:hover { background: #1b1e24; }
    .tile b { display: block; font-size: 12px; color: #c8cbd1; } .tile span { font-size: 12px; color: #8a8f99; }
    .ded { display: grid; grid-template-columns: 38px 1fr; gap: 2px 8px; } .ded b { color: #ff7a7a; text-align: right; }
    details summary { cursor: pointer; color: #8a8f99; font-size: 12px; margin-top: 4px; }
    .sub { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; }
  </style>
  <div class="panel">
    <header><b>EngineX-ray</b><span class="status">checking this page…</span><button class="close" title="Close">✕</button></header>
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

  const wire = {}; // per-tab event wiring, run after each render
  const TABS = { report: 'Report card', findings: 'Findings', watch: 'Live watch', advanced: 'Advanced', export: 'Export' };
  const ADVANCED = { overview: 'Engine', wasm: 'Engine file', strings: 'Strings', globals: 'Globals', storage: 'Storage', console: 'Console' };
  function renderNav() {
    $('nav').innerHTML = Object.entries(TABS).map(([k, v]) => `<button data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${v}${k === 'watch' && watcher.on ? ' ●' : ''}${k === 'advanced' && state.files.length ? ' ⚙' : ''}</button>`).join('');
    $('nav').querySelectorAll('button').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; if (b.dataset.tab === 'findings') state.focus = null; render(); });
  }
  function render() {
    renderNav();
    const view = { report: reportCard, findings, watch: watchTab, advanced, export: exportTab }[state.tab];
    $('main').innerHTML = view();
    wire[state.tab]?.();
  }
  // The engine tools, one sub-tab at a time.
  function advanced() {
    const views = { overview, wasm, strings, globals, storage, console: consoleTab };
    return `<div class="sub">${Object.entries(ADVANCED).map(([k, v]) => `<button class="chip ${state.adv === k ? 'on' : ''}" data-adv="${k}">${v}</button>`).join('')}</div>` + views[state.adv]();
  }
  wire.advanced = () => {
    shadow.querySelectorAll('[data-adv]').forEach(b => b.onclick = () => { state.adv = b.dataset.adv; render(); });
    wire[state.adv]?.();
  };

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
  // Each step has a deadline: one that runs over is skipped and listed under state.skipped, never left hanging.
  async function step(label, work, ms, fallback, announce = true) {
    if (announce) status(`${label}…`);
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => { state.skipped.push(label); resolve(fallback); }, ms); });
    try { return await Promise.race([work(), late]); } catch { state.skipped.push(label); return fallback; } finally { clearTimeout(timer); }
  }
  async function scan() {
    state.skipped = [];
    status('reading globals…');
    try { state.globals = pageGlobals(); } catch { state.globals = []; state.skipped.push('reading globals'); }
    for (const url of wasmUrls()) await step(`reading ${url.split('/').pop().split('?')[0]}`, () => addWasm(url), 90000);
    // These don't depend on each other, so they run side by side: the scan takes as long as the slowest one.
    status('reading the page…');
    [state.hints, state.tpTexts, state.storage, state.headers] = await Promise.all([
      step('reading page scripts', scriptHints, 30000, { wasm: [], workers: [], texts: [] }, false),
      step('reading third-party scripts', thirdPartyScriptTexts, 15000, [], false),
      step('reading storage', storageReport, 25000, { estimate: null, opfs: [], indexedDB: [], localStorage: [], caches: [] }, false),
      step('reading security headers', pageHeaders, 9000, null, false),
    ]);
    status('grading…');
    runSecurity();
    showStatus();
    render();
  }

  function showStatus() {
    status(`${location.hostname}${state.grade ? ` · grade ${state.grade.letter}` : ''}${state.files.length ? ` · ${state.files.length} engine file${state.files.length === 1 ? '' : 's'}` : ''}${state.skipped.length ? ` · timed out: ${state.skipped.join(', ')}` : ''}`);
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
    if (state.security) {
      h += `<div class="card"><b>Report card:</b> grade ${state.grade.letter} <span class="dim">· see the Report card tab</span></div>`;
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

  // ---- export ----
  function reportMarkdown() {
    const g = state.grade;
    const lines = [`# EngineX-ray report card: ${location.host}${location.pathname}`, '', `Scanned ${new Date().toISOString()}${watcher.startedAt ? ' · Live watch on' : ''}`, ''];
    if (g) {
      lines.push(`## Grade ${g.letter} (${g.score}/100)`, '', ...g.summary.map(x => `- ${x}`), '');
      if (g.deductions.length) lines.push('### Why this grade', '', ...g.deductions.map(d => `- −${d.points}: ${d.why}`), '');
    }
    if (state.security) {
      lines.push('## Findings', '', '_Passive checks. Secret values are masked._', '');
      for (const [section, list] of Object.entries(state.security)) {
        if (section === 'Live watch' && !watcher.startedAt) continue;
        lines.push(`### ${section}`, '', ...(list.length ? sortFindings(list).map(f => `- **${f.sev.toUpperCase()}** ${f.title}: ${f.evidence.slice(0, 12).map(clip).join('; ')}`) : ['- nothing found']), '');
      }
    }
    if (watcher.startedAt) {
      const hosts = watcher.byHost();
      lines.push('## Where data went while watching', '', '| Server | Requests | Sent | Kind | Your typing |', '|---|---|---|---|---|',
        ...hosts.slice(0, 40).map(h => `| ${h.host} | ${h.requests} | ${(h.bytes / 1024).toFixed(1)} KB | ${hostCategory(h.host) ?? (isThirdPartyHost(h.host) ? 'other' : 'this site')} | ${h.typed.size ? [...h.typed.keys()].join(', ') : ''} |`), '');
    }
    if (state.files.length) {
      lines.push('## Engine (Advanced)', '');
      for (const f of state.files) {
        if (f.error) { lines.push(`### ${f.url}`, '', `Error: ${f.error}`, ''); continue; }
        const m = f.mod;
        lines.push(`### ${f.url.split('/').pop()}`, '', `- Engine: **${f.engine.best}** (${(f.engine.matches[0]?.evidence ?? []).join('; ')})`,
          `- Size: ${mb(m.size)}, ${m.functions.defined} functions, ${m.exports.length} exports, ${m.imports.length} imports`,
          `- Memory: ${m.memories.map(x => `${pagesMb(x.min)}–${pagesMb(x.max)}${x.shared ? ' shared' : ''}`).join(', ') || 'none'}`, '');
        for (const [label, list] of Object.entries(interestingExports(m))) if (list.length) lines.push(`#### ${label}`, '', list.slice(0, 100).map(x => `- \`${x}\``).join('\n'), '');
      }
      lines.push('### Where to start', '', ...tips().map(t => '- ' + t.replace(/<[^>]+>/g, '')), '');
    }
    const s = state.storage;
    if (s) lines.push('## Storage', '', `- Used ${mb(s.estimate?.usage)} of ${mb(s.estimate?.quota)}`, ...s.opfs.map(o => `- OPFS \`${o.name}\`: ${mb(o.bytes)}${o.files ? `, ${o.files} files` : ''}`),
      ...s.indexedDB.map(d => `- IndexedDB ${d}`), `- localStorage: ${s.localStorage.length} keys`, '');
    lines.push('_Made with EngineX-ray_');
    return lines.join('\n');
  }
  function exportTab() {
    return `<p>The report card and every finding as Markdown, for your notes, a write-up or a bug report.</p>
      <div class="row"><button class="btn copy">Copy report</button><button class="btn ghost save">Download .md</button><span class="dim done"></span></div>
      <div class="list dim">${esc(reportMarkdown())}</div>`;
  }
  wire.export = () => {
    $('.copy').onclick = async () => { try { await navigator.clipboard.writeText(reportMarkdown()); $('.done').textContent = 'Copied.'; } catch { $('.done').textContent = 'Copy blocked: use Download.'; } };
    $('.save').onclick = () => {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([reportMarkdown()], { type: 'text/markdown' })), download: `enginexray-${location.host}.md` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
  };

  // ---- security ----
  const SEV_ORDER = { high: 0, medium: 1, low: 2, info: 3 };
  const sortFindings = list => [...list].sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
  const allFindings = () => Object.values(state.security ?? {}).flat();
  const severityCounts = list => list.reduce((c, f) => (c[f.sev]++, c), { high: 0, medium: 0, low: 0, info: 0 });
  function runSecurity() { watcher.quietly(runSecurityNow); }
  function runSecurityNow() {
    const cookies = readCookies();
    const texts = state.hints.texts ?? [];
    state.security = {
      'Privacy': [...privacyFindings({ watcher, storage: state.storage, cookies }), ...staticFingerprinting([...texts, ...(state.tpTexts ?? [])])],
      'Site security': [...siteSecurityFindings({ headers: state.headers }), ...libraryFindings()],
      'Secrets & tokens': secretFindings(secretSources({ cookies, scriptTexts: texts, files: state.files }), cookies),
      'Crypto-miner': minerFindings({ files: state.files, hints: state.hints, watcher, workerTexts: texts }),
      'Live watch': watchFindings(watcher),
    };
    state.grade = gradeReport(state.security, thirdParties());
  }
  const liveRefresh = debounce(() => { if (!state.security) return; runSecurity(); showStatus(); if (['report', 'findings', 'watch'].includes(state.tab)) render(); }, 700);
  watcher.onChange(liveRefresh);

  const findingCard = f => {
    const ev = f.evidence.slice(0, 12).map(e => esc(clip(e)));
    return `<div class="card finding ${f.sev}"><div><span class="sev ${f.sev}">${f.sev}</span><b>${esc(f.title)}</b></div>
      <div class="list dim">${ev.slice(0, 3).join('\n')}</div>${ev.length > 3 ? `<details><summary>${ev.length - 3} more</summary><div class="list dim">${ev.slice(3).join('\n')}</div></details>` : ''}
      <div><b>What it means:</b> ${esc(f.means)}</div><div class="dim"><b>What to do:</b> ${esc(f.todo)}</div></div>`;
  };

  // The report card: grade, summary, the areas at a glance, and why points were taken off.
  function reportCard() {
    const g = state.grade;
    if (!g) return '<div class="dim">Checking this page…</div>';
    let h = `<div class="card"><div class="grade"><div class="letter ${g.letter}">${g.letter}</div>
        <div><div class="site">${esc(location.hostname)}</div><div class="score">${g.score}/100 · how this page treats your privacy and security</div></div></div>
        <ul class="said">${g.summary.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
      <div class="tiles">${g.tiles.map(t => `<button class="tile ${t.state}" data-area="${t.area}"><b>${esc(t.label)}</b><span>${esc(t.text)}</span></button>`).join('')}</div>`;
    h += `<h3>Why this grade</h3>`;
    h += g.deductions.length ? `<div class="card ded">${g.deductions.map(d => `<b>−${d.points}</b><span>${esc(d.why)}</span>`).join('')}</div>` : '<div class="card ok">Nothing to take points off for.</div>';
    h += `<div class="row"><button class="btn ghost rerun">Rescan</button>${watcher.on ? '' : '<button class="btn gowatch">Start Live watch</button>'}</div>
      <p class="dim">Measured before you accept any cookie banner, from what this tab already loaded. ${watcher.startedAt ? 'Includes what Live watch saw.' : 'Live watch adds what happens while you use the page (typing, forms, data sent).'} Nothing is sent anywhere; secrets are masked.</p>`;
    return h;
  }
  wire.report = () => {
    if (!state.grade) return;
    shadow.querySelectorAll('.tile').forEach(t => t.onclick = () => { if (t.dataset.area === 'watch') state.tab = 'watch'; else { state.tab = 'findings'; state.focus = t.dataset.area; } render(); });
    $('.rerun').onclick = async () => { await scan(); };
    $('.gowatch') && ($('.gowatch').onclick = () => { watcher.start(); state.tab = 'watch'; render(); });
  };

  // Which findings sections a report-card tile opens.
  const AREA_SECTIONS = { recording: ['Privacy'], fingerprinting: ['Privacy'], trackers: ['Privacy'], site: ['Site security'], leaks: ['Secrets & tokens'], miner: ['Crypto-miner'] };
  function findings() {
    if (!state.security) return '<div class="dim">Checking this page…</div>';
    const sections = Object.entries(state.security).filter(([name]) => (!state.focus || AREA_SECTIONS[state.focus]?.includes(name)) && (name !== 'Live watch' || watcher.startedAt));
    const c = severityCounts(sections.flatMap(([, l]) => l));
    let h = `<div class="row">${state.focus ? `<button class="chip on all">Showing ${esc(AREA_SECTIONS[state.focus].join(', '))} · show all</button>` : ''}<button class="btn ghost rerun">Rescan</button></div>
      <div class="summary">${['high', 'medium', 'low', 'info'].map(s => `<span class="sev ${s}">${c[s]} ${s}</span>`).join('')}</div>`;
    for (const [section, list] of sections) {
      h += `<h3>${esc(section)}</h3>`;
      h += list.length ? sortFindings(list).map(findingCard).join('') : `<div class="dim">Nothing found.</div>`;
    }
    h += `<p class="dim">Passive checks only: EngineX-ray reads what this tab already received and stores, plus one re-read of this page for its headers. It probes nothing. Secret values are masked.</p>`;
    return h;
  }
  wire.findings = () => {
    if (!state.security) return;
    $('.all') && ($('.all').onclick = () => { state.focus = null; render(); });
    $('.rerun').onclick = async () => { await scan(); };
  };

  function watchTab() {
    let h = `<div class="card"><div class="row"><button class="btn watch">${watcher.on ? 'Stop watching' : 'Start watching'}</button>
      ${watcher.on ? '<span class="watching">● watching</span>' : ''}</div>
      <div>Use the page like you normally would: search, open menus, fill in a form with made-up details (like <code>test.person@example.com</code>). EngineX-ray checks where each request goes, whether what you typed is in it, and which outside scripts read your fields or listen to your keys.</div>
      <div class="dim">It sees what happens from the moment you switch it on, and never blocks or changes anything.</div></div>`;
    if (!watcher.startedAt) return h + '<div class="dim">Not watching yet.</div>';
    const hosts = watcher.byHost();
    h += `<div class="summary"><span class="chip">${watcher.requests.length} requests</span><span class="chip">${hosts.length} servers</span><span class="chip">${watcher.typedCount} typed values tracked</span>
      <span class="chip">${watcher.fieldReads.length} field reads</span><span class="chip">${watcher.keyListeners.length} key listeners</span><span class="chip">${watcher.events.length} fingerprinting calls</span></div>`;
    const live = sortFindings(state.security?.['Live watch'] ?? []).filter(f => f.sev !== 'info');
    h += live.length ? live.map(findingCard).join('') : `<div class="card dim">Nothing worrying seen yet. Type something into the page's search box or a form to test it.</div>`;
    h += `<h3>Where data went</h3>`;
    h += hosts.length ? `<table>${hosts.slice(0, 60).map(x => `<tr><td>${esc(x.host)}</td><td>${x.requests} req · ${(x.bytes / 1024).toFixed(1)} KB · <span class="dim">${esc(hostCategory(x.host) ?? (isThirdPartyHost(x.host) ? 'other company' : 'this site'))}</span>${x.typed.size ? `<div class="warn">contained your ${esc([...x.typed.keys()].join(', '))}</div>` : ''}</td></tr>`).join('')}</table>` : '<div class="dim">No requests yet.</div>';
    const fp = [...watcher.byScript()].filter(([, t]) => t.size);
    if (fp.length) h += `<h3>Device details read</h3><table>${fp.slice(0, 20).map(([script, techs]) => `<tr><td>${esc(clip(script.split('?')[0].split('/').slice(2).join('/')))}</td><td>${[...techs].map(([t, n]) => `${esc(t)} ×${n}`).join('<br>')}</td></tr>`).join('')}</table>`;
    if (watcher.sockets.length || watcher.workers.length) h += `<h3>Connections and workers</h3><div class="list dim">${[...watcher.sockets.map(x => `WebSocket ${x.url}`), ...watcher.workers.map(x => `Worker ${x.url}`)].map(x => esc(clip(x))).join('\n')}</div>`;
    return h;
  }
  wire.watch = () => { $('.watch').onclick = () => { watcher.on ? watcher.stop() : watcher.start(); runSecurity(); render(); }; };

  window.EngineXray = {
    toggle() { $('.panel').classList.toggle('hidden'); },
    state, rescan: scan, report: reportMarkdown, watcher, runSecurity, setTab: t => { if (ADVANCED[t]) { state.adv = t; t = 'advanced'; } state.tab = t; render(); },
    addWasm: async (url, bytes) => { await addWasm(url, bytes); render(); },
  };
  render();
  await scan();
})();

})();
