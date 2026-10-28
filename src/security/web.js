// Site security: how well the site protects you, from what the page already exposes. The response headers come from
// one re-read of this page (usually straight from the browser's cache); everything else is the live page.

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$|\.localhost$|\.test$/;

export async function pageHeaders() {
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

export function siteSecurityFindings({ headers }) {
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

export function detectLibraries() {
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

export function libraryFindings() {
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
