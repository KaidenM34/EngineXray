// Builds the panel's DOM from its own markup without assigning HTML strings. Sites that enforce Trusted Types
// (YouTube) reject innerHTML outright, and sites with a sanitizing default policy (LinkedIn) strip every tag from it.
// createElement / setAttribute / text nodes aren't affected by either, so the panel's markup is parsed here instead.
// Only for EngineX-ray's own templates: well-formed tags, quoted attributes, page data already escaped with esc().

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITY[e.toLowerCase()] ?? m);
const TOKEN = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|([^<]+)|</g;
const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export function buildHTML(html) {
  const root = document.createDocumentFragment();
  const stack = [root];
  for (const m of html.matchAll(TOKEN)) {
    const [whole, close, open, attrs, selfClose, text] = m;
    const parent = stack.at(-1);
    if (text != null || whole === '<') { parent.append(decode(text ?? whole)); continue; }
    if (close) {
      const name = close.toLowerCase();
      const i = stack.findLastIndex(n => n.localName === name);
      if (i > 0) stack.length = i;
      continue;
    }
    if (!open) continue; // comment
    const name = open.toLowerCase();
    const inSvg = name === 'svg' || parent.namespaceURI === SVG_NS;
    const el = inSvg ? document.createElementNS(SVG_NS, open) : document.createElement(name);
    for (const a of (attrs ?? '').matchAll(ATTR)) {
      if (/^on/i.test(a[1])) continue; // never event-handler attributes
      try { el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? '')); } catch {}
    }
    parent.append(el);
    if (!selfClose && !(!inSvg && VOID.has(name))) stack.push(el);
  }
  return root;
}

export function setHTML(el, html) {
  el.replaceChildren(buildHTML(html));
}

// Styles for a shadow root: a constructed stylesheet when the browser has them (page CSPs don't apply to those),
// otherwise a <style> element filled as text.
export function applyStyles(shadow, css) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    shadow.append(style);
  }
}
