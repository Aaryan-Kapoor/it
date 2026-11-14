# terminal.py for Windows, which has no pty module: the program runs in a pseudo console of
# Windows's own (ConPTY), as Windows Terminal runs one, through pywinpty
# (`pip install pywinpty`). What the program shows comes out on standard output as the console
# gave it, and what comes in on standard input is typed into the console. The questions a
# program asks of its terminal are answered by the pseudo console itself.
#
#   python terminal-windows.py <columns> <rows> <program> [arguments...]
#
# It ends when the program does, with the program's own exit status.
import os
import sys
import threading

from winpty import PtyProcess

columns, rows, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
env = dict(os.environ)
env['TERM'] = 'xterm-256color'
proc = PtyProcess.spawn(argv, cwd=os.getcwd(), env=env, dimensions=(rows, columns))
out = sys.stdout.buffer


def typed():
    # What comes in is typed into the console as it comes, until it ends
    while True:
        try:
            chunk = os.read(sys.stdin.fileno(), 4096)
        except OSError:
            return
        if not chunk:
            return
        try:
            proc.write(chunk.decode('utf-8', 'replace'))
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
