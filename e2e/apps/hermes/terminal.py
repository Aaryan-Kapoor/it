# A terminal for a program that will run only in one, such as the plain `hermes` terminal, for a
# test to type into and read. It uses nothing but Python's own library.
#
#   python3 -I terminal.py <file the screen is written to> <program> [arguments...]
#
# The program is started in a pseudo-terminal of 120 columns by 40 rows. Everything it writes is
# appended to the file as it comes, escapes and all. Each line read on this script's own input is
# typed into the terminal as a person types it: its characters, a short pause, and Enter. A line
# that is `\x04` alone is sent as Ctrl-D, and `\x03` as Ctrl-C. When this script's input ends, or
# the program exits, the program is given Ctrl-D, then a hang-up, and is waited for; this script
# exits with the program's code.
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: terminal.py <screen file> <program> [arguments...]\n")
        return 2
    screen_path, argv = sys.argv[1], sys.argv[2:]
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        finally:
            os._exit(127)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    os.kill(pid, signal.SIGWINCH)
    screen = open(screen_path, "ab", buffering=0)
    typed = sys.stdin.buffer
    pending = b""
    open_input = True
    code = None

    def type_line(line):
        if line == b"\\x04":
            os.write(fd, b"\x04")
            return
        if line == b"\\x03":
            os.write(fd, b"\x03")
            return
        # A person's typing: the program's line editor may treat a burst that ends in Enter as a paste
        for start in range(0, len(line), 16):
            os.write(fd, line[start : start + 16])
            time.sleep(0.02)
        time.sleep(0.3)
        os.write(fd, b"\r")

    while code is None:
        watched = [fd] + ([typed] if open_input else [])
        try:
            ready, _, _ = select.select(watched, [], [], 0.2)
        except InterruptedError:
            ready = []
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if data:
                screen.write(data)
            else:
                ready = [r for r in ready if r is not fd]
        if open_input and typed in ready:
            chunk = os.read(typed.fileno(), 65536)
            if not chunk:
                open_input = False
                break
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                type_line(line.rstrip(b"\r"))
        finished, status = os.waitpid(pid, os.WNOHANG)
        if finished:
            code = os.waitstatus_to_exitcode(status)
    if code is None:
        # Asked to stop: the program is closed as a person closes it, and then hung up on
        for ask in (lambda: os.write(fd, b"\x04"), lambda: os.kill(pid, signal.SIGHUP), lambda: os.kill(pid, signal.SIGKILL)):
            try:
                ask()
            except OSError:
                pass
            end = time.monotonic() + 10
            while time.monotonic() < end:
                try:
                    if select.select([fd], [], [], 0.2)[0]:
                        data = os.read(fd, 65536)
                        if data:
                            screen.write(data)
                except OSError:
                    pass
                finished, status = os.waitpid(pid, os.WNOHANG)
                if finished:
                    code = os.waitstatus_to_exitcode(status)
                    break
            if code is not None:
                break
    screen.close()
    return code if code is not None and code >= 0 else 1


if __name__ == "__main__":
    sys.exit(main())
