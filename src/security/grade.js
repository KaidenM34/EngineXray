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

export function gradeReport(security, parties) {
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
