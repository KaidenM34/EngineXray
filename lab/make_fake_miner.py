# Builds fake-miner.wasm: a valid WebAssembly module with NO code at all. Its only content is a data segment holding
# the crypto tables and text a real CryptoNight browser miner carries (Keccak round constants, the AES S-box, the
# BLAKE-256 initial values, miner function names and a pool address). It can't hash or mine anything: it exists so
# EngineX-ray's miner detector has something realistic to find.
import pathlib, struct


def leb(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def section(sid, payload):
    return bytes([sid]) + leb(len(payload)) + payload


keccak_rc = [0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B]
aes_sbox_start = bytes([0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5, 0x30, 0x01, 0x67, 0x2B, 0xFE, 0xD7, 0xAB, 0x76])
blake256_iv = struct.pack('<8I', 0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19)
texts = [b'cryptonight_hash', b'cn_slow_hash', b'groestl', b'skein', b'jh256', b'getHashesPerSecond',
         b'stratum+tcp://pool.fake-xmr.test:3333', b'{"method":"login","params":{"login":"FAKE-WALLET"}}']

data = bytearray()
def put(blob, align=16):
    while len(data) % align:
        data.append(0)
    data.extend(blob)

data.extend(b'\0' * 16)
put(b''.join(struct.pack('<Q', rc) for rc in keccak_rc))
put(aes_sbox_start)
put(blake256_iv)
for t in texts:
    put(t + b'\0', align=4)

module = b'\0asm' + struct.pack('<I', 1)
module += section(5, leb(1) + b'\x00' + leb(1))                                  # memory: 1 page (64 KB)
module += section(7, leb(1) + leb(6) + b'memory' + b'\x02' + leb(0))             # export it as "memory"
module += section(11, leb(1) + b'\x00\x41\x00\x0b' + leb(len(data)) + bytes(data))  # one data segment at address 0
out = pathlib.Path(__file__).with_name('fake-miner.wasm')
out.write_bytes(module)
print(f'wrote {out.name}: {len(module)} bytes (data only, no code)')
