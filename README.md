<p align="center">
  <a href="https://itcan.do">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.svg">
      <img src="docs/assets/hero-light.svg" alt="It. Your agent, as an app. A new way to interact with your agent." width="100%">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://github.com/Aaryan-Kapoor/it/releases/latest"><img src="https://img.shields.io/github/v/release/Aaryan-Kapoor/it?style=flat-square&label=release&labelColor=1f2328&color=34d399" alt="Latest release"></a>
  <a href="#install"><img src="https://img.shields.io/badge/macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-1f2328?style=flat-square" alt="macOS, Linux and Windows"></a>
  <a href="docs/licensing.md"><img src="https://img.shields.io/badge/license-source--available-59636e?style=flat-square&labelColor=1f2328" alt="Source-available"></a>
</p>

<p align="center">
  <a href="https://itcan.do"><b>itcan.do</b></a>
  &nbsp;·&nbsp;
  <a href="#install">Install</a>
  &nbsp;·&nbsp;
  <a href="https://itcan.do/#films">Watch the film</a>
  &nbsp;·&nbsp;
  <a href="docs/README.md">Docs</a>
</p>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/pages-dark.png">
  <img src="docs/assets/pages-light.png" alt="Pages agents made with It: a long weekend in Lisbon, tonight's dinner, step by step, and three looks for a coffee brand to pick from." width="100%">
</picture>

### Built for the task, and two-way

Your agent builds the page the job needs, like a whiteboard, a floor plan or a review, then works on it with you and answers on the page.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/two-way-dark.gif">
  <img src="docs/assets/two-way-light.gif" alt="On a whiteboard, Claude Code circles a wrong answer and writes a hint beside it. On a floor plan, Codex moves the armchair so the door still opens." width="100%">
</picture>

### On the screen it belongs on

Say “Hey Claude, put the PR review board up on my TV,” and there it is. Pages go on any screen you own: your laptop, your phone, your TV, or any browser you pair.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screens-dark.png">
  <img src="docs/assets/screens-light.png" alt="A pull request review on a TV, a whiteboard on a laptop and a trip on a phone." width="100%">
</picture>

### Even after you've closed the chat

A tap on the page hours later reopens the same agent on your computer, with what it knew, and it gets on with it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/after-the-chat-dark.gif">
  <img src="docs/assets/after-the-chat-light.gif" alt="The chat closed at 5:40 pm. At 11:02 pm a tap on Merge all three brings Codex back, and it merges the three pull requests." width="100%">
</picture>

### Whichever agent you use

It works with Claude Code, Codex, T3 Code, Pi, OpenCode and Hermes Agent, and you can hand a page from one agent to another.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/agents-dark.svg">
  <img src="docs/assets/agents-light.svg" alt="Claude Code, Codex, T3 Code, Pi, OpenCode and Hermes Agent" width="100%">
</picture>

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/how-it-works-dark.svg">
  <img src="docs/assets/how-it-works-light.svg" alt="Your agent builds the page. It, on your computer, shows it on your screens. Every tap goes back to your agent." width="100%">
</picture>

It runs on your own computer, beside your agent. Your agent builds the page, It shows it on your screens, and every tap goes back to the agent. Your computer has to be on. Screens join over your home network, or from anywhere over Tailscale.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/numbers-dark.svg">
  <img src="docs/assets/numbers-light.svg" alt="Half the code, for the same whiteboard, floor-plan and homework apps. 0 servers to build or deploy." width="100%">
</picture>

## Install

Paste this to your agent:

```text
Install It from https://itcan.do and set it up on this computer.
```

Or install it yourself. On macOS and Linux:

```text
curl -fsSL https://itcan.do/install.sh | sh
```

On Windows, in PowerShell:

```text
irm https://itcan.do/install.ps1 | iex
```

Then ask your agent for the first thing: **“Give me the It tour.”**

> [!NOTE]
> It is used every day on Linux, and has only been run on test machines on macOS and Windows so far.

## Learn more

- [Screens](docs/screens.md): pairing a phone, a tablet or a TV, and reaching It over your network or Tailscale.
- [Agents](docs/agents.md): connecting the agent apps you use.
- [What It protects, and what it does not](docs/what-it-protects.md), with every limit in full.
- [Network and privacy](docs/network-and-privacy.md): what leaves your computer, and what It fetches.
- [Usage reporting](docs/usage-reporting.md): every count It sends, and what it never sends.
- [All of the docs](docs/README.md), from installing to when something does not work.

## License

It is source-available. You can use it for as long as you like, for your own work too, and change it. [What the license lets you do](docs/licensing.md) explains it with examples, and [LICENSE.md](LICENSE.md) is the license itself.

Pull requests are welcome, and [CONTRIBUTING.md](docs/CONTRIBUTING.md) says how to build It and run the tests. To report a security problem, follow [SECURITY.md](docs/SECURITY.md).

<br>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/sign-off-dark.svg">
    <img src="docs/assets/sign-off-light.svg" alt="It can do that." width="60%">
  </picture>
</p>

<p align="center"><sub>
  <a href="https://itcan.do">itcan.do</a> &nbsp;·&nbsp;
  <a href="mailto:hello@itcan.do">hello@itcan.do</a> &nbsp;·&nbsp;
  Formerly Surface
</sub></p>
