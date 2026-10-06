"""What the Hermes add-on must do, checked against a stand-in for Hermes and a stand-in for the connector.

Run it from this folder with `python3 -m unittest`. Nothing here starts Hermes or touches a
real Hermes or It folder: the connector is a small HTTP server on a socket file in a temp
folder (or on a port, as on Windows), and Hermes is a class that keeps the few promises the
add-on relies on.
"""

import hashlib
import hmac
import http.server
import importlib.util
import json
import os
import pathlib
import re
import shutil
import socket
import socketserver
import sys
import tempfile
import queue
import threading
import time
import types
import unittest
from urllib.parse import parse_qs, urlsplit

# The CLI's packer copies every file under this folder into the program, so no compiled
# Python may be left here. What Python wrote before this line ran is removed at the end.
sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent

_spec = importlib.util.spec_from_file_location("it_bridge", HERE / "it-bridge" / "__init__.py")
addon = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(addon)

TOKEN = "".join(["0123456789", "abcdef"]) * 3
A = "20261002_101500_ab12cd"
B = "20261002_113000_ef34ab"
# What the connector hands over for a click. The add-on passes it on as it is, whatever it
# says, so these stand for the connector's own words: a page's name, what a click carried, with
# letters outside ASCII and a line break written out, and the click's name at the end.
TEXT = '[It] the connector\'s words for a click on "Deploy plan" (deploy-plan): approve {"env":"prod","note":"línea\\n2"} [action k57abc]'

# Stands in for gateway/session_context.py in Hermes: the name of the conversation whose hook
# is running, and the id its commands are marked with. Hermes binds the name around each turn of
# the TUI, the desktop app and the gateway.
bound = {"HERMES_SESSION_KEY": ""}
# The ids Hermes keeps a conversation under, as its record has them
kept_by_hermes = set()
# The id of a review Hermes runs in the background when a turn has ended. Hermes keeps no conversation under it.
REVIEW = "20261002_101630_5567df"

# Stands in for Hermes's record of conversations (hermes_state.py, SessionDB): which id a
# conversation went on under when Hermes compressed it. Nothing else gives a conversation a
# new id and leaves it the same conversation.
compressed = {}


class Record:
    """As much of SessionDB as the add-on reads, opened the way Hermes's own tools open it for a look."""

    def __init__(self, db_path=None, read_only=False):
        assert read_only, "the add-on only ever reads Hermes's record"

    def get_session(self, session_id):
        return {"id": session_id} if session_id in kept_by_hermes else None

    def get_compression_tip(self, session_id):
        seen = set()
        while session_id in compressed and session_id not in seen:
            seen.add(session_id)
            session_id = compressed[session_id]
        return session_id

    def close(self):
        pass


def setUpModule():
    hermes_side = types.ModuleType("gateway.session_context")
    hermes_side.get_session_env = lambda name, default="": bound.get(name, default)
    sys.modules["gateway"] = types.ModuleType("gateway")
    sys.modules["gateway.session_context"] = hermes_side
    record = types.ModuleType("hermes_state")
    record.SessionDB = Record
    sys.modules["hermes_state"] = record


def tearDownModule():
    sys.modules.pop("gateway.session_context", None)
    sys.modules.pop("gateway", None)
    sys.modules.pop("hermes_state", None)
    for folder in (HERE, HERE / "it-bridge"):
        shutil.rmtree(folder / "__pycache__", ignore_errors=True)


def click(id, text=TEXT):
    return {"id": id, "artifact": "deploy-plan", "title": "Deploy plan", "name": "approve", "payload": {"env": "prod"}, "at": 1, "text": text}


def seal(token, nonce, what):
    """As `mac` in packages/cli/src/connector.ts: HMAC-SHA256 of the nonce, a new line and the message, keyed by the token."""
    return hmac.new(token.encode(), nonce.encode() + b"\n" + what, hashlib.sha256).hexdigest()


def until(what, seconds=5.0):
    """Waits for something to become true, and says whether it did."""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if what():
            return True
        time.sleep(0.01)
    return bool(what())


class Connector:
    """The connector's side of the contract, as packages/cli/src/connector.ts keeps it.

    It listens on a socket file in It's folder, where knowing the token is enough. With
    `port=True` it listens on a port of this machine instead, as it does on Windows, where the
    token is never sent: each request and each answer carries a code made from it.
    """

    def __init__(self, home, token=TOKEN, port=False):
        self.home = home
        self.token = token
        self.log = []  # every request it understood, in order
        self.refused = 0  # requests it did not believe
        self.token_shown = 0  # requests that carried the token itself
        self.offers = {}  # session -> clicks, offered on every asking until the add-on reports them
        self.seals_with = None  # set to another token, it stands for some other program that took the port
        self.padding = 0  # above zero, each click offered is padded by this many characters, past what any real answer holds
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def answer(self, status, body):
                data = json.dumps(body, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                nonce = self.headers.get("x-it-nonce", "")
                if status != 401 and nonce:
                    self.send_header("x-it-mac", seal(outer.seals_with or outer.token, nonce, b"%d\n" % status + data))
                self.end_headers()
                self.wfile.write(data)

            def known(self, sent):
                if "x-it-token" in self.headers:
                    outer.token_shown += 1
                if not outer.port:
                    return self.headers.get("x-it-token") == outer.token
                if outer.seals_with:
                    return True
                nonce, given = self.headers.get("x-it-nonce", ""), self.headers.get("x-it-mac", "")
                if not re.fullmatch(r"[0-9a-f]{16,64}", nonce) or not re.fullmatch(r"[0-9a-f]{64}", given):
                    return False
                return hmac.compare_digest(seal(outer.token, nonce, ("%s\n%s\n" % (self.command, self.path)).encode() + sent), given)

            def do_GET(self):
                if not self.known(b""):
                    outer.refused += 1
                    return self.answer(401, {"error": "not for you"})
                url = urlsplit(self.path)
                query = parse_qs(url.query)
                if url.path != "/clicks":
                    return self.answer(404, {"error": "no such thing"})
                harness, session = query.get("harness", [""])[0], query.get("session", [""])[0]
                outer.log.append(("clicks", harness, session))
                offered = list(outer.offers.get(session, []))
                self.answer(200, {"clicks": [{**c, "title": "x" * outer.padding} for c in offered] if outer.padding else offered})

            def do_POST(self):
                sent = self.rfile.read(int(self.headers.get("content-length", "0")))
                if not self.known(sent):
                    outer.refused += 1
                    return self.answer(401, {"error": "not for you"})
                body = json.loads(sent or b"{}")
                if self.path == "/ack":
                    outer.log.append(("ack", tuple(body["ids"])))
                    for session in outer.offers:
                        outer.offers[session] = [c for c in outer.offers[session] if c["id"] not in body["ids"]]
                    return self.answer(200, {"ok": True, "acked": len(body["ids"])})
                if self.path == "/session":
                    outer.log.append(("session", body["harness"], body["session"], body.get("was")))
                    return self.answer(200, {"ok": True})
                self.answer(404, {"error": "no such thing"})

        if port:
            self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            self.port = self.server.server_address[1]
        else:
            self.server = socketserver.ThreadingUnixStreamServer(os.path.join(home, "connector.sock"), Handler)
            self.port = None
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def write_file(self, text=None):
        where = {"port": self.port} if self.port else {"socket": os.path.join(self.home, "connector.sock")}
        said = json.dumps({**where, "token": self.token, "pid": 1}) if text is None else text
        with open(os.path.join(self.home, "connector.json"), "w", encoding="utf-8") as file:
            file.write(said)

    def offer(self, session, *clicks):
        self.offers[session] = self.offers.get(session, []) + list(clicks)

    def asked(self):
        return [entry[1:] for entry in self.log if entry[0] == "clicks"]

    def acks(self):
        return [entry[1] for entry in self.log if entry[0] == "ack"]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Dribbler:
    """Something that took the connector's port, and answers a little at a time, for ever."""

    def __init__(self):
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen()
        self.port = self.listener.getsockname()[1]
        self.lasted = []  # how long each asker stayed before hanging up
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                link, _ = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self._drip, args=(link,), daemon=True).start()

    def _drip(self, link):
        began = time.monotonic()
        try:
            link.recv(65536)
            # Not even the head of the answer ever ends
            link.sendall(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-more: ")
            while True:
                link.sendall(b"a")
                time.sleep(0.02)
        except OSError:
            pass
        finally:
            self.lasted.append(time.monotonic() - began)
            link.close()

    def close(self):
        self.listener.close()


class Hermes:
    """Stands in for the context Hermes hands a plugin (hermes_cli/plugins.py, PluginContext).

    `inject_message` decides as the real one does: the terminal first, then a named
    conversation if the person allowed it and something in the process can take it.
    """

    def __init__(self, terminal=None, allowed=True, host=True, takes=True):
        self.hooks = {}
        self.unloads = []
        self.messages = []  # (content, role, session_key) of every message Hermes took
        self.interrupted = []  # messages that landed in the middle of a turn in the terminal
        self.tried = 0
        self.allowed = allowed
        self.takes = takes
        self._manager = types.SimpleNamespace(_cli_ref=terminal, has_tui_message_injector=False, has_gateway_message_injector=host)

    def register_hook(self, name, callback):
        self.hooks.setdefault(name, []).append(callback)

    def on_unload(self, callback):
        self.unloads.append(callback)

    def _gateway_injection_allowed(self):
        return self.allowed

    def inject_message(self, content, role="user", *, session_key=None):
        self.tried += 1
        if not self.takes:
            return False
        terminal = self._manager._cli_ref
        if terminal is not None:
            if terminal._agent_running:
                self.interrupted.append(content)
        elif not session_key or not self.allowed or not self._manager.has_gateway_message_injector:
            return False
        self.messages.append((content, role, session_key))
        return True

    def fire(self, name, **kwargs):
        """Calls the add-on's hooks the way Hermes does: by keyword, with more than it asked for."""
        for callback in self.hooks.get(name, []):
            returned = callback(telemetry_schema_version="hermes.observer.v1", **kwargs)
            assert returned is None, "Hermes adds whatever pre_llm_call returns to the user's message"

    def _shown(self):
        """The terminal, if this Hermes is one, whether or not a plugin can still see it."""
        return getattr(getattr(self, "_manager", None) or getattr(self, "_hidden", None), "_cli_ref", None)

    def shows(self, session):
        """The terminal has this conversation open now. It keeps the id of the open one in `session_id`."""
        self._shown().session_id = session

    def resume(self, session):
        """The person goes to another conversation in the same terminal (/resume). No hook says so
        (hermes_cli/cli_commands_mixin.py, _handle_resume_command): the terminal just has another id."""
        self.shows(session)

    def compress(self, old, new):
        """Hermes compresses a conversation, which goes on under a new id. Its record says which
        became which, and the terminal shows the new one. No hook says so."""
        compressed[old] = new
        if self._shown() is not None and self._shown().session_id == old:
            self._shown().session_id = new

    def turn(self, session, running=True):
        self.fire("pre_llm_call", session_id=session, task_id="t", turn_id="turn-1", user_message="hi", conversation_history=[], is_first_turn=False, model="m", platform="cli", parent_session_id="", sender_id="")
        if not running:
            self.fire("on_session_end", session_id=session, task_id="t", turn_id="turn-1", completed=True, failed=False, interrupted=False, turn_exit_reason="done", model="m", platform="cli")


class LaterHermes(Hermes):
    """A Hermes whose insides have changed, so that only the hooks and inject_message are left."""

    def __init__(self):
        super().__init__(terminal=types.SimpleNamespace(_agent_running=False, session_id=None, _pending_input=queue.Queue()))
        self._hidden = self._manager
        del self._manager

    def inject_message(self, content, role="user", *, session_key=None):
        self._manager = self._hidden
        try:
            return super().inject_message(content, role, session_key=session_key)
        finally:
            del self._manager


class Case(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="it-")
        self.kept = {name: os.environ.get(name) for name in ("IT_HOME", "HERMES_SINGLE_QUERY_SESSION")}
        os.environ["IT_HOME"] = self.home
        os.environ.pop("HERMES_SINGLE_QUERY_SESSION", None)
        self.speeds = (addon.POLL_SECONDS, addon.SETTLE_SECONDS, addon.REFUSED_SECONDS)
        addon.POLL_SECONDS, addon.SETTLE_SECONDS, addon.REFUSED_SECONDS = 0.02, 0.05, 0.05
        bound["HERMES_SESSION_KEY"] = ""
        bound.pop("HERMES_SESSION_ID", None)
        kept_by_hermes.clear()
        kept_by_hermes.update({A, B})
        compressed.clear()
        self.connector = Connector(self.home)
        self.connector.write_file()
        self.loaded = []

    def tearDown(self):
        for hermes in self.loaded:
            for unload in hermes.unloads:
                unload()
        self.connector.close()
        addon.POLL_SECONDS, addon.SETTLE_SECONDS, addon.REFUSED_SECONDS = self.speeds
        for name, value in self.kept.items():
            os.environ.pop(name, None) if value is None else os.environ.__setitem__(name, value)
        shutil.rmtree(self.home, ignore_errors=True)

    def load(self, hermes):
        addon.register(hermes)
        self.loaded.append(hermes)
        return hermes

    def terminal(self, running=False, showing=A, **more):
        """A Hermes in the plain terminal, which has one conversation open: A, unless the test says otherwise."""
        return self.load(Hermes(terminal=types.SimpleNamespace(_agent_running=running, session_id=showing, _pending_input=queue.Queue()), **more))

    def a_while(self):
        time.sleep(0.3)  # fifteen askings


class InTheTerminal(Case):
    def test_it_asks_for_the_conversation_its_shell_commands_report(self):
        hermes = self.terminal()
        self.assertEqual(self.connector.log, [], "nothing is asked before a conversation has a turn")
        hermes.turn(A, running=False)
        self.assertTrue(until(lambda: len(self.connector.asked()) >= 3), "it keeps asking, so the connector knows it is listening")
        self.assertEqual(set(self.connector.asked()), {("hermes", A)})
        self.assertEqual(self.connector.refused, 0, "every request carries the token")

    def test_it_hands_over_the_connectors_text_as_it_is_and_reports_it(self):
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.connector.offer(A, click("k57abc"))
        self.assertTrue(until(lambda: self.connector.acks()))
        self.assertEqual(hermes.messages, [(TEXT, "user", None)])
        self.assertEqual(self.connector.acks(), [("k57abc",)])

    def test_clicks_offered_together_go_in_one_message(self):
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.connector.offers[A] = [click("one", "[It] first [action one]"), click("two", "[It] second [action two]")]
        self.assertTrue(until(lambda: self.connector.acks()))
        self.assertEqual(hermes.messages, [("[It] first [action one]\n[It] second [action two]", "user", None)])
        self.assertEqual(self.connector.acks(), [("one", "two")])

    def test_it_holds_a_click_while_a_turn_is_running(self):
        hermes = self.terminal(running=True)
        hermes.turn(A)
        self.connector.offer(A, click("k1"))
        self.a_while()
        self.assertEqual(hermes.tried, 0, "a message now would interrupt the turn")
        self.assertEqual(self.connector.acks(), [])
        self.assertGreater(len(self.connector.asked()), 5, "it goes on asking, so the click stays set aside for it")
        hermes._manager._cli_ref._agent_running = False
        hermes.turn(A, running=False)
        self.assertTrue(until(lambda: self.connector.acks()))
        self.assertEqual([m[0] for m in hermes.messages], [TEXT])
        self.assertEqual(hermes.interrupted, [])

    def test_it_holds_through_the_moment_before_the_hooks_say_a_turn_began(self):
        # The terminal marks a turn as running when the person presses Enter, some time before
        # the first hook of that turn runs
        hermes = self.terminal()
        hermes.turn(A, running=False)
        until(lambda: self.connector.asked())
        hermes._manager._cli_ref._agent_running = True
        self.connector.offer(A, click("k1"))
        self.a_while()
        self.assertEqual(hermes.tried, 0)

    def test_a_click_offered_twice_is_handed_over_once(self):
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.connector.offer(A, click("k1"))
        self.assertTrue(until(lambda: len(self.connector.acks()) == 1))
        # The connector did not get the report, so it offers the click again
        self.connector.offer(A, click("k1"))
        self.assertTrue(until(lambda: len(self.connector.acks()) == 2), "it is reported again")
        self.a_while()
        self.assertEqual(len(hermes.messages), 1, "and not handed over again")
        self.assertEqual(self.connector.acks()[:2], [("k1",), ("k1",)])

    def test_a_click_hermes_would_not_take_is_not_reported(self):
        hermes = self.terminal(takes=False)
        hermes.turn(A, running=False)
        self.connector.offer(A, click("k1"))
        self.assertTrue(until(lambda: hermes.tried >= 1))
        self.a_while()
        self.assertEqual(self.connector.acks(), [])
        self.assertLessEqual(hermes.tried, addon.REFUSED_TIMES, "and after a few tries the conversation is left alone")

    def test_a_click_without_the_connectors_text_is_not_reworded(self):
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.connector.offers[A] = [{"id": "k1", "name": "approve", "payload": {}}]
        self.a_while()
        self.assertEqual(hermes.tried, 0)

    def test_a_compressed_conversation_is_followed_and_the_connector_is_told_before_it_is_asked_for(self):
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.assertTrue(until(lambda: self.connector.asked()))
        compressed[A] = B  # Hermes compresses the conversation during its next turn, which gives it a new id
        hermes.turn(B, running=False)  # the hooks of that turn carry the new id
        hermes.shows(B)  # and the terminal shows it once the turn is over (hermes_cli/cli_chat_turn_mixin.py)
        self.assertTrue(until(lambda: ("hermes", B) in self.connector.asked()))
        log = self.connector.log
        told = log.index(("session", "hermes", B, A))
        self.assertLess(told, log.index(("clicks", "hermes", B)))
        self.assertNotIn(("clicks", "hermes", A), log[told:], "the old id is not asked for any more")
        self.connector.offer(B, click("k1"))
        self.assertTrue(until(lambda: hermes.messages))

    def test_the_id_hermes_marks_commands_with_after_a_turn_is_followed_when_it_is_nobodys(self):
        # When a turn ends Hermes starts a review in the background under an id of its own, and
        # the conversation's commands carry that id from then on. A page made under it is this
        # conversation's, and the connector is told so before the turn runs anything.
        hermes = self.terminal()
        bound["HERMES_SESSION_ID"] = A
        hermes.turn(A, running=False)
        self.assertTrue(until(lambda: self.connector.asked()))
        self.assertNotIn(("session", "hermes", A, A), self.connector.log, "its own id is not told as an earlier one")
        bound["HERMES_SESSION_ID"] = REVIEW
        told = len(self.connector.log)
        hermes.turn(A, running=True)
        self.assertIn(("session", "hermes", A, REVIEW), self.connector.log[told:], "told within the hook itself, before the turn's first command")
        again = len(self.connector.log)
        hermes.turn(A, running=False)
        self.a_while()
        self.assertNotIn(("session", "hermes", A, REVIEW), self.connector.log[again:], "and told once")
        self.assertEqual({asked for asked in self.connector.asked()}, {("hermes", A)}, "it goes on asking for the conversation, never for the review")

    def test_an_id_hermes_keeps_a_conversation_under_is_never_followed(self):
        # After /resume the commands may still carry the conversation the person left. Its pages are its own.
        hermes = self.terminal()
        bound["HERMES_SESSION_ID"] = B
        hermes.turn(A, running=False)
        self.a_while()
        self.assertNotIn(("session", "hermes", A, B), self.connector.log)

    def test_a_mark_that_could_not_be_told_at_once_is_told_before_the_conversation_is_next_asked_for(self):
        talk = addon._Talk(A, "")
        bridge = addon._Bridge(None)
        bridge._catch_up = lambda talk: None
        bridge._reachable = lambda talk: True
        log = []
        there = False

        def ask(route, body=None):
            if not there:
                return None  # the connector cannot be asked
            log.append((route.split("?")[0], body and body.get("was")))
            return {"ok": True, "clicks": []}

        bridge._ask = ask
        bound["HERMES_SESSION_ID"] = REVIEW
        bridge._follow_mark(talk)
        self.assertEqual(talk.was, [REVIEW], "kept, with the conversation's other earlier ids")
        there = True
        bridge._check(talk)
        self.assertEqual(log, [("/session", REVIEW), ("/clicks", None)])
        self.assertEqual(talk.was, [])

    def test_a_conversation_compressed_between_turns_is_followed_without_waiting_for_its_next_turn(self):
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.assertTrue(until(lambda: self.connector.asked()))
        hermes.compress(A, B)  # /compress: no hook says so, and the click may be what starts the next turn
        self.assertTrue(until(lambda: ("session", "hermes", B, A) in self.connector.log))
        self.connector.offer(B, click("k1"))
        self.assertTrue(until(lambda: self.connector.acks()))
        self.assertEqual(hermes.messages, [(TEXT, "user", None)])

    def test_every_id_a_conversation_had_while_the_connector_was_away_is_told_once_it_is_back_however_many_there_were(self):
        ids = ["20261002_%02d0000_aaaaaa" % hour for hour in range(10, 18)]
        talk = addon._Talk(ids[0], None)
        for later in ids[1:]:  # compressed seven times over, and the connector told of none of it
            talk.became(later)
        bridge = addon._Bridge(None)
        bridge._catch_up = lambda talk: None
        bridge._reachable = lambda talk: True
        told = []

        def ask(route, body=None):
            if route == "/session":
                told.append((body["was"], body["session"]))
            return {"ok": True, "clicks": []}

        bridge._ask = ask
        bridge._check(talk)
        self.assertEqual(told, [(old, ids[-1]) for old in ids[:-1]], "the pages made under each earlier id follow the conversation")
        self.assertEqual(talk.was, [])

    def test_a_hermes_whose_terminal_takes_a_message_without_any_name_is_given_one_without(self):
        hermes = self.terminal()
        took = []

        def older(content, role="user"):  # as an earlier Hermes has it: no word for a conversation's name
            took.append(content)
            hermes.messages.append((content, role, None))
            return True

        hermes.inject_message = older
        hermes.turn(A, running=False)
        self.connector.offer(A, click("k1", "[It] for A [action k1]"))
        self.assertTrue(until(lambda: self.connector.acks() == [("k1",)]))
        self.assertEqual(took, ["[It] for A [action k1]"])

    def test_a_click_is_not_put_behind_something_the_person_typed_that_is_still_waiting(self):
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.assertTrue(until(lambda: self.connector.asked()))
        # The person has typed /resume, and the terminal has not yet got to it
        hermes._manager._cli_ref._pending_input.put("/resume other")
        time.sleep(0.1)
        self.connector.offer(A, click("k1", "[It] for A [action k1]"))
        self.a_while()
        self.assertEqual(hermes.tried, 0, "a click put behind it would follow it into the other conversation")
        # Nothing is waiting any more, and the terminal still has this conversation open
        hermes._manager._cli_ref._pending_input.get_nowait()
        self.assertTrue(until(lambda: self.connector.acks() == [("k1",)]))

    def test_a_click_is_not_given_to_another_conversation_the_person_went_to(self):
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.assertTrue(until(lambda: self.connector.asked()))
        hermes.resume(B)  # /resume: the terminal now has another conversation open, and no hook has said so
        time.sleep(0.1)
        asked = len(self.connector.log)
        self.connector.offer(A, click("k1", "[It] for A [action k1]"))
        self.a_while()
        self.assertEqual(hermes.tried, 0, "a message handed over now would land in the other conversation")
        self.assertEqual(len(self.connector.log), asked, "nor is its click set aside here, where nothing else could have it")
        # The other conversation has a turn. It is not the first one under a new id, so nothing follows it there.
        hermes.turn(B, running=False)
        self.assertTrue(until(lambda: ("hermes", B) in self.connector.asked()))
        self.a_while()
        self.assertEqual([e for e in self.connector.log if e[0] == "session"], [])
        self.assertEqual(hermes.tried, 0)
        self.connector.offer(B, click("k2", "[It] for B [action k2]"))
        self.assertTrue(until(lambda: self.connector.acks() == [("k2",)]))
        self.assertEqual(hermes.messages, [("[It] for B [action k2]", "user", None)])
        # Back in the first conversation, its click is waiting for it
        hermes.resume(A)
        hermes.turn(A, running=False)
        self.assertTrue(until(lambda: len(self.connector.acks()) == 2))
        self.assertEqual(hermes.messages[1], ("[It] for A [action k1]", "user", None))
        self.assertEqual([e for e in self.connector.log if e[0] == "session"], [])

    def test_a_conversation_hermes_put_away_is_not_taken_up_again_under_another_id(self):
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.assertTrue(until(lambda: self.connector.asked()))
        hermes.fire("on_session_finalize", session_id=A, platform="cli")  # /new
        compressed[A] = B  # even if the record were to say so
        hermes.shows(B)
        hermes.turn(B, running=False)
        self.assertTrue(until(lambda: ("hermes", B) in self.connector.asked()))
        self.a_while()
        self.assertEqual([e for e in self.connector.log if e[0] == "session"], [])

    def test_nothing_is_handed_over_when_the_terminal_does_not_say_which_conversation_it_has_open(self):
        hermes = self.terminal(showing=None)  # a later Hermes that keeps the id somewhere else
        hermes.turn(A, running=False)
        self.connector.offer(A, click("k1"))
        self.a_while()
        self.assertEqual(self.connector.log, [])
        self.assertEqual(hermes.tried, 0)

    def test_an_agent_started_by_the_conversation_is_not_taken_for_it(self):
        hermes = self.terminal()
        hermes.turn(A, running=False)
        hermes.fire("subagent_start", parent_session_id=A, child_session_id=B, child_role="worker", child_goal="look")
        hermes.turn(B, running=False)
        self.a_while()
        self.assertEqual(set(self.connector.asked()), {("hermes", A)})
        self.assertEqual([e for e in self.connector.log if e[0] == "session"], [])

    def test_a_conversation_hermes_put_away_is_not_asked_about(self):
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.assertTrue(until(lambda: self.connector.asked()))
        hermes.fire("on_session_finalize", session_id=A, platform="cli")
        time.sleep(0.1)
        before = len(self.connector.log)
        self.a_while()
        self.assertEqual(len(self.connector.log), before)

    def test_a_run_that_answers_once_and_exits_is_never_asked_about(self):
        os.environ["HERMES_SINGLE_QUERY_SESSION"] = "1"
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.connector.offer(A, click("k1"))
        self.a_while()
        self.assertEqual(self.connector.log, [])
        self.assertEqual(hermes.tried, 0)

    def test_a_wrong_token_is_read_again_from_the_connectors_file(self):
        self.connector.token = "f" * 48  # the connector restarted and made a new one
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.connector.offer(A, click("k1"))
        self.assertTrue(until(lambda: self.connector.refused >= 2))
        self.assertEqual(hermes.tried, 0)
        self.connector.write_file()
        self.assertTrue(until(lambda: self.connector.acks()))
        self.assertEqual(len(hermes.messages), 1)

    def test_the_socket_is_the_one_in_its_folder_whatever_the_file_says(self):
        self.connector.write_file(json.dumps({"socket": "/nowhere/else.sock", "token": TOKEN}))
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.assertTrue(until(lambda: self.connector.asked()))


class WhenOnlyTheHooksCanBeSeen(Case):
    def test_nothing_is_handed_over_in_a_terminal_whose_open_conversation_cannot_be_told(self):
        # A message with no name on it goes to whichever conversation the terminal has open. The
        # hooks alone do not say which that is after /resume, so nothing is handed over, and
        # nothing is asked, which leaves the click for whatever else could take it.
        hermes = self.load(LaterHermes())
        hermes.turn(A, running=False)
        self.connector.offer(A, click("k1"))
        self.a_while()
        self.assertEqual(self.connector.log, [])
        self.assertEqual(hermes.tried, 0)

    def test_a_conversation_with_a_name_still_gets_its_click_by_that_name(self):
        hermes = self.load(LaterHermes())
        bound["HERMES_SESSION_KEY"] = "agent:main:telegram:dm:42"
        hermes.turn(A)
        self.connector.offer(A, click("k1"))
        self.a_while()
        self.assertEqual(hermes.tried, 0, "held while the hooks say a turn is running")
        hermes.turn(A, running=False)
        self.assertTrue(until(lambda: self.connector.acks()))
        self.assertEqual(hermes.messages, [(TEXT, "user", "agent:main:telegram:dm:42")])


class InTheTuiAndTheGateway(Case):
    KEY = "agent:main:telegram:dm:42"

    def named(self, **more):
        return self.load(Hermes(terminal=None, **more))

    def test_the_click_goes_to_the_conversation_by_name_even_during_a_turn(self):
        # Hermes keeps it until the turn is over (tui_gateway/plugin_inject.py, gateway/run_busy.py)
        hermes = self.named()
        bound["HERMES_SESSION_KEY"] = self.KEY
        hermes.turn(A)
        self.connector.offer(A, click("k1"))
        self.assertTrue(until(lambda: self.connector.acks()))
        self.assertEqual(hermes.messages, [(TEXT, "user", self.KEY)])
        self.assertEqual(set(self.connector.asked()), {("hermes", A)})

    def test_each_conversation_gets_its_own_clicks(self):
        hermes = self.named()
        bound["HERMES_SESSION_KEY"] = "ses_one"
        hermes.turn(A, running=False)
        bound["HERMES_SESSION_KEY"] = "ses_two"
        hermes.turn(B, running=False)
        bound["HERMES_SESSION_KEY"] = ""
        self.connector.offer(B, click("k2", "[It] for two [action k2]"))
        self.connector.offer(A, click("k1", "[It] for one [action k1]"))
        self.assertTrue(until(lambda: len(self.connector.acks()) == 2))
        self.assertEqual(sorted(hermes.messages), [("[It] for one [action k1]", "user", "ses_one"), ("[It] for two [action k2]", "user", "ses_two")])

    def test_another_conversation_under_the_same_name_does_not_get_the_first_ones_pages(self):
        hermes = self.named()
        bound["HERMES_SESSION_KEY"] = self.KEY
        hermes.turn(A, running=False)
        self.assertTrue(until(lambda: self.connector.asked()))
        hermes.turn(B, running=False)  # /new or /resume in the same chat: another conversation, not the first one compressed
        self.assertTrue(until(lambda: ("hermes", B) in self.connector.asked()))
        self.a_while()
        self.assertEqual([e for e in self.connector.log if e[0] == "session"], [])
        # A compressed conversation, though, is still followed under its name
        compressed[B] = "20261002_120000_cd56ef"
        hermes.turn("20261002_120000_cd56ef", running=False)
        self.assertTrue(until(lambda: ("session", "hermes", "20261002_120000_cd56ef", B) in self.connector.log))

    def test_nothing_is_asked_until_the_person_has_allowed_messages(self):
        hermes = self.named(allowed=False)
        bound["HERMES_SESSION_KEY"] = self.KEY
        hermes.turn(A, running=False)
        self.connector.offer(A, click("k1"))
        self.a_while()
        self.assertEqual(self.connector.log, [], "asking would set the click aside where nothing else could have it")
        hermes.allowed = True
        self.assertTrue(until(lambda: self.connector.acks()))

    def test_nothing_is_asked_where_no_message_could_be_taken(self):
        for hermes, key in ((self.named(host=False), self.KEY), (self.named(), "")):
            bound["HERMES_SESSION_KEY"] = key
            hermes.turn(A, running=False)
        self.connector.offer(A, click("k1"))
        self.a_while()
        self.assertEqual(self.connector.log, [])


class OverAPort(Case):
    """Where there is no socket file (Windows), the connector listens on a port of this machine."""

    def setUp(self):
        super().setUp()
        self.connector.close()
        os.remove(os.path.join(self.home, "connector.sock"))
        self.connector = Connector(self.home, port=True)
        self.connector.write_file()

    def test_requests_are_sealed_and_the_token_is_never_sent(self):
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.assertTrue(until(lambda: self.connector.asked()))
        hermes.compress(A, B)
        hermes.turn(B, running=False)
        self.connector.offer(B, click("k57abc"))
        self.assertTrue(until(lambda: self.connector.acks()))
        self.assertEqual(hermes.messages, [(TEXT, "user", None)])
        self.assertIn(("session", "hermes", B, A), self.connector.log)
        self.assertEqual(self.connector.refused, 0, "the connector believed every request")
        self.assertEqual(self.connector.token_shown, 0)

    def test_an_answer_from_something_else_on_the_port_is_not_believed(self):
        self.connector.seals_with = "f" * 48
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.connector.offer(A, click("k1"))
        self.assertTrue(until(lambda: len(self.connector.asked()) >= 3))
        self.a_while()
        self.assertEqual(hermes.tried, 0)
        self.assertEqual(self.connector.acks(), [])
        self.assertEqual(self.connector.token_shown, 0, "and it was never shown the token")

    def test_an_answer_too_long_to_be_the_connectors_counts_as_no_answer(self):
        self.connector.padding = 300_000
        hermes = self.terminal()
        hermes.turn(A, running=False)
        self.connector.offer(A, click("k1"))
        self.assertTrue(until(lambda: len(self.connector.asked()) >= 3))
        self.assertEqual(hermes.tried, 0, "even though it was sealed as the connector seals")
        # The next answer, of a usual length, is read as usual
        self.connector.padding = 0
        self.assertTrue(until(lambda: self.connector.acks()))
        self.assertEqual(hermes.messages, [(TEXT, "user", None)])

    def test_an_answer_that_never_ends_is_given_up_on_however_steadily_it_arrives(self):
        dribbler = Dribbler()
        self.addCleanup(dribbler.close)
        kept = addon.DEADLINE_SECONDS
        self.addCleanup(lambda: setattr(addon, "DEADLINE_SECONDS", kept))
        addon.DEADLINE_SECONDS = 0.5
        with open(os.path.join(self.home, "connector.json"), "w", encoding="utf-8") as file:
            json.dump({"port": dribbler.port, "token": TOKEN}, file)
        hermes = self.terminal()
        hermes.turn(A, running=False)
        # A byte arrives every fiftieth of a second, so the wait for silence never ends. The
        # time allowed from start to finish does, and after it the add-on asks again.
        self.assertTrue(until(lambda: len(dribbler.lasted) >= 2))
        self.assertGreater(dribbler.lasted[0], 0.4)
        self.assertLess(dribbler.lasted[0], 1.5)
        self.assertEqual(hermes.tried, 0)


class WhereItWasSetUp(Case):
    """It installed in a folder of its own choosing, and a Hermes started from a shell that does not know where."""

    def test_the_folder_from_setup_is_used_when_the_environment_names_none(self):
        source = (HERE / "it-bridge" / "__init__.py").read_text(encoding="utf-8")
        # `it setup` fills the folder in on this very line, so the line must stay exactly as it is
        self.assertEqual(len(re.findall(r"^IT_HOME_AT_SETUP = None$", source, flags=re.M)), 1)
        filled = re.sub(r"^IT_HOME_AT_SETUP = None$", lambda _: "IT_HOME_AT_SETUP = %r" % self.home, source, flags=re.M)
        copy = pathlib.Path(self.home) / "filled.py"
        copy.write_text(filled, encoding="utf-8")
        spec = importlib.util.spec_from_file_location("it_bridge_filled", copy)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.POLL_SECONDS, module.SETTLE_SECONDS = 0.02, 0.05
        del os.environ["IT_HOME"]
        self.assertEqual(module._it_home(), self.home)
        hermes = Hermes(terminal=types.SimpleNamespace(_agent_running=False, session_id=A, _pending_input=queue.Queue()))
        module.register(hermes)
        self.loaded.append(hermes)
        hermes.turn(A, running=False)
        self.connector.offer(A, click("k1"))
        self.assertTrue(until(lambda: self.connector.acks()), "it found the connector in the folder from setup")
        # What the environment says comes first, and with neither it is the usual folder
        os.environ["IT_HOME"] = "/somewhere/else"
        self.assertEqual(module._it_home(), "/somewhere/else")
        del os.environ["IT_HOME"]
        self.assertEqual(addon._it_home(), os.path.join(os.path.expanduser("~"), ".it"))


class WithoutAConnector(Case):
    def quiet(self, hermes):
        hermes.turn(A, running=False)
        self.a_while()
        self.assertEqual(hermes.tried, 0)
        self.assertEqual(self.connector.log, [])
        self.assertTrue(any(t.name == "it-bridge" and t.is_alive() for t in threading.enumerate()), "it is still there for when a connector starts")

    def test_a_missing_file_does_nothing_and_raises_nothing(self):
        os.remove(os.path.join(self.home, "connector.json"))
        self.connector.offer(A, click("k1"))
        self.quiet(self.terminal())

    def test_a_malformed_file_does_nothing_and_raises_nothing(self):
        sock = os.path.join(self.home, "connector.sock")
        for text in (
            "",
            "not json",
            "[]",
            '"a string"',
            "null",
            json.dumps({"socket": sock}),
            json.dumps({"socket": sock, "token": 5}),
            json.dumps({"socket": sock, "token": "short"}),
            json.dumps({"socket": sock, "token": TOKEN.upper()}),
            json.dumps({"token": TOKEN}),
            json.dumps({"socket": "", "token": TOKEN}),
            json.dumps({"port": 70000, "token": TOKEN}),
            json.dumps({"port": True, "token": TOKEN}),
            json.dumps({"port": "8080", "token": TOKEN}),
        ):
            with self.subTest(file=text):
                self.connector.write_file(text)
                self.connector.offer(A, click("k1"))
                self.quiet(self.terminal())

    def test_a_connector_that_is_not_there_does_nothing_and_raises_nothing(self):
        self.connector.close()
        os.remove(os.path.join(self.home, "connector.sock"))
        self.quiet(self.terminal())
        self.connector = Connector(self.home)  # so that tearDown has one to close


if __name__ == "__main__":
    unittest.main()
