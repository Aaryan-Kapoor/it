# Installing It, and the first run

The installer and `it setup` keep an `installation.json` record in It's folder. With no `IT_HOME`, an installed standalone command uses the folder above its real `bin` directory, including when the command was reached through a symlink. A custom installation therefore keeps using its own folder in new terminals. An explicit, nonempty `IT_HOME` always wins, including a relative path resolved from your current directory. An empty value is treated as unset. Commands run from source or a package use `~/.it` unless `IT_HOME` is set. The same discovery works for a legacy standalone installation with its original licence and notices files beside `bin`, so an older updater can replace the program safely. A bare program copied into a shared bin directory still uses `~/.it`. Two installed programs can each have their own data folder, although only one background service is registered per user.

## What you need

You need a computer that runs Linux, macOS or Windows, and a browser. There is no account to make anywhere, and no other service to sign up for.

The program carries its own runtime, so nothing else has to be installed first. It does need the internet once, on its first run, to fetch the backend program it runs beside itself. [Network and privacy](network-and-privacy.md) lists that and everything else it ever asks for.

The x64 downloads include Bun 1.3.11's standard runtime, which requires AVX and AVX2 and targets Intel Haswell or AMD Excavator and newer processors. These are [Bun's stated CPU requirements](https://github.com/oven-sh/bun/blob/af24e281ebacd6ac77c0f14b4206599cf4ae1c9f/docs/installation.mdx#cpu-requirements). The backend program's minimum CPU instruction set has not been established, and the complete service has not been validated on older x64 processors or an emulator configured for them. The installer does not check CPU instructions before starting the program.

On Linux, It needs version 2.35 or newer of the system's C library (glibc), on an Intel or ARM chip. Ubuntu 22.04, Debian 12 and Fedora 36 have it, and so does everything newer than those. That is what the backend program asks for, and It cannot run without it: Rocky Linux 9 and the systems it is modelled on have 2.34, and Debian 11 and Ubuntu 20.04 have 2.31. On such a system the install script says so and does not go on into the setup. The `it` command itself still works there, so `it login` can join an It that runs on another machine. A Linux with another C library, as Alpine has, has no program at all, and the install script says that before it downloads anything.

It has been used on Linux and on Windows, and on macOS only on test machines so far. Installing, running, publishing a page and removing It were run in fresh containers of Debian 12, Ubuntu 22.04 and Fedora 41, and the two refusals above were seen on Rocky Linux 9 and on Alpine. On macOS, on an Intel and on an ARM chip, and on Windows, the install script installs the program, and the product's browser tests pass in their short form, which sets It up, pairs a browser, publishes pages and answers them. On both, the background service was registered, came back by itself after it was ended from outside as a crash ends it, was left running by a second `it setup`, and was taken away again. On Windows it has also been installed with the one line, set up, updated and used by hand, on one laptop. Nobody has used It on a Mac by hand. The pages are tested in Chromium and in Firefox, and showing one has not been checked in Safari.

## Installing

```sh
curl -fsSL https://itcan.do/install.sh | sh        # macOS and Linux
irm https://itcan.do/install.ps1 | iex             # Windows
```

Each command downloads one program for your system, checks it against its published checksum and puts it in `~/.it/bin`, with the licence and the third-party notices beside it in `~/.it`. It asks for no administrator rights, and it installs no runtime and no package manager. It also adds `~/.it/bin` to your PATH, by a line in your shell's profile or in your user settings on Windows. Where the folder is on the PATH already, your profile is left as it is, unless none of the files your shell reads names the folder: then only the terminal you are in has it, as the one `it uninstall` was run in does, and the line is added so that a new terminal has it too. The checksum is published in the same place as the program, so it guards against a download that was damaged or cut short, and it is not a signature.

On macOS and Linux the shell named by `SHELL` selects these files. Missing files are made, and an existing profile that is a symlink is written through to its target.

| Shell | Files that receive the PATH line |
|---|---|
| bash | `~/.bashrc`, and the first existing file in `~/.bash_profile`, `~/.bash_login`, `~/.profile`. If none exists, `~/.profile` is made |
| zsh | `.zshrc` in the directory zsh reports after reading `.zshenv`. This includes a `ZDOTDIR` set there without `export`, and otherwise uses zsh's inherited `ZDOTDIR` or your home directory. Zsh has five seconds to answer. If it fails, hangs or reports a relative directory, the installer leaves the file alone and says to add the line yourself |
| fish | `$XDG_CONFIG_HOME/fish/conf.d/it.fish`, or `~/.config/fish/conf.d/it.fish` when that variable is unset |
| Any other shell, or no `SHELL` | `~/.profile` |

On Windows the installer edits your account's PATH in the registry, and edits none of these shell files.

Run at a terminal, the command says what it did in a few lines and goes straight on into the setup, which the next section describes. On macOS and Linux it says there that it is downloading and shows the program as it comes. A slow download is waited for, however long it takes, and one from which nothing has come for a minute is given up: the command then says that nothing was installed, and to run it again. Run by a script or an agent, it installs, says in sentences what it did, and names the command that sets It up, and the two commands an agent goes on with, which ask nothing at a terminal. Nothing is said at a terminal of the counts It reports of its use: the first screen of its site says it, and [Usage reporting](usage-reporting.md) says what is sent and how to turn it off.

The programs are built for five systems: Linux and macOS on Intel and ARM chips, and Windows on Intel. Three variables change what the scripts do. `IT_HOME` names another folder than `~/.it` for everything It keeps. `IT_VERSION` names a release other than the latest, by its tag. `IT_INSTALL_NO_PATH`, set to anything, leaves your PATH alone.

To have a computer join an It that runs on another one, give the install script the joining as its arguments. On macOS and Linux, use `curl -fsSL https://itcan.do/install.sh | sh -s -- login --url <address> --code <code>`, which is the line that It's site shows under Machines, "Add a machine". In PowerShell, use:

```powershell
& ([scriptblock]::Create((irm https://itcan.do/install.ps1))) login --url '<address>' --code '<code>'
```

Replace the address and code with the ones the other computer shows. Keep each argument separate, and quote values that contain spaces. The program is installed and then joins, and no local It is set up on that computer. If joining fails, the installed program stays and the script says that joining failed. Run `it login` again with a new code. [Agents on another computer](agents.md#agents-on-another-computer) has the rest.

## The first run

```sh
it setup
```

`it setup` does everything It needs to exist on this machine, and at a terminal it leads you through it as a short list of steps.

The first time, it begins by asking where your It is. "On this computer" sets It up here, as the steps below describe. "On another computer of mine" is for a second computer: It runs on one of your computers, and the others join it, so that the agents on all of them put their pages on the same screens. Joining takes the line that the first computer's site gives under Machines, "Add a machine", which you paste when you are asked for it. [Agents on another computer](agents.md#agents-on-another-computer) has the rest.

Before downloading the backend, setup checks the agent apps. If every app It can connect to is too old, it says which versions are installed and required, and stops. Update an app and run setup again, or use `it setup --none` to continue without connecting one. A machine with no agent app can still be set up. Each command used to check an app has fifteen seconds to answer, and a later setup checks again.

1. It fetches the backend program, once, and checks it against a checksum written in It's own source. It is about 60 MB to download, and a bar shows how far it has got.
2. It makes It's settings, which hold the port It listens on and the secrets it works with, in `~/.it/service.json`.
3. It registers It as a background service for your user, and starts it.
4. It enrols this machine as the one your agents run on.
5. It lists the agent apps it found on this machine, for you to tick the ones to connect, and installs It's add-on into each.
6. It asks how you will reach It: from this computer only, from your home network, or over Tailscale. [Screens](screens.md#the-network) says what each lets in.
7. It pairs your first screen. On your own computer it opens the site in your browser. Over SSH, or on a machine with no screen, it prints the address for another device to open, with a QR code of it, and waits until a browser has paired or you press Enter.
8. It says what is left for you to do, if anything is, and the one sentence to say to your agent: "Give me the It tour."

Then `it site` pairs another browser whenever you want one, as [Screens](screens.md) describes.

Running `it setup` again is safe. It finds what is already done and puts right what is not, and one setup or joining at a time works in a folder: a second one started meanwhile says that it is waiting, and goes on when the first has finished. It is also how you change which agent apps are connected: `--all` connects every one it finds, `--only claude-code,codex` connects the ones named, `--none` connects none, and `--yes` connects every one it would otherwise ask about. `--name` gives the machine a name other than its host name. `--no-service` leaves the background service out.

It leads you through only where there is a terminal to ask at. Run with none, as an agent or a script runs it, it asks nothing: with none of those four options it connects no app that is not connected already, it leaves the network as it is, it pairs no screen, and it says in sentences which apps it found and which commands do the rest. An agent that has just set It up for you can give you the tour without your saying anything to it: it runs `it tour --wait`, which waits until you press "Take the tour" on the first screen of the site and then prints the tour for it to give. That screen also says what such a setup left out: the other agent apps it found, and how to add another screen.

`it setup --none` does one of three things, by where it is run. On a machine that has never been set up it is a whole first run that connects no agent app. Where It is set up, it takes out every add-on It had put in and touches nothing else: the background service is neither registered nor started again. And in a folder that holds only what an earlier use of It left behind, it takes those add-ons out and starts nothing.

## It keeps running in the background

From the first run on, It starts by itself, and you do not start it again. The background service is one command, `it serve`, registered with whatever your system uses to keep a program running for one user:

- On Linux it is a systemd user unit, `it.service`. `it setup` also asks the system to keep your services running while you are logged out, so that It starts when the computer starts and not only when you log in. Where the system refuses that, It stops when you log out, and `it setup` says so.
- On macOS it is a launchd agent, `dev.it`, which starts when you log in. It is registered with your login at the Mac's own screen. On a Mac that is reached only over SSH there is no such login to register it with, and `it setup` says that it could not be registered.
- On Windows it is a scheduled task named `it-<account SID>`, which starts when that account logs on. Each Windows account has its own task. Setup moves a task named `it` to the account's name only when its principal is that account and its action is It's launcher, including one in a previous installation folder. It asks each owned installation to stop and waits before replacing either task. Removal takes away only tasks for the current installation folder. Tasks belonging to another account or another Task Scheduler folder are left alone. Each account still needs its own It folder and ports.

There is one background service for each user of a computer, under that one name, whatever folder It lives in. Setting It up in a second folder, named with `IT_HOME`, registers the service for that folder in place of the first, unless `--no-service` is given.

On macOS, It waits up to five minutes for launchd to confirm that the earlier service has unloaded before loading its replacement. If it is still unloading, It restores the earlier definition and tells you to retry once it has stopped. If loading a replacement fails after the earlier service has unloaded, It restores the earlier definition and asks launchd to load it again if it had been loaded. If that fails too, It says both failures and leaves the earlier definition for a retry.

If It crashes after starting, it is started again. Temporary failures to start have increasing waits, up to ten minutes, and keep retrying at that interval until the failure clears. Failures that require repaired settings or data, or a replacement backend program, stop automatic attempts immediately. [Troubleshooting](troubleshooting.md#where-the-log-is) explains how to retry after fixing the cause. `it service status` says whether It is running, whether it is registered to start by itself, and whether it is ready to hand what is done on a page to the conversations on this machine. `it service logs` prints the end of what it wrote down. `it serve` runs the same service in a terminal, until you press Ctrl-C, for a machine where you would sooner start it yourself.

## How things stand

`it status` says how things stand on this machine, in a few sentences. What is wrong comes first, where something is, with what to do about it. Then it says whether It is running and where its site is, whether this machine is enrolled and under which name, whether the network is on, each agent app and whether it is connected, and whether It is registered to start by itself:

```
It is running on this machine, and its site is at http://localhost:4700.
This machine is enrolled as “studio”.
The network is off, so It answers this machine only. `it network on` lets your other devices on the same network reach it.
Claude Code is connected.
Codex is not connected.
Run `it setup` to choose which agent apps are connected.
It is registered with the system to start by itself (active).
This is It 0.1.0.
```

Some commands speak to a person in this way when they are run at a terminal: `it setup`, `it site`, `it network`, `it status`, `it service status`, `it list`, `it displays`, `it whoami`, `it upgrade`, `it updates` and `it uninstall`. With `--json`, and wherever a program reads what they print, as an agent does, they print JSON, as the other commands do whoever reads them. Four commands print plain text whoever reads it, since text is what was asked for: `it help`, `it skill`, `it tour` and `it service logs`. And `it serve` prints what the service writes down, a line at a time.

Command failures say what went wrong and what to do next in sentences at a terminal. With `--json`, through a pipe, and for an agent, they keep the structured error with its code, message and any hint. Failures go to standard error in either form. An option that belongs to another command is refused before the command reads input or changes anything.

The JSON of `it status` has `running`, whether It's door answers; `enrolled`, whether this machine is one of yours; where the `site` is; the `network`, as `on` and its `addresses`; the `database`, with the version of It and the release of the backend program that last ran on it; the `connector` and the `background` service; each agent app under `harnesses`; and, where something is wrong, a `hint` that says what to do next.

[When something does not work](troubleshooting.md) says what a start that failed says, and what to do about it.

## A newer It

It looks every half hour for a newer version of itself, and says so when one is out: on the Machines page of the site, under the machine, and in `it status`. Two ways put it in place.

- **`it upgrade`**, on the machine. It downloads the newest program, checks it against the checksum published beside it, starts it once to see that it runs on this system and is newer, and only then puts it in the place of the one that is there, with its licence and notices. A download that does not match, or a program that does not start, changes nothing. Updaters that use the lock beside the installed program put their programs in place one after the other, even when they use different data folders. Each checks the installed version while holding that lock and leaves an equal or newer version in place. Where It is registered to start by itself from this folder, it is then started again as the new version, with the settings its registration was given, such as another port, kept where the terminal names none of its own; where you started it by hand with `it serve`, stop it and start it again. `it upgrade --check` only says whether a newer one is out.
- **Update**, on the Machines page, in a browser paired as yours. It asks that machine to do the same. Nothing in the asking says which version or where from: the machine fetches what the place releases are kept says is newest. On Linux and macOS the service is then started again as the new version. On Windows, and wherever It was started by hand with `it serve`, the program is put in place and the page says what starts It again there: `it setup` on Windows, and stopping and starting `it serve` elsewhere.

Standalone setup holds the same program lock while it writes the service definition and add-ons. It checks its version after taking the lock. If the installed program has changed, or its version cannot be checked, setup stops and asks you to run `it setup` again. An upgrade that cannot take the lock within two minutes stops without replacing the program and can be tried again after setup finishes.

An updater already running code from before that lock can still overwrite a newer installation with its older download. Installing a new program does not change code that is already running. Stop and wait for such an updater, including one in an older service, before starting another upgrade. The lock cannot make that older code wait or check the installed version. A setup running code that does not take this lock can also write older service definitions and add-ons, so let it finish before upgrading.

Where several machines share one It, the machine It runs on is updated first, and the site says so on the others until it is. Each machine is updated by itself.

`it updates off` stops It looking, and `it updates on` has it look again. Setting `IT_UPDATE_CHECK=false` where It is started stops it too, whatever `it updates` says, until that is taken away and It is started again. The background service is started by your system, with none of what a terminal has set, so where `it setup` or `it service install` is run with that variable set, it is written down as `it updates off` writes it, and `it updates on` has It look again. Asking sends nothing about your installation: [what It fetches](network-and-privacy.md#what-it-fetches-from-the-internet) says what the request is. An It that was installed from another place than the usual one, with `IT_INSTALL_BASE`, looks there, and is updated from there.

What an upgrade trusts is what an install trusts: the place it downloads from, over https, and the checksums published there. It is not a signature.

The install command, run again, does the same by hand: it puts the newest program in the place of the one in `~/.it/bin`, with its licence and notices, and deletes none of your pages or settings. Run at a terminal, on any of the three systems, it then goes on into `it setup`, as it did the first time, which starts the service again as the new program. Run where there is no terminal, as a script or an agent runs it, or with `IT_INSTALL_PLAIN` set to anything, it stops once the program is in place: the service that is running goes on as the program it was started as until `it setup` is run, or `it service install`, which registers it and starts it anew.

A newer It may bring a newer backend program, which it fetches the first time it starts, and newer functions for it. Before either is put onto what you already have, It keeps a copy of its database. [What It keeps](data.md#a-newer-it-on-the-same-data) says what that copy is for, and what happens where the newer It and your data do not fit.

## Stopping and removing It

`it service uninstall` stops the background service and takes its registration away, so that It does not start again with the computer. It takes away only the service that this folder registered: one that runs It from another folder is left as it is, and it says so. `it service install` registers and starts it again.

On Linux, where `it setup` was what had your services kept running while you are logged out, taking the service away turns that off again, with `loginctl disable-linger`, and `it uninstall` does the same. That setting is your account's and not It's alone: any other service of yours that has come to count on it since then stops when you log out, and `loginctl enable-linger` turns it back on for them. Where the setting was on before It came, or the system would not say whether it was, It leaves it as it is. If another installation takes over the service, the unchanged note that It enabled lingering follows it. Removing the earlier installation keeps lingering enabled for the registered service. A modified or linked note stays untouched. An It that you started yourself with `it serve` stops when you press Ctrl-C.

However it is stopped, It is asked to stop and waited for. It stops its connector and closes its ports, and then it stops the backend program.

- **On Linux and macOS** the backend program is asked to stop and waited for, however long that takes. Nothing kills it for being slow.
- **On Windows** the backend program cannot be counted on to hear that it is to stop. Once It has closed its ports, it gives the program a second to finish what it was doing, asks it to stop, and ends it where it cannot be asked or has not gone three seconds later. The program's database comes through that as it comes through a power cut: everything it had answered for is kept, and only what it was in the middle of is lost.

To remove It, run `it uninstall`, which asks first because it deletes the databases, keys and page files. Before taking its add-ons out of the agent apps or deleting data, It stops the registered service, a manually started `it serve` and any backend program left running. If it cannot establish that the backend is gone, including when a backend folder has unreadable settings, it keeps the folder and add-ons for a retry. Another service cannot start in the folder while its files are being removed, and uninstall holds the setup, installer, program and add-on locks so that an installation, upgrade or setup must finish first, including setup run from source. If setup or an add-on change is still at work, or a lock cannot be read, uninstall refuses before changing services or files. On Linux and macOS it removes the installer's `# It` comment and exact PATH line from shell profiles, leaving other lines alone. It removes a profile that becomes empty unless it is a symbolic link, whose target is left empty. On Windows it removes that bin folder from the account's PATH and leaves other entries unchanged.

The folder must have the `installation.json` record written by the installer or `it setup`, or the running standalone program with its original licence and notices. When setup, login or uninstall checks a damaged record, It keeps it as `installation.json.unreadable` and says so once; if one is already kept aside or the record cannot be moved, it stays where it is and It says why. Setup and login refuse a damaged record that could not be moved, before login uses an invite. Because a damaged or linked record cannot prove ownership, a folder without a readable record can be identified only by the standalone program running from its own `bin/it`, or `bin/it.exe` on Windows, with the original licence and notices beside `bin`. For an older custom installation, set `IT_HOME` to its folder and run that installed program, or install It there again to write the record. For an older installation run from source, run `it setup --none --no-service` with the same `IT_HOME` to write the record, or inspect and remove its files by hand. Setup refuses a non-empty folder that has no It records or installed program, so a mistaken `IT_HOME` cannot mark a project for later removal; choose an empty folder or an existing It home instead. File names or JSON that resemble It's records alone never authorise removal.

Once the folder is identified as It's, uninstall deletes `backend/`, `content/`, `content-data/`, `logs/`, `publication-pending/`, `addons/` and `bin/` whole, including their subfolders, so page files with unreadable manifests, database copies with damaged records, backend storage and changed add-on sources go too. At the top level it removes only recognised files, including `startup.json`, and leaves unknown files, unknown folders and symbolic links in place; links inside It's subfolders are removed without following them to their targets. It lists any top-level entries that remain and reports `removed: false` in JSON, so you can inspect them before deleting anything yourself. If the home itself is a link, its target and the link are removed only once the target is empty.

Where an add-on cannot be taken out, It keeps the whole `addons/` and `bin/` folders with `installation.json`, so that running the same installed program's `uninstall` again can finish. The data folders are still deleted. Deleting the retained folders yourself leaves the add-on in its agent app.

On Windows the running program cannot delete itself. It first moves itself to a temporary location, says where, and asks Windows to delete it the next time you sign in. The path stays as a literal value under `HKEY_CURRENT_USER\Software\It\PendingRemoval` until deletion succeeds. If the request cannot be registered, or the file remains afterwards, It says to delete it yourself. You can also delete it before signing in again.

On macOS and Linux uninstall checks all the bash files in the table, `~/.zshrc`, `.zshrc` under an inherited `ZDOTDIR`, the effective zsh directory when `SHELL` names zsh, and the fish file under the current `XDG_CONFIG_HOME`. It removes only the exact installer line for this It folder, its comment, and its preceding blank line. Other contents stay. If you changed your shell or its configuration directory after installation, check its former files yourself. A zsh that cannot report its directory is called out, and that unknown file cannot be cleaned up automatically.

When uninstall changes a profile or Codex's settings, it keeps the original until the change is confirmed, then deletes it. Copied add-on originals whose bytes still match It's record are also deleted after a successful replacement or removal, including leftovers found during uninstall. Failed changes and personal edits remain available for recovery. See [Recovery originals](data.md#recovery-originals) for their names, the limit of 20 unresolved copies per file, and how to restore or remove them.

It also clears what Codex and Claude Code keep of an add-on after it is removed: their copy of it, and Codex's note that you trusted its hooks. The conversations you held are yours and are left as they are, with the messages that begin `[It]` in them.

The site's settings can also erase everything It holds and leave It installed, which [What It keeps](data.md#erasing-everything) describes.
