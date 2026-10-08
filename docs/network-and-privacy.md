# Network and privacy

It runs on your own computer and answers that computer alone until you turn the network on. This page says which ports it uses, what it fetches from the internet and from where, and what leaves the machine.

## What leaves the machine

Your pages and what you do on them are kept on the machine It runs on, in `~/.it`. It sends them only to the screens you paired and to your agents on the machines you enrolled, and nothing of them is sent to It's maker.

Four things do go out to the internet, and the next section describes each: the download of the backend program, a look every half hour for a newer It unless you turn that off, counts of how It is used unless you turn them off, which hold nothing of what is on a page, and a notification on its way to a browser that asked for them, whose text is sealed so that only that browser can read it. A page an agent wrote is a web page besides, and may load whatever its author put in it.

## What It fetches from the internet

It asks for four things, and nothing else.

- **The backend program, on the first run.** It runs Convex's backend program on your machine, and fetches it from that program's release on GitHub, `github.com/get-convex/convex-backend`. What arrives is kept only if it matches a SHA-256 checksum written in It's source. It is fetched once, and again only when a newer version of It needs a newer release of it. `IT_BACKEND_BIN` names a copy you already have, and then nothing is fetched. `IT_BACKEND_RELEASES` names another place to fetch the backend program from, laid out as the program's own releases are: a mirror, for a machine that cannot reach GitHub. It is an https address, or this machine itself over plain http, as `http://127.0.0.1:8080` is. Whatever it names, what arrives is kept only if it matches the checksum written in It's source. It is read wherever the program is fetched: by `it setup` on a first run, and by the background service, which is registered with the variable as it stood when the service was installed. So set it before running `it setup`, or run `it service install` again after setting it. A value that names no such place is refused with `backend_releases` before anything is asked. The program is started with its own usage beacon turned off.
- **Whether a newer It is out, every half hour, unless you turn that off.** The service asks the place It's releases are kept for one small file, `latest.json`, which says which version is newest. The request carries no id and nothing of what It holds: whoever serves it learns the address it came from and when, as with any request. `it updates off` stops it. The program itself is fetched from the same place only when you ask for it, with `it upgrade` or the Update button on the Machines page.
- **Usage counts, unless you turn them off.** It sends counts of its use to `https://itcan.do/api/usage`, under a random id. `it telemetry off` stops it, and [Usage counts](#usage-counts) below says what is in them.
- **A push service, when a notification goes to a browser that asked for them.** A browser can be told to show It's notifications while the site is closed. The notification then travels through that browser's own push service, which belongs to whoever makes the browser: Google, Apple, Mozilla or Microsoft. The text is sealed so that only the browser can read it. Browsers offer this only to a site they reach securely, which here is the browser on the machine It runs on. A screen that opens It by a plain `http` address on your network is shown notifications while it has the site open, and no push service is involved.

The install script and `it upgrade` ask `https://itcan.do/releases` for the program, unless `IT_INSTALL_BASE` named another place when It was installed (which is then noted in `releases.json` in It's folder, and looked at for updates too, until It is installed again from the usual place), which sends them on to the files of It's release on GitHub, and what arrives is kept only if it matches the checksums published with the release. A page an agent wrote is a web page, and may load whatever its author put in it.

Nothing It asks of its own backend or its own door goes through a proxy, whatever `HTTP_PROXY`, `HTTPS_PROXY` or a variable like them names where It runs. Those requests stay on the machine, or on your home network when they come from a machine that joined. The backend program is started with every such variable taken out of what it is given, so what it asks of the door goes to the door. The one request It does send through such a proxy is the download of the backend program, which a person behind a proxy needs it for. Where `IT_BACKEND_RELEASES` names this machine itself, the download is asked of this machine directly as well, and an answer that points to another address is not followed.

## Usage counts

It reports counts of how it is used, and it does so unless you turn it off. The counts go to `https://itcan.do/api/usage` under a random id for the installation: that the service started, that a page was published, that an answer reached an agent and by which path. It never reports what is on a page, what anyone clicked, or who you are. The install script says so when a person runs it at a terminal, and otherwise the first ordinary command a person runs at a terminal does; until one of them has, nothing is counted.

`it telemetry off` turns it off, and so does `IT_TELEMETRY_ENABLED=false` or `DO_NOT_TRACK=1` wherever an `it` command runs. `it telemetry` says whether it is on. [Usage reporting](usage-reporting.md) lists every event and every property, what is never sent, and what a request reveals by being sent at all.

## The ports It uses

One port is chosen, and every other is counted from it. It is 4700 unless `IT_PORT` names another. The first run writes the port into `service.json`, and wherever `IT_PORT` is set afterwards it is used in place of the one written there.

Another port is another address for the site. A browser that was paired stays paired, since its pairing is kept for the machine's name on every port. It is taken for a new display all the same, since what says which display it is was kept for the old address, and the display it was before is still listed on the Displays page. A machine that joined keeps the address it joined by, port and all, and has to be told the new one with `IT_URL`, or join again.

| Port | What listens there | Who can reach it |
|---|---|---|
| 4700 | The site, pairing, the browser's live connection, uploads from the `it` command, and everything a machine that joined asks | This machine only. Every device on the network once the network is on |
| 4701 | The pages being shown | The same |
| 4740 | The backend program, for calls to its functions | This machine only, always |
| 4741 | The backend program, for its HTTP routes | This machine only, always |

On Linux and macOS the connector takes its add-ons' requests on a socket in `~/.it` that only your user can open. Windows has no such socket, so there it listens on a port of the machine itself, which the system picks. Either way a request must show that it knows a token kept in `connector.json`.
