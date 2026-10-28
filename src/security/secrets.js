// Tokens and secrets that page scripts can read. Values are always masked (first 4 + last 2 characters): the point is
// to show that a secret is exposed and where, never to copy it.

export const mask = s => s.length <= 8 ? '•'.repeat(s.length) : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;

function b64urlJson(part) {
  try { return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='))); } catch { return null; }
}

export function readCookies() {
  if (!document.cookie) return [];
  return document.cookie.split(/;\s*/).map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1) }; });
}

// sources: [{ where, text, kind }] kind = 'storage' | 'cookie' | 'code'
export function secretFindings(sources, cookies) {
  const findings = [], seen = new Set();
  for (const { where, text, kind, key } of sources) {
    if (!text) continue;
    // An opaque token stored under a token-like name (access_token, auth, session...): readable by any script.
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
      // Ad-tech and analytics vendors also use JWTs, as visitor IDs. Only tokens carrying identity/permission claims
      // are login tokens; the rest are tracking IDs (still worth listing, not an account risk).
      const authLike = claims && Object.keys(claims).some(k => /^(sub|email|user(_?id|name)?|uid|role|roles|scope|scp|aud|permissions|groups|admin)$/i.test(k));
      if (!authLike) {
        findings.push({ sev: 'low', title: `${none ? 'Unsigned tracking' : 'Tracking'} token (JWT) in ${kind === 'code' ? 'the page\'s code' : kind}`, evidence: [mask(token), where, ...facts],
          means: 'A JWT with no login or permission claims: usually a visitor ID from an ad, analytics or identity vendor. It identifies your browser to them; it isn\'t a key to an account.' + (none ? ' It\'s unsigned, so it only matters if some server trusts it.' : ''),
          todo: 'Clearing this site\'s data resets it.' });
        continue;
      }
      findings.push({ sev: none ? 'high' : kind === 'code' ? 'medium' : 'medium', title: `Login token (JWT) in ${kind === 'code' ? 'the page\'s code' : kind}`,
        evidence: [mask(token), where, ...facts],
        means: (none ? 'Its algorithm is "none": it has no signature, so if the server accepts it, anyone can forge one. ' : '') +
          (kind === 'storage' ? 'Tokens in localStorage/sessionStorage can be read by any script on the page, so a single XSS bug or bad third-party script can steal the session.' :
            kind === 'cookie' ? 'This cookie isn\'t HttpOnly, so page scripts (and XSS) can read it.' : 'A token hard-coded in shipped code works for anyone who reads the code.'),
        todo: none ? 'If it\'s your app: make the server reject alg "none" and always verify signatures.' : 'If it\'s your app: keep session tokens in HttpOnly, Secure, SameSite cookies.' });
    }
  }
  // Session cookies readable by JS (HttpOnly cookies never appear in document.cookie, so these are the exposed ones).
  for (const c of cookies) {
    if (!SESSION_COOKIE.test(c.name) || NOT_SESSION_COOKIE.test(c.name) || new RegExp(JWT.source).test(c.value)) continue; // JWTs reported above
    findings.push({ sev: 'medium', title: `Session cookie "${c.name}" is readable by scripts`, evidence: [mask(c.value), 'document.cookie'],
      means: 'It isn\'t marked HttpOnly, so any script on the page (including an XSS attack) can read and steal it.', todo: 'If it\'s your site: set HttpOnly (and Secure, SameSite) on session cookies.' });
  }
  return findings;
}

// Everything secrets can hide in, gathered from the page. scriptTexts = [[where, text]] already fetched for hints.
export function secretSources({ cookies, scriptTexts, files }) {
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
