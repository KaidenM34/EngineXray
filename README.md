# EngineX-ray

**Click a bookmark on any website and get a privacy and security report card:** an A–F grade, three plain-English lines about how the page treats you, and the evidence behind every point it takes off. It finds session recording, device fingerprinting, ad trackers, outdated libraries with known CVEs, weak security headers, unsafe password forms, leaked keys and hidden crypto-miners. **Live watch** goes further: use the page normally and it shows where your data goes, whether what you type leaves the page, and which outside scripts read your form fields.

Everything is passive and stays in your tab: nothing is sent anywhere, and secrets are masked.

It started as a tool for reverse-engineering WebAssembly games, after I modded Black Ops Zombies in the browser ([bo1fun](https://github.com/KaidenM34/BO1PortedBrowserMods)). Those engine tools are still here, under **Advanced**.

## What it shows

| Tab | What you get |
|---|---|
| **Report card** | The grade, a short summary (problems first), one tile per area (session recording, fingerprinting, trackers, site security, leaked secrets, crypto-miner, Live watch) and **why this grade**: every deduction with its points |
| **Findings** | Every finding with its evidence, what it means and what to do, in five groups: **Privacy** (session replay, fingerprinting vendors and code, ad/social trackers, tracking IDs), **Site security** (HTTPS, HSTS, CSP, clickjacking, mixed content, password forms, vulnerable libraries, CDN scripts without integrity), **Secrets & tokens** (JWTs including forgeable `alg:none`, tokens in storage, script-readable session cookies, AWS/Stripe/GitHub/AI keys), **Crypto-miner** (CryptoNight/RandomX tables in WebAssembly, miner text, stratum traffic, worker swarms) and **Live watch**. See [docs/SECURITY_CHECKS.md](docs/SECURITY_CHECKS.md) |
| **Live watch** | Switch it on and use the page: where each request goes and how much it sends, whether your typing is in it, which outside scripts read your password/email/card fields or listen to your keys, and fingerprinting calls as they happen |
| **Advanced** | The original engine tools: engine fingerprint (Emscripten, Unity, Godot, Rust/wasm-bindgen, Go) with evidence, exports and the JS bridge, a string search with presets, page globals with notes, OPFS/IndexedDB/Cache storage, and a console recorder |
| **Export** | The report card and all findings as Markdown, to copy or download |

Engines that load inside a web worker, or that build their file name at runtime, don't appear in the page's resource list. EngineX-ray also reads the page's own scripts for `.wasm` and worker references and offers them as one-click scans.

## Test range: fake threats, real detection

`lab/` is a small local site where each page plants one threat: a hidden miner (with a fake mining pool), a fingerprinting script, a leaky login app, and a clean control page. Nothing in it is real or harmful. The "miner" WebAssembly file has no code at all.

```bash
python3 lab/server.py
```

Then open http://127.0.0.1:8790/. Each test page has a **Run EngineX-ray** button.

| Page | EngineX-ray finds |
|---|---|
| Hidden miner | CryptoNight crypto tables + miner text (high), stratum `login`/`submit` to the pool (high), a worker per CPU core (medium) |
| Device fingerprinting | `fp.js` flagged as likely fingerprinting: canvas, font probing ×120, GPU model, audio, hardware |
| Leaky login app | 6 of 6 planted secrets, masked: `alg:none` JWT and AWS key (high); access token, Stripe test key, readable session cookie (medium); Google key (info) |
| Outdated shop | jQuery 1.12.4 CVEs, a password form over HTTP using GET, no CSP or clickjacking protection: grade F. With Live watch on and made-up details typed in: the fake tracker reading both fields and sending them to another origin (high) |
| Clean page | grade A (100), no findings |

## Tested on

- **Black Ops Zombies (KisakBlack, Emscripten, 9.9 MB).** Found:
  - the `KB_*` engine API,
  - the 2 GB shared memory pool,
  - the `fs_mods` / `kisak_mod_zones` settings,
  - the site's `__kisakFlow` hook.

  This is everything that took hours to find by hand for bo1fun.
- **A skate fan game (Rust + wasm-bindgen, 61 MB, loaded from a worker).** Found the engine through the page's scripts, plus the `mods-worker.js` worker. The JS bridge list showed its mod API (`modsLoad`, `modsCall`, `modsUnload`).
- **The report card on real sites:** The Verge graded C–D, almost all for its ad networks (24–31 ad servers, 97–111 outside servers per load); Live watch caught an ad-verification script listening to keystrokes on the whole page. United's flight search shows Quantum Metric session replay. A 20-site survey of game portals, news, shopping and student sites is in `survey/`.
- **Security checks on real sites:** both game engines above come back as "standard crypto tables" (info), not miners. Testing on them caught and fixed one false positive (`XMRigid` matching the XMRig miner). A major news site showed 112 third-party hosts, 31 of them ad networks.
- Unity and Godot fingerprints are written but not yet tested on a real game.

Parsing a 10 MB engine takes about 0.3 seconds.

## Install

1. Open `install.html` and drag the **EngineX-ray** button to your bookmarks bar.
2. Open any page. (For the engine tools, get the game running first: some only load their engine after you press Play.)
3. Click the bookmark. It opens on the report card. Click it again to hide or show the panel; drag it by its title bar.

Or paste `engine-xray.js` into the DevTools console.

## How it works

- **`src/wasm.js`:** a small WebAssembly binary reader with no dependencies. It walks section headers for imports, exports, memory, function counts and custom sections, and scans data segments for text.
- **`src/detect.js`:** engine fingerprints (each result lists its evidence), export grouping, the JS-bridge name extraction and the string presets.
- **`src/page.js`:** the page side: resource timing for `.wasm` URLs, script hints, a globals diff against a blank iframe, the storage walk and the console recorder.
- **`src/security/`:** the checks. `lists.js` (tracker, miner and secret patterns), `privacy.js`, `secrets.js`, `miner.js`, `web.js` (headers, forms, mixed content, vulnerable libraries), `hooks.js` (Live watch's wrappers) and `grade.js` (the report card).
- **`src/main.js`:** the panel. It uses a shadow DOM so the page's CSS can't touch it, and the page's CSS can't be touched by it.

`./make.sh` puts these together into `engine-xray.js`, the bookmarklet and `install.html`. It needs only `python3`.

## Privacy and scope

EngineX-ray only **reads** what the page already loaded or stored in your own tab (plus one re-read of the page for its headers), and sends nothing anywhere. It's passive by design: no payloads, no scanning other hosts, nothing blocked, secrets masked. It's for seeing how sites treat you, checking your own sites, learning how web apps are built and modding games. Respect each site's terms: inspecting a page in your own browser is fine; using what you find to get around paywalls, logins or anti-cheat isn't.

## License

[MIT](LICENSE)
