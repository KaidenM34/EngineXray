# EngineX-ray test range: serves this folder on http://127.0.0.1:<port> and plays a fake mining pool on
# ws://127.0.0.1:<port>/stratum, so the Security tab's "talks the mining protocol" check can be shown working.
# Loopback only. The "pool" answers a login with a made-up job and accepts made-up submits. Nothing is mined.
import base64, hashlib, http.server, json, os, struct, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
os.chdir(os.path.dirname(os.path.abspath(__file__)))
WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


def ws_read(sock):
    head = sock.recv(2)
    if len(head) < 2:
        return None
    opcode, n = head[0] & 0x0F, head[1] & 0x7F
    if n == 126:
        n = struct.unpack('>H', sock.recv(2))[0]
    elif n == 127:
        n = struct.unpack('>Q', sock.recv(8))[0]
    mask = sock.recv(4) if head[1] & 0x80 else b'\0\0\0\0'
    data = bytearray()
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            return None
        data += chunk
    data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return None if opcode == 8 else data.decode('utf-8', 'replace')


def ws_send(sock, text):
    data = text.encode()
    header = bytes([0x81, len(data)]) if len(data) < 126 else bytes([0x81, 126]) + struct.pack('>H', len(data))
    sock.sendall(header + data)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if self.path.split('?')[0] == '/clean.html':  # the control page gets a strict policy, so it can grade an A
            self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
        super().end_headers()

    def do_POST(self):
        # The fake tracker on shop.html posts here. Whatever it sends is read and thrown away.
        if self.path.startswith('/collect'):
            self.rfile.read(int(self.headers.get('Content-Length') or 0))
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self):
        if self.path.startswith('/stratum') and self.headers.get('Upgrade', '').lower() == 'websocket':
            key = self.headers['Sec-WebSocket-Key']
            accept = base64.b64encode(hashlib.sha1((key + WS_MAGIC).encode()).digest()).decode()
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', accept)
            super().end_headers()
            sock = self.connection
            while True:
                msg = ws_read(sock)
                if msg is None:
                    break
                try:
                    req = json.loads(msg)
                except ValueError:
                    continue
                if req.get('method') == 'login':
                    ws_send(sock, json.dumps({'id': req.get('id'), 'result': {'id': 'fake-worker-1', 'status': 'OK',
                        'job': {'job_id': 'fake-job-1', 'blob': '00' * 38, 'target': 'ffffff00', 'algo': 'cn/r'}}}))
                elif req.get('method') == 'submit':
                    ws_send(sock, json.dumps({'id': req.get('id'), 'result': {'status': 'OK'}}))
            return
        super().do_GET()


print(f'EngineX-ray test range on http://127.0.0.1:{PORT}/')
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
