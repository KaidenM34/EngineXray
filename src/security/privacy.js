// Privacy: who the page shares you with (third-party services by category), whether a script is fingerprinting your
// device (from the live watcher), and which long-lived tracking IDs are stored in your browser.

export function thirdParties() {
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

export function privacyFindings({ watcher, storage, cookies }) {
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

export function staticFingerprinting(texts) {
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
export function watchFindings(watcher) {
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
