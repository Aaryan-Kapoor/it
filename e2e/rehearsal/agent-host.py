# The terminal of a person signed in as another Windows account: started as that account (by
# start-as.ps1), it holds a pseudo console of Windows's own (ConPTY, through pywinpty) with a
# shell in it, and relays it to the harness over one TCP connection on 127.0.0.1.
#
#   python agent-host.py            (with IT_HOST_PORT and IT_HOST_KEY in its environment)
#
# The first line the harness sends is JSON: {"key", "argv", "cwd", "cols", "rows", "files"}.
# The connection is refused unless `key` is IT_HOST_KEY, which only the harness knows. `files`
# are the sign-ins lent to this run ({"path", "content"}): each is made empty, closed to every
# account but this one, and only then written. After that line, what the harness sends is typed
# into the console, except a line beginning with the byte 0x01 ("\x01resize <cols> <rows>" or
# "\x01shred"), and what the console shows is sent back as it comes. When the shell ends or the
# harness goes, every file it wrote is overwritten and deleted. Nothing of a file is printed.
import hmac
import json
import os
import secrets
import socket
import subprocess
import sys
import threading

sys.path.insert(0, os.environ.pop('IT_REHEARSAL_PYPATH', ''))
from winpty import PtyProcess  # noqa: E402

PORT = int(os.environ.pop('IT_HOST_PORT'))
KEY = os.environ.pop('IT_HOST_KEY')
USER = os.environ.get('USERNAME', '')
written = []
lock = threading.Lock()


LOG = os.environ.pop('IT_HOST_LOG', '')


def log(text):
    try:
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(text + '\n')
    except Exception:
        pass


def only_mine(path):
    r = subprocess.run(['icacls', path, '/inheritance:r', '/grant:r', USER + ':(F)'], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError('the file could not be closed to all but ' + USER)
    shown = subprocess.run(['icacls', path], capture_output=True, text=True).stdout
    granted = [l.replace(path, '').strip() for l in shown.splitlines() if l.strip() and not l.startswith('Successfully')]
    exact = (os.environ.get('COMPUTERNAME', '') + '\\' + USER + ':(F)').lower()
    if len(granted) != 1 or granted[0].lower() != exact:
        raise RuntimeError('the file is open to more than ' + USER)


def put(path, content, secret=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        shred(path)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    if secret:
        # Only a file that holds a sign-in is closed to all but this account and shredded at the end
        with lock:
            written.append(path)
        only_mine(path)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())


def shred(path):
    try:
        if os.path.exists(path):
            size = max(os.path.getsize(path), 64)
            with open(path, 'r+b') as f:
                f.write(secrets.token_bytes(size))
                f.flush()
                os.fsync(f.fileno())
            os.remove(path)
    except Exception:
        try:
            os.remove(path)
        except Exception:
            pass
    return not os.path.exists(path)


def shred_all():
    with lock:
        paths = list(written)
        written.clear()
    ok = True
    for p in paths:
        ok = shred(p) and ok
    log('shredded %d file(s): %s' % (len(paths), 'all gone' if ok else 'SOME LEFT'))
    return ok


server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.bind(('127.0.0.1', PORT))
server.listen(1)
log('listening on 127.0.0.1:%d as %s, profile %s' % (PORT, USER, os.environ.get('USERPROFILE')))
server.settimeout(300)
conn, _ = server.accept()
server.close()
conn.settimeout(60)


def line_from(conn, buf):
    while b'\n' not in buf:
        chunk = conn.recv(65536)
        if not chunk or len(buf) > 1 << 20:
            raise RuntimeError('no line')
        buf += chunk
    first, rest = buf.split(b'\n', 1)
    return first, rest


try:
    # First the harness asks this host to prove that it knows the key, before it sends any secret
    first, rest = line_from(conn, b'')
    nonce = json.loads(first.decode('utf-8')).get('nonce', '')
    conn.sendall((hmac.new(KEY.encode(), str(nonce).encode(), 'sha256').hexdigest() + '\n').encode())
    first, rest = line_from(conn, rest)
    hello = json.loads(first.decode('utf-8'))
    first = None
except Exception:
    log('a connection did not finish the handshake')
    conn.close()
    sys.exit(1)
if not hmac.compare_digest(str(hello.get('key', '')), KEY):
    log('refused a connection with the wrong key')
    conn.close()
    sys.exit(1)
conn.settimeout(None)
proc = None
try:
    for f in hello.get('files', []):
        put(f['path'], f['content'], f.get('secret', True) is not False)
    hello['files'] = None
    env = dict(os.environ)
    # What the shell is given beyond the account's own environment, such as a lent access token
    env.update({str(k): str(v) for k, v in (hello.get('env') or {}).items()})
    hello['env'] = None
    env['TERM'] = 'xterm-256color'
    proc = PtyProcess.spawn(hello['argv'], cwd=hello.get('cwd') or os.environ.get('USERPROFILE'), env=env, dimensions=(int(hello['rows']), int(hello['cols'])))
    log('started %s, pid %s' % (hello['argv'][0], proc.pid))
except Exception as e:
    log('could not start: %s' % type(e).__name__)
    shred_all()
    conn.close()
    sys.exit(1)


def typed(pending):
    data = pending
    while True:
        if data:
            text = data.decode('utf-8', 'replace')
            if text.startswith('\x01'):
                line = text.strip()
                if line.startswith('\x01resize '):
                    try:
                        _, c, r = line.split()
                        proc.setwinsize(int(r), int(c))
                    except Exception:
                        pass
                elif line == '\x01shred':
                    shred_all()
            else:
                try:
                    proc.write(text)
                except Exception:
                    return
        try:
            data = conn.recv(65536)
        except OSError:
            data = b''
        if not data:
            # The harness is gone: the shell goes with it
            try:
                proc.terminate(force=True)
            except Exception:
                pass
            return


try:
    threading.Thread(target=typed, args=(rest,), daemon=True).start()
    while True:
        try:
            shown = proc.read(65536)
        except EOFError:
            break
        if shown:
            try:
                conn.sendall(shown.encode('utf-8', 'replace'))
            except OSError:
                break
        elif not proc.isalive():
            break
finally:
    shred_all()
    try:
        conn.close()
    except Exception:
        pass
log('ended')
