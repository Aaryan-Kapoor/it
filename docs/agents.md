# Agents

It connects the agents you already run, and brings none of its own. It reaches each one as a plugin to the unmodified program. The one thing it starts by itself is a conversation of yours that was closed, when you use a page it made, and only for an agent app you have switched Auto-wake on for: [add-ons](add-ons.md#a-conversation-that-has-been-closed) says how.

An agent drives It with one command, `it`, and learns how from the agent skill, which every add-on carries and `it skill` prints. It writes a page, publishes it with `it create`, and asks your displays to show it. What you do on the page goes back to the conversation that made it.

## Connecting agents

An add-on is how what you do on a page gets back into an open conversation in one agent app, by itself. `it setup` finds the apps on the machine and installs the add-on for each one you choose, with the app's own commands for installing a plugin. Run it again to change which apps are connected: `--all`, `--only claude-code,codex` and `--none` say which, as [Installing It](install.md#the-first-run) describes.

It has add-ons for six agent apps, and they are not all proven alike.

| Agent app | Proven? | What that rests on |
|---|---|---|
| Claude Code | Yes | Tested end to end against the real program: setup installs the add-on, Claude publishes a page, and a click starts a turn or rides the next tool result |
| Codex | Yes | Tested end to end against the real program, through its hooks and its own queue. The desktop app's queue was checked by hand on Windows |
| T3 Code | Yes, for an idle thread | It has no add-on of its own, because the Claude Code and Codex add-ons load inside its sessions. In real T3 Code threads, a click on an idle thread started a turn by itself in Claude Code, and reached Codex through Codex's own queue and started a turn there. A click that arrives while a tool is running has been seen in Claude Code and in Codex themselves, and not inside a T3 Code thread |
| Pi | Yes, on Linux | Tested end to end against the real program with a real model: Pi published a page, and a click started a turn when Pi was idle, was read once its running command had finished when it was busy, and reopened the conversation when Pi was closed |
| OpenCode | Yes, on Linux | Tested end to end against the real program with a real model: OpenCode published a page, and a click started a turn when it was idle, joined the running turn when it was busy, and reopened the conversation when OpenCode was closed |
| Hermes Agent | Yes, in the plain terminal, on Linux | Tested end to end against the real program, as built from its repository on 2026-09-24, with a real model: Hermes published a page, and a click started a turn when it was idle, waited for the running turn to end when it was busy, and reopened the conversation when Hermes was closed. Its TUI, its desktop app and its messaging gateway have not been tried |
| OpenClaw | No, and held back | Written and tested against a stand-in for OpenClaw. It has never been loaded by a gateway, so `it setup` does not offer it. `IT_EXPERIMENTAL=openclaw` installs it for someone who asks for it by name |

[Add-ons](add-ons.md) says what to expect of each: where a click arrives by itself, where it waits, and what It does not do.

Any agent app without an add-on can still use the `it` command and the agent skill. A click then waits where the site shows it, and the agent takes it with `it wait`, or reads what is waiting with `it actions`.

Three things are worth knowing about connected apps.

- **It listens for at most 40 conversations on one machine at a time.** Where more than that are open, it listens for the 40 it heard from most recently, and a click for any other waits, where the site shows it and `it wait` takes it, until that conversation is among them again.
- **It does nothing to get a click to an agent app that is not connected.** Its conversations are not listened for, its add-on is given no click, and the app's own command is never run to hand one over. A click on a page that such an app made waits where the site shows it, and `it wait` takes it. It does still ask each agent app it knows for its version and for its list of plugins, with the app's own command, when it starts and every half hour, whether the app is connected or not. That is how the site can list what there is to connect.
- **On Windows some folder names keep an add-on out.** An agent app's own command is run through a shell there, so `it setup` installs no add-on where a folder it has to name to that command holds one of the characters `" & ^ % | < > !`. It says that the command was not run and that nothing was changed.

## Agents on another computer

Agents on a second computer can make pages in the same It. That computer needs It installed, and the network has to be on, since it reaches It across the network.

1. In your paired browser, open Machines and choose "Add a machine". It shows one command, with the address of the machine It runs on and a code in it.
2. On the other computer, run that command: `it login --url <address> --code <code>`. `--name` gives the machine a name other than its host name. The address is a plain `http` one, and any other is refused.

The code joins one machine, once, and works for ten minutes. If the answer is lost on its way back, running `it login` again at the same address is given the machine that was made the first time. `it login` then goes on as `it setup` does: it finds the agent apps on that computer, connects the ones you choose, and registers a background service there. One setup or joining at a time works in a folder. A setup that was waiting while the machine joined an It says so, and sets no It up there: run `it setup` again to connect that computer's agent apps to the It it joined.

A joined machine runs no backend and keeps no pages. Everything it does goes through the site's port on the machine It runs on, so it works only while that machine is running It with the network on, and `it create` there prints the page's address at the address it joined by. It keeps that address. If the machine It runs on comes to have another, the joined machine is told the new one with `IT_URL`: set it to the new address where `it` runs there, and run `it service install` there again so that its background service has it too. Or it leaves with `it logout --force`, and joins again with a new code.

`it logout` on the joined computer leaves again: it takes the machine off your machines, removes its background service and takes its add-ons out. `it logout --force` leaves even when It cannot be told, and the machine then stays among your machines until you revoke it on the site.

Join only computers that you would trust with everything It holds: [every machine can pair a browser as yours](what-it-protects.md#every-machine-can-pair-a-browser-as-yours).

## Revoking a machine

The Machines page revokes a machine, which ends everything its agents can do at once. Everything that came from that machine goes with it: the browsers that were paired with a code it asked for, the screens those browsers added, and the machines that joined with a code from any of them. The site says how many of each before you confirm.

The machine It runs on is where `it site` gets its codes, so revoking it ends every browser you have paired. To use It again after that, run `it setup` on that machine, which enrols it anew and gives it back the pages it made, and then `it site`, which pairs a browser. A joined machine that was revoked runs `it logout` and is added again with "Add a machine".
