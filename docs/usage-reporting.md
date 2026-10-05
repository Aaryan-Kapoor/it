# Usage reporting

It reports counts of how it is used, so that the person who makes it can tell how many installations are in use and by which paths answers get back to agents. It never reports what is on a page, what anyone clicked, or who you are. This page says what the program on your machine sends, and what a receiver could learn from it.

Reporting is on unless you turn it off, and nothing is recorded until a person has been told so, once, in one line. The line is shown in one of three ways:

- The install script prints it, and that counts as telling you when the script's output is a terminal.
- The first `it` command that a person runs at a terminal prints it. A command counts as that when its output is a terminal and it is not being run inside an agent's conversation, since some agent apps give the commands they run a terminal. `it help`, `it version`, `it skill`, `it serve`, the `it service` commands, `it telemetry` and `it telemetry off` never print it, and neither do the commands that agent apps run as hooks, so it is the first command other than those.
- `it telemetry on` prints it to someone who has not been told, before it turns anything on or notes that you were told.

Until then, a command run by an agent, a script or a service says nothing and records nothing. An installation where nobody was ever at a terminal therefore reports nothing at all.

## Turning it off

Any of these stops events from being recorded and sent, and discards whatever was waiting to be sent:

- Run `it telemetry off`. `it telemetry on` turns it back on, and `it telemetry` by itself says whether it is on, and why.
- Set `IT_TELEMETRY_ENABLED=false` where an `it` command will run. The values `0`, `off`, `no`, `n` and `disabled` do the same, in capitals or not, and with or without spaces or quotes around them.
- Set `DO_NOT_TRACK=1` where an `it` command will run. Any other value does the same, except an empty one and `0`, `false`, `no` and `off`.

### Off is one file

Reporting is off when something named `telemetry-off` exists in It's folder, which is `~/.it` unless `IT_HOME` names another. `it telemetry off` makes that file, and `it telemetry on` removes it. The file holds one word that says what turned reporting off: `command`, `IT_TELEMETRY_ENABLED` or `DO_NOT_TRACK`. Every `it` command looks for it before it records anything, and so does the background service, on every system. Nothing that It writes anywhere else can turn reporting back on, and making the file by hand turns it off as well.

### A variable wins

The program that does the sending is It's background service, which is not started from your shell. Installing the service copies neither variable into it, on any system, so the service goes by the file. The first `it` command that finds either variable set therefore makes the file, with the variable's name in it. From then on reporting is off for the whole installation, in every shell and for the service, until you run `it telemetry on` somewhere the variable is not set.

While a variable is set where a command runs, that command records nothing, whatever the file says. `it telemetry on` is refused there: it says which variable is set, changes nothing, and asks you to run it again without the variable.

`it telemetry` names the true reason. If a variable is set where you ask, it names that variable. Otherwise it says what the file says, so someone whose reporting was turned off by `DO_NOT_TRACK` is told `DO_NOT_TRACK`, in whichever shell they ask.

If the file cannot be written, because the disk is full or the folder cannot be written to, a command that has the variable still records nothing, but the background service has not been told. `it telemetry` says so in a note when that is the case, and `it telemetry off` fails with a message instead of saying that reporting is off.

### What turning it off and on does

The background service looks for the file every five seconds. When it finds reporting off, it gives up at once any request that is under way and discards what was waiting to be sent.

Once `it telemetry off` has returned, no new request begins. A request that had already begun is given up within five seconds, and may have arrived by then. `it telemetry on` returns only once the new id is written down and no request can begin under the old one. A `telemetry-off` made by hand is found at the service's next look.

Turning reporting off also forgets the installation's id, and turning it on always makes a new one, even when reporting was on already. Every event remembers which id it was recorded under, and an event recorded under any id but the current one is never sent. So nothing recorded before you turned reporting off is sent after you turn it on again.

## What is sent

Each event is a name, the hour it happened in, an id of its own, and the properties in this table. Every property is one of the listed values: there is no free text anywhere in an event, and the program refuses to send an event that holds anything else.

| Event | Sent when | Properties and their possible values |
|---|---|---|
| `service.started` | The background service starts, including each time it is restarted, and once a day while it runs | `version`: the three numbers It's version begins with, such as `0.1.0`. `os`: `linux`, `macos`, `windows` or `other`. `arch`: `x64`, `arm64` or `other`. `installed`: `script` when the program is running from the folder the install script puts it in, `source` when Node or Bun is running it, whether from a checkout or from a copy of its files anywhere else, or `other` |
| `screen.connected` | A display opens the site | `screen`: `phone`, `tablet`, `computer` or `tv`. `sameMachine`: `true` or `false`, whether it is the machine the service runs on |
| `page.published` | A page is put up, by an agent or by you, and the backend has confirmed it | `agent`: which agent app's conversation the command was run in, one of `claude-code`, `codex`, `openclaw`, `hermes`, `opencode`, `pi`, `other`, or `unknown` when it was not run inside one. `change`: `new` or `update`. `kind`: `custom`, always, because It has no ready-made page templates. `size`: `under 10 KB`, `10 to 100 KB`, `100 KB to 1 MB`, `1 to 10 MB` or `over 10 MB` |
| `answer.sent` | You do something on a page that is sent to the agent | `screen`: `phone`, `tablet`, `computer` or `tv`. `agentRunning`: `true` or `false`, whether the agent that built the page was still working |
| `answer.delivered` | The backend has confirmed that your answer was handed over to an agent app for its conversation. For Codex's queue that is the queue accepting the answer, which can be before any turn has run | `path`: `heard`, `woke` or `waited`. `after`: how long after you answered the hand-over was confirmed, one of `under 1 second`, `1 to 10 seconds`, `10 to 60 seconds`, `1 to 10 minutes`, `10 to 60 minutes`, `1 to 24 hours` or `over 24 hours`. `agent`: which agent app the answer was for, from the same list as above |
| `agent.woken` | An agent app has taken an answer to start a turn with, or has refused to. It is recorded as soon as the agent app answers, before the backend has confirmed anything | `result`: `resumed`, `declined` or `failed`. `agent`: as for `answer.delivered` |

Two of these are never sent. `screen.connected` and `answer.sent` happen between a display and the backend, where nothing counts them, so It sends the other four.

### What the three paths mean

- `heard`: the agent's conversation was working, or the agent was already waiting for you with `it wait`, and your answer was handed to it there and then.
- `woke`: nothing was running in the conversation, and your answer was handed over to start a turn. For the Claude Code add-on that is a turn the add-on says it started. For Codex it is Codex's own queue accepting the answer. The queue starts a turn as soon as the conversation is free, and if the conversation is closed, only when it is next opened, so for Codex `woke` is counted once the queue has the answer, which can be before any turn runs.
- `waited`: It could not hand your answer over by itself, and the agent came and took it later, with `it wait` or `it ack`.

Only the Claude Code add-on and Codex's queue say that an answer started a turn. Answers handed over through the other add-ons are counted as `heard` even when they started a turn, so `heard` is counted too high and `woke` too low for them.

### What the three results mean

- `resumed`: the agent app took the answer to start a turn with. For the Claude Code add-on that is a turn it started, and one turn is counted once, however many answers it carried. For Codex it is Codex's own queue accepting the answer, which can be before any turn runs, and each answer the queue accepts is counted.
- `declined`: Codex's queue did not take the answer this time, and It will try again.
- `failed`: It gave up on putting that answer in Codex's queue. The answer stays waiting where you and the agent can see it.

`declined` and `failed` are reported only for Codex's queue. Neither is a hand-over. Because `agent.woken` is recorded without waiting for the backend, a `resumed` can also be counted for an answer whose `answer.delivered` never is.

## What is never sent

Page contents and titles, the names and data of actions, prompts, file paths, project and repository names, display and machine names, and anything else that says who you are, are never sent. Conversation ids are never sent either, nor the ids of pages or of clicks.

## What the request itself reveals

Sending anything over the network tells the receiver more than what is in the message, and this is the rest of it.

- **It shows your network address.** Every request arrives from your IP address, as any request does.
- **It shows when.** An event says only the hour it happened in, but it is usually sent within a minute of happening, so the receiver can tell when it arrived far more closely than the hour.
- **One header names It.** The request's `user-agent` is `it/0.1.0`, which is It's version, and its `content-type` is `application/json`. The runtime adds the ordinary headers every request has, such as `accept` and `accept-encoding`. It sends no cookie and no credential.
- **It shows that the events are one installation's.** Every batch from one installation carries the same id, so everything that installation reports can be put together: which days and hours you use agents, which agent apps, and each change of network address.

What the receiver keeps of this is not something this program can promise.

## How an installation is identified

It keeps a random id in `telemetry.json` in its own folder, beside the time you were told about usage reporting. Those two things are all that file holds, and a file that holds them in any other form is treated as holding neither, so that nothing is recorded or sent until a person is told again.

The id is made by the command that tells you. When it was the install script that told you, the script makes none: the id is made by the first `it` command run after it, other than the ones listed at the top of this page, whoever runs that command. Every `it telemetry on` makes a new one.

What is sent is a hash of that id. The hash hides nothing: it is a stable name for this installation, and it is the same in every batch. It is random and is made from nothing about you or your machine, so it identifies an installation and not a person: someone with two machines counts twice, and nothing in what is sent says whose the installation is.

The id lasts until you turn reporting off or on, or delete `telemetry.json`. It survives installing It again, and erasing everything It holds from the site's settings.

## How it is sent

The background service sends events in batches of up to twenty, as JSON, to `https://itcan.do/api/usage`. An event waits about thirty seconds for others to go with it, and a full batch goes at once. Each event carries an id of its own, so that a batch that arrives twice can be counted once. A request that is not answered within ten seconds is given up. An answer that points to another address counts as a failure, and the batch is never sent on to that address.

A batch that cannot be delivered is tried four more times, after waits of 2 seconds, 15 seconds, 1 minute and 5 minutes, and is then dropped. It is also dropped if the service stops while it is waiting to be tried again. The waits are counted on a clock that does not move when the machine's clock is set.

Reporting does its work after the thing it counts, and no page being published or answer being delivered waits for a request.

`IT_TELEMETRY_URL` sends the batches to another address, which is how the tests check what is sent. It has to reach the background service, which is what sends: the address is carried into the service when the service is installed, so set it before running `it setup`, or run `it service install` again after setting it. `it telemetry` shows the address that the command you ran would use, and says so when the service may be sending to another.

A batch looks like this:

```json
{
  "v": 1,
  "installation": "9c1f…a hash, 64 characters long",
  "events": [
    {
      "id": "0b7f6a52-5c0e-4e0b-9d1c-2f1f3f0a8d11",
      "name": "answer.delivered",
      "at": "2026-10-04T05:00:00.000Z",
      "properties": { "path": "woke", "after": "1 to 10 seconds", "agent": "claude-code" }
    }
  ]
}
```
