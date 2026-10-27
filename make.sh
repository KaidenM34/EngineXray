#!/bin/sh
# Builds EngineX-ray from src/ (needs only python3):
#   engine-xray.js           the whole tool as one script (paste into DevTools, or load it however you like)
#   enginexray.bookmarklet.txt + install.html   the same thing as a drag-to-install bookmark
cd "$(dirname "$0")"
python3 -I - <<'PYEOF'
import html, pathlib, re, urllib.parse
parts = []
for name in ['wasm.js', 'detect.js', 'page.js', 'security/lists.js', 'security/hooks.js', 'security/miner.js', 'security/privacy.js', 'security/secrets.js']:
    src = pathlib.Path('src', name).read_text()
    parts.append(f'// ---- {name} ----\n' + re.sub(r'^export ', '', src, flags=re.M))
parts.append('// ---- main.js ----\n' + pathlib.Path('src/main.js').read_text())
bundle = '(() => {\n' + '\n'.join(parts) + '\n})();\n'
pathlib.Path('engine-xray.js').write_text(bundle)

def squeeze(t):  # drop comment-only lines and indentation (keeps the bookmark small; code is unchanged)
    return '\n'.join(l.strip() for l in t.splitlines() if l.strip() and not l.strip().startswith('//'))
bookmarklet = 'javascript:' + urllib.parse.quote(squeeze(bundle), safe='')
pathlib.Path('enginexray.bookmarklet.txt').write_text(bookmarklet)
page = pathlib.Path('install.template.html').read_text().replace('{{BOOKMARKLET}}', html.escape(bookmarklet, quote=True))
pathlib.Path('install.html').write_text(page)
pathlib.Path('lab/engine-xray.js').write_text(bundle)  # the test range loads it too
# Survey probe: the passive checks without the panel (see survey/RESULTS.md)
probe_parts = []
for name in ['wasm.js', 'detect.js', 'page.js', 'security/lists.js', 'security/miner.js', 'security/privacy.js', 'security/secrets.js', 'survey.js']:
    probe_parts.append(re.sub(r'^export ', '', pathlib.Path('src', name).read_text(), flags=re.M))
probe = squeeze('(() => {\n' + '\n'.join(probe_parts) + '\n})();\n')
pathlib.Path('survey-probe.js').write_text(probe)
pathlib.Path('lab/survey-probe.js').write_text(probe)
print('built survey-probe.js', len(probe), 'chars')
print('built engine-xray.js', len(bundle), 'chars | bookmarklet', len(bookmarklet), 'chars')
PYEOF
