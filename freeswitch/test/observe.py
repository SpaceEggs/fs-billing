#!/usr/bin/env python3
"""记录授权号码和 SIP 时刻，不保存 HTTP 密钥。仅用于 Linux 回环测试。"""
import json
import os
import socket
import struct
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
log_path = os.environ.get('EVENT_LOG', '/logs/events.jsonl')


def record(event):
    event['at'] = time.monotonic()
    with lock, open(log_path, 'a', encoding='utf-8') as output:
        output.write(json.dumps(event) + '\n')


# AF_PACKET 可以在 carrier 端口已被 SIPp 占用时观测 INVITE，不改变 SIP 路由。
sniffer = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0800))
sniffer.bind(('lo', 0))


def capture():
    seen = set()
    while True:
        packet = sniffer.recv(65535)
        if len(packet) < 42 or packet[23] != 17:
            continue
        ip_header_size = (packet[14] & 15) * 4
        udp_offset = 14 + ip_header_size
        if len(packet) < udp_offset + 8:
            continue
        _, port = struct.unpack('!HH', packet[udp_offset:udp_offset + 4])
        if port not in (5060, 5090):
            continue
        payload = packet[udp_offset + 8:].decode('utf-8', errors='replace')
        if not payload.startswith('INVITE '):
            continue
        lines = payload.split('\r\n')
        headers = dict(line.split(':', 1) for line in lines[1:] if ':' in line)
        call_id = next((v.strip() for k, v in headers.items() if k.lower() in ('call-id', 'i')), '')
        identity = (port, call_id, lines[0])
        if identity in seen:
            continue
        seen.add(identity)
        record({'kind': 'invite', 'port': port, 'call_id': call_id, 'request': lines[0]})


class Relay(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200 if self.path == '/health' else 404)
        self.end_headers()

    def do_POST(self):
        if self.path != '/authorize':
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        value = json.loads(body)
        record({'kind': 'authorize', 'tenant': value.get('tenant'),
                'callee': value.get('callee'), 'uuid': value.get('uuid')})
        request = urllib.request.Request(
            'http://127.0.0.1:3001/authorize', data=body,
            headers={'Content-Type': 'application/json',
                     'X-Billing-Key': self.headers.get('X-Billing-Key', '')})
        try:
            response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=2)
        except urllib.error.HTTPError as error:
            response = error
        except urllib.error.URLError:
            self.send_error(503)
            return
        with response:
            result = response.read()
            self.send_response(response.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(result)))
            self.end_headers()
            self.wfile.write(result)


threading.Thread(target=capture, daemon=True).start()
ThreadingHTTPServer(('127.0.0.1', 3004), Relay).serve_forever()
