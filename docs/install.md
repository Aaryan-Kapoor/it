# Installing It, and the first run

## What you need

You need a computer that runs Linux, macOS or Windows, and a browser. There is no account to make anywhere, and no other service to sign up for.

The program carries its own runtime, so nothing else has to be installed first. It does need the internet once, on its first run, to fetch the backend program it runs beside itself. [Network and privacy](network-and-privacy.md) lists that and everything else it ever asks for.

On Linux, It needs version 2.35 or newer of the system's C library (glibc), on an Intel or ARM chip. Ubuntu 22.04, Debian 12 and Fedora 36 have it, and so does everything newer than those. That is what the backend program asks for, and It cannot run without it: Rocky Linux 9 and the systems it is modelled on have 2.34, and Debian 11 and Ubuntu 20.04 have 2.31. On such a system the install script says so and does not go on into the setup. The `it` command itself still works there, so `it login` can join an It that runs on another machine. A Linux with another C library, as Alpine has, has no program at all, and the install script says that before it downloads anything.

It has been used on Linux, and nowhere else so far. Installing, running, publishing a page and removing It were run in fresh containers of Debian 12, Ubuntu 22.04 and Fedora 41, and the two refusals above were seen on Rocky Linux 9 and on Alpine. On macOS and on Windows the program starts, the install script installs it, and a first run of `it setup` passes, all on test machines. Nobody has used It on either by hand, and the background service has not been registered on either. The pages are tested in Chromium and in Firefox, and showing one has not been checked in Safari.

## Installing

```sh
curl -fsSL https://itcan.do/install.sh | sh        # macOS and Linux
irm https://itcan.do/install.ps1 | iex             # Windows
```

Each command downloads one program for your system, checks it against its published checksum and puts it in `~/.it/bin`, with the license and the third-party notices beside it in `~/.it`. It asks for no administrator rights, and it installs no runtime and no package manager. It also adds `~/.it/bin` to your PATH, by a line in your shell's profile or in your user settings on Windows. Where the folder is on the PATH already, your profile is left as it is, unless none of the files your shell reads names the folder: then only the terminal you are in has it, as the one `it uninstall` was run in does, and the line is added so that a new terminal has it too. The checksum is published in the same place as the program, so it guards against a download that was damaged or cut short, and it is not a signature.

Run at a terminal on macOS or Linux, the command says what it did in a few lines and goes straight on into the setup, which the next section describes. Run by a script or an agent, it installs, says in sentences what it did, and names the command that sets It up. On Windows it ends by naming that command. Either way it says, once, that It reports counts of its use, and how to turn that off.

No release is published yet, so these two commands have nothing to download, and the scripts are not served at that address. Until one is, It is run from a checkout of this repository, as [Contributing](CONTRIBUTING.md#running-it-from-a-checkout) describes.

The programs are built for five systems: Linux and macOS on Intel and ARM chips, and Windows on Intel. Three variables change what the scripts do. `IT_HOME` names another folder than `~/.it` for everything It keeps. `IT_VERSION` names a release other than the latest, by its tag. `IT_INSTALL_NO_PATH`, set to anything, leaves your PATH alone.

## The first run

```sh
it setup
```

`it setup` does everything It needs to exist on this machine, and at a terminal it leads you through it as a short list of steps.

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

It leads you through only where there is a terminal to ask at. Run with none, as an agent or a script runs it, it asks nothing: with none of those four options it connects no app that is not connected already, it leaves the network as it is, it pairs no screen, and it says in sentences which apps it found and which commands do the rest.

`it setup --none` does one of three things, by where it is run. On a machine that has never been set up it is a whole first run that connects no agent app. Where It is set up, it takes out every add-on It had put in and touches nothing else: the background service is neither registered nor started again. And in a folder that holds only what an earlier use of It left behind, it takes those add-ons out and starts nothing.

## It keeps running in the background

From the first run on, It starts by itself, and you do not start it again. The background service is one command, `it serve`, registered with whatever your system uses to keep a program running for one user:

- On Linux it is a systemd user unit, `it.service`. `it setup` also asks the system to keep your services running while you are logged out, so that It starts when the computer starts and not only when you log in. Where the system refuses that, It stops when you log out, and `it setup` says so.
- On macOS it is a launchd agent, `dev.it`, which starts when you log in. It is registered with your login at the Mac's own screen. On a Mac that is reached only over SSH there is no such login to register it with, and `it setup` says that it could not be registered.
- On Windows it is a scheduled task named `it`, which starts when you log on.

There is one background service for each user of a computer, under that one name, whatever folder It lives in. Setting It up in a second folder, named with `IT_HOME`, registers the service for that folder in place of the first, unless `--no-service` is given.

If It fails it is started again. `it service status` says whether It is running, whether it is registered to start by itself, and whether it is ready to hand what is done on a page to the conversations on this machine. `it service logs` prints the end of what it wrote down. `it serve` runs the same service in a terminal, until you press Ctrl-C, for a machine where you would sooner start it yourself.

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

Five commands speak to a person in this way when they are run at a terminal: `it setup`, `it site`, `it network`, `it status` and `it service status`. With `--json`, and wherever a program reads what they print, as an agent does, they print JSON, as the other commands do whoever reads them. Three commands print plain text whoever reads it, since text is what was asked for: `it help`, `it skill` and `it service logs`. And `it serve` prints what the service writes down, a line at a time.

The JSON of `it status` has `running`, whether It's door answers; `enrolled`, whether this machine is one of yours; where the `site` is; the `network`, as `on` and its `addresses`; the `database`, with the version of It and the release of the backend program that last ran on it; the `connector` and the `background` service; each agent app under `harnesses`; and, where something is wrong, a `hint` that says what to do next.

[When something does not work](troubleshooting.md) says what a start that failed says, and what to do about it.

## A newer It

The install command, run again, puts the newest program in the place of the one in `~/.it/bin`, with its license and notices. It leaves everything else in `~/.it` as it is. The service that is running goes on as the program it was started as until it is started again, and `it service install` registers it and starts it anew.

A newer It may bring a newer backend program, which it fetches the first time it starts, and newer functions for it. Before either is put onto what you already have, It keeps a copy of its database. [What It keeps](data.md#a-newer-it-on-the-same-data) says what that copy is for, and what happens where the newer It and your data do not fit.

## Stopping and removing It

`it service uninstall` stops the background service and takes its registration away, so that It does not start again with the computer. It takes away only the service that this folder registered: one that runs It from another folder is left as it is, and it says so. `it service install` registers and starts it again. An It that you started yourself with `it serve` stops when you press Ctrl-C.

However it is stopped, It is asked to stop and waited for. It stops its connector and closes its ports, and then it stops the backend program.

- **On Linux and macOS** the backend program is asked to stop and waited for, however long that takes. Nothing kills it for being slow.
- **On Windows** the backend program cannot be counted on to hear that it is to stop. Once It has closed its ports, it gives the program a second to finish what it was doing, asks it to stop, and ends it where it cannot be asked or has not gone three seconds later. The program's database comes through that as it comes through a power cut: everything it had answered for is kept, and only what it was in the middle of is lost.

To remove It altogether, run `it uninstall`. It asks first, because every page It holds on the machine goes with it, and then does these four things in order. Each can also be done by hand:

1. It takes It's add-on out of every agent app, as `it setup --none` does.
2. It stops the background service and takes its registration away, as `it service uninstall` does, and asks an `it serve` you started yourself in that folder to stop.
3. It takes `~/.it/bin` off your PATH. The install script added it with a comment, `# It`, and one line in your shell's profile, and those lines are removed; a profile that held nothing else was made by the installer and is removed too. On Windows the folder is on your user's PATH, and you take it off yourself.
4. It deletes `~/.it`. Everything It kept goes with it, the program included.

It also clears what Codex and Claude Code keep of an add-on after it is removed: their copy of it, and Codex's note that you trusted its hooks. The conversations you held are yours and are left as they are, with the messages that begin `[It]` in them.

The site's settings can also erase everything It holds and leave It installed, which [What It keeps](data.md#erasing-everything) describes.
