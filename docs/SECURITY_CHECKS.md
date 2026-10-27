# Security checks

EngineX-ray's Security tab runs three groups of **passive** checks:
- It reads what your own tab already downloaded and stores.
- With **Watch this page** on, it also records what scripts do from that moment.
- It never sends anything, never probes other hosts, never blocks anything, and always masks secret values.

Every finding shows its evidence, so you can judge it yourself.

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
- **Leaky login app:** an `alg:none` JWT, an opaque `access_token`, a JS-readable `session` cookie, AWS's documentation example key `AKIAIOSFODNN7EXAMPLE`, a Stripe test key and a fake Google key. **Expected:** all six found and masked (2 high, 3 medium, 1 info).
- **Clean page:** nothing planted. **Expected:** no findings.

Each test page has a **Run EngineX-ray** button that loads the same build as the bookmark.
