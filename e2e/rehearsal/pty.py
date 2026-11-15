# Runs a program in a pseudo console of Windows's own (ConPTY, through pywinpty), as a terminal
# window runs it: what it shows comes out on standard output as the console gives it, and what
# comes in on standard input is typed into the console. A line on standard input that begins
# with the byte 0x01 followed by "resize <cols> <rows>" resizes the console instead.
#
#   python -I pty.py <columns> <rows> <program> [arguments...]
#
# pywinpty is found in the folder IT_REHEARSAL_PYPATH names, and that variable is taken out of
# what the program is given. It ends when the program does, with the program's exit status.
import os
import sys
import threading

sys.path.insert(0, os.environ.pop('IT_REHEARSAL_PYPATH', ''))
from winpty import PtyProcess  # noqa: E402

columns, rows, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
env = dict(os.environ)
env['TERM'] = 'xterm-256color'
proc = PtyProcess.spawn(argv, cwd=os.getcwd(), env=env, dimensions=(rows, columns))
out = sys.stdout.buffer


def typed():
    while True:
        try:
            chunk = os.read(sys.stdin.fileno(), 65536)
        except OSError:
            return
        if not chunk:
            return
        text = chunk.decode('utf-8', 'replace')
        if text.startswith('\x01resize '):
            try:
                _, c, r = text.strip().split()
                proc.setwinsize(int(r), int(c))
            except Exception:
                pass
            continue
        try:
            proc.write(text)
        except Exception:
            return


threading.Thread(target=typed, daemon=True).start()
while True:
    try:
        shown = proc.read(65536)
    except EOFError:
        break
    if shown:
        out.write(shown.encode('utf-8', 'replace'))
        out.flush()
    elif not proc.isalive():
        break
proc.wait()
sys.exit(proc.exitstatus or 0)
