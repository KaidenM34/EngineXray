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
  applyStyles(shadow, `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      --bg: #0f1115; --surface: #161a21; --surface-2: #1c212a; --line: #262c36;
      --text: #e6e8eb; --muted: #8b93a1; --faint: #5c6370;
      --accent: #4c8dff; --accent-weak: rgba(76,141,255,.14);
      --high: #e5484d; --medium: #f0883e; --low: #d4a72c; --info: #6b7280; --good: #3fb950;
      width: min(480px, calc(100vw - 32px)); height: min(80vh, 760px); display: flex; flex-direction: column;
      background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 10px; overflow: hidden;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif; -webkit-font-smoothing: antialiased;
      box-shadow: 0 12px 32px rgba(0,0,0,.45), 0 0 0 1px rgba(0,0,0,.2); }
    .panel.hidden { display: none; }
    button { font: inherit; color: inherit; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--surface); border-bottom: 1px solid var(--line); cursor: move; user-select: none; }
    header svg { flex: none; }
    header b { font-size: 14px; font-weight: 650; letter-spacing: .1px; color: var(--text); }
    header .status { flex: 1; min-width: 0; text-align: right; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
    header .close { background: none; border: 0; color: var(--muted); width: 26px; height: 26px; border-radius: 6px; cursor: pointer; display: grid; place-items: center; font-size: 14px; }
    header .close:hover { background: var(--surface-2); color: var(--text); }
    nav { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--line); background: var(--surface); overflow-x: auto; scrollbar-width: none; }
    nav::-webkit-scrollbar { display: none; }
    nav button { flex: none; background: none; border: 0; border-bottom: 2px solid transparent; color: var(--muted); padding: 9px 9px 8px; cursor: pointer; font-weight: 500; white-space: nowrap; }
    nav button:hover { color: var(--text); }
    nav button.on { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
    main { flex: 1; overflow: auto; padding: 14px; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
    main::-webkit-scrollbar { width: 8px; } main::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }
    h3 { margin: 18px 0 8px; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
    h3:first-child { margin-top: 0; }
    .card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 8px; }
    .big { font-size: 17px; font-weight: 650; color: var(--text); }
    .dim { color: var(--muted); } .warn { color: var(--medium); } .ok { color: var(--good); }
    .kv { display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px; }
    ul { margin: 4px 0; padding-left: 18px; } li { margin: 2px 0; word-break: break-word; }
    code, .mono { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
    code { background: var(--surface-2); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
    .list { font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; }
    input[type=text] { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 7px 9px; font: inherit; }
    input[type=text]::placeholder { color: var(--faint); }
    .row { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; align-items: center; }
    .chip { background: var(--surface-2); color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 3px 8px; cursor: pointer; font-size: 12px; font-variant-numeric: tabular-nums; }
    .chip:hover { color: var(--text); }
    .chip.on { background: var(--accent-weak); border-color: rgba(76,141,255,.45); color: #9cc0ff; }
    .btn { background: var(--accent); color: #fff; border: 1px solid var(--accent); border-radius: 6px; padding: 6px 12px; font-weight: 600; cursor: pointer; }
    .btn:hover { background: #3d7ef0; }
    .btn.ghost { background: var(--surface-2); color: var(--text); border-color: var(--line); font-weight: 500; }
    .btn.ghost:hover { border-color: #3a414d; }
    table { width: 100%; border-collapse: collapse; } td { vertical-align: top; padding: 6px; border-top: 1px solid var(--line); }
    td:first-child { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text); white-space: nowrap; }
    .tip { border-left: 2px solid var(--accent); padding: 4px 0 4px 10px; margin: 8px 0; }
    .lvl-warn { color: var(--medium); } .lvl-error { color: #ff8589; }
    .finding { border-left: 3px solid var(--info); }
    .finding.high { border-left-color: var(--high); } .finding.medium { border-left-color: var(--medium); } .finding.low { border-left-color: var(--low); }
    .finding b { font-weight: 600; }
    .sev { display: inline-block; font-size: 10.5px; font-weight: 700; letter-spacing: .04em; padding: 1px 6px; border-radius: 4px; margin-right: 6px; text-transform: uppercase;
      background: rgba(107,114,128,.16); color: #aab1bd; border: 1px solid rgba(107,114,128,.35); font-variant-numeric: tabular-nums; }
    .sev.high { background: rgba(229,72,77,.15); color: #ff8589; border-color: rgba(229,72,77,.4); }
    .sev.medium { background: rgba(240,136,62,.15); color: #ffa86b; border-color: rgba(240,136,62,.4); }
    .sev.low { background: rgba(212,167,44,.15); color: #e3c15a; border-color: rgba(212,167,44,.4); }
    .summary { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0 12px; } .watching { color: var(--accent); font-weight: 600; }
    .grade { display: flex; gap: 14px; align-items: center; }
    .letter { width: 64px; height: 64px; flex: none; border-radius: 12px; display: grid; place-items: center; font-size: 34px; font-weight: 750; border: 1px solid; }
    .letter.A { color: #56d364; background: rgba(63,185,80,.14); border-color: rgba(63,185,80,.45); }
    .letter.B { color: #9bd36a; background: rgba(139,195,74,.13); border-color: rgba(139,195,74,.42); }
    .letter.C { color: #e3c15a; background: rgba(212,167,44,.14); border-color: rgba(212,167,44,.45); }
    .letter.D { color: #ffa86b; background: rgba(240,136,62,.14); border-color: rgba(240,136,62,.45); }
    .letter.F { color: #ff8589; background: rgba(229,72,77,.14); border-color: rgba(229,72,77,.45); }
    .site { font-size: 15px; font-weight: 650; color: var(--text); word-break: break-all; } .score { color: var(--muted); font-variant-numeric: tabular-nums; }
    .said { margin: 12px 0 0; padding: 12px 0 0; list-style: none; border-top: 1px solid var(--line); } .said li { padding: 3px 0 3px 14px; position: relative; }
    .said li::before { content: ''; position: absolute; left: 2px; top: 11px; width: 4px; height: 4px; border-radius: 50%; background: var(--muted); }
    .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 8px 0; }
    .tile { background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--good); border-radius: 6px; padding: 8px 10px; cursor: pointer; text-align: left; }
    .tile.warn { border-left-color: var(--medium); } .tile.off { border-left-color: var(--faint); } .tile.bad { border-left-color: var(--high); } .tile:hover { background: var(--surface-2); }
    .tile b { display: block; font-size: 12px; font-weight: 600; color: var(--text); } .tile span { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .ded { display: grid; grid-template-columns: 34px 1fr; gap: 4px 10px; } .ded b { color: #ff8589; text-align: right; font: 600 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
    details summary { cursor: pointer; color: var(--muted); font-size: 12px; margin-top: 4px; } details summary:hover { color: var(--text); }
    .sub { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px; }
  `);
  shadow.append(buildHTML(`<div class="panel">
    <header><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 4.5 5.5v6c0 4.6 3.1 8.6 7.5 10 4.4-1.4 7.5-5.4 7.5-10v-6L12 2.5Z" fill="rgba(76,141,255,.18)" stroke="#4c8dff" stroke-width="1.6" stroke-linejoin="round"/><path d="m8.8 12.2 2.2 2.2 4.4-4.6" fill="none" stroke="#4c8dff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><b>EngineX-ray</b><span class="status">checking this page…</span><button class="close" title="Close" aria-label="Close">✕</button></header>
    <nav></nav>
    <main></main>
  </div>`));
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
    setHTML($('nav'), Object.entries(TABS).map(([k, v]) => `<button data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${v}${k === 'watch' && watcher.on ? ' ●' : ''}${k === 'advanced' && state.files.length ? ' ⚙' : ''}</button>`).join(''));
    $('nav').querySelectorAll('button').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; if (b.dataset.tab === 'findings') state.focus = null; render(); });
  }
  function render() {
    renderNav();
    const view = { report: reportCard, findings, watch: watchTab, advanced, export: exportTab }[state.tab];
    setHTML($('main'), view());
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
      if (!filter) { setHTML($('.results'), '<p class="dim">Pick a preset or type something.</p>'); return; }
      let h = '';
      for (const f of files) {
        const { strings, total } = findStrings(f.mod, { minLength: 4, filter, limit: 300 });
        const shown = strings.filter(s => filter instanceof RegExp ? filter.test(s) : true);
        h += `<h3>${esc(f.url.split('/').pop())}: ${shown.length}${shown.length >= 300 ? '+' : ''} matches <span class="dim">(of ${total.toLocaleString()} strings)</span></h3><div class="list">${shown.map(esc).join('\n')}</div>`;
      }
      setHTML($('.results'), h || '<p class="dim">No engine file scanned.</p>');
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
      setHTML($('.lines'), rows.map(l => `<span class="lvl-${l.level}">${esc(l.text)}</span>`).join('\n'));
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
