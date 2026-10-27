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

  const TABS = { overview: 'Overview', security: 'Security', wasm: 'Engine file', strings: 'Strings', globals: 'Globals', storage: 'Storage', console: 'Console', report: 'Report' };
  function renderNav() {
    $('nav').innerHTML = Object.entries(TABS).map(([k, v]) => `<button data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${v}</button>`).join('');
    $('nav').querySelectorAll('button').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; render(); });
  }
  function render() {
    renderNav();
    const view = { overview, security, wasm, strings, globals, storage, console: consoleTab, report }[state.tab];
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
    runSecurity();
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
    if (state.security) {
      const c = severityCounts(allFindings());
      h += `<div class="card"><b>Security:</b> ${['high', 'medium', 'low'].map(s => `<span class="sev ${s}">${c[s]} ${s}</span>`).join(' ')} <span class="dim">· see the Security tab</span></div>`;
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
    if (state.security) {
      lines.push('## Security findings', '', '_Secret values are masked._', '');
      for (const [section, list] of Object.entries(state.security)) {
        lines.push(`### ${section}`, '', ...(list.length ? sortFindings(list).map(f => `- **${f.sev.toUpperCase()}** ${f.title}: ${f.evidence.join('; ')}`) : ['- nothing found']), '');
      }
    }
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
      'Crypto-miner': minerFindings({ files: state.files, hints: state.hints, watcher, workerTexts: texts }),
      'Privacy': privacyFindings({ watcher, storage: state.storage, cookies }),
      'Secrets & tokens': secretFindings(secretSources({ cookies, scriptTexts: texts, files: state.files }), cookies),
    };
  }
  const liveRefresh = debounce(() => { runSecurity(); if (state.tab === 'security' || state.tab === 'overview') render(); }, 600);
  watcher.onChange(liveRefresh);

  function security() {
    if (!state.security) return '<div class="dim">Scanning…</div>';
    const c = severityCounts(allFindings());
    let h = `<div class="card"><div class="row"><button class="btn watch">${watcher.on ? 'Stop watching' : 'Watch this page'}</button>
      ${watcher.on ? `<span class="watching">● watching</span> <span class="dim">${watcher.events.length} API calls · ${watcher.sockets.length} sockets · ${watcher.workers.length} workers</span>` : ''}
      <button class="btn ghost rerun">Rescan</button></div>
      <div class="dim">Watching records fingerprinting calls, WebSocket connections and new workers <b>from the moment you switch it on</b>. Switch it on, then use the page (press Play, log in, scroll). It never blocks or changes anything.</div></div>
      <div class="summary">${['high', 'medium', 'low', 'info'].map(s => `<span class="sev ${s}">${c[s]} ${s}</span>`).join('')}</div>`;
    for (const [section, list] of Object.entries(state.security)) {
      h += `<h3>${esc(section)}</h3>`;
      if (!list.length) { h += `<div class="dim">Nothing found.</div>`; continue; }
      for (const f of sortFindings(list)) {
        h += `<div class="card finding ${f.sev}"><div><span class="sev ${f.sev}">${f.sev}</span><b>${esc(f.title)}</b></div>
          <div class="list dim">${f.evidence.map(esc).join('\n')}</div>
          <div><b>What it means:</b> ${esc(f.means)}</div><div class="dim"><b>What to do:</b> ${esc(f.todo)}</div></div>`;
      }
    }
    h += `<p class="dim">Passive checks only: EngineX-ray reads what this tab already received and stores. It sends nothing and probes nothing. Secret values are masked.</p>`;
    return h;
  }
  wire.security = () => {
    $('.watch').onclick = () => { watcher.on ? watcher.stop() : watcher.start(); render(); };
    $('.rerun').onclick = async () => { state.storage = await storageReport(); state.hints = await scriptHints(); runSecurity(); render(); };
  };

  window.EngineXray = {
    toggle() { $('.panel').classList.toggle('hidden'); },
    state, rescan: scan, report: reportMarkdown, watcher, runSecurity, setTab: t => { state.tab = t; render(); },
    addWasm: async (url, bytes) => { await addWasm(url, bytes); render(); },
  };
  render();
  await scan();
})();
