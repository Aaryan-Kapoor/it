# When something does not work

Start with `it status`. It says how things stand on this machine in a few sentences, and where something is wrong it says that first, with what to do about it. This page is for what it sends you to, and for the things it cannot see from where it runs.

## Where the log is

The background service writes down what happens in `~/.it/logs/it.log`, which only your user can read, and `it service logs` prints the end of it. The file is kept to its newest few megabytes. A line there names what happened and carries ids, counts and fixed codes. It never carries what was on a page, a name you typed, or a file's path.

Where the service could not start, the log has one line, `could not start: <code>`, and the table below says what each code means. The explanation in full sentences names folders on your machine, so it is said only to a person at a terminal: run `it serve` there to read it.

`it service status` says whether It is running, whether it is registered to start by itself, and whether it is ready to hand what is done on a page to the conversations on this machine.

If a background start fails, It waits 30 seconds, then two minutes, then ten minutes between attempts. If the machine stays offline, a request times out or another temporary failure continues, It keeps trying every ten minutes. A failure that requires repaired settings or data, or a replacement backend program, stops automatic attempts immediately. An unreadable `startup.json` is moved aside as `startup.json.unreadable`, reported once and its retry count forgotten; it does not prevent a start. `it service status` shows the last code and whether a retry is waiting or stopped. Run `it serve` in a terminal to read the full explanation. After fixing the cause, run `it service install` to retry in the background. That command clears the retry count. Changed startup settings or a newer It get a fresh attempt the next time the service starts. Once It starts successfully, a later crash restarts normally.

## What the service could not start for

The code is one of these, or the system's own code for what a file or a socket refused, such as `EACCES`.

| Code | What it met | What to do |
|---|---|---|
| `invalid` | `IT_PORT` is set, and names no port It can use. The port has to be a whole number with 41 more ports above it, which is where the backend program's two are. And neither it nor the port above it, where the pages are, may be one that no browser opens a page on: browsers keep a list of such ports, 6000 among them, and It would run there and never be opened | Set `IT_PORT` to such a port, or unset it |
| `not_set_up`, `settings` | It has not been set up in this folder. Its settings file, `service.json`, is not as It wrote it | Run `it setup`. Where the settings are not as It wrote them, put the file back as it was: it holds the keys to what It keeps, and It makes no new ones in their place |
| `record_unread` | A record that It keeps beside its database and goes by is there, and is not as It wrote it: what it notes of the database, in `backend/data.json`, or what it keeps of the erasings it was told of, in `backend/erased.json`. Such a record is never taken for one that says nothing, so nothing is started. The same code is what a setup or a joining says of this machine's identity, or of the keys it waits to be enrolled with, and what an erasing stops with where a folder named as a copy does not say which copy it is. | It names the file, and says what you can do about that one: put it back as it was, or move it away where that is safe |
| `home_unfit` | It's folder is on a disk that did not let It make a file in the one way that only one program at a time can, which is how its settings and its locks are made | Keep the folder on a disk of the computer's own, and not on a memory stick or a network share. `IT_HOME` names another folder |
| `already_running`, `lock_not_taken` | Another service holds the folder. The lock could not be taken, because another program keeps putting one in its place | It is running already: `it service status` says so. Stop the other one first if you meant to start this one |
| `cannot_list_processes` | The system's list of running programs could not be read, or one of your own programs is running and the system would not say what it was started with. Either way It cannot tell whether a backend program was left on its folder, and starts none | It reads the list with `ps`, or on Windows through PowerShell, which has to be allowed to run. Something that confines It, such as a sandbox it was started in, may keep it from that. Where a program is named, and it is a backend program, end it |
| `still_running` | A backend program left on the folder by a service that is gone is still there: it did not stop when asked, or more of them go on being started. Or something may be such a program and the system does not show it to be the backend program, so it is not asked to stop. Or a backend program that runs in another folder has this folder's database, which has a second name there: it is that folder's to stop, and is asked nothing. Or a program runs under the name this folder's settings give its backend, and nothing the system shows says that it runs on this folder's database: it may run for a copy of the folder, or have been left on this one before the folder was given another name, so it is asked nothing. Or a process has the number the folder's backend program had and cannot be told to be that program, or a backend answers for the folder and nothing says which process it is. No second one is started on the same data | It names the process by its number. Where it is a backend program left on this folder, named `convex-local-backend`, end it with an interrupt, as Ctrl-C at a terminal would, and start It again. Where it runs for another folder or for a copy of this one, stop It there |
| `offline`, `checksum`, `unsupported`, `backend_program` | The backend program could not be fetched. What was fetched is not the file It expects. None is published for this system. It could not be unpacked or started, or `IT_BACKEND_BIN` names no file | Check that the machine is online, or that the place `IT_BACKEND_RELEASES` names holds the release, and try again. The whole of it has twenty minutes to come. On a connection that is working and too slow for that, give it longer: `IT_BACKEND_FETCH_MINUTES=90 it setup`. A second `checksum` means that something between this machine and the release is changing what is fetched |
| `backend_releases` | `IT_BACKEND_RELEASES` is set, and does not name a place the backend program may be fetched from: an https address, or this machine itself over plain http, as `127.0.0.1` or `localhost` with its port. Nothing is asked of what it names, and what it holds is not said back | Set it to such an address, or unset it to fetch from the program's own releases |
| `backend_older` | The data has the functions of a newer It than this one in it, or a newer It began to load its functions into it and how that ended was never learned, or a newer backend program than this version of It runs has run on it, or one that cannot be told to be older. An older one is not started on it | Install the version it names, or a newer one. To go back to the older It, put back the copy of the database from before the newer one changed it, which [What It keeps](data.md#a-newer-it-on-the-same-data) describes |
| `copy_failed` | No copy of the database could be kept before a newer backend program was started on it, or before other functions were loaded where none that were loaded before answer: for want of room, or because something It did not make has the copy's name, which It leaves as it is | Make room on the disk for a second copy of the database, or move what has the copy's name somewhere else, and start It again |
| `port_in_use`, `port_taken`, `cannot_listen` | Another program has one of the backend program's two ports. Another has the site's port or the pages'. The door could not listen for another reason | Stop whatever is using the port, or give It another port to count from with `IT_PORT`. [A port another program has](#a-port-another-program-has) says which ports those are |
| `database_unfinished`, `database_unopened` | The backend program could not open the database. It was begun and never finished, with nothing ever loaded into it. Or it will not open for another reason. Either way nothing there is moved or removed | Where the database was never finished and It was never used on this machine, move the folder `~/.it/backend` out of the way and run `it setup` again. Anything else is said with what the backend program said of it |
| `backend_exited`, `backend_silent` | The backend program ended as soon as it was started, and what is in the folder is left as it is. It was started and did not answer, or stopped answering while the functions were being loaded | Run `it serve` in a terminal, which says what the program said as it ended, and start It again |
| `functions_refused`, `settings_refused` | The backend would not take It's functions, and none that were loaded before answer. It would not take their settings | Run `it serve` in a terminal to read why. Nothing in the database was changed |
| `port_changed` | The functions of this version could not be loaded, and the ones in the database were loaded for another port than the one It was given | Put the port back with `IT_PORT`: it names the port |
| `error` | Anything else: what stopped the start has no code of It's own and none of the system's | Run `it serve` in a terminal, which says what it was |

## What the door refused

The door is the one part of It that a browser, another screen or a machine on another computer reaches. Where it refuses a request it writes `door refused a request (<code>)` in the log, once every ten minutes for each code, with how many more like it there were since. The line says nothing of what was asked or of who asked. Most of these need nothing done: the door did what it is there for.

| Code | What it means | What to do |
|---|---|---|
| `unknown_host` | Something asked It by a name that is not this machine's | Open It by one of the addresses `it network` lists. Where it was not you, a page of another website tried to reach It through a browser by a name pointed at your machine, and was refused |
| `too_many_wrong_codes` | A pairing code came from an address that has had ten refused in the last minute | Wait a minute, and use a code made just now. Where it was not you, someone on the network is trying codes: a code is too long to come upon so, and `it network off` shuts the network out |
| `foreign_origin` | A page of another website asked for one of It's routes through a browser | Nothing. It was refused |
| `method`, `bad_request`, `no_such_thing`, `api_path`, `session_method`, `upload_method`, `download_method`, `control_method`, `call_method`, `call_type`, `call_as` | Something asked the door for an address it does not have, or in a way that It's own site and command never do | Nothing, where the site and the `it` command work: it was another program, or something looking at what answers on the port. Where a command on a machine that joined is refused so, that machine and this one may run different versions of It: `it version` says which each is, and the older is the one to update |
| `websocket_path`, `not_a_handshake`, `handshake_body`, `handshake_early`, `websocket_version`, `websocket_key` | Something asked for the live connection that the site keeps with It, at another address than the site does or not in the way a browser asks for one | Nothing, where the site stays current in your browsers: It's own site does not ask so |
| `too_large`, `too_slow`, `length_required`, `headers_too_large` | A request was longer than It takes, did not arrive in time, did not say how long it was, or had more than 16 KB of headers | Where a publish failed, the `it` command said which limit it met, and [How much It takes](data.md#how-much-it-takes) lists them. On a slow network, try again |
| `backend_unreachable`, `backend_no_websocket`, `backend_slow` | The backend program did not answer the door, did not agree to a live connection, or was not taking what a browser sent | Once is nothing: the site asks again. Where it goes on, `it status` says whether It is running, and the lines that begin `backend:` in the log say what became of the backend program |
| `not_local`, `push_not_local`, `push_no_such_thing`, `push_token`, `push_for_another_route`, `push_body_not_the_one_signed` | Something other than It's own backend asked the door to send a notification, or to pass a message on inside It | Nothing. Only It's own backend, on this machine, may ask either, and the request was refused |
| `push_malformed`, `push_not_a_push_service`, `push_too_long`, `push_subscription` | A notification could not be sent to a browser whose site is closed, because what there was to send it with was not as it should be: the request itself, the address of the browser's push service, the length of the text, or the keys the browser gave | Nothing, where notifications arrive. The notification is still shown on every screen that has the site open |
| `push_backend_keys`, `push_service_unreachable` | A notification could not be sent to a browser whose site is closed: the keys to check the request with could not be read, or the browser's push service did not answer | Check that the machine is online. The notification is still shown on every screen that has the site open |
| `accept_failed` | The system could not hand the door a connection | Once is nothing. Where it goes on, stop It and start it again |
| `content_failed`, `fault` | Something went wrong inside It while it answered | Where it goes on, report it, with the lines around it in the log: they hold ids and codes, and nothing that was on a page |

## A port another program has

It counts every port from one, which is 4700 unless `IT_PORT` names another: the site is on that port, the pages are on the one after it, and the backend program has the two that are 40 and 41 above it, 4740 and 4741. Where another program has one of them, It does not start, and says which port it was.

The other way about, a program that is not It may answer at the port where It's site would be. `it status` then says that It is not running on this machine and that another program answers at that port, and on a machine that joined, that what answers at the address is not the It it joined.

A first setup looks at the four ports before it fetches or writes anything. Where one of them is taken, by a program or by another It (another person's on the same machine, or one set up in another folder), it sets nothing up, says which, and names a first port that is free: `IT_PORT=4800 it setup`, say. The port is written into the settings of that It, so it is named that once.

Either stop the other program, or give It another port to count from. The first run writes the port into `~/.it/service.json`, and wherever `IT_PORT` is set afterwards it is used in place of the one written there, so set it where It is started. For the background service that means setting it and running `it service install` again, which registers the service with it.

Another port is another address for the site. A browser that was paired stays paired, and is taken for a new display. A machine that joined from another computer keeps the address it joined by, and has to be told the new one, as [Agents on another computer](agents.md#agents-on-another-computer) says.

`it network on` fails with `cannot_listen` where another program has one of It's ports on the machine's network addresses. The network is left off, and It goes on answering the machine it runs on.

## An agent that says It is not there

An agent app that runs commands in a sandbox may give them no network. `it` then cannot reach It, though It is running, and answers with the code `blocked`: "It could not be asked from here". `it status`, asked from there, says `"blocked": true` and gives `running` as not known, since it cannot see. Let the agent run `it` outside the sandbox, or let commands in the sandbox use the network. [Add-ons](add-ons.md#codex) says how for Codex, where one rule lets `it` out and leaves the sandbox as it is for everything else. Nothing needs starting again.

## A pairing address that does not work

A code pairs one browser, once, and works for ten minutes. An address from `it site`, or one made on the Displays page, is refused once its code has been used or its ten minutes are over, and the way on is a new one: run `it site` again, or choose "Add a display" again.

- **Too many wrong codes.** The door lets one address try ten wrong codes a minute. After that it refuses every code from that address until the minute is over, a right one included, so wait a minute and use a code made just now.
- **A screen that was paired asks to be paired again.** A browser keeps its pairing for the name or the address it opened the machine by. A screen paired at `http://192.168.1.20:4700` is not paired at the machine's host name or at another of its addresses, so open It by the address the screen was paired at. If the router has given the machine another address, pair the screen again, and give the machine a fixed address on the router to keep that from happening.
- **Another screen cannot open the address at all.** `it network` says whether the network is on and at which addresses other devices open the site. A firewall on the machine has to let the site's port and the pages' port through, 4700 and 4701 unless you chose others. An address that says `localhost` is for the machine It runs on, and no other device can open it. To have the links agents give at an address another device can open, choose one under Displays, in "Links agents give".
- **"It does not answer to this name."** It answers to the machine's own names and addresses and to nothing else. Open it by one of the addresses `it network` lists.

## A page that does not arrive, or a click that does not

`it status` says whether each agent app is connected. Where It is running and is not handing what is done on a page to the conversations on this machine, it says so, and `it service logs` says what it met. A click on a page whose agent app is not connected waits where the site shows it, and the agent takes it with `it wait`. [Agents](agents.md) says which agent apps a click reaches by itself, and where it waits.

A display with the site open brings a page up when an agent asks it to. One whose browser is closed does not open by itself.

The bar above a page says what is still waiting, though something you did later is done with, and otherwise where the last thing you did has got to. What it says tells you what to do:

| The bar says | What it means | What to do |
|---|---|---|
| Sending… | It is on its way to It | Nothing |
| Saved on this browser, not sent yet | This browser has no connection to It for the moment | Nothing. It is sent when the connection is back |
| Can’t reach It | It has not answered for a few seconds: it is stopped, or this device has lost its network | Start It (`it status` on its machine says how it stands). What you did is kept and sent then |
| Sent. Waiting for your agent | It has it, and is handing it to the agent | Nothing, for the first seconds |
| Sent. … is busy, and gets it when it is free | The conversation is open and in the middle of something | Wait for its turn to end |
| Sent. … is not listening: its conversation looks closed | Nothing on that machine was listening for it: the conversation is closed, or its app is not running | Open the conversation again, or press "Wake it", where it is offered, to have It reopen it for this and from now on. It is offered in a browser paired as yours, for what was done in the last day, on a machine that runs Linux or macOS |
| Sent. … is not connected on …, and gets it once it is connected there, under Machines | The agent app that made the page is switched off on that machine, under Machines. The machine hands nothing to such an app and reopens none of its conversations, whatever Auto-wake is set to | Connect the app again on the Machines page, or run `it wait` in its conversation to take this one thing. It is said in a browser paired as yours, for an agent app It can reopen a conversation of: any other browser says that the conversation looks closed |
| Sent more than a day ago. … gets it when its conversation is next open | It is older than anything a conversation is reopened for | Open the conversation again |
| … earlier things done here are still waiting for … | What you did last is done with, and something from before it never reached the agent | Open its conversation, or look at its machine |
| Working | It reopened the conversation, and its agent is at work. "…more waiting" counts what else you did meanwhile, and "not sent yet" what has not left this browser | Nothing. Stop, beside it, ends the agent and drops what was waiting for it |
| Stopping | You asked for the agent to be stopped, and its machine has not yet said it is | Wait a few seconds |
| … is not answering. Whether … is still at work there is not known | The machine went quiet while its agent was working: it may have stopped, or may not | Look at that machine. Stop can still be asked, and is kept for it |
| Asked to stop. … is not answering, and is told when it is back | Your stop is kept, and the machine has not heard it | Look at that machine if the work has to end now |
| Not sent yet. This browser could not save it, so keep this tab open | This browser would not store what you did, so it is only in this tab | Keep the tab open until it says it was sent |
| Couldn’t wake …, with a reason | It tried to reopen the conversation and could not: the reason follows, with the last line the agent app itself printed where it ended with an error | Put right what the reason names. It tries four times in all, further apart each time, and then leaves what you did waiting until the conversation next runs |
| Stopped, sometimes "with … more that were waiting" | You stopped the agent. What was waiting for that conversation went with the stop | Do it again if you still want it |
| Your agent got it; whether it finished is not known | It was handed over, and what became of the work cannot be told | Look at the page and the conversation before you do it again |
| Your agent has it | The agent was given it and has not changed the page since | Wait, or look at the conversation |
| Done, or Your agent could not do that | The agent said so | |
| This page has an error in it | The page's own script failed, with the words that follow | Nothing, where it ends "It has been sent to your agent" and the agent's conversation is open: the agent that wrote the page gets the error and mends the page. Where its conversation is closed, the error waits for it as a click does, and the bar says so. Where it ends "Tell your agent", say those words to it yourself. Until the page is mended, what you do on it may not be sent |
| Waiting for … to come online | The machine whose agent made the page is off: It was stopped there, which is known at once, or the machine has not been heard from for a hundred seconds, as when a laptop is closed | Start It on that machine, or wake the computer. What you did is delivered when it is back |
| Sent. … and It are of versions that do not work together, so … gets it once the one that is behind is updated. The Machines page says more | The machine joined an It of another version than its own, and the two do not speak the same way. The machine stays joined and online, and hands nothing to an agent and reopens no conversation meanwhile. The Machines page says "Online, paused" beside it | Update It on whichever is behind: `it status` on that machine says which. What was done on the page is handed over by itself within a minute of the two fitting again |
| Sent. … is still asking It whether the two work together, and hands it to … once it knows | The machine has not yet been able to reach the It it joined to ask which version it speaks, as right after it starts, or while that It cannot be reached from it | Nothing, where it passes within a minute. Where it does not, see that the machine can reach the address it joined at (`it status` there says what it could not reach) |
| … was removed from It | The machine the page was made on was revoked, or left with `it logout`. What you do on the page reaches its conversation only while that is open on one of your machines, and the page belongs to that machine from then on | Open the conversation again on a machine that has joined, or ask any agent to bring the page up, which makes it that agent's |

Once the agent has changed the page after what you did, the bar stops saying "Your agent has it": the answer is on the page. What is still waiting goes on being said, and "Done" or a failure is said for ten minutes.

If a page says that a turn from before may still be running, or `it status` says that some conversations are not reopened for now, run `it runs` on that machine. It lists what It has reopened and what it holds back: a conversation whose earlier run it could not check on or end, or every conversation where it could not read its own note of what was running (kept as `runs.json.unreadable` in its folder). A conversation whose run could not be checked on is reopened again once It can verify that its processes are gone, or once the machine has been started again. You can also check that no agent It started is still running there and run `it runs clear`. Where it was the note that could not be read, starting the machine again does not put that right, so check and clear it in the same way.

A run is recorded before the agent gets work, so a full disk cannot erase that record. If the connector crashes, restarting It checks the run and any processes carrying its mark, ends those it finds, and releases the hold once it can verify that they are gone. If the system cannot list or identify the processes, the conversation stays held. It checks again before reopening it. An older uncertain record without a run mark cannot identify detached children, so that hold stays until you restart the machine or check that nothing from the run is still working and use `it runs clear`.

If the disk cannot save the notice that you pressed Stop, It keeps the run's record and the backend's Stop. It retries saving the notice while it runs. The conversation stays held until the notice is safe, and its next reopened turn is told not to continue the stopped work.

On a machine that joined an It, `it status` may say that the two are of versions that do not work together, and which of them to update. The machine stays joined. Nothing done on a page is handed to an agent on it until the two fit, which It asks about every minute, so there is nothing to do after the update but wait a moment.

A page that a conversation made belongs to that conversation until another one brings it up or takes it, so what you do on it goes to the agent you last asked to show it.

If the connector cannot read `delivery-recovery.json`, it keeps the file as
`delivery-recovery.json.unreadable`, reports this once in its log and continues delivery.
A click may be delivered again; its id lets the agent recognise it. Erasing everything
removes both files. If the file could not be moved, the log says where it remains.

Messages you send above a page and answers you choose in notifications are saved before they are sent. Reopening the site under the same pairing retries them. If a saved request is too old to retry safely, check what your agent received before sending it again. A typed message refused during recovery remains in the composer with the reason. A Stop still needs its tab until It confirms it, and automatic recovery waits for that confirmation. A retry of Stop applies only to the run you saw when you pressed it. If It asks you to reload before stopping or answering a notification, reload and check what is shown before acting again.

If It says "Reload It before sending new requests", reload the site to use the service's current version. An older site left open during an update cannot safely send a new request without a replay deadline. It can still confirm a request whose receipt the service has kept. Check what your agent received before repeating an older saved request.

## Older backend functions

If an update cannot load its backend functions, It keeps serving with the functions already loaded. The site shows this beside its pages and on Machines. Some pages or controls may fail because the site and functions differ. In an owner browser, the warning points to `it status` on the machine It runs on for the reason. After resolving the reported problem, restart It to retry loading the functions. `it service logs` shows what the service met. A paired screen shows the warning and asks you to open your owner browser.

Machines compares the running versions already reported by the host and joined machines. A joined machine can say it is behind before its next release check. That alone does not offer an update: a release must also have been found by that machine.

## The Windows command is missing after an interrupted update

If an install or update was stopped while it was replacing `it.exe`, run the install command again. That restores the command without removing your pages or settings. Do not choose a program from the files named `it.old.*.exe` yourself.

A service registered by this version can restore the exact previous program recorded by an interrupted install or update. It checks the writer's process number and creation time, so an unrelated process that later receives the same number does not prevent recovery. Once the writer has stopped, it checks that the file matches the recorded checksum before giving it the `it.exe` name again. It leaves a program already at that name alone. A missing or unreadable record, or a file that does not match it, needs the installer again.

An older service launcher has no recovery step. Once the command is available, run `it service install` to refresh that launcher. A terminal command cannot repair its own missing executable, and a computer with no background service also needs the installer run again.
