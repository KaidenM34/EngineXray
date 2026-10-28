# Plan: EngineX-ray as a Chrome extension

Agreed 2026-10-28, to build in a later session. The bookmarklet stays; the extension wraps the same bundle (`engine-xray.js`) built by `make.sh`.

## Step 1: working extension (about 1 hour)
- `extension/manifest.json` (Manifest V3): `action` toolbar button, `scripting` + `activeTab` permissions, icons.
- `extension/background.js`: on toolbar click, `chrome.scripting.executeScript({ world: 'MAIN', files: ['engine-xray.js'] })` on the current tab. The MAIN world is needed so the checks can read page globals and Live watch can wrap `fetch`, `XMLHttpRequest`, form fields and so on.
- `make.sh` copies `engine-xray.js` into `extension/` and zips it for upload.
- The panel's `<style>` moves to a constructable stylesheet (`adoptedStyleSheets`), so strict page CSPs can't block its styling.
- Load it unpacked (chrome://extensions → Developer mode → Load unpacked); test on the lab pages, The Verge, United and a strict-CSP site.

## Step 2: upgrades (2–3 hours)
- **Live watch from page load (opt-in setting):** a `document_start` content script in the MAIN world installs the watcher before page scripts run, so load-time fingerprinting, field binding and keystroke listeners are seen. Needs host permission for all sites, so it's an option, off by default.
- **Grade badge on the icon:** after a scan, `chrome.action.setBadgeText` per tab (A–F, colored to match).
- An options page (auto-watch on/off), proper icons at 16/32/48/128 px.

## Step 3: Chrome Web Store (about 1 hour + review)
- Store listing: description, 3–5 screenshots (report card, findings, Live watch), a small promo tile.
- Privacy policy page: EngineX-ray collects and sends nothing.
- Permission justifications (`activeTab`/`scripting`; all-sites host access only for the auto-watch option).
- The user pays the one-time $5 developer fee and uploads; review usually takes 1–3 days, longer with broad host permissions.
