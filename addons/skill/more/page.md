# What a page can and cannot do

A page is shown in a sandbox, as a document that shares nothing with the site, with another page, or with itself the last time it was open. Write it to these limits:

- **It has no cookies.** Reading or setting `document.cookie` throws.
- **`localStorage` and `sessionStorage` last only while the page is open.** They take what they are given and forget it when the page closes or is shown again. Anything the page must remember goes in `It.store`.
- **There is no IndexedDB, no `caches` and no service worker.** Each of them throws.
- **A worker starts only from a `blob:` address.** `new Worker('worker.js')` fails. Fetch the script and start the worker from a `Blob` of it.
- **It cannot frame its own files.** An `<iframe>`, `<embed>` or `<object>` that names another file of the page, a PDF included, stays empty. Link to the file, or draw what it holds in the page itself. Its scripts, styles, pictures, fonts and what it fetches from its own files all load as usual.
- **A link to another site opens in a new tab.** Write links as on any page: one to another site opens in a tab of its own, whatever its `target` says, and the page stays as it was. The tab is an ordinary one, and neither it nor the page has a hold on the other, so `window.open` returns `null`: do not take that for a blocked window. No referrer is sent. A link within the page or to another of its files stays in the page, and a tab of the page's own files is sandboxed as the page is. Every link and form is given `rel="noopener noreferrer"`, which changes nothing where it is followed within the page. The page cannot move the tab it is shown in. Do not put a link in a closed shadow root that the markup declares (`<template shadowrootmode="closed">`): It cannot see that link, and following it shows the page again instead of opening the link. A shadow root a script makes, open or closed, and an open one the markup declares, is fine.
- **A mail, phone or messages link is opened by It.** A `mailto:`, `tel:` or `sms:` link works when the user clicks it. From a script, call `It.open(url)` in the handler of the user's click or key: it opens an http, https, mailto, tel or sms address as a link would, and throws on any other kind. A window of a `javascript:`, `data:` or `blob:` address is never opened.
- **It limits how markup sends the showing's address.** That address holds what opens this showing's files. In the main document, a `<meta name="referrer">` or a `referrerpolicy` is put back to `no-referrer`, and links lose their `ping` attributes. This is a mitigation, not a guarantee: shadow roots the markup declares and `srcdoc` documents are not watched, and page scripts can still send the address. Do not put policies that disclose the address or links with `ping` in embedded content.
- **Its own address is not one to keep.** What a page's script reads as `location` is where the files of this one showing are, and it stops answering when the showing ends. Do not show it, send it or store it. The address to give the user is the `url` that `it create` printed.

## Sending a photo or any other file

Put the file in what the action carries, wherever it fits: `It.action('receipt', { photo: input.files[0], table: 4 })`. A `File` from an `<input type="file">` or a drop, or a `Blob` from `canvas.toBlob`, goes with the action, beside what it carries, and the action is accepted only once It has every file whole. Never cut a file into pieces or write it into the data as text.

- **A photo is made smaller before it is sent**, to 1600 pixels on its longer side, as a JPEG, which is what you read a picture at, and what the camera wrote into it, such as where it was taken, does not go with it. A picture that goes as it is keeps whatever is written in it: one that is small already (at most 1600 pixels and 1 MB, or at most 1600 pixels where a JPEG would only make it larger), and one this browser cannot read or redraw, as some browsers cannot a HEIC photo. Where the page needs the file as it is, pass `{ original: true }` as the third argument: `It.action('scan', { page: file }, { original: true })`, and `It.commit(name, extra, { original: true })` the same. Any other file, such as a PDF, a CSV or a recording, always goes as it is.
- **A phone that loses its connection keeps the action and its files**, in that browser, and sends them once it is back, even if the page was closed in between. The promise stays unanswered while there is no connection, so show on the page that the photo is on its way, and say so when the promise rejects.
- **`It.store` keeps no file.** To show a picture you were sent, on this page or on every screen, put it in the page's folder, publish again with `it update`, and refer to it by its path.

## Recording sound, video or a photo

A page records from the microphone or the camera of the screen it is shown on by calling for them: nothing is said of it when you publish. The page never gets the device itself. The first time on each screen, It asks the user in its own bar whether this page may, and the browser asks too the first time for It's site; after that the page records there without being asked, and It's bar says that it is recording for as long as it is. What the user allows lasts until they take it back, or until the page goes 30 days without using it. It asks only while the page is in front, in the window the user is using, and begins nothing while the browser says the page is not shown, so call from something the user did on the page.

```js
// Starts recording, and asks the user first the first time on each screen. video: true adds the camera.
const take = await It.record({ audio: true })
// ...later, when the user presses Stop on the page
const file = await take.stop() // a File: audio/webm, or audio/mp4 in Safari
await It.action('take', { take: file })
// A photo: the user takes it in It's own view of the camera, and the page is given the JPEG
const photo = await It.photo()
```

- **Show why it failed.** `It.record` and `It.photo` reject with a sentence that says why: the user said no, the page was not in front, the screen reaches It over plain http, or the browser refused. A browser gives the microphone only to an https address or to the machine It runs on, so on another screen It must be opened at its https address, which `it https on` on that machine sets up.
- **The user can stop it.** `take.state` is `recording`, `paused` (while the screen does not show It) or `ended`, and `take.onchange = (state, why) => …` is called when it changes without the page asking. The user can stop a recording from It's bar, which throws it away, and it is thrown away too when another conversation takes the page over. `take.cancel()` throws one away from the page.
- **Settings are the page's to say.** `audio` and `video` may be objects such as `{ echoCancellation: false }` or `{ facingMode: 'environment', width: 1280 }`, and `audioBitsPerSecond`, `videoBitsPerSecond` and `mimeType` are as for a MediaRecorder. A page records one thing at a time, for an hour at most and up to 1 GB, the most one file sent with an action can be: It stops it there and gives the page what was recorded.
- **A recording is a file like any other.** The action that carries it is held to the same limits as any file, so keep video takes short or their bit rate low, and save what arrives with `it save <id> take.webm`.

## Keeping something with the page

`It.store.set(key, value)` and `It.store.get(key)` keep what the page itself changes. What is kept there is kept with the page, so it is there the next time the page is opened, on any display. It arrives with the page's state, which is empty until it arrives, a moment after the page opens. It is not there yet when the page's scripts first run: `It.store.get` waits for nothing and answers from what has arrived, so as the page starts it returns `undefined` even for something that was saved. Read what was saved in `It.onState`, as below.

**Store each change as it is made, and each thing under a key of its own.** Call `It.store.set` at every stroke, move or keystroke, one key for each stroke, card or cell (`It.store.set('stroke-' + id, stroke)`) and never a whole board under one key: It sends what is set within a moment as one write, the other displays are sent only the values that changed, and this page sees what it set in `It.store.get` and `It.state` at once. Do not hold writes back, send them one at a time or try them again yourself: It does all three.

A draft is put back once, when the state first arrives, and never over what is being typed: not when the state changes later, and not when the user began typing before it arrived. It is saved at every letter. A failed save keeps the text and offers a retry. Keep the page open until it says "Saved." Closing it while changes are unsaved can lose them.

A text field or dropdown bound with `data-it-bind` follows changes to its value only while it holds no edit of the user's, including one made before the state arrived.

Each save remembers which edit it saved, so that the answer to an older one cannot mark newer text as saved. Two displays editing the same draft still overwrite each other's saved values.

```html
<label for="draft">Draft</label>
<textarea id="draft" aria-describedby="draft-status"></textarea>
<p id="draft-status" role="status">Loading saved draft...</p>
<button id="draft-retry" type="button" hidden>Retry saving</button>
<script>
  const box = document.getElementById('draft')
  const status = document.getElementById('draft-status')
  const retry = document.getElementById('draft-retry')
  let settled = false
  It.onState(() => {
    if (settled) return
    settled = true
    box.value = It.store.get('draft') ?? ''
    status.textContent = 'No unsaved changes.'
  })
  let edits = 0
  async function save() {
    const edit = ++edits
    retry.hidden = true
    status.textContent = 'Saving...'
    try {
      await It.store.set('draft', box.value)
      if (edit === edits) status.textContent = 'Saved.'
    } catch {
      if (edit === edits) {
        status.textContent = 'Not saved. Keep this page open and try again. If it keeps failing, shorten the draft.'
        retry.hidden = false
      }
    }
  }
  retry.addEventListener('click', save)
  box.addEventListener('input', () => {
    settled = true
    save()
  })
</script>
```

## Keeping everything in state

Everything a page shows that can change, and every control on it, lives in its state. Then you change what it shows without publishing it again, and `it state` tells you what the user sees and has chosen before they send anything. Publish again with `it update` only when the page's files change, such as its code, its layout or a picture added to its folder: a new version reloads the page on every screen, and whatever was typed there and not yet saved or sent is lost.

- **What the page shows is in your part of the state,** drawn in `It.onState`. Keep a list as an object keyed by id, with the ids in an `order` array, since a patch merges objects and replaces an array whole. Adding a card is then `it patch board '{"items":{"c3":{"title":"Call the bank"}},"order":["c1","c2","c3"]}'`, and taking it away is `it patch board '{"items":{"c3":null},"order":["c1","c2"]}'`.
- **Each control keeps one value with `It.store.set`, under a key of its own, at every change:** text fields, choices, toggles, sliders, tabs, filters, sorting, what is selected or open, the view, and the step of a flow. `it state board` shows them under `_page`. Name them in a comment in the page, so that you find them when you come back to it.
- **You change a control by writing that same value under `_page`:** `it set board _page.show open`, or `it patch board '{"_page":{"show":"open","find":""}}'` for several. Only the values you name change. Keep each under 32 KB: It does not hold you to that, but the page could not save a larger value back. The latest saved write wins, whether it was yours or the page's.
- **A change the user is making keeps going.** A value of yours that arrives while they type in a field or drag a slider waits until they finish, by leaving the field or letting go, and then shows, unless they changed it again after it arrived. A change the page could not save, as when its state is full, stays on the screen with a button to try again, and is not sent again by itself. The example below does both. Do not bind a control with `data-it-bind`: that keeps an edit only until it is saved, and then puts in your next value even while the user types.
- **A file input cannot be kept,** by `It.store` or by you: the browser lets no page keep or set the file chosen in one. Send the file with an action.
- **What the user decides still comes to you as an action,** with `It.action`, or `It.stage` and `It.commit`. `It.store` does not change what was staged, so stage the values the controls show when the user submits. Your answer goes back into the state.

A control that is not a form field, such as a tab or the item that is open, works the same way: draw it from its stored value, and store it whenever the user changes it.

```html
<!-- Controls, each kept with It.store under its name and shown by `it state board` under `_page`:
     `show` (all or open) and `find` (text to look for). Change one with `it set board _page.show open`. -->
<label>Show
  <select data-control="show">
    <option value="all">All</option>
    <option value="open">Open</option>
  </select>
</label>
<label>Find <input data-control="find" type="search"></label>
<p id="unsaved" role="status" hidden>A change was not saved. <button id="retry" type="button">Try again</button></p>
<ul id="cards"></ul>
<script>
  const controls = [...document.querySelectorAll('[data-control]')]
  const control = (name) => controls.find((el) => el.dataset.control === name)
  const valueOf = (el) => (el.type === 'checkbox' ? el.checked : el.value)
  function put(el, value) {
    if (el.type === 'checkbox') el.checked = Boolean(value)
    else if (el.value !== String(value ?? '')) el.value = value ?? ''
  }
  const first = new Map(controls.map((el) => [el, valueOf(el)]))
  const editing = new Set() // controls the user is changing and has not finished with
  const saving = new Map() // the number of each control's latest save, until It answers it
  const unsaved = new Set() // controls whose latest save It refused
  let saves = 0
  let opened = false

  // Shows a control's stored value, unless the user is changing it or their change is not saved
  function show(el) {
    const name = el.dataset.control
    if (editing.has(el) || saving.has(name) || unsaved.has(name)) return
    put(el, It.store.get(name) ?? first.get(el))
  }

  function save(el) {
    const name = el.dataset.control
    const save = ++saves
    saving.set(name, save)
    const answered = (ok) => {
      if (saving.get(name) !== save) return
      saving.delete(name)
      if (ok) unsaved.delete(name)
      else unsaved.add(name)
      document.getElementById('unsaved').hidden = unsaved.size === 0
      show(el)
      draw()
    }
    It.store.set(name, valueOf(el)).then(() => answered(true), () => answered(false))
  }

  function draw() {
    const { items = {}, order = [] } = It.state
    const find = control('find').value.toLowerCase()
    const shown = order
      .map((id) => items[id])
      .filter((item) => item && (control('show').value === 'all' || !item.done) && item.title.toLowerCase().includes(find))
    document.getElementById('cards').replaceChildren(...shown.map((item) => Object.assign(document.createElement('li'), { textContent: item.title })))
  }

  It.onState(() => {
    for (const el of controls) {
      // When the page opens, a control with no stored value is stored as it stands, so that the agent sees it
      if (!opened && It.store.get(el.dataset.control) === undefined) save(el)
      show(el)
    }
    opened = true
    draw()
  })
  for (const el of controls) {
    el.addEventListener('input', () => {
      editing.add(el)
      save(el)
      draw()
    })
    // The user has finished: a choice made, a slider let go, a field left. A value that came meanwhile shows now
    const finished = () => {
      editing.delete(el)
      show(el)
      draw()
    }
    el.addEventListener('change', finished)
    el.addEventListener('blur', finished)
  }
  document.getElementById('retry').addEventListener('click', () => {
    for (const el of controls) if (unsaved.has(el.dataset.control)) save(el)
  })
</script>
```

## Changing state that something else may have changed

A page can change its own state while you work, and so can another conversation. Where a change of yours must not overwrite one you have not seen, read the state with `it state deploy-plan`, which prints its `revision` beside it, and give that number back: `it patch deploy-plan '{"total":42}' --if-revision 7`. The change is made only while the state is still at that revision. If it has moved on, the command is refused with the code `conflict`: read the state again and decide anew.

## How much a page may hold and send

A command that goes past one of these is refused with the code `limit`, and one that comes too fast with `rate_limited`: wait a moment and run it again. Sizes are in units of 1,024.

- **A page is at most 500 files and 4 GB, with no file over 2 GB.** A file's path is at most 300 bytes. A film can be one of a page's files and shown with `<video src="film.mp4">`: the browser asks for the part it plays, so it starts at once and plays from wherever the user skips to. Ten versions of a page are kept, and It holds 500 pages and 100 GB of their files in all, unless the user set It up to keep another amount, so publish under the same id to make a new version, and `it delete <id>` a page nobody needs. It always leaves some of its disk free, 2 GB unless the user said otherwise, and a page that would take more is refused, saying so.
- **State is at most 512 KB of JSON,** with what the page stored with `It.store` counted in, and a page keeps at most 5,000 values with `It.store`. A change of yours stores your part of the state again whole and sends it to every display that shows the page, so it is counted by the size of that part: one page may write 8 MB of it at once, and then 2 MB a minute. Keep your part small if you change it often. What the page stores is written and sent value by value, and counted by the values that changed.
- **An action carries at most 32 KB of data, and beside it up to 10 files, each at most 1 GB and 2 GB together.** It holds 20 GB of files sent from pages in all, unless the user set It up to keep another amount, each kept as long as its action. Its name is 1 to 64 letters, digits, dots, colons, dashes or underscores. A value kept with `It.store` is at most 32 KB too, under a key of 1 to 64 letters, digits, dashes or underscores.
- **A page that asks for its own files too often is refused.** The files of one showing may be asked for 3,000 times in a minute. A page that fetches its own files in a loop is answered 429 past that, until the minute is over.
- **A page that sends too many actions at once is refused.** The site takes 20 actions from a page at once, and then five a second, and It takes 30 actions from one page before it slows that page to one a second. The promise that `It.action` and `It.commit` return rejects when what was sent was refused, for being too large or for coming too fast, and it was then not taken. Catch that, and say so on the page, so that the user can press again.
- **`It.store.set` waits rather than fail for coming too fast.** It sends no more than twenty writes a second from one display, and a page that sets values faster than It takes them has them held and sent together a moment later. Its promise resolves once the value is kept, and rejects only for a value It will not take, such as one over 32 KB, or a page whose state is full.
- **At most 500 actions wait on one page.** An action waits until an agent takes it, and past 500 the page's next one is refused. If you read actions with `it actions`, run `it ack` for each one you have dealt with.

`it delete <id>` requests deletion and waits briefly for confirmation. Only a result with `deleted` confirms completion. A `pending` or `retrying` result means It is still working; check with `it delete <id> --status`, which never deletes another page. The site lists unfinished deletions too. Existing file addresses may still answer until the content service has heard of the deletion.
## Publishing and ownership

An explicit `--agent <name>` on `create` or `update` changes the label when this conversation owns the page. Omitting it keeps the label. Updating another conversation's page does not change its label unless you take it with `--take`. Automatic continuation under an earlier local conversation id succeeds only while the page still has the owner that was checked.

`it open` checks the display and changes the page's owner in the same operation that shows it. If no requested display can show it, the owner stays as it was. A publication has thirty minutes, including retries. An identical command already running is reported as `busy`; wait for it to end before retrying. If its answer cannot be confirmed, run the identical command again when It can be reached. It recovers that publication's result before making another version.
