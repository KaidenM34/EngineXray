// WebAssembly binary reader: just enough of the format (spec "Binary Format") to list what a module imports and
// exports, how big its memory is, how many functions it has, and the text hidden in its data segments.
// No dependencies. Works on a few hundred MB without trouble because it only walks section headers and data bytes.

const KINDS = ['function', 'table', 'memory', 'global', 'tag'];

function reader(bytes) {
  let pos = 0;
  const r = {
    get pos() { return pos; }, set pos(p) { pos = p; },
    byte() { if (pos >= bytes.length) throw new Error('unexpected end of file'); return bytes[pos++]; },
    u32() { // unsigned LEB128
      let result = 0, shift = 0, b;
      do { b = r.byte(); result += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
      return result;
    },
    skipLeb() { while (r.byte() & 0x80); },
    bytes(n) { const out = bytes.subarray(pos, pos + n); pos += n; return out; },
    name() { return new TextDecoder().decode(r.bytes(r.u32())); },
    limits() {
      const flags = r.byte();
      const min = r.u32(), max = flags & 1 ? r.u32() : null;
      return { min, max, shared: !!(flags & 2), is64: !!(flags & 4) };
    },
    // constant expression (data/elem offsets, globals): read opcodes up to `end` (0x0b)
    constExpr() {
      for (;;) {
        const op = r.byte();
        if (op === 0x0b) return;
        if (op === 0x41 || op === 0x42 || op === 0x23 || op === 0xd2) r.skipLeb();
        else if (op === 0x43) pos += 4;
        else if (op === 0x44) pos += 8;
        else if (op === 0xd0) r.byte();
        else if (op === 0xfd) { r.skipLeb(); pos += 16; } // v128.const
      }
    },
  };
  return r;
}

export function parseWasm(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error('not a WebAssembly file');
  const r = reader(bytes);
  r.pos = 4;
  const version = bytes[4] | bytes[5] << 8 | bytes[6] << 16 | bytes[7] << 24;
  r.pos = 8;
  const out = {
    size: bytes.length, version, imports: [], exports: [], memories: [], tables: 0, globals: 0,
    functions: { imported: 0, defined: 0 }, customSections: [], data: [], dataBytes: 0, functionNames: 0, names: [],
    sections: [],
  };
  while (r.pos < bytes.length) {
    const id = r.byte(), len = r.u32(), start = r.pos, end = start + len;
    out.sections.push({ id, size: len });
    try {
      if (id === 0) {
        const name = r.name();
        out.customSections.push({ name, size: end - r.pos });
        if (name === 'name') { out.names = readFunctionNames(r, end); out.functionNames = out.names.length; }
      } else if (id === 2) {
        for (let n = r.u32(); n--;) {
          const module = r.name(), field = r.name(), kind = r.byte();
          const imp = { module, name: field, kind: KINDS[kind] ?? `kind${kind}` };
          if (kind === 0) { r.skipLeb(); out.functions.imported++; }
          else if (kind === 1) { r.byte(); r.limits(); }
          else if (kind === 2) { imp.limits = r.limits(); out.memories.push({ ...imp.limits, imported: `${module}.${field}` }); }
          else if (kind === 3) { r.byte(); r.byte(); }
          else if (kind === 4) { r.byte(); r.skipLeb(); }
          out.imports.push(imp);
        }
      } else if (id === 3) {
        out.functions.defined = r.u32();
      } else if (id === 4) {
        out.tables += r.u32();
      } else if (id === 5) {
        for (let n = r.u32(); n--;) out.memories.push(r.limits());
      } else if (id === 6) {
        out.globals += r.u32();
      } else if (id === 7) {
        for (let n = r.u32(); n--;) {
          const name = r.name(), kind = r.byte(), index = r.u32();
          out.exports.push({ name, kind: KINDS[kind] ?? `kind${kind}`, index });
        }
      } else if (id === 11) {
        for (let n = r.u32(); n--;) {
          const flags = r.u32();
          if (flags === 2) r.u32();
          if (flags !== 1) r.constExpr();
          const size = r.u32();
          out.data.push({ start: r.pos, size });
          out.dataBytes += size;
          r.pos += size;
        }
      }
    } catch (e) {
      out.warning = `section ${id} could not be read fully (${e.message})`;
    }
    r.pos = end;
  }
  out.bytes = bytes; // kept for string search
  return out;
}

// The "name" custom section: subsection 1 lists function names (debug builds and many engines keep it). Capped so a
// huge debug build doesn't hold hundreds of thousands of strings.
function readFunctionNames(r, end, cap = 200000) {
  while (r.pos < end) {
    const sub = r.byte(), len = r.u32(), next = r.pos + len;
    if (sub === 1) {
      const names = [];
      for (let n = r.u32(); n-- && names.length < cap;) { r.u32(); names.push(r.name()); }
      return names;
    }
    r.pos = next;
  }
  return [];
}

// Printable ASCII runs inside the data segments (where C/C++/Rust string literals end up), or the whole file if a
// module has no data segments. Returns up to `limit` matches for `filter` (a RegExp or plain substring).
export function findStrings(mod, { minLength = 6, filter = null, limit = 500 } = {}) {
  const ranges = mod.data.length ? mod.data : [{ start: 0, size: mod.bytes.length }];
  const test = !filter ? () => true : filter instanceof RegExp ? s => filter.test(s) : s => s.toLowerCase().includes(String(filter).toLowerCase());
  const found = [], seen = new Set();
  let total = 0;
  for (const { start, size } of ranges) {
    let runStart = -1;
    for (let i = start, endAt = start + size; i <= endAt; i++) {
      const c = i < endAt ? mod.bytes[i] : 0;
      const printable = c >= 0x20 && c < 0x7f || c === 0x09;
      if (printable) { if (runStart < 0) runStart = i; continue; }
      if (runStart >= 0 && i - runStart >= minLength) {
        total++;
        if (found.length < limit) {
          const s = String.fromCharCode(...mod.bytes.subarray(runStart, Math.min(i, runStart + 400)));
          if (!seen.has(s) && test(s)) { seen.add(s); found.push(s); }
        }
      }
      runStart = -1;
    }
  }
  return { strings: found, total };
}
