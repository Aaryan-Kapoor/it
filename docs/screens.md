# Screens

## Opening the site

```sh
it site
```

The site is where your pages are shown. It is at `http://localhost:4700`, and a browser has to be paired with It before the site shows it anything. `it site` pairs one: it asks It for a code, and opens the site in your browser with the code in the address. The code works once, and for ten minutes. `--no-open` only prints the address.

Where you are on the machine over SSH, or it has no screen, no browser is opened there. With the network on, `it site` prints the address for another device to open, at each address the machine is reached by, and at a terminal draws the first of them as a QR code for a phone's camera. With the network off it prints the address for the machine itself, and says which command lets another device in.

A browser paired this way is yours: everything on the site can be done from it. It becomes a display at once, so pages can be shown on it, and the site's Displays page lets you name it. Until you do it goes by the kind of browser it is, such as "Chrome on Linux", and a second browser of the same kind is "Chrome on Linux 2", so that you and an agent can tell the two apart. The site also has a page for your pages, one for your machines and their agent apps, and settings, where you can download the records It holds or erase everything.

A display stays on the Displays page when the pairing of its browser is ended, and is said there to be not paired. It shows nothing until that browser is paired again, which makes it the same display, and forgetting it takes it off the page.

## Paired browsers

A browser that is used stays paired. Its pairing ends when you end it, or a year after the browser last used it. The Displays page lists every paired browser, the ones that show no display among them, with when each was paired, by whose code, and when it was last used. Each has a button that ends it, and "End all others" ends every one but the browser you are reading on.

Forgetting a display ends the pairing of the browser that showed it. Ending a browser in any of these ways ends everything that came from it as well: the screens that were paired with its codes, the machines that joined with them, and whatever came from those. The site says how many before you confirm. Signing out in a browser ends its own pairing and nothing else, so what that browser let in stays.

At most fifty browsers are paired at once: when one more is paired, the one that has gone longest unused is ended to make room, and it too is ended alone.

## Adding another screen

A phone, a tablet or a TV on the same network becomes a display in three steps.

1. On the machine It runs on, run `it network on`. Until then It answers only to that machine itself.
2. In your paired browser, open Displays and choose "Add a display". It shows the address for the other screen to open, as text and as a QR code, and a code to type.
3. On the other screen, open that address or read the QR code with its camera, and press "Make this browser a screen of It". Or open the machine's address there and type the code.

The code pairs one browser, once, and works for ten minutes. Opening the address uses nothing up: the page there says that the address was made to pair one screen, and the code is spent only when the button is pressed. So the address opened in your own browser, by whichever of the machine's names, changes nothing, and the code stays good for the other screen.

A screen paired this way can open every one of your pages and answer on any of them, can be named, takes notifications and can sign itself out. So pair only screens that are yours. It cannot delete a page, and your machines, your other displays and what It holds are looked after only from a browser paired with `it site`.

## The network

`it network on` makes It answer at every network address this machine has, which at home means other devices on the same network, and on a machine the internet can reach means the internet, over plain http: the command says so where it sees a public address, one of the internet's own addresses under IPv6, or a server rented from a company that rents them. `it network tailscale` makes it answer the devices of your tailnet and no others, `it network off` returns it to this machine only, and `it network` says which it is. At a terminal each says how the network stands in a sentence, with the addresses other devices open the site at under it. With `--json`, or where a program reads it, each prints `{ "network": true or false, "addresses": [...] }`, with `"tailnet": true` beside them where It is kept to the tailnet. `it status` says the same of the network. `it setup`, run at a terminal, asks which of the three you want as one of its steps.

### Over Tailscale

A tailnet is the private network Tailscale makes of your own devices, wherever each of them is. `it network tailscale` is for a machine with no screen of its own, and for reaching It from outside your home. It needs Tailscale installed and signed in on the machine It runs on, and on each device that is to open the site.

Kept to the tailnet, It answers a caller only from an address of the tailnet, or from the machine itself. A device on the home network that is not on your tailnet is answered nothing, at any of the machine's addresses and whatever name it asks for. The addresses It gives are the machine's name on the tailnet, such as `http://studio.tail1234.ts.net:4700`, where Tailscale's own command is there to say it, and then its addresses there. Tailscale carries what passes between your devices encrypted, so on a tailnet the first of the cautions below does not apply between them.

The addresses are the ones another device can open, such as `http://192.168.1.20:4700`, with the likeliest to work first: an address of a home network, then any other IPv4 address, then one of a private tunnel such as a VPN, then IPv6. The list is empty while the network is off. Addresses that mean this machine only or one link only, and the ones that lead to the machine's own containers and virtual machines, are left out.

The running service takes the change by itself, within a second or two. Nothing else of It is stopped, and a page that is open stays shown, at the address it has. Where no service is running, the setting is kept for when one starts. If It cannot listen on the machine's network addresses, because another program has one of its ports there, `it network on` fails with the code `cannot_listen`, the network is left off, and It goes on answering the machine it runs on.

Before you turn the network on, know these things:

- **Nothing is encrypted.** It speaks plain `http`, so whoever can watch the network can read what passes. [What It protects, and what it does not](what-it-protects.md#on-your-network-everything-travels-in-the-clear) says what follows from that.
- **Anyone on the network can reach the pairing screen.** They can do nothing else without a code, and the door lets one address try only ten wrong codes a minute.
- **An IPv6 address may reach further than your home.** With the network on, It listens on every address the machine has. An address under IPv6 is often one the whole internet could reach, and whether it can is your router's to decide, so it is worth knowing what yours lets in.
- **A screen is paired under one name for the machine.** A browser keeps its pairing for the name or the address it opened the machine by, whatever the port. So a screen that was paired at `http://192.168.1.20:4700` is not paired at the machine's host name, or at another of its addresses. If your router gives the machine another address, the screen has to be paired again. Setting a fixed address for the machine on the router avoids that. It also answers to the machine's host name, and to that name with `.local` after it, on a network that looks such names up.
- **A firewall has to let two ports through.** Another device reaches the site's port and the pages' port, 4700 and 4701 unless you chose others. A firewall on the machine that lets neither in leaves the network on and It unreachable.
- **The address `it create` prints is for the machine It runs on.** It says `localhost`, which no other device can open. On another screen, open the page from the site there.

Turn the network on only on a network where you trust every device and everyone who can join it, and run `it network off` before you carry the machine to another.
