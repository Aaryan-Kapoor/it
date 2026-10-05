# What It keeps

Everything It keeps is in one folder, `~/.it`, which only your user can look inside. `IT_HOME` names another folder for it. That folder is the only copy of your pages and of the record of what was done on them, and nothing of them is kept off the machine. The one other place It keeps anything is the browsers you pair, and [What a paired browser keeps](#what-a-paired-browser-keeps) says what.

## Where everything is kept

| In `~/.it` | What it is |
|---|---|
| `service.json` | It's settings: the port, whether the network is on, and the secrets It runs its backend with. Whoever can read this file can do anything to what It holds |
| `backend/` | The backend's database and the files it stores, the backend program as it was fetched, in `bin/`, and the copies of the database that It keeps before a newer version changes it, in folders whose names begin with `before-` |
| `content/`, `content-data/` | The files of every version of every page, and the small database of the part of It that serves them |
| `machine.json`, `token.json` | This machine's identity and its key, and the short-lived token the key last earned |
| `push.json` | The keys It signs notifications with, made the first time one is needed |
| `connector.json`, `journal.jsonl` and the files beside them | How the add-ons reach It on this machine, and its record of each click it handed to an agent, by ids alone |
| `addons/` | The add-ons as they are installed into the agent apps, and a note of what was put where |
| `logs/it.log` | What the background service wrote down. `it service logs` prints the end of it |
| `telemetry.json`, `telemetry-off`, `usage.jsonl` | Usage reporting: the installation's random id, whether reporting is off, and counts waiting to be sent |
| `bin/` | The program, which is what goes on your PATH |
| `LICENSE.md`, `THIRD_PARTY_NOTICES.md` | The terms It comes under, and the notices of what it includes |

A machine that joined an It on another computer runs no backend and holds no pages, so its folder has no `service.json`, no `backend/`, no `content/` and no `push.json`.

Three things about the folder are worth knowing.

- **It never moves, replaces or deletes a database.** One that the backend program cannot open is left exactly where it is: It stops, and says what it found. Under `backend/` it removes, renames and writes over nothing that it did not make, whatever it is called. [When something does not work](troubleshooting.md) says what each such stop means.
- **The folder has to be on a disk of the computer's own.** A memory stick or a network share may not let It make its settings and its locks in the way it needs, and there It stops with `home_unfit`: name a folder on the computer's own disk with `IT_HOME`.
- **On Linux and macOS the folder's path can be at most 85 bytes long.** In a folder with a longer one the connector, which hands clicks to your agents, does not start, and says `home_too_long`.

## Backing it up

A copy of the whole folder, made while It is stopped, is a backup of everything: your pages, their state, what was done on them, your displays and this machine's identity. Put back in the same place, it is It as it was. A copy made while It is running may catch the database half written.

The copies It keeps under `backend/`, in folders whose names begin with `before-`, are not a backup. They are on the same disk as what they copy, they hold the database and not the files of your pages, only the two made last are kept, the ones there are when you erase everything go with it, and one made soon after an erasing is removed a few hours later. They are there for one thing, which the next section describes.

The site's settings can download the records It holds. That download is a record and not a backup: it has each page's state and history and the names and checksums of its files, it does not have the files, and nothing of It reads it back in. With each page It also keeps the name of the folder the page was published from, and of that folder's repository where it has one. Nothing shows that name and the download does not hold it; it goes when the page's owner erases everything. The same settings say what It keeps and for how long, and what is so of the computer It runs on: whether It starts by itself there, which ports it uses, and whether usage counts are sent.

## A newer It on the same data

A newer version of It may bring a newer backend program, newer functions, or both, and either may change the database. So before a newer backend program is started on the database, and before other functions are loaded into it, It keeps a whole copy of the database and its stored files beside it, in a folder named for what was about to be put onto it: `backend/before-<release>/`, `backend/before-functions-<hash>/`, or both in one name. The copy is made while nothing has the database open, so it is whole. Put back in the database's place while It is stopped, it is the data as it was before that change, and nothing that was published or done after it was made is in it.

- **A copy that cannot be made stops the change.** If there is no room for the copy, a newer backend program is not started, and It does not start: `copy_failed`. Where only the functions are newer, It goes on serving with the ones already loaded.
- **Functions that do not fit the data are not forced onto it.** If what the database holds does not fit the functions of the newer version, It keeps the functions that were loaded before and goes on serving with them, and everything you had is still there. Only the functions are the earlier version's. The site, the `it` command and the rest of the service are the newer version's, and where the two do not fit each other, something on the site or a command may fail. `it status` says so before anything else, and its JSON has it under `database` as `behind` and in its `hint`. The version of It that those functions came with starts on the data again and puts the two in step, as long as the newer It did not also bring a newer backend program: where it did, that program has run on the data, and the older It is refused as the next point but one says.
- **A newer backend program is fetched before it is started.** A version of It that runs a newer release of the backend program fetches it the first time it starts, so that start has to reach the program's releases, or the place `IT_BACKEND_RELEASES` names. Where it cannot, It does not start: `offline`.
- **Functions that stay are held to their port.** What a backend believes of its own address is fixed with its functions. So where the newer functions could not be loaded and It was also given another port than the one the functions in the database were loaded for, it stops: `port_changed`. Put the port back with `IT_PORT`, and it says which.
- **An older It does not start on data that is a newer one's.** The data is a newer It's once that It's functions are in it, or once a newer backend program has run on it, and from then an older It refuses it with `backend_older` and names the version to install. A loading of a newer It's functions that was cut short counts as done, since it may have been. To go back to the older It, put back the copy from before the newer one changed the database.
- **A copy made soon after everything was erased does not last.** A copy of the database that It makes before the backend program has run for about two and a half hours since everything was erased still holds what was erased, as the database's own file does for that long. It removes such a copy once that time is over, whether or not a later copy exists, so the way back that copy gave lasts only until then. The time is counted while the backend program runs, which is the only time it clears anything out of its file, and erasing everything again starts it again.
- **A newer It that changes nothing in the database leaves no copy.** A copy is made before a newer backend program and before other functions. A newer version of It that brings neither makes none, since it changes nothing there. The data is that newer It's all the same, so the older It refuses it, and for that case there is no copy to put back: the way on is the newer It.

## How long things are kept

| What | How long |
|---|---|
| A page, with its state | Until you delete it, with `it delete <id>` or on the site |
| Earlier versions of a page | The ten newest. An older one goes when a newer one is published |
| What was done on a page | A week after an agent was given it. A month if no agent ever took it |
| A notification | A month |
| A publish that was begun and never finished | An hour |
| A browser's pairing | For as long as the browser is used, and a year after it was last used, unless you end it sooner |
| A showing of a page | Until nothing has asked under it for ten minutes, and a day at most. The site then shows the page again by itself. It ends at once when the page is deleted, when its display is signed out, and when It stops |
| A machine you revoked | Its record for a month, and for as long after that as a page it made is still there |
| The key of a display you forgot | Refused for 90 days, so that the browser that held it has to be paired again to be a display |
| The background service's log | Its newest few megabytes |
| What was removed, inside the database's file | About an hour more. The next paragraph says what that means |
| The backend program's note of a task it ran in the background | About an hour after the task ran, and then, as with anything removed, about an hour more inside the database's file |

Removing something takes it out of what It shows and answers with at once. Inside the database's own file it takes longer to go: what was removed can still be read there for about an hour, counted while the backend program runs, by whoever can read the file, and traces of it can stay in the file's unused space after that. The copies kept from before an update are copies of the whole file, and hold all of it for as long as they are kept. [What It protects, and what it does not](what-it-protects.md#what-is-removed-can-be-read-in-the-databases-file-for-a-while) says all of this in full.

## How much It takes

Whatever goes past one of these is refused, in a sentence that says which, and what is already kept is left as it is. There are two exceptions, which the paragraph under the table describes: a display past the twenty-fifth may take the place of one that is there, and a browser past the fiftieth always does. Sizes are counted here as the program's own messages count them, in units of 1,024: a KB is 1,024 bytes, a MB is 1,024 KB and a GB is 1,024 MB.

| What | The most |
|---|---|
| Pages | 500, and 2 GB of their files in all, with every kept version counted |
| One version of a page | 500 files and 100 MB, with no file over 25 MB. A file's path is at most 300 bytes, and the paths of one version are at most 64 KB together |
| A page's state | 512 KB as JSON, with what the page stored for itself counted in. One value a page stores is at most 32 KB |
| What one action carries | 32 KB |
| Actions waiting for an agent | 500 on one page, and 5,000 in all. One more is refused until an agent has taken some |
| Publishes begun and not finished | 50 |
| A title, and a page's id | 200 characters, and 64 |
| A notification | 1,000 characters, and four buttons |
| A display's name, and a machine's | 60 characters, and 80 |
| Machines | 25 |
| Displays | 25 |
| Paired browsers | 50 |

Where there are 25 displays already, another is let in only if room can be made for it by letting one go. The one to go is the one longest unopened among those that were never named, take no notifications and have not been open for ten minutes. Failing that, it is the one that has gone longest unopened of all, if that is a month or more. Where there is neither, the new display is refused, and you forget one on the Displays page first. For a fifty-first paired browser room is always made, by ending the one that has gone longest unused.

It also counts how fast things come, so that one page or one command that has gone wrong cannot use up what the rest need. What comes too fast is refused with `rate_limited`, and is taken when it is sent again a moment later.

- The site takes 20 messages from one page at once, actions and stored values together, and then five a second.
- It takes 30 actions from one page before it slows that page to one a second, and 60 from all pages together before it slows them to two a second. What pages store for themselves is counted in the same way, apart from their actions. What actions carry is counted too: 4 MB at once, and then 512 KB a minute.
- Your agents together may publish 30 times at once and then once a second, and ask the displays to show a page as often. They may send 15 notifications at once and then one every two seconds.
- A showing's files may be asked for 3,000 times in a minute, and all of your showings together 30,000 times. A page of the most files loads several times over within that. Past either, the pages' port answers 429 until that minute is over.
- The files of one version may be uploaded 1,500 times in a minute, and all uploads together 6,000 times, which is three times and more what a version of the most files takes. Past either, an upload is answered 429, and the `it` command waits and sends the file again, up to five times more, before it gives the publish up as `rate_limited`.
- State may be changed 200 times at once and then ten times a second. Every change stores the whole state again and sends it to every display that shows the page, so a change is counted by the size of the whole state as well: for one page, 8 MB at once and then 2 MB a minute, and twice that for all pages together.

## What a paired browser keeps

A paired browser keeps a little in its own storage, under the address it opened the site at.

- It keeps the cookie that is its pairing.
- It keeps a key that says which display it is, a token with which that display can sign itself out, and the ids It has for you and for the browser's pairing, which say nothing of who you are.
- It keeps what you did on a page that has not reached It yet, exactly as it is to be sent: at most a hundred such actions, and thirty for one page. One that could not be sent is tried again when the site is next open in that browser. One that is more than a week old is dropped when the site next starts there, whoever it was kept for and whether or not the browser is still paired.
- Where you turned notifications on, it keeps the site's script that shows them while the site is closed.
- When a pairing of that browser ends, it keeps the name of the cookie it held for a day more, in a list of at most twenty such names. A name is no secret and opens nothing: with it the browser asks again for that cookie to be cleared, should an answer that was on its way have put it back.

Erasing everything, in the site's settings, makes each browser let go of all of that, in every tab the site is open in: the cookie that is its pairing, everything in its storage but the names of the cookies it held, and, where notifications were on, the script that shows them, with any notification of It's that is still showing. The names are kept for a day more, as the list above says, and so they are after a sign-out. The browser that asked does so at once. Every other does so the next time the site is opened in it, and one that was offline does so when it comes back: it asks whether It still holds anything for you, is told that it does not, and names the pairing it had, so that its cookie is cleared. Nothing that was under way in a tab at that moment writes any of it back. What a browser keeps for itself of your having used the site, such as its history and whether it lets the site notify you, stays until you clear it there. Clearing the site's data in a browser removes what the site kept at any time.

## Erasing everything

The site's settings can erase everything It holds and leave It installed. Afterwards It is as it was before it was first set up: every browser is unpaired and every machine forgotten, and `it setup` followed by `it site` begins again.

Erasing ends what every display and machine can do at once, and then removes every page, its files and every record of them, with the copies of the database that It had kept from before an update when it was told of the erasing. Each paired browser lets go of what it kept, as [What a paired browser keeps](#what-a-paired-browser-keeps) says. Some things stay:

- What was removed stays inside the database's file for about an hour more, and traces of it can stay in the file's unused space after that, as [How long things are kept](#how-long-things-are-kept) says. For about an hour after a task has run, the backend program also keeps its note of it, which holds the id of a record of It's own and no person's.
- A copy of the database that It makes before the backend program has run for about two and a half hours since everything was erased still holds what was erased, as the database's own file does for that long. It removes such a copy once that time is over, whether or not a later copy exists, so the way back that copy gave lasts only until then.
- The content service keeps two notes, by ids alone, so that nothing from before can be used: that every display was signed out, which it clears away the next time a page is shown more than a day later, and that the files were deleted, which it clears away the next time something is deleted more than an hour later.
- The program stays, with its settings, its keys and its log, which holds ids and counts and nothing that was on a page.
- A copy of the folder that you made yourself, and the records you downloaded, are yours to remove.
