# It as an MCP server

An agent drives It with the `it` command, and that is how every agent app with an add-on uses it. Some agents cannot run a command on your machine and can be given a Model Context Protocol server instead. For those, `it mcp` serves the same commands as MCP tools.

```sh
it mcp --session desk
```

The server speaks MCP on its standard input and output, so the agent app starts it and nothing listens on the network. It opens no port, needs no account, and reaches nothing but the It that already runs on this machine.

## What an agent gets

Each tool is one `it` command, and does what the command does.

| Tool | Command |
|---|---|
| `it_guide` | `it skill`, and `it help <topic>`: how to write a page and read what comes back |
| `it_status` | `it status` |
| `it_create` · `it_update` | `it create` and `it update`, with the page given as one HTML document |
| `it_state` · `it_patch` | `it state` and `it patch`, with `ifRevision` to change the state only where it is still at a revision |
| `it_say` | `it say` |
| `it_open` · `it_displays` | `it open` and `it displays`, with a display named or given by its id |
| `it_list` · `it_read` | `it list` and `it read` |
| `it_wait` | `it wait`, for 50 seconds at most in one call |
| `it_actions` · `it_action` · `it_ack` | `it actions`, `it action` and `it ack` |

The server runs the `it` program for each tool and hands back what it printed, so a tool is refused exactly where the command is refused: a page under an id that belongs to another conversation answers `conflict`, and a stale revision does too.

A tool takes a page as text only. It takes no file and no folder from the agent, and saves no file an action carried.

## Which conversation the pages belong to

A page belongs to the conversation that made it. `--session <name>` names the server's conversation, so the pages it made are its own the next time the agent app starts it. Give each agent a name of its own. Without `--session`, the server is a new conversation each time it is started, and the pages of the last one are another conversation's to it.

## Hearing what you do on a page

The agent calls `it_wait` after it publishes, and calls it again when the time is up. That works in every MCP client.

A client that follows resources can subscribe to `it://page/<id>/actions` instead. The server then sends `notifications/resources/updated` for that address when you act on the page, and the agent reads the address, or calls `it_actions`, for what you did. The notification carries the page's address and nothing of the action. Watching in this way claims nothing, so `it_wait` and `it_ack` work as before. Few agent apps act on such a notification by themselves today, which is why `it_wait` is the way that always works.

## Connecting an agent

Any app that starts an MCP server from a command can use It. Its configuration names the command and its words:

```json
{
  "mcpServers": {
    "it": { "command": "it", "args": ["mcp", "--session", "desk"] }
  }
}
```

Where the app does not find `it` on its PATH, give the whole path, `~/.it/bin/it` written out in full (on Windows, `%USERPROFILE%\.it\bin\it.exe`).

`it mcp` has been run with the protocol's own TypeScript client, against the 2025-06-18 revision. It has not yet been run inside any agent app, so no app is listed here as proven.

An agent app with an add-on (Claude Code, Codex, OpenCode, Pi, Hermes) is better served by the add-on, which brings what you do on a page into the conversation by itself. [Agents](agents.md) says how to connect one.

## Agents that run on someone else's computers

ChatGPT's and Grok's connectors reach an MCP server only at a public HTTPS address, from their own computers. `it mcp` serves no such address: It answers this machine alone until you turn the network on, and nothing of It is on the internet. Those agents cannot use It through `it mcp` as it is.
