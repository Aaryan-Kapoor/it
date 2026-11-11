# The It tour

This is for you, the agent. The person on the other end has just installed something they have never used, and does not yet know what it is for. Your job is to show them, on their own screen, and to play along. It is a demonstration and not a test, so read the rules before you run anything.

The tour is one page, `tour-start`, with the whole first run of It on it: a room, a whiteboard, a packing list, a game of chess, a Rubik's cube, a drum machine, an approval on a phone, and an ending. The page goes from one part to the next by itself, when the person presses Next or Back, and tells you nothing of that. You are the brain behind it: you show it once, and then you answer what the person does on it. Nothing on it is the person's, and nothing is at stake.

## Rules

1. **Never block.** What each `it tour show` prints says, under `arrives`, whether what the person does on the page arrives in this conversation by itself. Where `arrives.byItself` is `true`, it arrives as a message that begins `[It]`: do not wait at all, since a wait holds your terminal and the person cannot talk to you. Where it is `false` or `"unknown"`, wait for each thing they do: after every page you show and every answer you give, run `it wait --timeout 100` and act on what it prints, which is an action, or `{"timedOut": true}` when nothing has happened yet, and then you run it again. Where `arrives` is not printed at all, It cannot tell which conversation this is, and `it wait` is refused without a page: name the page that is on the screen, as in `it wait --id tour-start --timeout 100`, or `it wait --id tour-menu --timeout 100` on the menu. If the person says they did something and nothing reached you, wait in that way from then on, whatever `arrives` said. The one exception is the first page where showing it printed `"asleep": true`: there you end your turn, as its `arrives.next` says. During the tour, say nothing else of what `arrives.next` says: where it asks the person to type /reload-plugins or to start a new conversation, say that once, after the ending, unless the first page has said it for you. And do not use `--follow` or put a wait in the background: the command has to end for you to be shown what it printed.
2. **Nothing in the tour touches the person's things.** The room, the homework, the list, the games and the pull requests are part of the page. Do not read their folder, run anything of theirs, change a file, merge, push or send anything anywhere because of the tour. The one file you write is a picture you save to look at, and you delete it as soon as you have.
3. **Answer on the page, and say nothing in the chat.** Each thing the person does arrives as one action, and you answer it with one `it patch` into the page's state, as its section says: the page draws your answer. While the tour goes on, write nothing in the chat at all: no "still on the tour", no word of what you answered or are about to do. The person is looking at the page. Never describe what the page already shows. The person may also type to you in the box above a page: that arrives as an action named `it:message` with their words in `text`, and is answered above the page, with `it say <the page's id> "…"`, since the chat is not where they are looking.
4. **Say the quoted lines as they are written.** Where a section has a line under **Then say**, send it as it is.
5. **Show before you speak.** `it tour show` publishes a page and brings it up, in one move. Run it, and then say its line: in most agent apps your turn ends when you have spoken.
6. **Never ask a question in the chat, and never go on by yourself.** The person moves through the first page themselves. Never show another page because of where they are on it.
7. **Never say "step 3 of 5", "this works", or what you are about to do.** No tables of results and no progress reports. The screen is the report.
8. **If something fails, say so in one plain line and go on.** A tour that stops at a broken part teaches nothing.

## The first page

```sh
it tour show start
```

Show it before anything else, even where the person has no screen paired yet, as when you have just installed It for them. What it prints says in `shownOn` which display was asked to bring it up. Where that is empty because no screen is paired, give them the link that `it site --no-open` prints, to open on this computer: the browser they pair with it opens on this page by itself.

Where showing it printed `"asleep": true`, you are in a Claude Code conversation that has not loaded It's add-on. The page says so to the person in amber, with the line to type, and keeps what they do. Do what `arrives.next` says: give the link and that line in one message, and end your turn.

**Then say:** "It's on your screen. Move the armchair, and I'll answer there." Where you gave them a link, say this in its place, with the link: "Open this to start, and move the armchair: <the link>".

Every action from this page carries `request`. Answer with one `it patch tour-start`, under the name of the part it came from, and copy `request` into your answer exactly: the page draws only the answer to the request it is waiting on, and leaves an answer to an earlier one alone. Each example below shows the shape of an answer, and what is in angle brackets is yours to write: in `say` and `note`, one sentence of your own to the person, in plain words, about what they actually did. Never send an example's words as they stand. After each answer, do what `arrives` says: end your turn, or run `it wait` again. Actions may come from parts the person has already left: answer each all the same.

### The room: `moved`

The person dragged the armchair. `armchair` is where they put its top left corner, `[x, y]` in centimetres from the room's top left corner, in a room `room` of 640 by 440 with the window on the top wall and the door at the bottom left. `size` is the armchair's side, 78. `in_the_way` is `null`, `"door"` where the door would hit it, or the furniture it stands on: `"sofa"`, `"coffee table"`, `"shelves"` or `"plant"`. `free` holds the nearest places where it can stand, nearest first, and is the armchair's own place first where that is free. `door_clears_by` is how far the door's swing clears it, `from_sofa` how far it is from the sofa, both in centimetres, and `by_window` whether it is under the window.

Answer with where it is to stand, one of the places in `free`, whether to put a lamp beside it, and a sentence about the spot:

```sh
it patch tour-start '{"room":{"request":"the exact request","armchair":[419,309],"lamp":true,"say":"<one sentence of your own about the spot>"}}'
```

The page moves the armchair there, draws how far the door clears it, and puts the lamp in. A place that is not free is not used: the page takes the first of `free` in its stead, and still shows your sentence.

### The whiteboard: `checked`

The person wrote their answer to a sum by hand and pressed Check it. `question` and `sum` say what the sheet asks, and `png` is a picture of the sheet with what they wrote, as a file, which its data names as `{"file": 1}`. Have it written to a file in the folder you are in, look at it, and delete it:

```sh
it save <the action's id> sheet.png
```

If it says that `sheet.png` is there already, that file is the person's: save under another name. Read the picture with whatever you read images with, and do not save it anywhere else. Where `png` is `null`, the person's browser could not make a picture, and `strokes` is all there is (`it action <the action's id>` prints them): each line is `{ points: [[x, y], …] }`, with `x` and `y` from 0 to 1 across and down the sheet. Work out what they wrote and whether it is right, and answer with what you read, whether it is right, the right answer, a hint of a few words, and a sentence:

```sh
it patch tour-start '{"board":{"request":"the exact request","read":"<what you read>","right":false,"answer":"<the right answer>","hint":"<a hint of a few words>","say":"<one sentence of your own about their answer>"}}'
```

The page rings what they wrote and writes your answer and hint beside it in green, or ticks it where `right` is `true`. If you cannot read images, set `"read":""`, mark from the sum alone, and say so in your sentence, in one line.

### The packing list: `list`

`items` is the whole list as it now is, each with `text`, `done` and `by` (`you` or `agent`). It comes a moment after the person stops ticking or adding, and carries no `request`. Add one or two things a person would be sorry to have forgotten, each with a few words of why. `added` is the whole of what you have added, so give all of it each time:

```sh
it patch tour-start '{"checklist":{"added":[{"text":"<a thing>","why":"<a few words of why>"}],"note":"<one sentence of your own about what you added>"}}'
```

### The chessboard: `move`, `illegal`, `reset`

Each `move` carries `request`, `move` (theirs, as `e2e4`), `said` (the same in words), `fen` (the position after it), `legal` (every move you may make, in the same form), `check` and `over` (`null`, `"checkmate"` or `"stalemate"`). Answer with the exact `request`, a colon, and one of the moves in `legal`:

```sh
it patch tour-start '{"chess":{"reply":"the exact request:e7e5","note":"<a few words of your own about the game>"}}'
```

Play properly: develop, take what is hanging, do not walk into mate. If an `illegal` action arrives, the move you set was not one of the legal ones: set another from the `legal` it carries, with that action's `request` and a colon before it. When `over` is not `null` their move has ended the game, and there is nothing to answer. `reset` means they started a new game, and needs no answer.

### The cube: `turned`

The person asked for the next turns. `faces` is the cube as 54 letters, nine for each face in the order U, R, F, D, L, B, each read row by row as that face is seen from outside, with U above for the four side faces, B above for U and F above for D. Each letter names the face whose colour that sticker has. `turns` is what has been turned since the cube was solved, oldest first, in the usual notation: U, D, L, R, F or B turns that face a quarter clockwise as seen from outside, with `'` for the other way and `2` for a half turn. `solved` says whether it is solved. Answer with up to twenty turns that take it towards solved, and a sentence. Undoing `turns` from the last is the sure way back:

```sh
it patch tour-start '{"cube":{"request":"the exact request","moves":["F","R","D"],"say":"<one sentence of your own about the turns>"}}'
```

The page plays them one at a time, and leaves out anything that is not a turn's name.

### The drum machine: `beat`, `cleared`

The `beat` action carries `request`, `rows` (`hat`, `clap`, `snare`, `kick`, from the top) and `pattern`, one string of eight steps for each row, with `x` where they put a hit. The eight steps are one bar: the first, third, fifth and seventh are its beats, and the others fall between them. Answer with your own hits in the same form, on steps they left empty, so that the two together make a groove, with the exact `request` and a note in the same value:

```sh
it patch tour-start '{"drums":{"theirs":{"request":"the exact request","pattern":["..x...x.","....x...","........","...x...."],"note":"<one sentence of your own about what you added>"}}}'
```

`cleared` means the page has emptied both patterns already. Send nothing in response.

### The approval: `answered`

These three pull requests are part of the demonstration, on a phone drawn on the page. They are not real, and you merge nothing and touch no repository: you only answer on the page. `answer` is `merge` or `not_yet`. Answer with a sentence:

```sh
it patch tour-start '{"approval":{"request":"the exact request","say":"<one sentence of your own about their answer>"}}'
```

Where it is `merge`, the page marks the three as merged once your answer comes.

### The ending: `finish`

"Go to my pages" arrives as `finish`, with `from` set to `start`. Remove the tour's pages, which sends their screen back to their own pages:

```sh
it tour clear
```

**Say:** one thing for them to try today, from what you know of what they are working on, as a sentence they could say to you. If you know nothing of it: "Next time I'm about to make a big change, say 'show me the plan first', and I'll put it on your screen before I touch anything."

## If they ask to see more

The tour has more pages for a person who asks for more: a menu, the same things as pages of their own, and an ending. Show the menu with the command below and follow the sections after it. Before you start these, run:

```sh
it displays
```

If the list is empty, or every display in it has `"paired": false`, the person has no screen paired. Tell them to run `it site`, which opens the site in a browser and pairs that browser, and wait for them. Each `it tour show` below brings its page up on the display the person is using, which It chooses by itself, so name none. What `it tour show` prints says which display was asked to bring the page up, in `shownOn`: if that is empty, nobody is looking at the page, so say that in place of the page's line.

Each page of the tour has a fixed id, `tour-` and its name, so every command below can be run as it is written. Keep the `id` and `version` printed by each `it tour show`: together they identify the showing now on the screen.

Every page from here on has the buttons that go on, **Next** and **All of them**, which goes back to the menu: you move when one of them arrives, and not before. Each has a line under **Then say**.

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

A page gives its buttons back to the person when it is still on the screen forty seconds after one was pressed, and they may press again. So `next` and `menu` carry `from`, the page they were pressed on, and so do `pick`, `done` and `finish`. All five carry `from_version`, the version of that showing, and `attempt`, an increasing number saved before sending so a reload of the same showing continues the count. They also carry `attempt_display`, a random tie-breaker made once per page load and saved with the counter. It stays the same for every action from that load and is never copied from the shared store. Before acting on `pick`, `next`, `menu`, `done` or `finish`, check the showing and attempt with the rules below. If those fields are not shown in the message, run `it action <the action's id>`: its `page` and `version` identify the showing, and its `data` holds the attempt and choice.

The person's latest action on one display wins on every tour page. Across displays, order attempts by the counter first, then by `attempt_display` using JavaScript's string comparison, not locale order. Equal counters therefore have one winner regardless of the order they arrive. This is the tour's rule for simultaneous displays: there is no shared allocation or clock, so it does not claim which simultaneous choice happened last.

Keep `tour.current` as `{ from: <page name>, version: <its version>, attempt: 0, attempt_display: "", choice: null, wanted: null }` for the showing now on the screen, and start with `tour.previous = null`. The previous record is the showing whose action brought up the current page. Keep it after showing a choice, the menu or the ending, or building what they named. A higher attempt pair from that showing replaces its earlier choice even when its page is no longer current. If several actions from one showing are already available, process only the highest `attempt` pair and acknowledge the others without navigating. If chess arrives first and drums later with a higher pair, show drums; if drums arrives first, ignore chess when it arrives. The same rule applies to Next followed by All of them, and Finish followed by See another one.

Apply `takeTourAttempt` when a navigation action arrives. A false result means acknowledge without navigating. A true result means prepare the requested navigation. Immediately before running its command, apply `commitTourAttempt`; a false result means it was superseded, so acknowledge it without running that command. Run navigation commands one at a time, never in parallel. Keep `tour.current` until a command succeeds, then replace it with a fresh record for the `id` and `version` it printed, keeping `tour.previous`. If the command fails, leave `tour.current` as it is and set `tour.previous.choice` back to `null` so a fresh attempt can try again. The page still on the screen must remain current so its Next and All of them buttons can navigate. An identical choice advances the attempt without restarting a page already shown; an unfinished identical choice may still complete.

```js
function takeTourAttempt(tour, name, data) {
  const matches = (showing) => showing && data.from === showing.from && data.from_version === showing.version;
  const showing = matches(tour.current) ? tour.current : matches(tour.previous) ? tour.previous : null;
  if (!showing) return false;
  const allowed = data.from === "menu" ? ["pick", "done"] : data.from === "done" ? ["menu", "finish"] : ["next", "menu"];
  if (!allowed.includes(name)) return false;
  if (!Number.isSafeInteger(data.attempt) || data.attempt < 1 || typeof data.attempt_display !== "string" || !data.attempt_display) return false;
  if (data.attempt < showing.attempt || (data.attempt === showing.attempt && data.attempt_display <= showing.attempt_display)) return false;
  showing.attempt = data.attempt;
  showing.attempt_display = data.attempt_display;
  showing.wanted = JSON.stringify([name, data.choice || null, data.text || null]);
  if (showing.wanted === showing.choice) return false;
  tour.previous = showing;
  return true;
}

function commitTourAttempt(tour, name, data) {
  const showing = tour.previous;
  if (!showing || data.from !== showing.from || data.from_version !== showing.version || data.attempt !== showing.attempt || data.attempt_display !== showing.attempt_display) return false;
  const choice = JSON.stringify([name, data.choice || null, data.text || null]);
  if (choice !== showing.wanted) return false;
  showing.choice = choice;
  return true;
}
```

Acknowledge every handled, older or identical action with `it ack <the action's id>`. Accepting navigation from the current destination replaces the previous record and retires the earlier source. A newer attempt from the previous source retires the destination only when its replacement command succeeds. A showing brought up independently, such as a spoken request to return to the tour, also retires both records. Retired requests are discarded and acknowledged, even if you later return to the same page. After clearing the tour, set both records to `null`.

Before handling Finish, read `it actions --id tour-done` and consider every available attempt from that showing. Apply `commitTourAttempt` immediately before `it tour clear`, after processing any newer navigation received while preparing to finish. An older Finish must never clear a menu or another page brought up by a newer action. Once a current Finish clears the tour, discard all further actions from its retired showings.

## The whiteboard

```sh
it tour show whiteboard
```

**Then say:** "Draw something. Anything: a box, a face, an arrow. I'll look at it properly, and then draw on the same board."

The `snapshot` action carries `strokes`, the drawing as lines, and beside them `png`, a picture of the drawing as a file, which its data names as `{"file": 1}`. The message that arrives says the file is there and cuts long data short, so have the picture written to a file, in the folder you are in:

```sh
it save <the action's id> drawing.png
```

If it says that `drawing.png` is there already, that file is the person's: save under another name, and use that name from here on.

**Look at the picture.** Read that file with whatever you read images with, and delete it when you have: the one you saved is yours, and the person did not ask for a file in their folder. Do not decode the picture yourself and do not save it anywhere else, such as `/tmp`: your harness may stop to ask the person about either, and they are looking at the whiteboard, not at you. Where `png` is `null` the person's browser could not make a picture, and the strokes are all there is (`it action <the action's id>` prints them): each is `{ points: [[x, y], …], width, erase, color }`, with `x` and `y` from 0 to 1 and the origin at the top left. Where `strokes` is empty the drawing had more lines than an action holds, and the picture is all there is.

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

Two buttons are on it. **See another one** arrives as `menu`: show the menu again. **Finish the tour** arrives as `finish`. Apply the navigation rules above, including the final attempt check. Only a current Finish removes the tour's pages, which sends their screen back to their own pages:

```sh
it tour clear
```

**Say:** one thing for them to try today, from what you know of what they are working on, as a sentence they could say to you. If you know nothing of it: "Next time I'm about to make a big change, say 'show me the plan first', and I'll put it on your screen before I touch anything."

## If they want out

If at any point they say stop, say "Fine. Ask me for the It tour again whenever you like," run `it tour clear`, and stop. Do not talk them back into it.
