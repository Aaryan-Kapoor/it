# The It tour

This is for you, the agent. The person on the other end has just installed something they have never used, and does not yet know what it is for. Your job is to show them, on their own screen, and to play along. It is a demonstration and not a test, so read the rules before you run anything: they are the difference between a tour and a test report.

## Rules

1. **Never block.** What the person does on a page arrives in this conversation by itself, as a message that begins `[It]`, where It's add-on for your harness is connected. `it status` says whether it is: your harness has `"addon": "connected"`, and `connector` has `"ok": true`. If it is not, start `it wait --follow` once, in the background, before the first step, and leave it running for the whole tour. Do not run `it wait` in the foreground at any point: it holds your terminal, so the person cannot talk to you.
2. **Say the quoted lines as they are written.** Each step has a line under **Say**. Send it as it is. The lines are written to be read out, and improvising here is how a tour turns into the narration of a test plan.
3. **Never ask a question in the chat.** You are showing a product whose whole point is that the question goes on the screen. Use the page in front of them, or a notification with buttons. The last step is the one exception, since it is a conversation.
4. **Showing a page is one move.** `it tour show` publishes a page and brings it up. Never end a turn having made a page that is not on a screen.
5. **Every step ends by handing over.** When you have reacted and are waiting for them, send `it notify … --button "Next=next"`. They can then go on from the notification or from the **Next** button on the page. Either reaches you as the same `next` action.
6. **Never go on by yourself.** You move on when `next` arrives, and not before. If they linger, let them.
7. **Never say "step 3 of 5", "this works", or what you are about to do.** No tables of results and no progress reports. The screen is the report.
8. **One page at a time.** Each `it tour show` replaces what is on the screen.
9. **If something fails, say so in one plain line and go on** to the next step. A tour that stops at a broken step teaches nothing.

## Before you start

```sh
it displays
```

If the list is empty, the person has no screen paired yet. Tell them to run `it site`, which opens the site in a browser, and wait for them. If there is more than one display, use the one they are most likely looking at, and add `--on "<its name>"` to every `it tour show` below.

Each page of the tour has a fixed id, `tour-` and its name, so every command below can be run as it is written.

## The menu

**Say:** "Here's what I could put on your screen. Pick whichever you want to see first, and we'll go through the rest after."

```sh
it tour show menu
```

The `pick` action's `choice` is one of `whiteboard`, `tictactoe`, `triage`, `mockup`, `gauge`, or `other`. When it arrives, mark the menu as answered, so that it stops looking live:

```sh
it patch tour-menu '{"status":"picked","picked":"<choice>"}'
```

You go through all five. The pick chooses where to start: begin at the step they picked, go on down the list, wrap to the top, and stop when each has been seen once. `other` means they typed something of their own, in `text`. Build that first, as a page of your own, show it, and then start at the whiteboard.

Every step below is: show the page, say the line, react to what they do, send the notification that hands over, and wait for `next`. `<n>` is the step's place in your own running order, counting from 1.

## The whiteboard

Do not explain it before they draw.

**Say:** "Draw something. Anything: a box, a face, an arrow. I'll look at it properly, and then draw on the same canvas."

```sh
it tour show whiteboard --step <n>
```

The `snapshot` action carries `png`, a picture of the drawing, and `strokes`, the same drawing as lines. The message that arrives leaves the picture out and cuts long data short, so have the picture written to a file, in the folder you are in:

```sh
it action <the action's id> --save drawing.png
```

**Look at the picture.** Read that file with whatever you read images with. Do not decode the picture yourself and do not save it anywhere else, such as `/tmp`: your harness may stop to ask the person about either, and they are looking at the whiteboard, not at you. Where `png` is `null` the drawing was too large to send as a picture, and the strokes are all there is (`it action <the action's id>` prints them): each is `{ points: [[x, y], …], width, erase }`, with `x` and `y` from 0 to 1 and the origin at the top left.

**Say:** one sentence about what they drew. Not "I received your drawing". If it is a house, say that it is a house. If you cannot tell what it is, say so cheerfully. This one sentence is the whole point of the step.

Then draw back, in the same form, adding to their drawing and not starting your own in a corner:

```sh
it set tour-whiteboard agent_strokes '[{"points":[[0.55,0.30],[0.75,0.30],[0.75,0.55],[0.55,0.55],[0.55,0.30]],"width":4}]'
it notify "Drew on yours. Next when you've had a look." --id tour-whiteboard --button "Next=next"
```

## Tic-tac-toe

**Say:** "Your move. I'm playing along as you go: no refresh, no 'let me check'. I just see it."

```sh
it tour show tictactoe --step <n>
```

Each `move` action carries `index`, 0 to 8, reading left to right and top to bottom. They are X and you are O. `board` is nine characters, with `.` for an empty square. Set `turn` to `agent` first, which shows the board thinking, then the board, then hand the turn back:

```sh
it set tour-tictactoe turn agent
it set tour-tictactoe board "X...O...."
it set tour-tictactoe turn you
```

Play properly: take the win, block the fork. Losing on purpose is obvious and insults them. When the game ends, set `status` to `won`, `lost` or `draw` as it was for them, put one line in `note`, and hand over:

```sh
it notify "Good game. Next when you're ready." --id tour-tictactoe --button "Next=next"
```

## The queue of pull requests

**Say:** "Drag these where you think they belong. I'm not reading the order you drop them in. I'm reading where on the plane they land."

```sh
it tour show triage --step <n>
```

The `ranked` action comes when they press **Send ranking**. Its `items` are every chip with its `x`, its `y` and the `quadrant` it landed in. They may send more than once, so read each one afresh.

**Say:** their layout read back as a decision, in a sentence or two, naming the things: "you'd ship the session fix first and let the dependency bump wait", and not "I received five placements". Then:

```sh
it set tour-triage note "<the same reading, in one short line>"
it notify "Done reading your triage. Next when you want the design review." --id tour-triage --button "Next=next"
```

## Pick a design

**Say:** "Same button, four ways. Pick the one you'd actually ship and tell me why. This is what a design review looks like when I can just show you."

```sh
it tour show mockup --step <n>
```

The `vote` action's `choice` is the label, and `text` is why, if they said.

**Say:** one sentence that agrees or pushes back, with a reason. A review in which the reviewer always agrees is not a review.

```sh
it patch tour-mockup '{"status":"voted","chosen":"<label>"}'
it notify "Noted. Next when you're ready: a number that moves." --id tour-mockup --button "Next=next"
```

## A number that moves

**Say:** "Watch the number. I'm not rebuilding the page. The page is already there, and I'm only changing what it says."

```sh
it tour show gauge --step <n>
```

Then move it, with real pauses between, since this only lands if they watch it change:

```sh
it patch tour-gauge '{"value":12,"label":"Building"}'
sleep 2
it patch tour-gauge '{"value":48,"label":"Running tests"}'
sleep 2
it patch tour-gauge '{"value":91,"label":"Uploading"}'
sleep 2
it patch tour-gauge '{"value":100,"label":"Live","note":"The page never changed. Only its state did."}'
```

**Say:** "That's `it patch`. The same words work on any page you leave up: a build, the depth of a queue, a countdown, whatever you want to glance at."

```sh
it notify "That was the last one. Next when you're ready." --id tour-gauge --button "Next=next"
```

## What it is for

This is the useful part, and the only step that happens in the chat. First send one notification with buttons. It is a demonstration too: it is the lightest way you have to ask for one decision, and it waits in their tray if they do not answer at once.

```sh
it notify "That's the tour. Want the two-minute version of how to use this day to day?" --id tour-menu --button "Go on=explain" --button "I'm good=skip"
```

If they press **I'm good**, say "It's all under the bell at the top if you want it later," and go to the end.

If they press **Go on**, say this, in your own words, and cover all four:

- **Say it out loud.** There is nothing to configure. "Show me", "put that on my screen", "ask me on my phone": plain words are the whole interface.
- **It works when you are not there.** What you do on a page waits for the agent that asked. That is the difference between this and a chat window.
- **Where it fits.** Ask which of these is them, and mean it: plans and diffs, shown before the work is done; approvals in the middle of a long job, answered from a phone; a dashboard left up on a screen that the agent keeps current.
- **One thing to try today.** Give them one first move, from what they have just said, and not a menu. If they spoke of reviewing code: "the next time I'm about to make a big change, tell me to show you the plan first."

## The end

```sh
it tour clear
```

That removes the tour's pages, and nothing else. Stop the `it wait --follow` you started, if you started one.

## If they want out

If at any point they say stop, say "Fine. It's all in `it help` and under the bell when you want it," run `it tour clear`, and stop. Do not talk them back into it.
