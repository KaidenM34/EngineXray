# Security checks

EngineX-ray opens on a **report card**: an A–F grade for how the page treats your privacy and security, a short summary, and the points taken off. The grade is built from five groups of **passive** checks, listed in the Findings tab:
- It reads what your own tab already downloaded and stores, plus one re-read of the page for its response headers (usually served from the browser's cache).
- With **Live watch** on, it also records what scripts do from that moment: where data goes, whether your typing is in it, who reads your form fields.
- It never sends anything, never probes other hosts, never blocks anything, and always masks secret values.

Every finding shows its evidence, so you can judge it yourself.

## The grade

The score starts at 100. Points come off for:

| What | Points |
|---|---|
| Session replay (your clicks and typing are recorded) | −25 |
| Device fingerprinting (a vendor, or fingerprinting code in a script) | −10 |
| Ad-network servers | −1 per 2, up to −20 |
| Social-media trackers | −2 each, up to −8 |
| More than 50 / 100 outside servers | −4 / −8 |
| A crypto-miner (confirmed / only hints) | −60 / −5 |
| Exposed keys or forgeable tokens (high) | −25 each, up to −50 |
| Login tokens readable by scripts (medium) | −4 each, up to −12 |
| Site security: high / medium / low findings | −20 / −8 each, −3 each up to −9 |
| Live watch: high / medium findings | −20 / −10 each |

A is 90+, B 80+, C 70+, D 60+, F below. The summary lists problems first, then the all-clear lines. It's measured before any cookie banner is clicked, which is what a first-time visitor gets.

## Crypto-miner detection

Browser miners use visitors' CPUs to earn cryptocurrency. Most compile their hashing code to WebAssembly.

| Check | How | Severity |
|---|---|---|
| **Known mining services** | Resource hostnames matched against a list of browser-mining services (Coinhive, CoinIMP, Crypto-Loot, …) | high |
| **CryptoNight shape** | The engine's data segments contain **Keccak round constants + the AES S-box/T-table + a BLAKE-256/Groestl/JH/Skein finalizer**. That's the recipe of CryptoNight, the proof of work browser miners used for Monero | high with miner text in the same file, otherwise low |
| **RandomX shape** | BLAKE2b initial values plus RandomX/Argon2 text | high / low, as above |
| **Mining text** | Miner names and protocol strings (`cryptonight`, `randomx`, `stratum+tcp`, `mining.subscribe`, `getHashesPerSecond`, …) in wasm strings, function names, page scripts and worker scripts | high |
| **Stratum traffic** (watch) | WebSocket frames with stratum methods (`login`, `job`, `submit`, `mining.*`) | high |
| **Pool-like socket** (watch) | A WebSocket URL that looks like a pool or proxy | medium |
| **Worker swarm** (watch) | As many new workers as CPU cores | medium |
| **Standard crypto tables** | AES or SHA tables on their own | info |

How the constant search works:
- The crypto tables are compared byte for byte, little-endian, at 4-byte steps through the data segments.
- A 61 MB engine is scanned in about 0.35 s.

False positives and how they're handled:
- **Crypto tables alone are normal.** Downloads, saves, TLS-style libraries and checksums all use SHA and AES. Both real engines tested (Black Ops' KisakBlack and a Rust skate game) contain SHA-256 tables and are correctly reported as **info**.
- **Word boundaries matter.** An early version flagged Black Ops' `XMRigid` (a model format) as the XMRig miner. The pattern is now `\bxmrig\b`.
- **Worker swarms happen in normal apps too.** Games, video editors and Emscripten pthreads start many workers. That's why it's medium and only a lead.

## Privacy and fingerprinting

| Check | How | Severity |
|---|---|---|
| **Session replay** | Third-party hosts of replay services (Hotjar, FullStory, LogRocket, Clarity, Mouseflow, …). These record clicks, scrolling and often typing | high |
| **Fingerprinting service** | Hosts of fingerprinting / bot-detection vendors | medium |
| **Likely fingerprinting** (watch) | One script using 3 or more techniques: canvas readback, font probing (50+ `measureText` calls), the WebGL GPU model, an `OfflineAudioContext`, high-entropy `navigator` reads, `enumerateDevices`, the battery, `RTCPeerConnection` | high |
| **Ads / social pixels** | Hosts on the ad-network and social-pixel lists | low |
| **Tracking IDs** | Known long-lived ID cookies and localStorage keys (`_ga`, `_fbp`, `ajs_anonymous_id`, …) | low |
| **Analytics, error monitoring, other third parties** | Grouped by category | info |

Calls are blamed on the script that made them, using the call stack. EngineX-ray's own frames are skipped, and its own checks run with recording paused.

Limitations:
- **Watch only sees what happens after you switch it on.** A script that fingerprints at page load, before you click, won't show. Switch Watch on, then reload the site's state (log in, start a game, open the checkout).
- **One or two device reads are normal.** Games read the GPU model and core count to pick settings. That's info, not fingerprinting.

## Site security

How well the site protects you, from the response headers and the live page.

| Check | How | Severity |
|---|---|---|
| **Plain HTTP page** | The page isn't served over HTTPS (local addresses excepted) | high |
| **Password form over HTTP** | A form with a password field whose action is an `http://` address | high |
| **Password form uses GET** | The password would go in the URL (history, logs, analytics) | medium |
| **Mixed content** | Scripts, frames or requests loaded over `http://` on an HTTPS page (images: low) | medium |
| **Known-vulnerable library** | jQuery, jQuery UI, AngularJS, Bootstrap, Lodash, Underscore, Moment, Handlebars, DOMPurify and Vue versions, from their globals or from version numbers in script URLs, checked against published CVEs (e.g. jQuery < 3.5.0: CVE-2020-11022/11023) and end-of-life versions | medium (low for denial-of-service bugs and end of life) |
| **No HSTS** | No `Strict-Transport-Security` header on an HTTPS page | low (short max-age: info) |
| **No Content Security Policy** | Neither a header nor a `<meta>` policy | low |
| **Weak CSP** | `'unsafe-inline'` without nonces or hashes, or a wildcard script source | low (`'unsafe-eval'`: info) |
| **Clickjacking** | No `X-Frame-Options` and no CSP `frame-ancestors` | low |
| **CDN scripts without integrity** | Library files from public CDNs (cdnjs, jsDelivr, unpkg, code.jquery.com, …) without an `integrity` attribute | low |
| **No nosniff**, password form to another site (often single sign-on) | | info |

A vulnerable version is only exploitable if the site uses the affected feature; the finding says so.

## Live watch

Switch it on, then use the page. It wraps `fetch`, `XMLHttpRequest`, `sendBeacon` and WebSocket `send`, reads the resource timeline for images and pixels, and remembers the current value of each field you type in (5+ characters).

| Finding | Severity |
|---|---|
| **What you typed was sent to another company's server**: a field's current value found in a request's URL or body (as typed, URL-encoded or lowercased) | high for password, email, phone or card fields; medium otherwise; info when it went to the site itself |
| **A third-party script read your password, card, email or phone field** (from the call stack of the `value` read) | high for password/card; medium for email/phone |
| **A third-party script listens to your keystrokes** (new `keydown`/`input`/`paste` listeners) | medium on form fields; low on the whole page (ad verification and bot detection do this to check a person is there) |
| **Where data went**: every server that received something, with request counts and bytes | info |

Limitations: listeners and field reads set up before you switched it on aren't visible, and session-replay tools usually compress or mask what they send, so their uploads rarely match your text. The field-read check catches those instead.

## Token and secret leaks

Sources scanned:
- cookies that scripts can read (HttpOnly cookies are invisible to `document.cookie`, which is the point),
- localStorage and sessionStorage,
- inline scripts and same-origin script files,
- wasm strings,
- string values on `window`.

| Finding | Severity |
|---|---|
| AWS access key IDs, Stripe live secret keys, GitHub/Slack tokens, AI API keys, private keys in shipped code | high |
| JWT with `alg: none` (no signature, so it's forgeable if the server accepts it) | high |
| Login tokens (JWT or opaque values under token/session names) in localStorage/sessionStorage. Any XSS can read them | medium |
| Session cookies without HttpOnly | medium |
| Session-named cookies and keys from analytics, ad, feedback and bot-check vendors (Parsely, Optimizely, Braze, Kampyle, AWS WAF, …): a visit, not a login | low |
| Stripe test secret keys | medium |
| Google API keys, Stripe publishable keys (often public by design) | info |

For a JWT, EngineX-ray shows:
- the algorithm,
- the expiry date (and whether it has expired),
- the issuer,
- the claim **names**.

It never shows the signature, the claim values or the full token.

All values are masked as `AKIA…LE (20 chars)`.

## Test range

`lab/` is a local site with one fake threat per page, for demos and for checking the checks:
1. Run `python3 lab/server.py`. It serves on `127.0.0.1:8790` and plays a fake stratum pool on `/stratum`.
2. Open `http://127.0.0.1:8790/`.

Pages:
- **Hidden miner:** `fake-miner.wasm`, built by `lab/make_fake_miner.py`. It is a valid module with **no code**, only the data a CryptoNight miner carries. The page also starts one sleeping worker per core and talks stratum to the fake pool. **Expected:** 3 high + 1 medium.
- **Device fingerprinting:** `fp.js` runs canvas, font, GPU, audio and hardware probes. **Expected:** `fp.js` flagged as "likely fingerprinting" with all five techniques.
- **Leaky login app:** an `alg:none` JWT, an opaque `access_token`, a JS-readable `session` cookie, AWS's documentation example key `AKIAIOSFODNN7EXAMPLE`, a Stripe test key and a fake Google key. **Expected:** all six found and masked (2 high, 3 medium, 1 info). Leaving the page logs out, so the other pages aren't graded on its tokens.
- **Outdated shop:** a jQuery 1.12.4 version number, a login form that would `GET` to an `http://` address, no CSP or clickjacking protection, and `tracker.js` loaded from `localhost` (another origin than `127.0.0.1`) that reads the email and password fields and beacons them to the server's `/collect`, which discards them. **Expected:** grade F; with Live watch on and a made-up email and password typed in: "What you typed was sent to localhost" (high, both fields), "A script from localhost read your password or card field" (high), keystroke listeners on the fields (medium).
- **Clean page:** nothing planted, and the server sends it a strict CSP, `frame-ancestors 'none'` and `nosniff`. **Expected:** grade A (100), no findings.

Each test page has a **Run EngineX-ray** button that loads the same build as the bookmark.
