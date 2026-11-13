# Runs a program in a terminal of its own, as a person's terminal window runs it, for a test
# that has none: what the program shows comes out on standard output as the terminal was given
# it, and what comes in on standard input is typed into the terminal. The few questions a
# program asks of the terminal it is in (where the cursor is, its colours, what kind of
# terminal it is) are answered here, as a terminal answers them, since nothing else would.
#
#   python3 terminal.py <columns> <rows> <program> [arguments...]
#
# It ends when the program does, with the program's own exit status.
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

columns, rows, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))

ANSWERS = [
    (b'\x1b[6n', b'\x1b[1;1R'),
    (b'\x1b]10;?', b'\x1b]10;rgb:ffff/ffff/ffff\x1b\\'),
    (b'\x1b]11;?', b'\x1b]11;rgb:0000/0000/0000\x1b\\'),
    (b'\x1b[c', b'\x1b[?62;22c'),
    (b'\x1b[0c', b'\x1b[?62;22c'),
    (b'\x1b[?u', b'\x1b[?0u'),
]


def stop(*_):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
given = sys.stdin.fileno()
watching = [fd, given]
seen = b''
while True:
    try:
        ready, _, _ = select.select(watching, [], [], 0.5)
    except InterruptedError:
        continue
    if fd in ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        os.write(sys.stdout.fileno(), chunk)
        # A question may be cut between two reads, so the end of the last one is kept with it
        seen = seen[-16:] + chunk
        for asked, answer in ANSWERS:
            if asked in seen:
                os.write(fd, answer)
        seen = seen if not any(asked in seen for asked, _ in ANSWERS) else b''
    if given in ready:
        typed = os.read(given, 65536)
        if typed:
            os.write(fd, typed)
        else:
            watching = [fd]
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else 0)
