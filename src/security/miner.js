// Hidden crypto-miner detection. Evidence is combined, never trusted alone: AES and SHA tables are in plenty of normal
// software, so constants only raise the alarm together with miner text, pool traffic or known miner hosts.

// Which crypto tables a wasm file contains. Scans data segments at 4-byte steps (tables are word-aligned in memory).
export function cryptoConstants(mod) {
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

export function minerFindings({ files, hints, watcher, workerTexts }) {
  const findings = [];
  const strongText = [], weakText = [];
  const check = (where, text) => {
    const s = MINER_STRONG.exec(text); if (s) strongText.push(`"${s[0]}" in ${where}`);
    const w = MINER_WEAK.exec(text); if (w) weakText.push(`"${w[0]}" in ${where}`);
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
