# The parts of the tour's first page

The tour's first page, `tour-start`, is a shell and a row of parts. The shell is `../pages/start.html`: the look, the frame, the going from one part to the next, and the agent's dock. Each part is one file here, `<name>.html`, and `../pages.json` gives their order under `start.parts`. `packages/cli/tour.mjs` sets every part into the shell when the program is built, and refuses to build where a part that is named is not there or does not name itself.

## What a part's file holds

A part's file holds three things and nothing else but comments.

```html
<style>
  [data-part="room"] .thing { … }
</style>
<section class="part" data-part="room" data-title="A room" data-line="Drag the armchair anywhere. {agent} checks the spot." hidden>
  …
</section>
<script>
Shell.part("room", (my) => { … });
</script>
```

- **The style** is optional, and there is at most one. Begin each rule with `[data-part="<name>"]`, or with an id or class that begins with the part's name, so that it reaches nothing outside the part.
- **The section** is the part itself. It has `class="part"`, names the part in `data-part`, and is `hidden` until the shell shows it. `data-title` is the short title the top line shows, and `data-line` is the one line that says what to do, in which `{agent}` stands for the name of the agent app. A part has no section inside its section.
- **The script** calls `Shell.part("<name>", setup)` once. `setup` is run as the page loads, whether or not the part is the one shown, and is given `my`, which is described below.

An element is found by its id from anywhere on the page, so an id in a part begins with the part's name and a hyphen. The build refuses two elements with one id.

## The frame a part fills

The part that is shown has the whole stage: everything between the slim top line and the dock, at any size, with nothing that scrolls. The shell lays the section out as a column with its content in the middle, and a part makes the thing a person plays with as large as the stage allows. Two classes of the shell's help with that.

- `.fill` takes all the room the part has left, and is a container whose size can be asked for. A drawing of a fixed shape is fitted into it by its own width, as in `width: min(100cqw, calc(100cqh * 720 / 520))` for a drawing that is 720 by 520.
- `.foot` is a row under it for a part's own small buttons and words.

The shell's `.btn`, `.btn.ghost`, `.btn.small` and `.pill` are a part's to use, with the colours and the typefaces of `:root`: `Display` for a heading, `Text` for words, `Hand` for handwriting and `var(--mono)` for numbers. A part writes no headline and no paragraph of explanation: its title and its one line are in the top line, and the agent's words are in the dock. A part makes no sound unless making sound is what it is for. Check a part at 1366 by 768 and at 390 by 844, in light and in dark.

## What the shell gives a part

`my` is what a part works with.

| | |
|---|---|
| `my.el`, `my.$(selector)` | The part's section, and an element inside it |
| `my.agent` | The name of the agent app that gives the tour, as in "Claude Code" |
| `my.answers()` | The agent's answers for this part: the object under the part's name in the page's state |
| `my.listen(fn)` | Hears every change of the page's state |
| `my.revision()` | How many times the state has been set, or -1 where It does not say |
| `my.asker(apply, back)` | One thing at a time asked of the agent, and its answer. See below |
| `my.send(action, data)` | Sends an action by itself, named for this part. It resolves with what `It.action` answered, which is for `my.box.asked` |
| `my.box` | The agent's dock as this part has it. See below |
| `my.line(text)` | Says something else in the one line at the top, and with nothing, what `data-line` says |
| `my.onEnter(fn)`, `my.onLeave(fn)` | Called as the part is come to and as it is left |
| `my.shown()` | Whether the part is the one shown |

`Shell` itself has `Shell.$` (an element by its id), `Shell.newId()`, `Shell.tidy(value, most)` (a string or number as one line of at most so many characters, and nothing else as the empty string), `Shell.calm` (whether the person asked for less motion), `Shell.SVG`, `Shell.SLOW` (the forty seconds) and `Shell.go(name)`.

## Asking the agent, and hearing its answer

Most parts ask one thing at a time, and `my.asker` does all of it:

```js
var asker = my.asker((got) => { /* draw the answer */ }, () => { /* the part is the person's again */ });
my.box.did("moved the chair");
asker.send("moved", { armchair: [390, 190], free: [[419, 309]] });
```

`send` makes a request id, sends the action with `part` and `request` first in what it carries, and takes the dock through its stages. The agent answers by setting the object under the part's name in the state, with the same `request` in it: `{ "room": { "request": "…", … } }`. `apply` is given that object once, when it names the request that is waiting and It has said that it took the action. An answer to an earlier request is never drawn. Where no answer has come after forty seconds, or It refused the action, `back` is called and the part is the person's again. A late answer is still given to `apply`, unless the part called `asker.forget()` because the person has changed what the answer was to. `asker.waiting()` says whether a request is waiting.

Treat everything in an answer as something that may be wrong: check each value's type, put text in as text and never as markup, and where the answer names a place, a move or anything else from a list the page sent, use it only where it is one of them.

Two things make an agent quick, and both are the part's to do:

- **Send what the answer is made of.** The room sends the free places, chess sends a few sound moves before the whole list, the cube sends the way back. An agent that only has to choose answers in one step.
- **Keep what an action carries under 2,000 characters**, with what the agent needs first. An agent is shown that much of an action when it arrives, and has to run a command to read the rest.

A picture goes as a file beside the action, as the whiteboard's does: `saved: ".it-tour-" + request + ".png"` beside `png: <the Blob>`. It writes the first file of such an action to that name, in the folder the agent works in, before the agent hears of it, and takes it away when the action is answered. The request id is passed to `asker.send` as its fourth argument, so that the name and the request are the same.

A part that matches answers itself, as chess and the drum machine do, sends with `my.send` and calls the dock itself: `my.box.sending()`, then `my.box.asked(back, result)` with what `my.send` resolved with, then `my.box.got()` when the answer is drawn.

## The dock

The dock is the shell's, and shows where what the person last did in the part that is shown has got to: done by the person, taken by It, handed to the agent's conversation, the agent's turn running, answered. It says a stage only once it is known, with the time it was known at, and a part cannot make it say more. A part tells it these things.

| | |
|---|---|
| `my.box.did(text)` | What the person did, in a few words that begin with a verb, as in "moved the chair". Eighteen letters or fewer are shown whole |
| `my.box.hint(text)` | What the person can do here, in the page's words, shown until the agent has said something |
| `my.box.say(text)` | The agent's own words, from its answer. Nothing else is ever put here: the page writes no sentence for the agent |
| `my.box.idle()` | Nothing is waiting, as after "Start again" |
| `my.box.sending()`, `.asked(back, result)`, `.got()`, `.refused()` | The stages, for a part that does not use `my.asker` |
| `my.box.waiting()` | Whether something the person did is still on its way or with the agent |

Nothing in a part moves by a timer in the agent's place. While the agent has not answered, the part shows what the person did and nothing of the agent's.

## Left, and come back to

A person may go on to another part at any moment, and come back. A part keeps what it has in the page as it is, so that it is there to come back to. A wait goes on while the part is not shown, and its answer is drawn when it comes. Whatever plays or runs by itself is stopped in `my.onLeave`, as the drum machine stops its loop, and is not started again by an answer that arrives while the part is not shown.

## The agent's side

The agent's guide is `../TOUR.md`. Each part has one short section there: the action it sends, what the agent answers with, and one example of `it tour answer`. A test holds the guide to the page: every action a part sends is named in it, and every example answers under a part the page has.

## Tests

`../start-page.ts` opens the page as it is published, in a stand-in for a browser, and gives a test what it needs: what the page sent (`page.sentOf("moved")`), accepting or refusing it as It would, setting the state as the agent would (`page.set({ room: { … } })`), the site's word of where an action has got to (`page.progress([...])`), the clock (`page.advance(ms)`), and what the dock says of a part (`page.read("room")`). A part's tests are beside it, in `<name>.test.ts`, and the shell's are in `../shell.test.ts`. Run them with `npx vitest run packages/cli/tour` after `node packages/cli/tour.mjs`, which packs the page.
