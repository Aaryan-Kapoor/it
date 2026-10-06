# Add-ons: what to expect of each agent app

An add-on is how what you do on a page gets back into the conversation that made the page, by itself. This page says what every add-on does, which routes a click tries, what to expect in each agent app, and what It does not do. [Agents](agents.md) has the table of which add-ons are proven, and what that rests on.

## What every add-on does

- It is a plugin to the agent app's unmodified release. No agent app is forked or patched, and It never wraps or replaces the command you start an agent app with.
- It is installed with the app's own command for add-ons where the app has one (Claude Code, Codex, Pi, OpenClaw). OpenCode has none, so its plugin and the skill are copied into the folder OpenCode loads from, and Hermes's are copied and then switched on with Hermes's own command.
- Each installation is written down with every file it wrote, so that only those files are ever replaced or removed. A file that was already there and is not It's is kept beside the new one, with `.set-aside-by-it` added to its name.
- `it setup` installs an add-on only into a version of the app that It knows the add-on to work with. It says which version it needs where the one it finds is older, and installs nothing there.
- The conversation that made a page keeps it. Ownership moves only when the machine that made the page has left or was revoked, or when an agent takes the page over explicitly by publishing it again with `--take`, as in `it update <id> --file page.html --take`.

## The order a click tries

A click is stored before anything tries to deliver it, and then tries these routes in order, stopping at the first that works:

1. **The add-on, live.** The add-on inside the conversation that owns the page puts the click into it now, or at the agent's next step if it is busy.
2. **The app's own queue**, where it has one. Codex has, and Codex's is the only queue It uses: the click arrives when the conversation is next idle or reopened.
3. **Reopening the conversation**, where you have switched Auto-wake on for the agent app on that machine. Only Claude Code's is reopened: [below](#a-conversation-that-has-been-closed) says how.
4. **The inbox.** Everything else waits, in view: the site shows it, and the agent takes it with `it wait`.

None of these routes is tried for an agent app you have not connected. A click on a page it made waits in the inbox.

An add-on that cannot deliver a click leaves it in the inbox, and the site does not say why in every such case.

Delivery is at least once, and every click carries a stable id so that an agent can tell a repeat. In one case a click may be seen twice, with the same id: where It was stopped by a crash after Codex's queue took the click and before that was written down. Where what became of a click is not known, the site says so.

## What to expect in each agent app

It has add-ons for Claude Code, Codex, Pi, OpenCode, Hermes Agent and OpenClaw, and it reaches T3 Code through two of them. `it setup` asks for these versions or later:

| Agent app | The oldest version `it setup` installs into |
|---|---|
| Claude Code | 2.1.287 |
| Codex | 0.159.0 |
| Pi | 0.82.0 |
| OpenCode | 1.18.32 |
| Hermes Agent | 0.20.1 |
| OpenClaw | 2026.9.6 |

### Claude Code

When the conversation is idle, a click starts a turn. While a turn runs, the click is attached to the next tool result, so that nothing is interrupted, and it starts a turn when that one ends if no tool ran.

A click that starts a turn shows in the conversation as one short line: the page, what was done, and the action's id, as in `[It] "Chess": move [action …]`. Everything else the page sent goes to Claude beside that line, where you are not shown it, with a note that It put the line there and that what a page sends is data and not instructions.

The add-on needs Claude Code 2.1.287 or later, with mods turned on. There is no other route for an older Claude Code, or for one where mods are turned off: a click waits in the inbox there.

### A conversation that has been closed

You can let It reopen a Claude Code conversation that has been closed, so that what you do on a page it made is acted on while you are away from the machine. It is off until you turn it on, for each agent app on each machine by itself: on the site's Machines page, with the Auto-wake switch under the app, or with "Wake it" on a page whose click nobody has taken. Only a browser paired as yours can turn it on. A machine cannot, so an agent cannot switch it on for itself. It holds from about the moment you turn it on: a click that had been waiting more than ten minutes by then stays in the inbox, so that turning it on does not run your agent for everything that ever went unanswered.

With it on, a click that no open conversation asks for within a few seconds is given to Claude Code's own command for carrying a conversation on without a window, `claude --resume`, run in the folder the conversation was held in. The click is its prompt, given on the command's input. The conversation then runs as it would with you there, except that nobody is watching: it may run `it`, and whatever else your own Claude Code settings allow without asking, and it uses your Claude Code account as any turn does. When you open the conversation again, the turn is in it.

Each conversation is reopened for one click at a time, in the order they were made. If the command fails, It tries again a few times, further apart, and then leaves the click in the inbox. It knows which folder a conversation was held in from a note the `it` command keeps in `~/.it` each time the conversation publishes a page, and that note leaves the machine no more than anything else there does.

### Codex

While a turn runs, the click is handed to the model at the next tool call, and the turn goes on with any click that arrived after the last one. When the conversation is idle, the click goes into Codex's own queue, which starts a turn with it.

Codex runs an agent's commands in a sandbox, and unless it is told otherwise that sandbox gives them no network. `it` reaches It over the network of your own machine, so in such a sandbox it cannot, and it says so: its answer has the code `blocked`, and says that It could not be asked from there. Either approve `it` to run outside the sandbox when Codex asks, or let commands in the sandbox use the network, with `sandbox_workspace_write.network_access = true` in Codex's `config.toml`.

Codex runs none of the add-on's hooks until you have approved them, and says nothing when it skips one. In the terminal, Codex asks the next time it starts, and "Trust all and continue" approves them. Until then a click still arrives, as a new message when Codex is idle. `it setup` and the site say that the hooks are waiting to be approved until one of them has run. How the desktop app and T3 Code ask, where there is no terminal to show the question, is not known.

The same add-on serves Codex in three places, and they differ in what happens to a click:

- **In the terminal.** A click reaches a busy conversation and an idle one.
- **In the desktop app.** A click for an idle thread starts a turn by itself. A click for a busy thread waits in view there, with a Steer button, and runs by itself when the turn ends. Delivery in the middle of a turn is not proven in the desktop app.
- **Inside T3 Code.** T3 Code closes a Codex session after 30 idle minutes. From then a click waits in Codex's own queue and runs the moment the thread is reopened, which means your next message there.

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

The add-on puts a click into the conversation that owns the page, where it starts a turn or joins a busy run at its next step. The agent's answer goes where that conversation's answers already go.

It is held back: `it setup` does not offer it, and installs it only for someone who asks for it by name, with `IT_EXPERIMENTAL=openclaw`. It has never been loaded by a gateway, so these things are not known of it:

- Whether a click delivered through the add-on is held to the restrictions OpenClaw applies to that conversation's own messages, which are the tools a direct message may use and who sent it. As OpenClaw's interface is written, it is not.
- How the session keys of a subagent and of a scheduled run read.
- Whether OpenClaw signals the start of a run for a click that joins a turn already under way.
- How two profiles on one machine are told apart.

## What It does not do

- Only a Claude Code conversation is reopened when it has been closed, and only on a machine where you have switched Auto-wake on for it. A click for a closed conversation of any other app with no queue of its own waits in the inbox.
- It does not use ACP, which cannot reach a conversation another program owns: the conversation It has to reach is the one you already have open.
- It ships no MCP server, so it has no add-on for an agent app that could be reached only through one, such as Crush.
- It builds no add-on on an agent app's undocumented API, or on an interface for add-ons that is not stable, which is why it has none for Copilot CLI.
- It uses no queue but Codex's. Qwen has a queue of the same kind, and It has no add-on for Qwen.

Any agent app without an add-on still gets the `it` command, the agent skill (`addons/skill/SKILL.md`, which `it skill` prints), `it wait` where the app can wake on a command's output, and the inbox. No click arrives there by itself.
