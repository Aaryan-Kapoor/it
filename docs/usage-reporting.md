# Usage reporting

It reports counts of how it is used, so that the person who makes it can tell how many installations are in use, what they are used for, and where something fails. It never reports what is on a page, what anyone clicked, or who you are. This page says what the program on your machine sends, what a receiver could learn from it, and what the receiver at `itcan.do` keeps.

Reporting is on unless you turn it off, and it begins with the installation: the first `it` command, or the first start of the background service, gives the installation a random id, and counts are sent from then on. Nothing is printed about it in a terminal. It is said in three places: on the first screen of It's site, in one line that links to the privacy policy at `https://itcan.do/privacy`; in that policy; and on this page.

`it help`, `it version`, `it skill`, the `it service` commands and `it telemetry` never begin it, and neither do the commands that agent apps run as hooks. So someone who runs `it telemetry off` before anything else is never given an id at all.

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

Each event is a name, the hour it happened in, an id of its own, and the properties in this table. Every property is one of the listed values: there is no free text anywhere in an event, and the program refuses to send an event that holds anything else. Where a number is counted it is sent as a band, never as the number.

The agent apps are named as `claude-code`, `codex`, `openclaw`, `hermes`, `opencode` and `pi`. An app It does not know is `other`, and `unknown` means the command was not run inside any.

| Event | Sent when | Properties and their possible values |
|---|---|---|
| `service.started` | The background service starts, including each time it is restarted, and once a day while it runs | `version`: the three numbers It's version begins with, such as `0.1.0`. `os`: `linux`, `macos`, `windows` or `other`. `arch`: `x64`, `arm64` or `other`. `installed`: `script` when the program is running from the folder the install script puts it in, `source` when Node or Bun is running it, whether from a checkout or from a copy of its files anywhere else, or `other` |
| `machine.seen` | With `service.started`, on every machine that runs It's service | `role`: `serves` for the machine It runs on, `joined` for one that joined it. `os` and `arch`, as above. `linux`: the family of Linux, one of `debian`, `fedora`, `arch`, `suse`, `alpine`, `nix` or `other`, and `none` on another system. `wsl`: `true` or `false`, whether that Linux runs inside Windows. `container`: `true` or `false`. `shell`: your account's shell, one of `bash`, `zsh`, `fish`, `sh`, `powershell`, `cmd` or `other`, and `unknown` where the system does not say |
| `app.seen` | The service has looked at which agent apps this machine has, as it starts and once a day, once for each app found | `agent`: the app. `addon`: how It's add-on for it stands, one of `connected`, `needs_approval`, `unavailable`, `too_old`, `error` or `not_connected`. `version`: the three numbers the app's own version begins with, or `unknown`. `wake`: `true` or `false`, whether closed conversations of that app are reopened on this machine |
| `installation.seen` | Once a day, on the machine It runs on | `pages`, `displays`, `machines` and `conversations`: how many of each this It holds, as one of `0`, `1`, `2 to 5`, `6 to 20`, `21 to 100` or `over 100`. `network`: `off` when It answers this machine only, `lan` when it answers your other devices, `tailscale` when it answers your tailnet alone. `background`: `true` or `false`, whether It is registered to start by itself. `push`: `true` or `false`, whether any display has notifications turned on. `age`: how long this installation has been counting, one of `under 1 day`, `1 to 7 days`, `8 to 30 days`, `31 to 90 days` or `over 90 days` |
| `setup.finished` | `it setup` comes to its end | `led`: who ran it, `person` at a terminal, `agent` in a conversation, or `script`. `kind`: `new` for an It set up here for the first time, `joined` for a machine that joined an It on another computer, `again` where It was set up already. `service`: `registered` when It starts by itself, `none` when that was not asked for, `failed` when it was asked for and is not so. `apps`: how many agent apps have It's add-on, one of `0`, `1`, `2` or `3 or more`. `ssh`: `true` or `false`, whether it was run over SSH |
| `command.run` | An `it` command ends, other than the service itself and what agent apps run as hooks | `command`: which command, one of `create`, `update`, `list`, `read`, `delete`, `rollback`, `set`, `patch`, `state`, `open`, `notify`, `displays`, `wait`, `actions`, `action`, `ack`, `setup`, `site`, `network`, `status`, `whoami`, `service`, `login`, `logout`, `uninstall`, `skill`, `tour`, `telemetry`, `upgrade`, `runs`, `updates`, `version` or `help`, and `other` for anything else that was typed. `by`: `person` at a terminal, `script`, or the agent app whose conversation ran it. `result`: `ok`, or the code of the problem it ended with, one of `invalid`, `limit`, `error`, `backend_program`, `unavailable`, `offline`, `busy`, `backend_silent`, `unauthenticated`, `timeout`, `stopped`, `settings`, `refused`, `record_unread`, `rate_limited`, `port_taken`, `not_set_up`, `lock_not_taken`, `lock_lost`, `checksum`, `not_found`, `forbidden` or `another_session`, and `other` for any other. `took`: how long it ran, in the bands of `after` below. Nothing typed after the command is sent |
| `page.published` | A page is put up, by an agent or by you, and the backend has confirmed it. The pages of It's own tour are not counted | `agent`: which agent app's conversation the command was run in. `change`: `new` or `update`. `kind`: `custom`, always, because It has no ready-made page templates. `size`: `under 10 KB`, `10 to 100 KB`, `100 KB to 1 MB`, `1 to 10 MB` or `over 10 MB`. `files`: how many files it is, one of `1`, `2 to 5`, `6 to 20` or `over 20`. `state`: `true` or `false`, whether it was given a state to start with. `actions`: `true` or `false`, whether its files call It to send something back. `pictures`: `true` or `false`, whether one of its files is a picture. `shown`: `true` or `false`, whether the same command brought it up on a display |
| `page.shown` | A display shows a page | `screen`: `phone`, `tablet`, `computer` or `tv`, as the display's browser names itself. `by`: `agent` when an agent had just asked that display for the page, `person` when you opened it |
| `screen.connected` | A display opens the site, after having been away for ten minutes or more | `screen`: as above. `sameMachine`: `true` or `false`, whether it reached It at the machine's own address |
| `display.paired` | A browser is paired and opens the site as a display for the first time | `screen` and `sameMachine`: as above. `first`: `true` or `false`, whether it is the only display there is |
| `answer.sent` | You do something on a page that is sent to the agent | `screen`: as above. `from`: `page` for something done on the page itself, `notification` for a button of a notification |
| `answer.delivered` | The backend has confirmed that your answer was handed over to an agent app for its conversation. For Codex's queue that is the queue accepting the answer, which can be before any turn has run | `path`: `heard`, `woke` or `waited`. `after`: how long after you answered the hand-over was confirmed, one of `under 1 second`, `1 to 10 seconds`, `10 to 60 seconds`, `1 to 10 minutes`, `10 to 60 minutes`, `1 to 24 hours` or `over 24 hours`. `agent`: which agent app the answer was for |
| `agent.woken` | An agent app has taken an answer to start a turn with, or has refused to. It is recorded as soon as the agent app answers, before the backend has confirmed anything | `result`: `resumed`, `declined` or `failed`. `agent`: as for `answer.delivered` |
| `notification.sent` | `it notify` has sent a notification | `agent`: which agent app's conversation sent it. `buttons`: `true` or `false`, whether it has any. `sticky`: `true` or `false`, whether it stays until dismissed. `page`: `true` or `false`, whether it is about a page. `to`: `one` display or `all` |
| `notification.ended` | You answer a notification with one of its buttons, or put it away unanswered | `how`: `answered` or `dismissed`. `pushed`: `true` or `false`, whether it had been pushed to a display that was closed |
| `tour.shown` | `it tour show` brings up a page of It's own tour | `page`: which of the tour's pages, one of `menu`, `whiteboard`, `chess`, `checklist`, `drums`, `button` or `done`. `agent`: which agent app gives the tour |
| `tour.ended` | `it tour clear` removes the tour's pages | `seen`: how many of the tour's five things had been shown, one of `0`, `1`, `2`, `3`, `4` or `5` |
| `upgrade.done` | A newer It has been put in place of this one | `from` and `to`: the three numbers of each version. `by`: `command` for `it upgrade`, `site` for the button on the site. `result`: `ok`, or `failed` when the new version is in place and It could not be started again as it |
| `service.failed` | The background service ends because something went wrong | `what`: one of `backend_program`, `backend_silent`, `backend_exited`, `port_taken`, `lock_lost`, `functions` or `door`, and `other` for anything else |
| `installation.removed` | `it uninstall` takes It off the machine. It is sent by that command itself, before anything is removed | `age`: how long the installation had been counting, in the bands of `installation.seen` |

Five of these happen between a display and the backend, where the program that sends is not: `page.shown`, `screen.connected`, `display.paired`, `answer.sent` and `notification.ended`. The backend notes each as it happens, as a name and these same properties and nothing else, and only while reporting is on. The background service takes the notes from it a few times a minute and sends them like any other event. A note nobody came for is removed after a week.

What a page's files hold is looked at once, on your machine, to answer one question: whether they call It to send something back. Only the answer, `true` or `false`, is sent.

### What the three paths mean

- `heard`: the agent's conversation was working, or the agent was already waiting for you with `it wait`, and your answer was handed to it there and then.
- `woke`: nothing was running in the conversation, and your answer was handed over to start a turn. For the Claude Code add-on that is a turn the add-on says it started. For Codex it is Codex's own queue accepting the answer. The queue starts a turn as soon as the conversation is free, and if the conversation is closed, only when it is next opened, so for Codex `woke` is counted once the queue has the answer, which can be before any turn runs.
- `waited`: It could not hand your answer over by itself, and the agent came and took it later, with `it wait` or `it ack`.

Only the Claude Code add-on and Codex's queue say that an answer started a turn. Answers handed over through the other add-ons are counted as `heard` even when they started a turn, so `heard` is counted too high and `woke` too low for them.

### What the three results mean

- `resumed`: the agent app took the answer to start a turn with. For the Claude Code add-on that is a turn it started, and one turn is counted once, however many answers it carried. For Codex it is Codex's own queue accepting the answer, which can be before any turn runs, and each answer the queue accepts is counted.
- `declined`: Codex's queue did not take the answer this time, and It will try again.
- `failed`: It gave up on putting that answer in Codex's queue. The answer stays waiting where you and the agent can see it.

`declined` and `failed` are reported for Codex's queue and for the reopening of a closed conversation. Neither is a hand-over. Because `agent.woken` is recorded without waiting for the backend, a `resumed` can also be counted for an answer whose `answer.delivered` never is.

## What is never sent

Page contents and titles, the names and data of actions, prompts, file paths, project and repository names, display and machine names, and anything else that says who you are, are never sent. Conversation ids are never sent either, nor the ids of pages or of clicks.

## What the request itself reveals

Sending anything over the network tells the receiver more than what is in the message, and this is the rest of it.

- **It shows your network address.** Every request arrives from your IP address, as any request does.
- **It shows when.** An event says only the hour it happened in, but it is usually sent within a minute of happening, so the receiver can tell when it arrived far more closely than the hour.
- **One header names It.** The request's `user-agent` is `it/0.1.0`, which is It's version, and its `content-type` is `application/json`. The runtime adds the ordinary headers every request has, such as `accept` and `accept-encoding`. It sends no cookie and no credential.
- **It shows that the events are one installation's.** Every batch from one installation carries the same id, so everything that installation reports can be put together: which days and hours you use agents, which agent apps, and each change of network address.

## What the receiver keeps

The receiver at `itcan.do` keeps every event it is sent, for good: the event's name, its hour, its id, its properties, the hash that names the installation, and when it arrived. From the request it keeps two more things and nothing else: the version of It that the `user-agent` names, and the two-letter code of the country the request came from, which the host works out. The network address itself is not written down anywhere, in the events or beside them.

An event whose name or values are not in the table above is not kept. The privacy policy at `https://itcan.do/privacy` says the same, with who keeps it and how to ask about it.

## How an installation is identified

It keeps a random id in `telemetry.json` in its own folder, beside the time counting began there. Those two things are all that file holds, and a file that holds them in any other form is treated as holding neither, so that nothing is recorded or sent under it.

The id is made by the first `it` command, other than the ones listed at the top of this page, or by the background service as it first starts, whichever comes first and whoever runs it. Every `it telemetry on` makes a new one.

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
