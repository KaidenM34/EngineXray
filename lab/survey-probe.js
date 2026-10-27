(() => {
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
const top = results[0];
return { best: top ? top.engine : 'Unknown', matches: results };
}
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
const STRING_PRESETS = {
'Settings / cvars': /^[a-z][a-z0-9]*_[a-z0-9_]{2,}$/,
'File paths': /\.(cfg|json|ini|txt|gsc|csc|lua|js|ff|pak|pk3|iwd|bin|dat|png|wav|ogg)\b|\/[\w.-]+\//i,
'Commands (+set, exec, ...)': /^\+?(set|seta|exec|bind|map|devmap|connect|cmd)\b|%s|command/i,
'Mod / script hooks': /mod|hook|script|plugin|lua|addon/i,
'Errors and asserts': /error|fail|assert|cannot|could not|invalid/i,
'URLs': /https?:\/\//,
};
function wasmUrls() {
const urls = performance.getEntriesByType('resource').map(e => e.name).filter(u => /\.wasm(\?|#|$)/i.test(u));
return [...new Set(urls)];
}
const SELF_URL = (document.currentScript?.src ?? '').split('?')[0];
async function scriptHints() {
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
async function thirdPartyScriptTexts({ max = 30, maxBytes = 3e6 } = {}) {
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
async function fetchWasm(url) {
const res = await fetch(url);
if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
return new Uint8Array(await res.arrayBuffer());
}
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
const MINER_DOMAINS = [
'coinhive.com', 'coin-hive.com', 'authedmine.com', 'crypto-loot.com', 'cryptoloot.pro', 'coinimp.com', 'coinimp.net',
'webminepool.com', 'minero.cc', 'jsecoin.com', 'ppoi.org', 'monerominer.rocks', 'cryptonoter.com', 'coinhave.com',
'webmine.cz', 'webmine.pro', 'coinpot.co', 'hashing.win', 'mineralt.io', 'freecontent.bid', 'deepminer.net',
];
const MINER_STRONG = /cryptonight|cryptonite|randomx|coinhive|coin-hive|cryptoloot|crypto-loot|coinimp|webminepool|deepminer|\bxmrig\b|stratum\+(tcp|ssl)|mining\.(subscribe|notify|authorize)|getHashesPerSecond|hashesPerSecond|setThrottle/i;
const MINER_WEAK = /\bmonero\b|\bxmr\b|hashrate|\bnonce\b.*\btarget\b|job_id|\bgroestl\b|\bskein\b|\bjh256\b|blake256/i;
const POOL_URL = /pool|stratum|xmr|monero|miner|mining|hashvault|nanopool|supportxmr|minexmr/i;
const STRATUM_FRAME = /"(method|type)"\s*:\s*"(login|submit|job|getjob|keepalived|mining\.\w+)"/i;
const CRYPTO_CONSTANTS = [
{ id: 'keccak', name: 'Keccak / SHA-3 round constants', bytes: [0x8a, 0x80, 0, 0, 0, 0, 0, 0x80, 0, 0x80, 0, 0x80, 0, 0, 0, 0x80] },
{ id: 'aes', name: 'AES S-box', bytes: [0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76] },
{ id: 'aes', name: 'AES T-table', bytes: [0xa5, 0x63, 0x63, 0xc6, 0x84, 0x7c, 0x7c, 0xf8] },
{ id: 'sha256k', name: 'SHA-256 round constants', bytes: [0x98, 0x2f, 0x8a, 0x42, 0x91, 0x44, 0x37, 0x71, 0xcf, 0xfb, 0xc0, 0xb5] },
{ id: 'blake256', name: 'SHA-256 / BLAKE-256 initial values', bytes: [0x67, 0xe6, 0x09, 0x6a, 0x85, 0xae, 0x67, 0xbb] },
{ id: 'blake2b', name: 'SHA-512 / BLAKE2b initial values', bytes: [0x08, 0xc9, 0xbc, 0xf3, 0x67, 0xe6, 0x09, 0x6a] },
];
const TRACKERS = {
'session replay': ['hotjar.com', 'hotjar.io', 'fullstory.com', 'logrocket.com', 'logrocket.io', 'lr-ingest.io', 'clarity.ms',
'mouseflow.com', 'smartlook.com', 'inspectlet.com', 'luckyorange.com', 'quantummetric.com', 'contentsquare.net', 'glassboxdigital.io'],
'fingerprinting / bot detection': ['fpjs.io', 'fpcdn.io', 'fingerprint.com', 'fingerprintjs.com', 'online-metrix.net', 'iovation.com',
'px-cdn.net', 'perimeterx.net', 'datadome.co', 'kasada.io', 'arkoselabs.com'],
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
const s = MINER_STRONG.exec(text); if (s) strongText.push(`"${s[0]}" in ${where}`);
const w = MINER_WEAK.exec(text); if (w) weakText.push(`"${w[0]}" in ${where}`);
};
const hosts = performance.getEntriesByType('resource').map(e => { try { return new URL(e.name).hostname; } catch { return ''; } });
const minerHosts = [...new Set(hosts.filter(isMinerHost))];
if (minerHosts.length) findings.push({ sev: 'high', title: 'Loads a known browser-mining service', evidence: minerHosts,
means: 'This page pulled code from a service that exists to mine cryptocurrency in visitors\' browsers.', todo: 'Close the tab. If it\'s your site, look for a compromised script or ad tag.' });
for (const f of files.filter(x => x.mod)) {
const name = f.url.split('/').pop();
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
for (const [where, text] of workerTexts) check(where, text);
if (strongText.length) findings.push({ sev: 'high', title: 'Mining code text found', evidence: [...new Set(strongText)].slice(0, 8),
means: 'Names of mining algorithms, miner products or mining-protocol messages appear in the page\'s code.', todo: 'Confirm by watching the page: a miner will connect to a pool and keep the CPU busy.' });
else if (weakText.length >= 2) findings.push({ sev: 'low', title: 'Mining-related words found', evidence: [...new Set(weakText)].slice(0, 8),
means: 'Words like "monero", "hashrate" or "job_id" appear. Common in crypto or finance apps too.', todo: 'Only a lead. Look for stronger signs.' });
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
if (watcher) {
for (const [script, techs] of watcher.byScript()) {
const used = FP_TECHS.filter(t => techs.has(t) && !(t === 'font probing (measureText)' && techs.get(t) < 50));
if (used.length >= 3) findings.push({ sev: 'high', title: 'Likely fingerprinting your device', evidence: [script, ...used.map(t => `${t} ×${techs.get(t)}`)],
means: 'One script read several hard-to-change details of your device. Combined, they make an ID that works without cookies and across private windows.', todo: 'Use a browser with fingerprinting protection (Firefox strict mode, Brave, Safari).' });
else if (used.length) findings.push({ sev: 'info', title: 'Read some device details', evidence: [script, ...used.map(t => `${t} ×${techs.get(t)}`)],
means: 'Games and graphics apps read these to pick settings. One or two on their own isn\'t fingerprinting.', todo: 'Nothing.' });
}
}
const ids = [];
for (const k of storage?.localStorage ?? []) if (TRACKING_ID_KEYS.test(k.key)) ids.push(`localStorage ${k.key}`);
for (const c of cookies) if (TRACKING_ID_KEYS.test(c.name)) ids.push(`cookie ${c.name}`);
if (ids.length) findings.push({ sev: 'low', title: `${ids.length} tracking ID${ids.length > 1 ? 's' : ''} stored in your browser`, evidence: ids,
means: 'Long-lived IDs that let analytics and ad services recognize you on your next visit.', todo: 'Clearing this site\'s data resets them.' });
return findings;
}
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
const mask = s => s.length <= 8 ? '•'.repeat(s.length) : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
function b64urlJson(part) {
try { return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='))); } catch { return null; }
}
function readCookies() {
if (!document.cookie) return [];
return document.cookie.split(/;\s*/).map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1) }; });
}
function secretFindings(sources, cookies) {
const findings = [], seen = new Set();
for (const { where, text, kind, key } of sources) {
if (!text) continue;
if (kind === 'storage' && key && SESSION_COOKIE.test(key) && !NOT_SESSION_COOKIE.test(key) && /^[\w\-.~+/=]{20,}$/.test(text) && !new RegExp(JWT.source).test(text)) {
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
findings.push({ sev: none ? 'high' : kind === 'code' ? 'medium' : 'medium', title: `Login token (JWT) in ${kind === 'code' ? 'the page\'s code' : kind}`,
evidence: [mask(token), where, ...facts],
means: (none ? 'Its algorithm is "none": it has no signature, so if the server accepts it, anyone can forge one. ' : '') +
(kind === 'storage' ? 'Tokens in localStorage/sessionStorage can be read by any script on the page, so a single XSS bug or bad third-party script can steal the session.' :
kind === 'cookie' ? 'This cookie isn\'t HttpOnly, so page scripts (and XSS) can read it.' : 'A token hard-coded in shipped code works for anyone who reads the code.'),
todo: none ? 'If it\'s your app: make the server reject alg "none" and always verify signatures.' : 'If it\'s your app: keep session tokens in HttpOnly, Secure, SameSite cookies.' });
}
}
for (const c of cookies) {
if (!SESSION_COOKIE.test(c.name) || NOT_SESSION_COOKIE.test(c.name) || new RegExp(JWT.source).test(c.value)) continue; // JWTs reported above
findings.push({ sev: 'medium', title: `Session cookie "${c.name}" is readable by scripts`, evidence: [mask(c.value), 'document.cookie'],
means: 'It isn\'t marked HttpOnly, so any script on the page (including an XSS attack) can read and steal it.', todo: 'If it\'s your site: set HttpOnly (and Secure, SameSite) on session cookies.' });
}
return findings;
}
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
window.EngineXraySurvey = {
async run({ wasmMaxMB = 25 } = {}) {
const started = performance.now();
const hints = await scriptHints();
const tpTexts = await thirdPartyScriptTexts();
const files = [];
const candidates = [...new Set([...wasmUrls(), ...hints.wasm.filter(w => !w.guessed).map(w => w.url)])].slice(0, 3);
for (const url of candidates) {
try {
const head = await fetch(url, { method: 'HEAD' });
const size = +head.headers.get('content-length') || 0;
if (size > wasmMaxMB * 1048576) { files.push({ url, skipped: `${Math.round(size / 1048576)} MB` }); continue; }
const mod = parseWasm(await fetchWasm(url));
const sample = findStrings(mod, { minLength: 6, limit: 4000 }).strings;
files.push({ url, mod, engine: detectEngine(mod, [], sample) });
} catch (e) { files.push({ url, error: e.message }); }
}
const storage = await storageReport();
const cookies = readCookies();
const strip = list => list.map(({ sev, title, evidence }) => ({ sev, title, evidence: evidence.slice(0, 12) }));
const parties = thirdParties();
const byCategory = {};
for (const p of parties) (byCategory[p.category ?? 'other'] ??= []).push(p.host);
const miner = minerFindings({ files, hints, watcher: null, workerTexts: hints.texts });
const privacy = [...privacyFindings({ watcher: null, storage, cookies }), ...staticFingerprinting([...hints.texts, ...tpTexts])];
const secrets = secretFindings(secretSources({ cookies, scriptTexts: hints.texts, files }), cookies);
const count = list => list.reduce((c, f) => (c[f.sev] = (c[f.sev] ?? 0) + 1, c), {});
return {
url: location.href, title: document.title.slice(0, 120), measuredAt: new Date().toISOString(),
scanMs: Math.round(performance.now() - started),
resources: performance.getEntriesByType('resource').length,
thirdParties: { hosts: parties.length, byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, k === 'other' ? v.length : v])) },
scriptsRead: { firstParty: hints.texts.length, thirdParty: tpTexts.length },
wasm: files.map(f => ({ url: f.url.split('?')[0], engine: f.engine?.best, sizeMB: f.mod ? +(f.mod.size / 1048576).toFixed(1) : undefined, skipped: f.skipped, error: f.error })),
storage: { cookies: cookies.length, localStorage: storage.localStorage.length, indexedDB: storage.indexedDB.length, opfs: storage.opfs.length },
findings: { miner: strip(miner), privacy: strip(privacy), secrets: strip(secrets) },
severity: { miner: count(miner), privacy: count(privacy), secrets: count(secrets) },
};
},
};
})();