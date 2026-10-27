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

export function detectEngine(mod, globals, strings) {
  const g = new Set(globals.map(x => x.name));
  const results = RULES.map(rule => ({ engine: rule.engine, evidence: rule.test(mod, g, strings).filter(Boolean) }))
    .filter(r => r.evidence.length)
    .sort((a, b) => b.evidence.length - a.evidence.length);
  // Unity and Godot are themselves built with Emscripten: name the specific engine, keep Emscripten as the toolchain.
  const top = results[0];
  return { best: top ? top.engine : 'Unknown', matches: results };
}

// Things a modder usually wants to know first, pulled from the export list.
export function interestingExports(mod) {
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
export function bridgeFunctions(mod) {
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
export const STRING_PRESETS = {
  'Settings / cvars': /^[a-z][a-z0-9]*_[a-z0-9_]{2,}$/,
  'File paths': /\.(cfg|json|ini|txt|gsc|csc|lua|js|ff|pak|pk3|iwd|bin|dat|png|wav|ogg)\b|\/[\w.-]+\//i,
  'Commands (+set, exec, ...)': /^\+?(set|seta|exec|bind|map|devmap|connect|cmd)\b|%s|command/i,
  'Mod / script hooks': /mod|hook|script|plugin|lua|addon/i,
  'Errors and asserts': /error|fail|assert|cannot|could not|invalid/i,
  'URLs': /https?:\/\//,
};
