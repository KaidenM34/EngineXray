// Test range: the classic fingerprinting techniques, in one script, shown on screen. The "ID" is only displayed;
// it isn't stored or sent anywhere.
const log = msg => { document.getElementById('log').textContent += '\n' + msg; };

async function hash(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes.slice(0, 6)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function fingerprint() {
  const parts = [];

  // 1. Canvas: the same drawing comes out slightly different on every GPU / font stack.
  const c = document.createElement('canvas'); c.width = 240; c.height = 60;
  const g = c.getContext('2d');
  g.textBaseline = 'top'; g.font = '16px Arial'; g.fillStyle = '#f60'; g.fillRect(100, 1, 62, 20);
  g.fillStyle = '#069'; g.fillText('EngineX-ray test 😃', 2, 15);
  parts.push(c.toDataURL());
  g.getImageData(0, 0, 240, 60);
  log('canvas: drew text, read the pixels back');

  // 2. Fonts: a font you have changes the measured width.
  const fonts = ['Arial', 'Verdana', 'Helvetica', 'Times New Roman', 'Courier New', 'Georgia', 'Palatino', 'Garamond', 'Bookman',
    'Comic Sans MS', 'Trebuchet MS', 'Arial Black', 'Impact', 'Menlo', 'Monaco', 'Consolas', 'Lucida Console', 'Tahoma', 'Futura',
    'Gill Sans', 'Optima', 'Didot', 'Baskerville', 'Avenir', 'Segoe UI', 'Calibri', 'Cambria', 'Candara', 'Franklin Gothic', 'Rockwell',
    'Copperplate', 'Papyrus', 'Brush Script MT', 'Hoefler Text', 'American Typewriter', 'Andale Mono', 'Big Caslon', 'Chalkboard',
    'Cochin', 'Herculanum', 'Marker Felt', 'Noteworthy', 'Phosphate', 'Skia', 'Trattatello', 'Zapfino', 'SF Pro', 'Roboto', 'Ubuntu',
    'Cantarell', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans', 'Fira Sans', 'Source Sans Pro', 'Open Sans', 'Lato', 'Montserrat', 'Inter', 'Raleway'];
  const have = fonts.filter(f => { g.font = `20px "${f}", monospace`; const w = g.measureText('mmmmmmmmmmlli').width; g.font = '20px monospace'; return w !== g.measureText('mmmmmmmmmmlli').width; });
  parts.push(have.join(','));
  log(`fonts: tested ${fonts.length}, you have ${have.length}`);

  // 3. GPU model.
  const gl = document.createElement('canvas').getContext('webgl');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  const gpu = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unavailable';
  parts.push(gpu);
  log('GPU: ' + gpu);

  // 4. Audio: tiny floating-point differences in how the audio stack renders a tone.
  const ctx = new OfflineAudioContext(1, 4410, 44100);
  const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 1000;
  const comp = ctx.createDynamicsCompressor(); osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
  const buffer = await ctx.startRendering();
  const sample = buffer.getChannelData(0).slice(4000, 4100).reduce((a, b) => a + Math.abs(b), 0);
  parts.push(sample);
  log('audio: rendered a tone offline, sum ' + sample.toFixed(6));

  // 5. Hardware.
  const hw = { cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory, plugins: navigator.plugins.length };
  parts.push(JSON.stringify(hw));
  log('hardware: ' + JSON.stringify(hw));

  log('\nYour fingerprint ID: ' + await hash(parts.join('|')) + '  (shown here only, not stored or sent)');
}

document.getElementById('go').onclick = () => { document.getElementById('go').disabled = true; fingerprint().catch(e => log('error: ' + e.message)); };
