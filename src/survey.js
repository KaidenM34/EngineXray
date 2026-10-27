// Survey probe: EngineX-ray's passive checks without the panel, returning one JSON summary of the page. Built by
// make.sh into survey-probe.js. Paste it into a page (after it has loaded), then: await EngineXraySurvey.run()

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
