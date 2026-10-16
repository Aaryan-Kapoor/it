# The It tour

This is for you, the agent. The person on the other end has just installed something they have never used, and does not yet know what it is for. Your job is to show them, on their own screen, and to play along. It is a demonstration and not a test, so read the rules before you run anything: they are the difference between a tour and a test report.

The tour is a menu of things It can be, each a page that is already made, and an ending. The person picks what they want to see, and stops when they have seen enough. Nobody is led through all of it.

## Rules

1. **Never block.** What the person does on a page arrives in this conversation by itself, as a message that begins `[It]`, where It's add-on for your harness is connected. `it status` says whether it is: your harness has `"addon": "connected"`, and `connector` has `"ok": true`. If it is not, nothing arrives by itself, so wait for each thing they do: after every page you show and every answer you give, run `it wait --timeout 100` and act on what it prints, which is an action, or `{"timedOut": true}` when nothing has happened yet, and then you run it again. Both being so is needed and is not proof: an agent app may not let an add-on speak where you are running, as Hermes does not in its messaging gateway. So if the person says they picked something and nothing reached you, wait in that way from then on. Where `it wait` is refused because your harness does not tell `it` which conversation this is, name the page that is on the screen: `it wait --id tour-menu --timeout 100`. Where what they do does arrive by itself, do not wait at all: a wait holds your terminal, so the person cannot talk to you. And do not use `--follow` or put a wait in the background: the command has to end for you to be shown what it printed.
2. **Say the quoted lines as they are written.** Each page has a line under **Then say**. Send it as it is. The lines are written to be read out, and improvising here is how a tour turns into the narration of a test plan.
3. **Show before you speak.** `it tour show` publishes a page and brings it up, in one move. Each page below gives the command and then the line, in that order. In most agent apps your turn ends when you have spoken, so a line said before its page leaves the person reading a sentence and looking at nothing.
4. **Answer on the page, and say little.** What you do in answer goes into the page's state, with the command its section gives, and the page shows it. In the chat, one short sentence is plenty, and for a move in a game, a few words. Never describe what the page already shows. The person may also type to you in the box above a page: that arrives as an action named `it:message` with their words in `text`, and is answered above the page, with `it say <the page's id> "…"`, since the chat is not where they are looking.
5. **Never ask a question in the chat, and never go on by yourself.** Every page of the tour has the buttons that go on: **Next**, and **All of them**, which goes back to the menu. You move when one of them arrives, and not before. If they linger, let them.
6. **Never say "step 3 of 5", "this works", or what you are about to do.** No tables of results and no progress reports. The screen is the report.
7. **If something fails, say so in one plain line and go on** to another page. A tour that stops at a broken page teaches nothing.

## Before you start

```sh
it displays
```

If the list is empty, or every display in it has `"paired": false`, the person has no screen paired. Tell them to run `it site`, which opens the site in a browser and pairs that browser, and wait for them. If more than one display is paired, use the one they are most likely looking at, and add `--on "<its name>"` to every `it tour show` below. What `it tour show` prints says which displays were asked to bring the page up, in `shownOn`: if that is empty, nobody is looking at the page, so say that in place of the page's line.

Each page of the tour has a fixed id, `tour-` and its name, so every command below can be run as it is written. Keep the `id` and `version` printed by each `it tour show`: together they identify the showing now on the screen.

## The menu

```sh
it tour show menu
```

**Then say:** "Here's some of what I can put on your screen. Pick one."

Three things can arrive from it, and from every other page of the tour:

- **`pick`**, with `choice`: one of `whiteboard`, `chess`, `checklist`, `drums`, `button`, or `other`. Show that page, with `it tour show <choice>`, and follow its section below. `other` means they named something of their own, in `text`: build that, as a page of your own with `it create … --open`, and when they have had a look say "Say 'back to the tour' whenever you want the rest." When they say so, show the menu again.
- **`next`**, from the **Next** button on a page. Run the command below: it shows the next thing they have not seen and prints its id, and you follow that page's section. When they have seen every one, it shows the ending instead, and prints `tour-done`.
- **`menu`**, from **All of them**. Show the menu again, with the command above. It remembers what has been seen, and marks it. Say nothing, or "Pick another."

```sh
it tour show next
```

The menu also has **That's enough for now**, which arrives as **`done`**: go to the ending.

A page gives its buttons back to the person when it is still on the screen forty seconds after one was pressed, and they may press again. So `next` and `menu` carry `from`, the page they were pressed on, and so do `pick`, `done` and `finish`. All five carry `from_version`, the version of that showing. Before acting on `pick`, `next`, `menu`, `done` or `finish`, compare `tour-<from>` and `from_version` with that `id` and `version`. Act only when both match, except for a newer attempt from the menu showing kept below. If those fields are not shown in the message, run `it action <the action's id>`: its `page` and `version` identify the showing, and its `data` holds the attempt and choice.

Each menu `pick` and `done` carries `attempt`, an increasing number for that showing, starting at 1. The person's latest choice wins. For each new menu showing, keep a record `{ version: <the menu's version>, attempt: 0, choice: null }`. Keep this record after showing a choice, building what they named or showing the ending in response to that menu. A higher attempt from that same showing replaces its earlier choice even when the menu is no longer current. If several menu actions are already available, process only the highest `attempt` and acknowledge the others without showing their choices. If chess arrives first and drums later with a higher attempt, show drums; if drums arrives first, ignore chess when it arrives.

Apply this decision rule to menu actions. `menu` is that retained record, `name` is the action name and `data` is what the action carried. A false result means acknowledge without navigating. A true result means show the requested choice or ending, then acknowledge. Increasing the attempt even for an identical choice keeps older choices from replacing it. An identical choice must not restart a page already shown. If showing the choice fails, set `menu.choice` back to `null` so a fresh attempt can try again.

```js
function takeMenuAttempt(menu, name, data) {
  if (!menu || data.from !== "menu" || data.from_version !== menu.version) return false;
  if (name !== "pick" && name !== "done") return false;
  if (!Number.isSafeInteger(data.attempt) || data.attempt <= menu.attempt) return false;
  menu.attempt = data.attempt;
  const choice = JSON.stringify([name, data.choice || null, data.text || null]);
  if (choice === menu.choice) return false;
  menu.choice = choice;
  return true;
}
```

Acknowledge every handled, older or identical menu action with `it ack <the action's id>`. Forget the record when another menu is shown, navigation from a destination is accepted, or the tour is cleared. Requests from those retired showings are discarded and acknowledged, even if you later return to the same page. For navigation outside the retained menu showing, discard every queued request from the showing you left. A later showing has a new version, and a queued retry must never restart it.

## The whiteboard

```sh
it tour show whiteboard
```

**Then say:** "Draw something. Anything: a box, a face, an arrow. I'll look at it properly, and then draw on the same board."

The `snapshot` action carries `png`, a picture of the drawing, and `strokes`, the same drawing as lines. The message that arrives leaves the picture out and cuts long data short, so have the picture written to a file, in the folder you are in:

```sh
it action <the action's id> --save drawing.png
```

If it says that `drawing.png` is there already, that file is the person's: save under another name, and use that name from here on.

**Look at the picture.** Read that file with whatever you read images with, and delete it when you have: the one you saved is yours, and the person did not ask for a file in their folder. Do not decode the picture yourself and do not save it anywhere else, such as `/tmp`: your harness may stop to ask the person about either, and they are looking at the whiteboard, not at you. Where `png` is `null` the drawing was too large to send as a picture, and the strokes are all there is (`it action <the action's id>` prints them): each is `{ points: [[x, y], …], width, erase, color }`, with `x` and `y` from 0 to 1 and the origin at the top left. Where `strokes` is empty the drawing had more lines than an action holds, and the picture is all there is.

Then draw back, in the same form, adding to their drawing and not starting your own in a corner, and say on the board what you saw. Your lines are drawn in green. `agent_strokes` is the whole of what you have drawn, so give all of it each time:

```sh
it set tour-whiteboard agent_strokes '[{"points":[[0.55,0.30],[0.75,0.30],[0.75,0.55],[0.55,0.55],[0.55,0.30]],"width":4}]'
it set tour-whiteboard note "saw a house, and gave it a neighbour"
```

**Say:** one sentence about what they drew. Not "I received your drawing". If it is a house, say that it is a house. If you cannot tell what it is, say so cheerfully. This one sentence is the whole point of the page. They may draw and send again: answer each one.

`cleared` means they wiped the board, your lines with their own. Take yours out of the state too, since the board draws whatever is there again with the next thing you set, and say nothing:

```sh
it patch tour-whiteboard '{"agent_strokes":[],"note":""}'
```

## The chessboard

```sh
it tour show chess
```

**Then say:** "You're white. Make a move, and I'll answer on the board."

Each `move` action carries `request` (the id of this move), `move` (theirs, as `e2e4`), `said` (the same in words), `fen` (the position after it), `legal` (every move you may make, in the same form), `check`, and `over` (`null`, `"checkmate"` or `"stalemate"`). Answer with the exact `request` id, a colon, and one of the moves in `legal`. For a request named `k3fq`:

```sh
it set tour-chess reply k3fq:e7e5
```

Play properly: develop, take what is hanging, do not walk into mate. Losing on purpose is obvious and insults them. In the chat, say a few words at most ("Knight out." / "Check."), and nothing at all is fine: the board is the conversation. If an `illegal` action arrives, the move you set was not one of the legal ones: set another from the `legal` it carries, prefixed with that action's `request` id and a colon, and say nothing of it. Replies without the matching request id are ignored, including replies to an earlier game. When `over` is not `null` their move has ended the game: say one line about it. If it is your own move that ends it, the board says so, and nothing more arrives until they start a new game. `reset` means they have, and needs no answer.

## The checklist

```sh
it tour show checklist
```

**Then say:** "Packing for a weekend away. Tick off what's packed, add what's missing, and I'll add what I think you've forgotten."

The `list` action carries `items`, each with `text`, `done` and `by` (`you` or `agent`). It comes a moment after they stop ticking or adding. Add one or two things a person would be sorry to have forgotten, that are not on the list, each with a few words of why. `added` is the whole of what you have added, so give all of it each time:

```sh
it patch tour-checklist '{"added":[{"text":"Umbrella","why":"the rain on Friday"}]}'
```

**Say:** one sentence, naming what you added and why. Then leave them to it: they may go on ticking, and you need not add more each time.

## The drum machine

```sh
it tour show drums
```

**Then say:** "Tap out a beat on the pads. When you stop, I'll play between yours."

The `beat` action carries `request`, the id of this beat, `rows` (`hat`, `clap`, `snare`, `kick`, from the top) and `pattern`, one string of eight steps for each row, with `x` where they put a hit. The eight steps are one bar: the first, third, fifth and seventh are its four beats, and the others fall between them. Answer with your own hits in the same form, on steps they left empty, so that the two together make a groove: hats between the beats, a clap on the third or the seventh step if nothing is there, a kick that pushes into the next beat:

```sh
it set tour-drums theirs '{"request":"the exact request id","pattern":["..x...x.","....x...","........","...x...."],"note":"I added hats between your hits."}'
```

**Say:** one sentence about what you added. They will hear it. Keep the exact `request` id with the pattern and optional note in the same value. The page ignores replies for an earlier beat. `cleared` means the page has emptied both patterns already. Say nothing and send no pattern in response.

## The big red button

```sh
it tour show button
```

**Then say:** "One button. Press it when you're ready."

When `press` arrives, say on the page that it is done:

```sh
it patch tour-button '{"status":"done","note":"shipped the homepage"}'
```

**Say:** "That's what an approval looks like. The next time I'm about to do something you'd want a say in, I can put a button like that on your screen, or on your phone, and wait for it."

## The ending

It comes when they have seen every thing and press **Next**, or when they say that is enough.

```sh
it tour show done
```

**Then say:** "That's the tour."

Two buttons are on it. **See another one** arrives as `menu`: show the menu again. **Finish the tour** arrives as `finish`. Then remove the tour's pages, which sends their screen back to their own pages:

```sh
it tour clear
```

**Say:** one thing for them to try today, from what you know of what they are working on, as a sentence they could say to you. If you know nothing of it: "Next time I'm about to make a big change, say 'show me the plan first', and I'll put it on your screen before I touch anything."

## If they want out

If at any point they say stop, say "Fine. Ask me for the It tour again whenever you like," run `it tour clear`, and stop. Do not talk them back into it.
