# Add-ons: what to expect of each agent app

An add-on is how what you do on a page gets back into the conversation that made the page, by itself. This page says what every add-on does, which routes a click tries, what to expect in each agent app, and what It does not do. [Agents](agents.md) has the table of which add-ons are proven, and what that rests on.

## What every add-on does

- It is a plugin to the agent app's unmodified release. No agent app is forked or patched, and It never wraps or replaces the command you start an agent app with.
- It is installed with the app's own command for add-ons where the app has one (Claude Code, Codex, Pi, OpenClaw). OpenCode has none, so its plugin and the skill are copied into the folder OpenCode loads from, and Hermes's are copied and then switched on with Hermes's own command.
- Each installation is written down with every file it wrote, so that only those files are ever replaced or removed. A file that was already there and is not It's is kept beside the new one, with `.set-aside-by-it` added to its name.
- `it setup` installs an add-on only into a version of the app that It knows the add-on to work with. It says which version it needs where the one it finds is older, and installs nothing there.
- A page belongs to the conversation that last made it or brought it up. `it create` under an id another conversation used, and `it open` of a page another conversation made, give the page to the one that runs it, since whoever says "show me the board again" the next day is talking to the conversation in front of them; the command's answer says that the page changed hands. `it update` from another conversation changes what the page shows and leaves it where it is, and says so, unless it is given `--take`. A page also moves when the machine that made it has left or was revoked: it goes to whoever publishes it next.

## The order a click tries

A click is stored before anything tries to deliver it, and then tries these routes in order, stopping at the first that works:

1. **The add-on, live.** The add-on inside the conversation that owns the page puts the click into it now, or at the agent's next step if it is busy.
2. **The app's own queue**, where it has one. Codex has, and Codex's is the only queue It uses. It is used for a conversation that some Codex on the machine has open, which takes a queued message by itself: at once when it is idle, and when its turn ends when it is not.
3. **Reopening the conversation**, where you have switched Auto-wake on for the agent app on that machine: [below](#a-conversation-that-has-been-closed) says how. A Codex conversation that no Codex has open goes this way too, and nothing is put in its queue: a queued message would wait there until the conversation was opened and a turn of it had ended.
4. **The inbox.** Everything else waits, in view: the site shows it, and the agent takes it with `it wait`.

None of these routes is tried for an agent app you have not connected. A click on a page it made waits in the inbox.

An add-on that cannot deliver a click leaves it in the inbox, and the site does not say why in every such case.

Delivery is at least once, and every click carries a stable id so that an agent can tell a repeat. In one case a click may be seen twice, with the same id: where It was stopped by a crash after Codex's queue took the click and before that was written down. Where what became of a click is not known, the site says so.

## What to expect in each agent app

It has add-ons for Claude Code, Codex, Pi, OpenCode, Hermes Agent and OpenClaw, and it reaches T3 Code through two of them. `it setup` asks for these versions or later:

| Agent app | The oldest version `it setup` installs into |
|---|---|
| Claude Code | 2.1.287 |
| Codex | 0.160.0 |
| Pi | 0.82.0 |
| OpenCode | 1.18.32 |
| Hermes Agent | 0.20.1 |
| OpenClaw | 2026.9.6 |

### Claude Code

When the conversation is idle, a click starts a turn. While a turn runs, the click is attached to the next tool result, so that nothing is interrupted, and it starts a turn when that one ends if no tool ran.

A click that starts a turn shows in the conversation as one short line: the page, what was done, and the action's id, as in `[It] "Chess" (chess): move, with details [action …]`. It stands there as your own message, which is the one way Claude Code shows a message from an add-on as it is, with no lines of its own around it. Nothing the page sent is put into that line. Claude reads what the action carried with `it action`, where it arrives as data and not as something you said.

The add-on needs Claude Code 2.1.287 or later, with mods turned on. There is no other route for an older Claude Code, or for one where mods are turned off: a click waits in the inbox there.

### A conversation that has been closed

You can let It reopen a conversation that has been closed, so that what you do on a page it made is acted on while you are away from the machine. This is Auto-wake. It is off until you turn it on, for each agent app on each machine by itself: on the site's Machines page, with the Auto-wake switch under the app, or with "Wake it" on a page whose click nobody has taken. Only a browser paired as yours can turn it on. A machine cannot, so an agent cannot switch it on for itself. Turning it on also reopens conversations for what you did in the day before, oldest first, so a click that went unanswered an hour ago is acted on. A click that had been waiting longer than a day by then stays in the inbox, so that turning it on does not run your agent on answers you gave long ago.

With it on, a click for a conversation that is not listening is given at once to the agent app's own command for carrying a conversation on without a window. It knows which conversations are listening, since an open one asks for its clicks every second, so nothing is waited for but a third of a second that lets a few things done together go together. The command is run in the folder the conversation was held in. The click is its message, given on the command's input and never on its command line. The conversation then runs as it would with you there, except that nobody is watching, and it uses your account with that app as any turn does. It is told so in a few lines after the click: that nothing can be approved for it, how to run `it`, and to say so on the page, and mark the action as failed, where it cannot do what was asked. When you open the conversation again, the turn is in it.

| Agent app | What It runs | What the conversation may do by itself |
|---|---|---|
| Claude Code | `claude --resume <id> --print` | What it could do the last time you had it open. It is reopened in the permission mode you last held the conversation in, where that mode asks nobody: one you held with full access, in T3 Code say, is reopened with full access. One you held in the mode that asks is reopened with `it` and whatever your own settings allow, and anything else it tries is refused |
| Codex | `codex exec resume <id>` | Run in Codex's sandbox for a workspace, with the network allowed and It's own folder writable, which is what `it` needs. It can write in the conversation's folder and nowhere else |
| Pi | `pi --print --session <id>` | Whatever it does in a window: Pi does not ask before it runs a command |
| OpenCode | `opencode run --session <id>` | Whatever your OpenCode settings allow without asking |
| Hermes Agent | `hermes chat --resume <id> --query-file -` | Whatever your Hermes settings allow without asking |

All five have been run this way against the real programs on Linux: Claude Code and Codex with their own models, and Pi, OpenCode and Hermes with a model reached through OpenRouter. None has been run this way on Windows or macOS. OpenClaw has no such switch: its conversations live in its gateway, which is not closed.

The command is started by It's background service, and so with the service's environment and not your shell's. An agent app that finds its account in a variable of your shell, and has no login of its own stored, cannot start a turn there. The page then says that it could not be woken.

**Everything waiting goes in one message.** A conversation reopened for five clicks is reopened once, and reads all five, up to eight at a time.

**A conversation is reopened only so often.** Ten times at once, and then once more for every twenty seconds that pass, which a person using a page steadily never reaches. What a page sends by itself, with nobody at it, reopens a conversation three times and then once for every five minutes, so that a page that sends on a timer cannot keep an agent running. All the conversations of one machine together are reopened thirty times at once and then once for every ten seconds. Nothing is lost past these: the clicks wait, and go together with the next reopening. A person's click is never held up behind what a page sent by itself.

**You can stop it.** While a conversation that It reopened is running, the bar above its page says "Working", with a small square beside it that stops the agent. The agent is ended at once, and so is any command it was in the middle of. What it had been asked stays in the conversation, as it does when you stop a turn in the app. What was still waiting for that conversation goes with the stop: it is not reopened for, it is not handed over when you next open the conversation, and it no longer counts as waiting. The next thing you do on the page reopens the conversation as before, and the agent is told then that its last turn was stopped. Any browser that can use the page can stop it. A machine cannot, so no agent stops another. Stopping It's service ends the conversations it reopened as well, and what they were reopened for is given back and reopened for again when It next starts.

**Where it cannot be done, the page says so.** "Couldn’t wake" and the app's name, with the reason beside it: the app was not found, its command ended with an error, the folder the conversation was held in is gone. It tries again a few times, further apart, and then leaves the click in the inbox. It knows which folder a conversation was held in from a note kept in `~/.it`: the `it` command writes it each time the conversation publishes a page, and Codex's add-on says it with every turn, since Codex runs the agent's own commands where that folder cannot be written. The note leaves the machine no more than anything else there does.

A conversation that is open in a window where It's add-on is not loaded looks closed to It. For Claude Code, one that wrote something in the last twenty seconds is left alone until it is quiet. For Codex, It asks Codex's own record of which conversations are being written: one that a Codex has open anywhere on the machine (the terminal, the desktop app, an editor, T3 Code) is never reopened beside it, and Codex goes on holding a conversation for about a minute after its window is closed.

### Codex

While a turn runs, the click is handed to the model at the next tool call, and the turn goes on with any click that arrived after the last one. When the conversation is open and idle, the click goes into Codex's own queue, which starts a turn with it. A click that arrives in the middle of a turn is said to be a separate one, so that a second press of a button is not taken for the first.

Codex runs an agent's commands in a sandbox, and unless it is told otherwise that sandbox gives them no network. `it` reaches It over the network of your own machine, so in such a sandbox it cannot, and it says so: its answer has the code `blocked`, and says that It could not be asked from there. Either approve `it` to run outside the sandbox when Codex asks, or let commands in the sandbox use the network, with `sandbox_workspace_write.network_access = true` in Codex's `config.toml`. `it setup` and `it status` say so when Codex's settings plainly give no network, and the answer a sandboxed agent gets carries the two lines for it to pass on to you. It changes nothing in Codex's settings itself.

Codex runs none of the add-on's hooks until you have approved them, and says nothing when it skips one. In the terminal, Codex asks the next time it starts, and "Trust all and continue" approves them. Until then a click still arrives, as a new message when Codex is idle. `it setup` and the site say that the hooks are waiting to be approved until one of them has run. How the desktop app and T3 Code ask, where there is no terminal to show the question, is not known.

The same add-on serves Codex in three places, and they differ in what happens to a click:

- **In the terminal.** A click reaches a busy conversation and an idle one.
- **In the desktop app.** A click for an idle thread starts a turn by itself. A click for a busy thread waits in view there, with a Steer button, and runs by itself when the turn ends. Delivery in the middle of a turn is not proven in the desktop app.
- **Inside T3 Code.** T3 Code closes a Codex session after 30 idle minutes. From then the conversation is closed as far as It can tell: with Auto-wake on for Codex a click reopens it, and without it the click waits in the inbox and is handed over during the turn your next message there starts.

### T3 Code

It has no add-on for T3 Code. T3 Code runs the unmodified Claude Code and Codex, so their add-ons load inside its sessions, and a click on an idle thread starts a turn by itself in either.

T3 Code shows Claude's reply to a click and not the click's text. Delivery in the middle of a turn is not proven inside a T3 Code thread, for Claude Code or for Codex.

### Pi

A click arrives as a message from you. When Pi is idle the message starts a turn. When Pi is working, Pi reads it once the tools it is running have finished and before it next asks the model, so that nothing is interrupted.

### OpenCode

A click starts a turn when the conversation is idle, and joins the running turn at its next step otherwise. One OpenCode holds many conversations, and a click goes to the conversation that made the page, whichever one is on screen.

### Hermes Agent

Where a click can arrive depends on where Hermes runs:

- **In the plain `hermes` terminal**, a click starts a turn when the conversation is idle. While a turn runs the click waits, because a message sent then would interrupt the turn.
- **In the TUI and the desktop app**, a click arrives only in a Hermes later than 0.21.5, and only once you have allowed it, which `it setup` says how to do. Hermes itself then keeps the click until the running turn is over. In Hermes 0.21.5 and earlier, a click for these waits in the inbox.
- **In the messaging gateway**, a page made after an agent's first turn has no conversation to send clicks to. Those clicks wait for `it wait` or the site.

One narrow window is known and accepted: in the terminal a click is handed over only when nothing you typed is waiting, but a `/resume` entered in the instant between that look and the hand-over takes the click with it into the other conversation.

### OpenClaw

The add-on runs inside the OpenClaw gateway and puts a click into the conversation that owns the page. What happens next is OpenClaw's own doing, as for any message:

- **The conversation is idle.** A turn starts with the click.
- **A turn that a click began is running.** OpenClaw puts the new click into that turn, and the agent reads it at its next step.
- **A turn that something else began is running**, such as one you started from OpenClaw's own interface. The click waits in line behind it, and starts a turn when that one ends.

A gateway is always there, so there is no Auto-wake for OpenClaw and nothing to reopen. While the gateway is stopped a click waits, and it arrives by itself once the gateway is running again, a little after it has started. A conversation is asked about for a month after the last command its agent ran, so a page left up for a week is still answered. One gateway is asked about at most 40 conversations at a time, the ones that ran a command most recently.

A helper that the agent starts, and a run on a schedule, are given no conversation: a page one of them makes belongs to nobody, and its clicks wait in the inbox. OpenClaw names their sessions `agent:<agent>:subagent:<id>` and `agent:<agent>:cron:<job>:run:<run>`, which is how the add-on knows them.

**It is held back.** `it setup` does not offer it, and installs it only for someone who asks for it by name: run `IT_EXPERIMENTAL=openclaw it setup` once. That it was asked for is then written down in It's folder, so the background service, and the `it` that OpenClaw's agent runs, keep it without the variable. `it setup --only openclaw` in a folder where nobody has asked is refused, and changes nothing. It has been run on a real gateway, OpenClaw 2026.9.6 on Linux with a real model, for a conversation held in OpenClaw's own interface: a click when the conversation was idle, when it was busy in each of the two ways above, three clicks at once, a click straight after the gateway restarted, and a click made while the gateway was stopped. It has not been run for a conversation held in a chat channel, such as Telegram or WhatsApp, which is where most OpenClaw conversations are. There the agent's answer to a click is meant to go to the chat, as its other answers do, and these things are not known:

- Whether that answer goes to the chat it should, and to nowhere else.
- Whether a click leaves the conversation's record of where it was last reached as it was. In OpenClaw's own interface, where a conversation has no such address, the record afterwards named It as the last channel.
- Whether a click is held to the restrictions OpenClaw applies to that conversation's own messages. A turn a click began was offered fewer of the agent's tools than a turn begun from OpenClaw's own interface, 44 against 57 in the run above, and which were left out was not looked at.
- How two profiles on one machine are told apart.

## What It does not do

- A conversation is reopened when it has been closed only on a machine where you have switched Auto-wake on for its agent app. Without that, a click for a closed conversation waits in the inbox.
- It does not use ACP, which cannot reach a conversation another program owns: the conversation It has to reach is the one you already have open.
- It ships no MCP server, so it has no add-on for an agent app that could be reached only through one, such as Crush.
- It builds no add-on on an agent app's undocumented API, or on an interface for add-ons that is not stable, which is why it has none for Copilot CLI.
- It uses no queue but Codex's. Qwen has a queue of the same kind, and It has no add-on for Qwen.

Any agent app without an add-on still gets the `it` command, the agent skill (`addons/skill/SKILL.md`, which `it skill` prints), `it wait` where the app can wake on a command's output, and the inbox. No click arrives there by itself.
