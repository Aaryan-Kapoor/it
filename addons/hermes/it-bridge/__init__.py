# Copyright (c) 2026 Aaryan Kapoor. Part of It, which is source-available under the It License 1.0.
# The terms are in LICENSE.md beside this add-on.
"""The It add-on for Hermes Agent.

It runs inside Hermes and brings the user's clicks on It pages into the conversation that made
the page:

  - the plain `hermes` terminal: the click starts a turn when the conversation is idle. While a
    turn is running the click waits, because a message sent then would interrupt the turn.
  - the Hermes TUI, the desktop app and the messaging gateway: the click is given to Hermes at
    once, and Hermes itself keeps it until the running turn is over.

It asks the connector on this machine once a second and never holds a request open. Ownership,
retries and receipts live in the connector. Nothing is kept here except which clicks the agent
already has, so that none is handed over twice.
"""

import contextvars
import hashlib
import hmac
import http.client
import io
import json
import os
import re
import secrets
import socket
import threading
import time
from urllib.parse import quote

# Where It keeps its files, when that was somewhere other than the usual folder at the time
# `it setup` put this add-on in place. `it setup` fills it in. The IT_HOME variable comes first.
IT_HOME_AT_SETUP = None

HARNESS = "hermes"
POLL_SECONDS = 1.0  # the connector takes a conversation to be listening if it asked in the last 5 seconds
ASK_SECONDS = 2.0  # how long the connector may stay silent before it is given up on
DEADLINE_SECONDS = 3.0  # how long one question may take from start to finish, however its answer arrives
MOST_BYTES = 256 * 1024  # an answer longer than this, head and all, is not read to its end, and counts as no answer
SETTLE_SECONDS = 1.0  # how long a turn must have been over before a click is handed over, when only the hooks can be seen
REFUSED_SECONDS = 60.0  # how long a conversation is left alone after Hermes would not take a message for it
REFUSED_TIMES = 3  # after this many refusals in a row it is forgotten, until it has another turn
REMEMBERED = 2000  # how many handed-over clicks are remembered
MOST_TALKS = 20  # how many conversations one Hermes process is asked for at once (a gateway may hold hundreds)
_CANNOT_TELL = object()


class _UnixConnection(http.client.HTTPConnection):
    """Plain HTTP over the connector's socket file."""

    def __init__(self, path):
        super().__init__("it", timeout=ASK_SECONDS)
        self._path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self._path)


class _Bounded(io.RawIOBase):
    """What the other end sends, read no later than a deadline and no further than a limit.

    Something that is not the connector may be at the other end, and may send without end, or
    a little at a time for ever. Either would otherwise keep this add-on's one thread reading.
    """

    def __init__(self, sock, deadline):
        super().__init__()
        self._sock = sock
        self._raw = sock.makefile("rb", buffering=0)
        self._deadline = deadline
        self._size = 0

    def readable(self):
        return True

    def readinto(self, buffer):
        # Counted from when the question was asked, and not put off by bytes that keep arriving
        left = self._deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("the answer took too long")
        self._sock.settimeout(min(ASK_SECONDS, left))
        count = self._raw.readinto(buffer) or 0
        self._size += count
        if self._size > MOST_BYTES:
            raise OSError("the answer was too long")
        return count

    def close(self):
        try:
            self._raw.close()
        finally:
            super().close()


class _Answer(http.client.HTTPResponse):
    """An answer whose every byte, from its first line on, is read through `_Bounded`."""

    def __init__(self, sock, deadline, *args, **kwargs):
        super().__init__(sock, *args, **kwargs)
        self.fp.close()
        self.fp = io.BufferedReader(_Bounded(sock, deadline))


def _seal(token, nonce, what):
    """The code that proves a message came from someone who knows the token, without the token being sent."""
    return hmac.new(token.encode("utf-8"), nonce.encode("utf-8") + b"\n" + what, hashlib.sha256).hexdigest()


def _it_home():
    """It's folder: where the IT_HOME variable says, or where it was when the add-on was set up, or the usual place."""
    return os.environ.get("IT_HOME") or (isinstance(IT_HOME_AT_SETUP, str) and IT_HOME_AT_SETUP) or os.path.join(os.path.expanduser("~"), ".it")


def _continues(old, new):
    """Whether Hermes's own record says that the conversation which had one id goes on under the other.

    Hermes gives a conversation a new id when it compresses a long one, and writes down which
    id became which. A new id is also what the terminal shows after /resume, /new and /branch,
    and those are other conversations. So the record is read, the way Hermes's own tools read
    it (tools/process_registry_results.py, _owns_result). If it cannot be read, the answer is no.
    """
    try:
        from hermes_state import SessionDB

        record = SessionDB(read_only=True)
        try:
            return record.get_compression_tip(old) == new
        finally:
            record.close()
    except Exception:
        return False


class _Talk:
    """One conversation in this Hermes process."""

    def __init__(self, session, key):
        # What the conversation's shell commands see as HERMES_SESSION_ID. The `it` command
        # reports that, so it is the id It knows the conversation's pages by. Hermes changes
        # it when it compresses a long conversation.
        self.id = session
        # Hermes's own lasting name for the conversation, which a message to it is addressed
        # by. The plain terminal holds one conversation and has no such name.
        self.key = key
        self.was = []  # ids it had before, which the connector has not been told about yet
        self.running = False  # a turn is in progress, as far as the hooks have said
        self.idle_since = 0.0
        self.closed = False  # Hermes put it away: nothing is asked for it until it has another turn
        self.refused = 0
        self.wait_until = 0.0
        self.seen = 0.0
        self.looked_up = None  # the last other id the terminal showed, which Hermes's record was asked about

    def became(self, session):
        """The same conversation goes on under another id. Its pages follow it, once the connector has been told.

        Every earlier id is kept until the connector has taken it, however many there are: one
        that was dropped would leave the pages made under it with no conversation to go to.
        """
        self.was = [old for old in self.was + [self.id] if old != session]
        self.id = session


def _session_key():
    """Hermes's lasting name for the conversation whose hook is running now, or nothing.

    Hermes binds it around each turn of the TUI, the desktop app and the gateway, and runs
    hooks inside that binding. No hook is handed it directly.
    """
    try:
        from gateway.session_context import get_session_env

        return str(get_session_env("HERMES_SESSION_KEY", "") or "")
    except Exception:
        return ""


class _Bridge:
    def __init__(self, ctx):
        self._ctx = ctx
        self._lock = threading.Lock()
        self._talks = {}  # by key
        self._helpers = {}  # ids of agents a conversation started to help it, which are not conversations
        self._given = {}  # clicks the agent already has, which must never be handed over a second time
        self._connector = None  # (socket file or None, port or None, token), read from the connector's own file
        self._look_again_at = 0.0
        self._thread = None
        self._stop = threading.Event()

    # ---------- the connector ----------

    def _find(self):
        now = time.monotonic()
        if now < self._look_again_at:
            return self._connector
        home = _it_home()
        found = None
        try:
            with open(os.path.join(home, "connector.json"), encoding="utf-8") as file:
                said = json.load(file)
            # Only a token and a port number are taken from the file. The socket is always the
            # one in that same folder, whatever the file says, so nothing in it can point
            # anywhere else.
            path = os.path.join(home, "connector.sock") if isinstance(said.get("socket"), str) and said["socket"] else None
            if path and not hasattr(socket, "AF_UNIX"):
                path = None
            port = said.get("port") if type(said.get("port")) is int and 0 < said["port"] < 65536 else None
            token = said.get("token")
            if isinstance(token, str) and re.fullmatch(r"[0-9a-f]{16,128}", token) and (path or port):
                found = (path, port, token)
        except Exception:
            pass
        self._connector = found
        self._look_again_at = now + (30 if found else 3)
        return found

    def _ask(self, path, body=None):
        """One question to the connector. Its answer, or None if there was none to be believed.

        None is also what an answer comes to that took too long or was too long. That is settled
        before its seal is looked at and before any of it is read as JSON.
        """
        found = self._find()
        if not found:
            return None
        socket_path, port, token = found
        method = "GET" if body is None else "POST"
        sent = b"" if body is None else json.dumps(body).encode("utf-8")
        # Over the socket, which only this user can open, the token is shown. Over a port it never
        # is: the request and the answer are each sealed with it, so a program that took the
        # connector's port after a crash learns nothing, and nothing it answers is believed.
        nonce = secrets.token_hex(16)
        if socket_path:
            connection = _UnixConnection(socket_path)
            proof = {"x-it-token": token}
        else:
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=ASK_SECONDS)
            proof = {"x-it-nonce": nonce, "x-it-mac": _seal(token, nonce, ("%s\n%s\n" % (method, path)).encode("utf-8") + sent)}
        deadline = time.monotonic() + DEADLINE_SECONDS
        connection.response_class = lambda sock, *args, **kwargs: _Answer(sock, deadline, *args, **kwargs)
        try:
            connection.request(method, path, body=sent or None, headers={**proof, "content-type": "application/json"})
            answer = connection.getresponse()
            text = answer.read()
            if answer.status == 401:
                self._look_again_at = 0.0  # the connector restarted: read its file again
            if answer.status != 200 or not text:
                return None
            if not socket_path and not hmac.compare_digest(answer.headers.get("x-it-mac") or "", _seal(token, nonce, b"200\n" + text)):
                return None
            return json.loads(text)
        except Exception:
            self._look_again_at = 0.0
        finally:
            try:
                connection.close()
            except Exception:
                pass
        return None

    # ---------- what Hermes says ----------

    def turn_started(self, session_id="", **_):
        talk = self._note(session_id)
        if talk:
            talk.running = True
        # Nothing is returned: Hermes adds whatever this hook returns to the user's message

    def turn_ended(self, session_id="", **_):
        talk = self._note(session_id)
        if talk:
            talk.running = False
            talk.idle_since = time.monotonic()

    def conversation_closed(self, session_id="", **_):
        with self._lock:
            for talk in self._talks.values():
                if talk.id == session_id:
                    talk.closed = True

    def helper_started(self, child_session_id="", **_):
        # An agent started by a conversation fires the same hooks, under an id of its own and
        # inside its parent's binding. It must not be taken for the conversation changing id.
        if isinstance(child_session_id, str) and child_session_id:
            with self._lock:
                self._helpers[child_session_id] = True
                if len(self._helpers) > 1000:
                    for old in list(self._helpers)[:500]:
                        del self._helpers[old]

    def _note(self, session):
        """The conversation a hook spoke for, which from now on is asked about. None if it is not one."""
        if not isinstance(session, str) or not session:
            return None
        key = _session_key()
        with self._lock:
            if session in self._helpers:
                return None
            talk = next((t for t in self._talks.values() if t.id == session), None)
            before = None if talk is not None else self._talks.get(key)
        if talk is None:
            if not key and self._terminal() is None:
                return None  # outside the terminal, a message can only go to a conversation with a name
            # An id not seen before, where another conversation was: in the same terminal, or
            # under the same name. Only if Hermes's record says that the one became the other is
            # it the same conversation, whose pages follow it. A conversation Hermes has put
            # away is never taken up again under another id. Asked outside the lock, since it
            # reads a file of Hermes's.
            same = before is not None and not before.closed and _continues(before.id, session)
            with self._lock:
                if same and self._talks.get(key) is before:
                    # Commands run from here on report the new id, and pages made under the old one follow it
                    before.became(session)
                    talk = before
                else:
                    # Another conversation has taken its place (/resume, /new, /branch). The one
                    # that was here keeps its pages: the connector is not told that it became
                    # this one, and its clicks wait until it is open again.
                    talk = self._talks[key] = _Talk(session, key)
        with self._lock:
            talk.closed = False
            talk.seen = time.monotonic()
            if len(self._talks) > MOST_TALKS:
                oldest = min(self._talks.values(), key=lambda t: t.seen)
                del self._talks[oldest.key]
            if self._thread is None and not self._stop.is_set():
                # Started inside a context of its own, so that it never carries along the
                # bindings of whichever conversation's hook happened to start it
                self._thread = threading.Thread(target=contextvars.Context().run, args=(self._run,), name="it-bridge", daemon=True)
                self._thread.start()
        return talk

    # ---------- what can be seen of Hermes ----------
    #
    # Hermes hands a message to the terminal if this process is one, and otherwise to the TUI or
    # the gateway by the conversation's name, if the person allowed this add-on to do that
    # (hermes_cli/plugins.py, inject_message). The three looks below read the same things Hermes
    # reads there, to avoid taking a click that could not be handed over, or handing one over in
    # the middle of a turn. They are looks at Hermes's insides, so each one may fail on a later
    # Hermes, and each then falls back to what is safe.

    def _terminal(self):
        """The terminal interface if this process is one, None if it is not, _CANNOT_TELL if this Hermes does not show it."""
        try:
            return self._ctx._manager._cli_ref
        except Exception:
            return _CANNOT_TELL

    def _reachable(self, talk):
        """Whether a message handed to Hermes now would reach this conversation."""
        terminal = self._terminal()
        if terminal is _CANNOT_TELL:
            # By its name a message can only reach the conversation of that name. Without one it
            # would go to whichever conversation a terminal has open, and which that is cannot be told.
            return bool(talk.key)
        if terminal is not None:
            # A run that answers one question and exits takes a message and never reads it
            if os.environ.get("HERMES_SINGLE_QUERY_SESSION") == "1" or getattr(terminal, "_single_query_mode", False) is True:
                return False
            # The terminal puts a message into whichever conversation it has open at that moment
            # (hermes_cli/plugins.py, inject_message), and after /resume or /new that is another
            # one. It keeps the id of the open one in `session_id`. If that is not this
            # conversation's, or cannot be read, nothing is handed over.
            if getattr(terminal, "session_id", None) != talk.id:
                return False
            # Something the person typed may be waiting its turn in the terminal, and it may be
            # a command that goes to another conversation. A click put behind it would follow
            # it there. So a click is only handed over when nothing is waiting; if that cannot
            # be told, the click waits too.
            waiting = getattr(terminal, "_pending_input", None)
            try:
                return waiting is not None and waiting.empty()
            except Exception:
                return False
        if not talk.key:
            return False
        try:
            manager = self._ctx._manager
            if not self._ctx._gateway_injection_allowed():
                return False
            return bool(getattr(manager, "has_tui_message_injector", False) or getattr(manager, "has_gateway_message_injector", False))
        except Exception:
            return True

    def _catch_up(self, talk):
        """Follows a conversation that the terminal compressed between two turns.

        No hook says so until its next turn, and a click may be what starts that turn. The
        terminal shows the new id, and Hermes's record says whether it is the same conversation
        going on. Each id the terminal shows is looked up until the record says so, or five times.
        """
        terminal = self._terminal()
        if terminal is None or terminal is _CANNOT_TELL or talk.key or talk.closed:
            return
        showing = getattr(terminal, "session_id", None)
        if not isinstance(showing, str) or not showing or showing == talk.id or showing == talk.looked_up:
            return
        if _continues(talk.id, showing):
            talk.looked_up = showing
            with self._lock:
                if self._talks.get(talk.key) is talk and not talk.closed:
                    talk.became(showing)
            return
        # Hermes may not have written its record down yet. The id is asked about a few more
        # times before it is taken for another conversation.
        talk.lookups = getattr(talk, "lookups", 0) + 1 if getattr(talk, "asking_about", None) == showing else 1
        talk.asking_about = showing
        if talk.lookups >= 5:
            talk.looked_up = showing

    def _busy(self, talk):
        """Whether a message handed over now would interrupt a turn."""
        terminal = self._terminal()
        if terminal is None:
            return False  # the TUI, the desktop app and the gateway keep it until the turn is over
        running = None if terminal is _CANNOT_TELL else getattr(terminal, "_agent_running", None)
        if isinstance(running, bool):
            return running  # exactly what Hermes looks at to choose between queueing and interrupting
        return talk.running or time.monotonic() - talk.idle_since < SETTLE_SECONDS

    # ---------- asking, handing over, reporting ----------

    def stop(self):
        self._stop.set()

    def _run(self):
        while not self._stop.wait(POLL_SECONDS):
            with self._lock:
                talks = list(self._talks.values())
            for talk in talks:
                try:
                    self._check(talk)
                except Exception:
                    pass  # nothing here may stop the asking, or reach Hermes

    def _check(self, talk):
        # A conversation is only asked about while a click could be handed to it. Asking tells
        # the connector that it is listening, and the connector then sets its clicks aside
        # for this add-on, where nothing else (`it wait`, the site) can have them.
        self._catch_up(talk)
        if talk.closed or time.monotonic() < talk.wait_until or not self._reachable(talk):
            return
        while True:
            with self._lock:
                session = talk.id
                old = talk.was[0] if talk.was else None
            if old is None:
                break
            # Asked for under the new id only once the connector knows the old one became it
            if self._ask("/session", {"harness": HARNESS, "session": session, "was": old}) is None:
                return
            with self._lock:
                if talk.was[:1] == [old]:
                    talk.was.pop(0)

        answer = self._ask("/clicks?harness=%s&session=%s" % (HARNESS, quote(session, safe="")))
        offered = answer.get("clicks") if isinstance(answer, dict) else None
        if not isinstance(offered, list):
            return
        # The connector offers a click on every asking until it is told the agent has it. So
        # what it offers now is all there is to hand over, and nothing is kept here between askings.
        clicks = [c for c in offered if isinstance(c, dict) and isinstance(c.get("id"), str) and c["id"] and isinstance(c.get("text"), str) and c["text"]]
        with self._lock:
            again = [c["id"] for c in clicks if c["id"] in self._given]
            fresh = [c for c in clicks if c["id"] not in self._given]
        # Offered something the agent already has: the earlier report of it was lost, so it is sent again
        if again:
            self._ask("/ack", {"ids": again})
        if not fresh or self._busy(talk):
            return
        with self._lock:
            if talk.closed or talk.id != session:
                return
        # The person may have gone to another conversation while the connector was answering
        if not self._reachable(talk):
            return
        try:
            # The connector's own wording, as it is: it names each click so a repeat can be told apart
            text = "\n".join(c["text"] for c in fresh)
            # By name only where there is a name. In the terminal there is none, and an older
            # Hermes does not know the word for it at all.
            taken = (self._ctx.inject_message(text, session_key=talk.key) if talk.key else self._ctx.inject_message(text)) is True
        except Exception:
            taken = False
        if not taken:
            # Hermes would not take it, so the agent does not have it and nothing is reported.
            # The conversation is left alone for a while, which lets the connector give the
            # click to something else that is listening.
            talk.refused += 1
            talk.wait_until = time.monotonic() + REFUSED_SECONDS
            if talk.refused >= REFUSED_TIMES:
                with self._lock:
                    if self._talks.get(talk.key) is talk:
                        del self._talks[talk.key]
            return
        talk.refused = 0
        with self._lock:
            for c in fresh:
                self._given[c["id"]] = True
            if len(self._given) > REMEMBERED:
                for old in list(self._given)[: REMEMBERED // 2]:
                    del self._given[old]
        # The agent has these now. If this report is lost, the connector offers them again and is told again.
        self._ask("/ack", {"ids": [c["id"] for c in fresh]})


def register(ctx):
    """Called by Hermes when it loads the add-on, in every Hermes program on the machine."""
    # The commands the agent runs are told where It's folder is too, when it is not the usual
    # place: the `it` command they run must use the same one as this add-on
    if not os.environ.get("IT_HOME") and isinstance(IT_HOME_AT_SETUP, str) and IT_HOME_AT_SETUP:
        os.environ["IT_HOME"] = IT_HOME_AT_SETUP
    bridge = _Bridge(ctx)
    # Nothing is asked of the connector, and no thread runs, until a conversation has a turn
    ctx.register_hook("pre_llm_call", bridge.turn_started)
    ctx.register_hook("on_session_end", bridge.turn_ended)
    ctx.register_hook("on_session_finalize", bridge.conversation_closed)
    ctx.register_hook("subagent_start", bridge.helper_started)
    if callable(getattr(ctx, "on_unload", None)):
        ctx.on_unload(bridge.stop)
