// Test range: imitates a browser miner's behaviour. The wasm has no code (see make_fake_miner.py), the workers sleep,
// and the "pool" is lab/server.py on this computer. Nothing here does any hashing.
const log = msg => { document.getElementById('log').textContent += '\n' + msg; };

WebAssembly.instantiateStreaming(fetch('fake-miner.wasm')).then(({ instance }) => {
  log(`fake-miner.wasm loaded: ${instance.exports.memory.buffer.byteLength / 1024} KB of memory, 0 functions.`);
}).catch(e => log('Could not load the wasm: ' + e.message));

document.getElementById('go').onclick = () => {
  document.getElementById('go').disabled = true;
  const cores = navigator.hardwareConcurrency || 4;
  for (let i = 0; i < cores; i++) new Worker('miner-worker.js');
  log(`Started ${cores} workers (one per CPU core). They only sleep.`);

  const pool = new WebSocket(`ws://${location.host}/stratum`);
  pool.onopen = () => {
    pool.send(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'login', params: { login: 'FAKE-WALLET-ADDRESS', pass: 'x', agent: 'fake-miner/1.0' } }));
    log('Connected to the fake pool, sent "login".');
  };
  pool.onmessage = e => {
    log('Pool replied: ' + e.data);
    const msg = JSON.parse(e.data);
    if (msg.result?.job) setTimeout(() => {
      pool.send(JSON.stringify({ id: 2, jsonrpc: '2.0', method: 'submit', params: { id: 'fake-worker-1', job_id: msg.result.job.job_id, nonce: '00000000', result: '00'.repeat(32) } }));
      log('Sent a made-up "submit".');
    }, 800);
  };
  pool.onerror = () => log('Pool connection failed (is lab/server.py running?)');
};
