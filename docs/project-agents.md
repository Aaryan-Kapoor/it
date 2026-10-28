# Project agents, an experiment

Project agents are an experiment, and they are off on every machine until someone at that machine turns them on. With them on, you can start an agent from the site in the folder of one of your projects, with Claude Code or Codex where that app is connected on the machine, and It keeps it running there. You see how it stands, send it messages, stop it and start it again from the site, and what you do on the pages it makes comes back to it as it does for any other conversation.

Everywhere else It connects the agents you run yourself and runs none of its own. This is the one place where It runs an agent for you, which is why it is an experiment and stays off unless you turn it on.

## Turning them on

Project agents are turned on at the machine they run on, and nowhere else. The site cannot turn them on, and it cannot name a folder.

```sh
it agents on                     # turn them on for this machine
it agents add ~/code/garden      # name a folder an agent may be started in
it agents remove ~/code/garden   # and take it off the list again
it agents on --most 2            # how many may run here at once: 3 unless you say, and 8 at most
it agents off                    # stop every agent running here, and offer none
it agents                        # say how things stand
```

The site offers only the folders you named, each by its name and by where it is, with your home folder written as `~`. A folder is named as itself: It does not take the whole disk or your whole home folder. They work on Linux and macOS, with Claude Code and with Codex, and only with an app that is connected on that machine, so that the agent has It's skill and add-on. You can have 30 agents listed at most, running or stopped.

## Starting one

Once a machine offers them, the site shows an Agents tab, in a browser paired as yours. A paired screen does not see it. You choose a machine, one of the folders it offers and an agent app connected there, and you may say what the agent is to do first.

The agent runs in that folder with nobody watching. Claude Code is run in its permission mode that accepts edits, with `it` allowed and whatever your own Claude Code settings allow without asking. Codex is run in its sandbox for a workspace, with the network open and It's own folder writable, and it asks for nothing. Anything else it tries is refused, since nobody is there to approve it. It is told that It started it, that nobody is watching, and that you see what it does on its pages and the last thing it says at the end of each turn.

Each turn the agent takes is a turn of your own account with that app, as it would be in a window of your own.

## How It keeps it running

It keeps one program open for each agent, with the app's own interface for that. Claude Code is run in its print mode, written to and read as a stream of JSON, which keeps the conversation open between turns. Codex is run as its app server, which holds the agent's thread. What you send it from the site, and what is done on its pages, is given to it as its next turn once it is free, all of it together.

When an agent has had nothing to do for half an hour, It lets its program go, and the site says it is idle. The same conversation is resumed the moment something comes for it, so an agent that is on costs nothing while it waits.

What is done on an agent's pages goes to the agent and nowhere else while it is on. It is not put into Codex's queue, it is not given to It's add-on inside the agent's program, and Auto-wake does not reopen the conversation beside it.

## Stopping, starting again and It stopping

- **Stop** ends the agent's program and everything it started. What was waiting for it is dropped. Its conversation is kept by its app, and the site shows the command that opens it on that machine. Do not open it there while It runs the agent, or two programs will be writing one conversation.
- **Start again**, or **Restart** while it runs, resumes the same conversation in a new program.
- **Remove** forgets a stopped agent. Its conversation is still kept by its app.
- **When It stops**, each program is ended. When It starts again, an agent that was idle stays idle until something comes for it, and an agent that was in the middle of a turn is resumed and told that its turn was cut off, so that it looks at where things stand before it carries on.
- **When It's service dies** without stopping, the next start finds the programs it had written down, ends what is left of them, and goes on as above.
- **When an agent's program ends by itself**, the site says the agent was stopped by a problem, with the last thing the app printed, and It does not start it again until you do.
- **When a folder is taken off the list, or `it agents off` is run**, the agents there are stopped, and the site says why.
- **When you revoke the machine**, its agents are forgotten, and its connector ends them as it stops.

It never starts a second program beside one of an agent's that it could not end. Where it cannot tell for certain that something the program started has ended, because the system will not say what some process of yours was started with, it looks again the next time It starts.

## On a machine that joined

An agent on a machine that joined your It runs on that machine and is kept by its connector, in the same way. While that machine is offline the site says the agent waits for it, and what you send waits too.

## What It keeps of them

On the machine, `agents.json` in It's folder says whether project agents are on, how many may run at once and which folders are named, and `agent-runs.json` notes the program of each agent that is running, so that a service that starts again can find it and end it. In It's backend, It keeps each agent's machine, the name of its folder and where the folder is, its app, the id of its conversation, how it stands and why, and the last thing it said at the end of a turn, up to 4,000 characters. A message you send it is kept until its machine has handed it over. Removing an agent removes all of that, revoking its machine does too, and so does erasing everything. They are not in the export of your data.

[What It protects, and what it does not](what-it-protects.md#a-project-agent-runs-with-nobody-watching) says what this lets in.
