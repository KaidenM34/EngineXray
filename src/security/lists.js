// Reference data for the Security tab. Kept short and well-known on purpose: every entry here is something the panel
// will name in a finding, so it has to be right. Add to these lists rather than loosening the matching.

// Browser-mining services (most are defunct, but their scripts and clones still circulate).
export const MINER_DOMAINS = [
  'coinhive.com', 'coin-hive.com', 'authedmine.com', 'crypto-loot.com', 'cryptoloot.pro', 'coinimp.com', 'coinimp.net',
  'webminepool.com', 'minero.cc', 'jsecoin.com', 'ppoi.org', 'monerominer.rocks', 'cryptonoter.com', 'coinhave.com',
  'webmine.cz', 'webmine.pro', 'coinpot.co', 'hashing.win', 'mineralt.io', 'freecontent.bid', 'deepminer.net',
];

// Text that shows up inside browser miners (JS, worker scripts or wasm strings / function names).
export const MINER_STRONG = /cryptonight|cryptonite|randomx|coinhive|coin-hive|cryptoloot|crypto-loot|coinimp|webminepool|deepminer|\bxmrig\b|stratum\+(tcp|ssl)|mining\.(subscribe|notify|authorize)|\bgetHashesPerSecond\b|\bhashesPerSecond\b/i;
export const MINER_WEAK = /\bmonero\b|\bxmr\b|hashrate|\bnonce\b.{0,40}\btarget\b|job_id|\bgroestl\b|\bskein\b|\bjh256\b|blake256|\bsetThrottle\b/i;
// WebSocket URLs that look like a mining pool or proxy.
export const POOL_URL = /pool|stratum|xmr|monero|miner|mining|hashvault|nanopool|supportxmr|minexmr/i;
// JSON-RPC methods of the stratum mining protocol (also used over WebSocket by browser miners).
export const STRATUM_FRAME = /"(method|type)"\s*:\s*"(login|submit|job|getjob|keepalived|mining\.\w+)"/i;

// Little-endian byte patterns of well-known crypto tables. Finding one means the code computes that algorithm.
// CryptoNight (Monero's old proof of work) = Keccak + AES rounds + one of BLAKE-256 / Groestl / JH / Skein.
export const CRYPTO_CONSTANTS = [
  { id: 'keccak', name: 'Keccak / SHA-3 round constants', bytes: [0x8a, 0x80, 0, 0, 0, 0, 0, 0x80, 0, 0x80, 0, 0x80, 0, 0, 0, 0x80] },
  { id: 'aes', name: 'AES S-box', bytes: [0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76] },
  { id: 'aes', name: 'AES T-table', bytes: [0xa5, 0x63, 0x63, 0xc6, 0x84, 0x7c, 0x7c, 0xf8] },
  { id: 'sha256k', name: 'SHA-256 round constants', bytes: [0x98, 0x2f, 0x8a, 0x42, 0x91, 0x44, 0x37, 0x71, 0xcf, 0xfb, 0xc0, 0xb5] },
  { id: 'blake256', name: 'SHA-256 / BLAKE-256 initial values', bytes: [0x67, 0xe6, 0x09, 0x6a, 0x85, 0xae, 0x67, 0xbb] },
  { id: 'blake2b', name: 'SHA-512 / BLAKE2b initial values', bytes: [0x08, 0xc9, 0xbc, 0xf3, 0x67, 0xe6, 0x09, 0x6a] },
];

// Third-party services by category. Matched on the end of the hostname.
export const TRACKERS = {
  'session replay': ['hotjar.com', 'hotjar.io', 'sr-client-cfg.amplitude.com', 'api-sr.amplitude.com', 'fullstory.com', 'logrocket.com', 'logrocket.io', 'lr-ingest.io', 'clarity.ms',
    'mouseflow.com', 'smartlook.com', 'inspectlet.com', 'luckyorange.com', 'quantummetric.com', 'contentsquare.net', 'glassboxdigital.io'],
  'fingerprinting / bot detection': ['fpjs.io', 'fpcdn.io', 'fingerprint.com', 'fingerprintjs.com', 'online-metrix.net', 'iovation.com',
    'px-cdn.net', 'px-cloud.net', 'pxchk.net', 'perimeterx.net', 'humansecurity.com', 'datadome.co', 'kasada.io', 'arkoselabs.com'],
  'ads': ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adnxs.com', 'amazon-adsystem.com', 'criteo.com',
    'criteo.net', 'taboola.com', 'outbrain.com', 'adsrvr.org', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'casalemedia.com',
    'moatads.com', 'adform.net', 'bat.bing.com', 'ads-twitter.com', 'ads.linkedin.com', 'sharethrough.com', 'teads.tv', '33across.com'],
  'social pixels': ['connect.facebook.net', 'facebook.com', 'analytics.tiktok.com', 'sc-static.net', 'ct.pinterest.com', 'snap.licdn.com',
    'px.ads.linkedin.com', 'redditstatic.com', 'alb.reddit.com'],
  'analytics': ['google-analytics.com', 'googletagmanager.com', 'analytics.google.com', 'segment.io', 'segment.com', 'mixpanel.com',
    'amplitude.com', 'heap.io', 'heapanalytics.com', 'plausible.io', 'nr-data.net', 'newrelic.com', 'quantserve.com',
    'scorecardresearch.com', 'chartbeat.com', 'chartbeat.net', 'parsely.com', 'static.cloudflareinsights.com', 'cloudflareinsights.com', 'pendo.io', 'posthog.com'],
  'error monitoring': ['sentry.io', 'sentry-cdn.com', 'bugsnag.com', 'datadoghq.com', 'browser-intake-datadoghq.com'],
};

// Secret / token patterns. sev = severity when found in code or storage the page ships to every visitor.
export const SECRET_PATTERNS = [
  { name: 'AWS access key ID', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, sev: 'high', means: 'Identifies an AWS account key. If its secret half is anywhere near it, anyone can use the account.' },
  { name: 'Stripe secret key', re: /\b(sk|rk)_live_[0-9a-zA-Z]{20,}\b/g, sev: 'high', means: 'Full access to a Stripe account: charges, refunds, customer data.' },
  { name: 'Stripe test secret key', re: /\b(sk|rk)_test_[0-9a-zA-Z]{20,}\b/g, sev: 'medium', means: 'A test-mode secret key. No real money, but it shows secret keys are being shipped to browsers.' },
  { name: 'Stripe publishable key', re: /\bpk_(live|test)_[0-9a-zA-Z]{20,}\b/g, sev: 'info', means: 'Publishable keys are meant to be public. Fine on its own.' },
  { name: 'GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g, sev: 'high', means: 'Access to GitHub repositories as the token\'s owner.' },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, sev: 'high', means: 'Can read or post messages in a Slack workspace.' },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, sev: 'high', means: 'Lets anyone run paid AI requests on the owner\'s account.' },
  { name: 'OpenAI-style API key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/g, sev: 'high', means: 'Lets anyone run paid AI requests on the owner\'s account.' },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, sev: 'info', means: 'Often public by design (Maps, Firebase). Safe only if it is restricted to this site in the Google Cloud console.' },
  { name: 'Private key', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g, sev: 'high', means: 'A private key should never be sent to a browser.' },
];
export const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
export const SESSION_COOKIE = /sess|\bsid\b|auth|token|jwt|login|remember|access|refresh/i;
export const NOT_SESSION_COOKIE = /^(_ga|_gid|_gcl|_fbp|_fbc|__cf|cf_|_hj|ajs_|amplitude|mp_|_clck|_clsk|csrf|xsrf|_csrf|cookie_?consent|OptanonConsent)/i;
// Session-named cookies and keys that belong to analytics, ad, feedback and bot-check vendors (seen in the 20-site
// survey): they identify a visit, not a login. Reported as low, not as an exposed login session.
export const VISITOR_SESSION = /^(aws-waf-token|_pin_unauth)$|^(ab\.storage|kampyle|__attentive|_parsely|optimizely|blaize|bcsession|logglytracking|gc_session|mgnisession|__milesession|s_sess$|as_session_id|cet-page_session|bf-xdomain|foxkit|ebay-rum|session_landing|_sdsat|ffsession|app_session_id|poki_session)|rum-session|session-data$/i;
export const TRACKING_ID_KEYS = /^(_ga|_gid|_fbp|_fbc|ajs_anonymous_id|ajs_user_id|amplitude_id|_hjSessionUser|_clck|mp_.*_mixpanel|__hstc|hubspotutk|_uetvid|_pin_unauth|_tt_enable_cookie|_ttp)/i;

export function hostCategory(hostname) {
  for (const [category, domains] of Object.entries(TRACKERS)) {
    if (domains.some(d => hostname === d || hostname.endsWith('.' + d))) return category;
  }
  return null;
}
export function isMinerHost(hostname) {
  return MINER_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
}

// Another site than this page's (compared by the last two name parts, so cdn.example.com counts as example.com).
const siteOf = host => host.split('.').slice(-2).join('.');
export const isThirdPartyHost = host => !!host && host !== location.hostname && siteOf(host) !== siteOf(location.hostname);
