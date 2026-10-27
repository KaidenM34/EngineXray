# EngineX-ray

**Click a bookmark on any browser game or WebAssembly app and see what's under the hood:** the engine it's built with, the functions it exposes, the hooks hiding in the page, and where it keeps its files. Its **Security tab** catches hidden crypto-miners, device fingerprinting and leaked tokens or keys, all passively, from your own tab.

It's the first hour of reverse-engineering a web game, done in a few seconds. I built it after modding Black Ops Zombies in the browser ([bo1fun](https://github.com/KaidenM34/BO1PortedBrowserMods)), so the next game would take minutes instead of days.

## What it shows

| Tab | What you get |
|---|---|
| **Security** | Hidden **crypto-miners** (CryptoNight/RandomX crypto tables in WebAssembly, miner text, stratum pool traffic, worker swarms), **privacy** (session replay, fingerprinting scripts with the techniques they used, ad/analytics trackers, tracking IDs) and **leaked secrets** (JWTs including forgeable `alg:none`, tokens in storage, script-readable session cookies, AWS/Stripe/GitHub/AI keys). Every finding has evidence, what it means, and what to do. Values are masked. See [docs/SECURITY_CHECKS.md](docs/SECURITY_CHECKS.md) |
| **Overview** | The engine's fingerprint (Emscripten, Unity, Godot, Rust/wasm-bindgen, Go) **with the evidence**, size, function count, memory, and a "Where to start" list of the most promising ways in |
| **Engine file** | The engine's own exported functions (its API), runtime exports, and every import grouped by module |
| **JS bridge** (in Engine file) | The page's JavaScript functions the engine calls back into, by readable name. Wrapping one is often the quickest way in |
| **Strings** | Search the text inside the engine, with presets for settings/cvars, file paths, commands, mod hooks, errors and URLs |
| **Globals** | Variables the page added, with notes: Emscripten `Module`s, virtual file systems, `callMain()`, Unity's `SendMessage()`, double-underscore hook names |
| **Storage** | OPFS folders with sizes and file counts, IndexedDB, localStorage, Cache Storage |
| **Console** | Record what the page prints while you play |
| **Report** | A Markdown summary to copy or download |

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
| Clean page | nothing |

## Tested on

- **Black Ops Zombies (KisakBlack, Emscripten, 9.9 MB).** Found:
  - the `KB_*` engine API,
  - the 2 GB shared memory pool,
  - the `fs_mods` / `kisak_mod_zones` settings,
  - the site's `__kisakFlow` hook.

  This is everything that took hours to find by hand for bo1fun.
- **A skate fan game (Rust + wasm-bindgen, 61 MB, loaded from a worker).** Found the engine through the page's scripts, plus the `mods-worker.js` worker. The JS bridge list showed its mod API (`modsLoad`, `modsCall`, `modsUnload`).
- **Security checks on real sites:** both game engines above come back as "standard crypto tables" (info), not miners. Testing on them caught and fixed one false positive (`XMRigid` matching the XMRig miner). A major news site showed 112 third-party hosts, 31 of them ad networks.
- Unity and Godot fingerprints are written but not yet tested on a real game.

Parsing a 10 MB engine takes about 0.3 seconds.

## Install

1. Open `install.html` and drag the **EngineX-ray** button to your bookmarks bar.
2. Open a game and get it running. Some only load their engine after you press Play.
3. Click the bookmark. Click it again to hide or show the panel. The panel can be dragged by its title bar.

Or paste `engine-xray.js` into the DevTools console.

## How it works

- **`src/wasm.js`:** a small WebAssembly binary reader with no dependencies. It walks section headers for imports, exports, memory, function counts and custom sections, and scans data segments for text.
- **`src/detect.js`:** engine fingerprints (each result lists its evidence), export grouping, the JS-bridge name extraction and the string presets.
- **`src/page.js`:** the page side: resource timing for `.wasm` URLs, script hints, a globals diff against a blank iframe, the storage walk and the console recorder.
- **`src/main.js`:** the panel. It uses a shadow DOM so the page's CSS can't touch it, and the page's CSS can't be touched by it.

`./make.sh` puts these together into `engine-xray.js`, the bookmarklet and `install.html`. It needs only `python3`.

## Privacy and scope

EngineX-ray only **reads** what the page already loaded or stored, in your own tab, and sends nothing anywhere. The Security tab is passive by design: no payloads, no scanning other hosts, nothing blocked, secrets masked. It's for learning how web apps are built, modding games, and debugging your own WebAssembly projects. Respect each site's terms: inspecting a page in your own browser is fine; using what you find to get around paywalls, logins or anti-cheat isn't.

## License

[MIT](LICENSE)
