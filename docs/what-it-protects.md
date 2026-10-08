# What It protects, and what it does not

It is one program that a person runs on their own computer, for themselves and for the screens in their home. This page says what It keeps closed, and where that stops. The limits are in the second half, every one of them, and they are meant to be read before you decide to run It.

To report a security problem, see [the security policy](SECURITY.md).

## Who It is for

It has one person. There are no accounts and no other people's data: the first machine that is set up makes the one person It has, and every page, display and machine is theirs. Nothing in It is built to keep two people apart, or to stand up to strangers on the internet.

## What It protects

### A browser must be paired

The site shows nothing to a browser until that browser has been paired, which is trading a code for a session. A code is made only by something that is already let in: one of your machines, with `it site`, or a browser already paired as yours, for another screen or another machine. A code is a hundred random bits. It works once and for ten minutes, and the door lets one address try only ten wrong codes a minute. Nothing a stranger sends can use a code up.

The address that carries a code has it after the `#`, which a browser sends to no server. Opening the address that carries a screen's code spends nothing: the page says that the address was made to pair one screen, and the code is traded only when the person at that browser presses "Make this browser a screen of It".

A browser that is used stays paired, and one that nothing has used for a year is ended. Every call a browser makes is checked against its pairing at that moment, so ending a pairing takes effect at once.

A browser paired with `it site` may do everything. A screen paired from the Displays page may open every page and answer on any of them, be named, take and answer notifications, and sign itself out. It may not delete a page, see or change your machines or other displays, make a code, download the records or erase them.

### Every pairing can be seen and ended

Each code, and the browser or the machine that comes of it, records what asked for it. The Displays page lists every browser that is paired, whether or not it ever showed a display, with what asked for its code and when it was last used. Any of them can be ended there, and all but the one you are reading on can be ended at once.

Ending a paired browser on the Displays page, forgetting a display and revoking a machine each end everything that came from what you end: the screens that were paired with its codes, the machines that joined with them, and theirs in turn. The site says how many go before you confirm. A browser that signs itself out ends only itself. At most fifty browsers are paired at once, and one more makes room by ending the one that has gone longest unused.

### A page cannot reach the site, or another page

A page is written by an agent, and may show content that neither the agent nor you wrote. It is kept apart from the site that shows it and from every other page. Pages are served from a port of their own, and a browser is told to run each one as a sandboxed document that shares nothing with anything else: it has no cookies and no storage in the browser, it cannot read the site's pages or your pairing, it cannot read another page, and it cannot move the tab it is shown in. Only the site may frame a page.

A page's files are at an address that cannot be guessed, made for one showing on one screen. The address stops answering when nothing has asked under it for ten minutes, when it is a day old, when the page is deleted, when its display is signed out, and when It stops. A page tells the site only that it wants to send an action for itself, and how much it may send is bounded.

### The site loads only itself

The site runs no script and uses no style, picture or anything else that does not come from the site itself. It talks only to the door it came from, it frames only a page being shown, it sends a form nowhere, and nothing may frame it.

### Other devices reach only the door

It runs Convex's backend program beside itself, and that program listens on the machine's own address and nowhere else, whether or not the network is on. Other devices reach only the door, which is It's own code, and the door passes on very little: the site, pairing, a browser's live connection, the calls of a function, uploads and the pages. The backend's routes for loading functions, changing its settings and reading what it stores as its administrator cannot be reached through the door at all.

The door answers only to the machine's own names and addresses. A request that names the machine by anything else is refused, which keeps a website elsewhere from reaching It through your browser by a name that it has pointed at your machine. A page of another site is refused by the origin its browser names.

### What It asks of itself goes to itself

The `it` command, the connector and the service ask It's own backend and its own door for everything they do. None of those requests goes through a proxy that the environment names, with `HTTP_PROXY`, `HTTPS_PROXY` or a variable like them, so a key or a token that It sends to itself is never handed to a proxy. The one request It does send through such a proxy is the download of the backend program.

### What is on the disk is yours alone

It's folder, `~/.it`, is made so that only your user can look inside it, and each file that holds a secret is written for your user alone. The backend program It fetched is yours alone to read and to run, and what that program makes is yours alone as well. On Windows a file has the permissions of the folder it is in, so those files are as private as the folder: your own profile is, and a folder you name with `IT_HOME` is as private as you made it.

A machine's key is made on that machine, and its private half never leaves it. A machine proves itself by signing a statement that is good for one use, and is given a token for five minutes. Revoking a machine on the site takes effect on its next call.

### What is uploaded is what was declared

An agent publishes a page by declaring its files, each with its size and checksum, and is given leave to upload exactly those. A file that was not declared, or does not match what was declared, is refused, and a page is switched to a new version only when every file of it has been checked on the disk.

### Logs name things by id

What It writes down carries ids, counts, fixed codes and reasons. It never carries a credential, a title, a file's path, a name a person typed, an address on your network, an error's own words, or anything a page or a person sent.

One file beside the log is not like it. While a conversation that It reopened is running (Auto-wake), everything its agent app prints is kept in a file of yours alone in `logs/`, so that the app's last line can be shown on the page if it ends with an error. That can be anything an agent says. The file is removed when the run ends, and the next time It starts if It was ended first.

### What comes from elsewhere is checked

The backend program is fetched from its own release, and kept only if it matches a SHA-256 checksum written in It's source. `IT_BACKEND_RELEASES` names another place to fetch it from, which is an https address or this machine itself over plain http, and anything else it holds is refused before anything is asked. Whatever it names, what arrives is kept only if it matches that same checksum. The install script checks the program it downloads against the checksum published beside it. That second check guards against a damaged download and is not a signature: whoever could replace the program in a release could replace the checksum too.

## What It does not protect

### Other accounts on the same computer are not kept out

It protects its folder with the file permissions of your user, and that is all that stands between It and the other accounts on the machine.

- The backend program is given its secret on its command line. On most systems any account can read the command lines of the programs that are running. The key that lets its holder do anything to what It keeps can be made from that secret.
- Every port It listens on can be reached by any program on the machine, whoever runs it. That includes the backend program's two ports, which do not pass through the door.
- A website that is open in a browser on the machine can send requests to those two ports as well, since the door does not stand before them. It is answered there as anyone is who shows no credential: every function checks who is calling it, and the routes about a session answer only through the door.
- A browser's pairing is a cookie kept for the machine's name, whatever the port. A program that listens on another port of the machine, and answers under `/session` there, is sent that cookie by a paired browser that is led to ask it.
- On Windows the connector listens for its add-ons on a port of the machine. A request there must show that it knows a token, but the port itself is open to every program on the machine.

A program running as your own user can read `~/.it` and so can do anything It can. Do not run It on a computer that you share with people you would not show your pages to.

### On your network, everything travels in the clear

It speaks plain `http` and has no encryption of its own. As it stands it also cannot be put behind a proxy that adds `https` for it: the door takes every request as having come over plain `http`, and will not pair a browser that came any other way. With the network off none of that matters, because nothing leaves the machine. With the network on:

- Anyone who can watch the traffic on that network can read your pages, their state, what you do on them and what your agents are told.
- They can read a pairing code as it is traded, and a session's cookie or token as it is sent, and with any of them use the site as that browser.
- They can read the path a page's files are at. That path is the whole of what is asked for those files while the showing lasts, so whoever has it can read the page until the showing ends.
- Anyone on the network can open the pairing screen and try codes there. A code is too long to come upon by trying, and the door slows whoever tries, but the screen itself is closed to nobody.
- `it network on` makes It listen on every address the machine has. An address under IPv6 is often one that can be reached from the whole internet, wherever the router lets it be. On a laptop that is carried to another network, It is open to everyone on that network. Run `it network off` before you leave a network you trust.

Turn the network on only on a network where you trust every device and everyone who can join it.

### A paired screen sees everything

There is one person, so there is nothing to divide between screens. A screen that has been paired can open every page and answer on any of them, and what it answers reaches your agents as your answer. It stays paired for as long as it is used. Pair only screens that are yours, and end a screen's pairing on the Displays page when it leaves your hands. End a browser of your own there too if it is lost: ending it on the Displays page ends what it let in with it, where a browser that signs itself out ends only itself.

### Every machine can pair a browser as yours

A machine that is enrolled may ask for a code that pairs a browser as the person's own, which is what `it site` does. So may anything that runs as you on that machine, an agent included, and a machine that joined from another computer as much as the one It runs on. Join only computers that you would trust with everything It holds. What a machine let in is ended with it when the machine is revoked.

### Auto-wake runs an agent with nobody watching

Auto-wake is off until you turn it on, for one agent app on one machine. With it on, whatever is done on a page whose conversation is closed starts that agent again by itself, in the folder the conversation was in, and for most apps in the permission mode you last had it in. For Claude Code that includes the mode that asks about nothing.

So think of who can do something on a page. You can, from any paired browser. So can a paired screen, and whoever can pair one. On your network everything travels in the clear, so someone there who reads one request of a paired browser can send one of their own. And another account on the same computer can reach the door. What they send reaches the agent as a short text, of up to 2 KB, with the name of what was pressed: enough to ask an agent for something you did not.

What It does about it: the text is marked as coming from a page, a conversation is reopened only on the machine and for the app you switched it on for, a run ends after fifteen minutes, and Stop on the page ends it and what it started. A reopened Codex conversation is kept to Codex's sandbox, with It's own folder writable too. None of that makes an agent refuse a request. Turn Auto-wake on where you would accept that agent acting on anything a page can send, and leave it off elsewhere.

### It is not made for the public internet

Do not forward a port to It, give it a public address, or put it where strangers can reach it. It has no encryption, it answers only to the machine's own names, and its limits on how fast a caller may try things are sized for one household.

### The keys It works with are not replaced

It has no command that makes its long-lived secrets anew: the secrets in `service.json`, the key the backend signs its tokens with, and the keys notifications are signed with. Ending a browser's pairing and revoking a machine end what each was given, and leave those keys as they are. A machine's own key is replaced only by revoking the machine and enrolling it again. If someone else may have read `~/.it`, or a copy of it, the only way to new keys is a new folder: stop It, move the folder away, and set It up again, which begins with no pages.

### A page is a web page

It keeps a page away from the site and from the other pages. It does not limit what a page does in its own frame.

- A page's scripts can load anything from the internet and send anything they hold there. Do not put a secret in a page.
- A page chooses what an action says. The site tells the agent whether someone had just used the page when an action was sent, and no more than that. A page that shows content from elsewhere, such as an email or a web page, can be made by that content to send an action that the person did not choose. An agent should not take an action alone as the person's approval of something that matters, and the agent skill says so.

### A notification passes through the browser's push service

A notification for a browser whose site is closed is sent through the push service of whoever makes that browser. The text is sealed so that only the browser can read it. The push service still learns that this installation sent that browser something, when, and how large it was.

### Usage is reported unless it is turned off

It sends its maker counts of how it is used, under a random id. They hold nothing of what is on a page or what was done on it, and the request itself tells the receiver your network address. [Usage reporting](usage-reporting.md) says exactly what is sent and how to turn it off.

### What is kept is not encrypted

Your pages, their state and the record of what was done on them are ordinary files and databases in `~/.it`, and so are the copies of the database that It keeps beside it before a newer version changes it. Whoever can read the disk, or a backup of that folder, can read all of it, and can take the keys in `service.json` and `machine.json` with it.

### What is removed can be read in the database's file for a while

Deleting a page, an action that ages out, a pairing that ends and erasing everything all take effect at once in what It shows and answers with. In the file `~/.it/backend/db.sqlite3` they do not. The backend program writes a change as a new version beside the old one and a removal as a mark, and keeps the earlier versions for a time. It starts the program so that this is an hour, where the program left to itself keeps them for two weeks. So what was removed is still a row that can be read in that file for about an hour, counted while the program runs, by whoever can read the file. After that, traces of it can stay in the file's unused space until the program writes over them. Nothing of It reads any of this.

The backend program keeps one more thing of its own in that file: a note of each task it was given to run in the background, with what the task was given. That is the id of a record of It's own, and never a person's own id or anything that was on a page. It starts the program so that such a note leaves the program's tables about an hour after its task has run, where the program left to itself keeps it for a week, and from then it is a removed record like any other, for about an hour more. A task that is still to run keeps its note until it has run.

The copies of the database kept from before an update are copies of the whole file, and hold all of that for as long as they are kept, which is until two newer copies have been made or everything is erased. Which copies are the newer ones is told by the order each says it was made in, and never by the clock.

A copy of the database that It makes before the backend program has run for about two and a half hours since everything was erased still holds what was erased, as the database's own file does for that long. It removes such a copy once that time is over, whether or not a later copy exists, so the way back that copy gave lasts only until then.

Erasing everything, in the site's settings, removes every page, its files and every record of them, with the copies of the database there were when the service was first told of the erasing. Each paired browser lets go of what the site kept in it, in every tab: the cookie that is its pairing, what is in its storage, and the script that shows notifications where they were on. For a day more each keeps one thing, the name of the cookie it held, which is no secret and opens nothing: with it the browser asks again for that cookie to be cleared, should an answer that was on its way have put it back. The browser that asked does so at once, and every other when the site is next opened in it. These stay: what the paragraphs above describe, for the time they describe; two notes the content service keeps by ids alone, that every display was signed out and that the files were deleted, which it clears away later; the program, with its settings, its keys and its log, which holds ids and counts and nothing that was on a page; what a browser keeps for itself of the site having been used, such as its history; and whatever copy of the folder, or download of the records, you made yourself.

A paired browser keeps its own share, as plainly: the cookie that is its pairing, and in the site's storage there what was done on a page and has not been sent yet, in full. Whoever can read that browser's profile can read both, and [What It keeps](data.md#what-a-paired-browser-keeps) lists what a browser keeps and when it lets go of it.

### A page's address is all it takes to read the page while it is shown

The address of a page's files cannot be guessed, and whoever is given it, or sees it pass on the network, can read those files until the showing ends, which is up to ten minutes after the last request under it and a day at most. So it can go on answering for up to ten minutes after the page's tab is closed. It is not an address to keep or to pass on: the one to keep is the page's address on the site, which `it create` prints and which shows nothing to a browser that is not paired.

### Reached by a name a browser will not take, the site may frame more

Every answer for the site tells the browser what the site may load, and the only thing it may frame is a page being shown, at the pages' port of the same machine. That rule has one limit. A policy can name a host only in letters, digits, dots and hyphens, and no browser takes an IPv6 address, or a name with an underscore in it, as a source. Where the site is reached by such a name, the policy cannot say "the pages' port of this machine". It then names the pages' port on every host under the longest ending of the name that it can say: reached at `my_tv.kitchen.local`, it says `http://*.kitchen.local:` and the port. Only where it can say no ending of the name does it say the pages' port of any host, `http://*:` and the port. That is so of a name whose last part has the underscore, such as `my_tv` by itself, and of every IPv6 address. Reached in one of these ways, the site may frame whatever answers on that port number under that ending, or anywhere, which matters only if something had already got into a page of the site, and its other rules stand as they are. The pages' rule that only the site may frame them is written from the same name and has the same limit: it names the site's port on every host under that ending, or on any host.

### The backend program remembers its last calls

One record is not It's own, and holds more than It's own logs do. The backend program keeps its last thousand function runs in its memory, and nowhere else. They can be read only at the backend program's own port, with the key in `service.json`, and they are gone when the program stops. Of a call from someone who is not paired, that record keeps the name of the function that was asked for, and, where the arguments were not of the shape the function takes, the value that was wrong, as it was sent. The caller is answered nothing that quotes it, and nothing of It's writes any of it down.
