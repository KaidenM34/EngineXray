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
  for (const k of storage?.localStorage ?? []) if (TRACKING_ID_KEYS.test(k.key)) ids.push(`localStorage ${k.key}`);
  for (const c of cookies) if (TRACKING_ID_KEYS.test(c.name)) ids.push(`cookie ${c.name}`);
  if (ids.length) findings.push({ sev: 'low', title: `${ids.length} tracking ID${ids.length > 1 ? 's' : ''} stored in your browser`, evidence: ids,
    means: 'Long-lived IDs that let analytics and ad services recognize you on your next visit.', todo: 'Clearing this site\'s data resets them.' });
  return findings;
}
