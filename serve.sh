#!/bin/sh
# Serve the app on http://localhost:8125 (ES modules need http://, not file://).
# Every response carries Cache-Control: no-store, so an edited stylesheet or
# module shows on the next reload — without it the browser keeps serving its
# heuristically cached copy of ui-kit/*.css and src/*.js for hours.
#
# It also answers two API calls the page uses for Microsoft Project files,
# which a browser cannot read on its own (tools/mpp2xml.sh does the work):
#   GET  /api/status                       {"converter": true|false}
#   POST /api/convert?name=in.mpp&to=xml   body: the file → the converted file
PORT="${1:-8125}"
cd "$(dirname "$0")" || exit 1
echo "Project Planner → http://localhost:$PORT"
exec python3 - "$PORT" <<'PY'
import sys, os, json, subprocess, tempfile, shutil, re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

SCRIPT = os.path.join(os.getcwd(), 'tools', 'mpp2xml.sh')
MIME = {'xml': 'application/xml', 'mpx': 'text/plain', 'planner': 'application/xml', 'xer': 'text/plain', 'json': 'application/json', 'pmxml': 'application/xml', 'sdef': 'text/plain'}

def converter_ready():
    return os.path.exists(SCRIPT) and (os.path.exists(os.path.join(os.getcwd(), 'tools', 'jre', 'Contents', 'Home', 'bin', 'java')) or shutil.which('java'))

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if '/api/' in (args[0] if args else ''): super().log_message(fmt, *args)

    def reply(self, code, body, ctype='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode() if ctype == 'application/json' else body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if urlparse(self.path).path == '/api/status':
            return self.reply(200, {'converter': bool(converter_ready())})
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != '/api/convert':
            return self.reply(404, {'error': 'no such call'})
        q = parse_qs(u.query)
        name = re.sub(r'[^A-Za-z0-9._-]', '_', q.get('name', ['input'])[0]) or 'input'
        to = re.sub(r'[^a-z]', '', q.get('to', ['xml'])[0].lower()) or 'xml'
        if not converter_ready():
            return self.reply(503, {'error': 'The converter is not installed. Run tools/setup-converter.sh to fetch MPXJ and a Java runtime.'})
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n)
        work = tempfile.mkdtemp(prefix='pp-convert-')
        try:
            src = os.path.join(work, name if '.' in name else name + '.bin')
            dst = os.path.join(work, 'out.' + to)
            with open(src, 'wb') as f: f.write(body)
            r = subprocess.run([SCRIPT, src, dst], capture_output=True, text=True, timeout=180)
            if r.returncode != 0 or not os.path.exists(dst):
                msg = (r.stderr or r.stdout).strip().splitlines()
                return self.reply(422, {'error': 'MPXJ could not read that file.', 'detail': '\n'.join(msg[-12:])})
            with open(dst, 'rb') as f: out = f.read()
            return self.reply(200, out, MIME.get(to, 'application/octet-stream'))
        except subprocess.TimeoutExpired:
            return self.reply(504, {'error': 'The conversion took too long.'})
        finally:
            shutil.rmtree(work, ignore_errors=True)

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
PY
