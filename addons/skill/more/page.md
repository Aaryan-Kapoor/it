# What a page can and cannot do

A page is shown in a sandbox, as a document that shares nothing with the site, with another page, or with itself the last time it was open. Write it to these limits:

- **It has no cookies.** Reading or setting `document.cookie` throws.
- **`localStorage` and `sessionStorage` last only while the page is open.** They take what they are given and forget it when the page closes or is shown again. Anything the page must remember goes in `It.store`.
- **There is no IndexedDB, no `caches` and no service worker.** Each of them throws.
- **A worker starts only from a `blob:` address.** `new Worker('worker.js')` fails. Fetch the script and start the worker from a `Blob` of it.
- **It cannot frame its own files.** An `<iframe>`, `<embed>` or `<object>` that names another file of the page, a PDF included, stays empty. Link to the file, or draw what it holds in the page itself. Its scripts, styles, pictures, fonts and what it fetches from its own files all load as usual.
- **A link to another site opens in a new tab.** Write links as on any page: one to another site opens in a tab of its own, whatever its `target` says, and the page stays as it was. The tab is an ordinary one, and neither it nor the page has a hold on the other, so `window.open` returns `null`: do not take that for a blocked window. No referrer is sent. In Firefox, a link inside an embedded `srcdoc` document can still send the page's showing address, with its token, to another site when clicked. Whoever receives it and can reach It's pages port can read that showing's version of the page, but no other page or browser pairing. The token lasts until ten minutes after the last request or a day after the showing began, whichever comes first; requests can keep it alive until that day. Closing the tab does not end it. It also ends when It stops or the content service hears of deletion or sign-out, which can be delayed. A link within the page or to another of its files stays in the page, and a tab of the page's own files is sandboxed as the page is. Every link and form It can see is given `rel="noopener noreferrer"`, which changes nothing where it is followed within the page. The page cannot move the tab it is shown in. Do not put a link in a closed shadow root that the markup declares (`<template shadowrootmode="closed">`): It cannot see that link, and following it shows the page again instead of opening the link. A shadow root a script makes, open or closed, and an open one the markup declares, is fine.
- **A mail, phone or messages link is opened by It.** A `mailto:`, `tel:` or `sms:` link works when the user clicks it. From a script, call `It.open(url)` in the handler of the user's click or key: it opens an http, https, mailto, tel or sms address as a link would, and throws on any other kind. A window of a `javascript:`, `data:` or `blob:` address is never opened.
- **It limits how markup sends the showing's address.** That address holds what opens this showing's files. In the main document, a `<meta name="referrer">` or a `referrerpolicy` is put back to `no-referrer`, and links lose their `ping` attributes. This is a mitigation, not a guarantee: closed shadow roots the markup declares and `srcdoc` documents are not watched, and page scripts can still send the address. Do not put policies that disclose the address or links with `ping` in embedded content.
- **Its own address is not one to keep.** What a page's script reads as `location` is where the files of this one showing are, and it stops answering when the showing ends. Do not show it, send it or store it. The address to give the user is the `url` that `it create` printed.

## Players and maps from other sites

A player or a map from one of these providers is framed by the site over the page, exactly where the page puts it, and works there as it does on any other site: YouTube (`https://www.youtube.com/embed/…` and `https://www.youtube-nocookie.com/embed/…`), Vimeo (`https://player.vimeo.com/video/…`), Spotify (`https://open.spotify.com/embed/…`), SoundCloud (`https://w.soundcloud.com/player/?url=…`), Google Maps (`https://www.google.com/maps/embed?…`, and `https://maps.google.com/maps?q=…&output=embed`), OpenStreetMap (`https://www.openstreetmap.org/export/embed.html?…`) and Twitch (`https://player.twitch.tv/?channel=…`). Write the provider's embed code as it gives it, such as `<iframe src="https://www.youtube.com/embed/aqz-KE-bpKQ" width="560" height="315"></iframe>`, and size and place the frame as you would any element. It keeps the frame where it is as the player's place, loads nothing inside it, and lays the player over it. Nobody is asked anything. A frame of any other site stays inside the page's sandbox, where most players do not start, so use a link for those.

To drive a player, take a handle to it. `It.embed(frame)` gives the handle of a frame you wrote, and `It.embed(element, url)` puts a player over any element, such as an empty `<div>` you have sized. `handle.post(message)` sends the player a message in the form its own API takes, `handle.onmessage = (e) => …` hears what it sends back in `e.data`, `handle.onload` is called each time its frame has loaded (what is posted before then waits for it), and `handle.remove()` takes it away, as taking its element out of the page does. Once you hold a frame's handle, change what it plays with `It.embed(frame, url)`, which gives a new handle: changing the frame's `src` then does nothing. For YouTube's API, add `enablejsapi=1` to the address and It puts in the `origin` the API needs; then post `'{"event":"listening"}'` once the frame has loaded, and commands as JSON text, such as `handle.post('{"event":"command","func":"pauseVideo","args":[]}')`. The scripts a provider gives for driving its player, such as YouTube's `iframe_api`, `SC.Widget` or Spotify's iFrame API, talk to a frame inside the page and cannot reach a player It hosts, so send what they would send with `post`. `It.embed` throws for an address of any other provider. A page may have at most 16 players and maps at once, and the place of any more is left empty.

A player lies over the page rather than in it, which has these costs. Lay the page out with them in mind:

- **Nothing of the page draws over a player.** A menu, a tooltip or a dialog of the page that opens over one is hidden under it. Keep them clear of players.
- **The wheel or a swipe over a player does not scroll the page.** Leave room around a large player for scrolling.
- **A player follows its element.** It hides while the element is hidden or scrolled out of sight, is cut where the window or a box of the page that scrolls cuts the element, takes the element's rounded corners, and goes with it as the page scrolls, a frame behind in some browsers.
- **A click within 0.6 seconds of a player appearing, moving, changing size or being uncovered does nothing**, so that a page cannot slide a player under a click meant for the page. A player that keeps moving cannot be clicked until it stops.
- **A page that puts another of its own elements in fullscreen leaves its players behind.** A player's own fullscreen button makes It fullscreen, with that player over the whole of the page's area below the bar, until the user leaves fullscreen; then it goes back to its place. `requestFullscreen()` on a player's frame or element does the same from the page.
- **A card's small picture of the page shows no player or map:** their places are left empty there.

## Sending a photo or any other file

Put the file in what the action carries, wherever it fits: `It.action('receipt', { photo: input.files[0], table: 4 })`. A `File` from an `<input type="file">` or a drop, or a `Blob` from `canvas.toBlob`, goes with the action, beside what it carries, and the action is accepted only once It has every file whole. Never cut a file into pieces or write it into the data as text.

- **For a photo from a phone, use a file input.** `<input type="file" accept="image/*" capture="environment">` works on every screen, over plain http too, and asks nothing of It. On most phones it offers the phone's own camera; elsewhere the user chooses a picture they have.
- **A photo is made smaller before it is sent**, to 1600 pixels on its longer side, as a JPEG, which is what you read a picture at, and what the camera wrote into it, such as where it was taken, does not go with it. A picture that goes as it is keeps whatever is written in it: one that is small already (at most 1600 pixels and 1 MB, or at most 1600 pixels where a JPEG would only make it larger), and one this browser cannot read or redraw, as some browsers cannot a HEIC photo. Where the page needs the file as it is, pass `{ original: true }` as the third argument: `It.action('scan', { page: file }, { original: true })`, and `It.commit(name, extra, { original: true })` the same. Any other file, such as a PDF, a CSV or a recording, always goes as it is.
- **A phone that loses its connection keeps the action and its files**, in that browser, and sends them once it is back, even if the page was closed in between. The promise stays unanswered while there is no connection, so show on the page that the photo is on its way, and say so when the promise rejects.
- **`It.store` keeps no file.** To show a picture you were sent, on this page or on every screen, put it in the page's folder, publish again with `it update`, and refer to it by its path.

## The microphone, the camera and a photo

A page uses the microphone or the camera of the screen it is shown on by calling for them: nothing is said of it when you publish. The page never gets the device itself: It opens it, and passes the page what it gives as it comes. The first time on each screen, It asks the user in its own bar whether this page may, and the browser asks too the first time for It's site; after that the page opens them there without being asked, and It's bar says what is live for as long as it is, with a Stop button. What the user allows lasts until they take it back, or until the page goes 30 days without using it. It asks only while the page is in front, in the window the user is using, and opens nothing while the browser says the page is not shown, so call from something the user did on the page. A call made before the page has finished loading waits until it has.

- **Show why it failed.** `It.microphone`, `It.camera` and `It.photo` reject with a sentence that says why: the user said no, the page was not in front, the call did not come from a click, the screen reaches It over plain http, the browser refused, or It was updated while that screen had it open, which reloading It there fixes. A browser gives the microphone only to an https address or to the machine It runs on, so on another screen It must be opened at its https address, which `it https on` on that machine sets up.
- **It can end without the page asking.** The microphone and the camera pause while the browser says the page is not shown, and end when the user presses Stop in It's bar or takes back what they allowed, when another conversation takes the page over, or when the page closes or loads another document, which has to ask again. `onchange` says which, and the stream ends.
- **It does not record for the page.** A page records the stream it is given with a `MediaRecorder` of its own, as the next section shows. `It.record` is refused with a sentence that says so.
- **A photo is the user's to take.** `const photo = await It.photo()` opens It's own view of the camera in its bar, the user takes the photo there or closes it, and the page is given a JPEG `File`. `It.photo({ facing: 'environment' })` asks for the camera on the back of a phone. Like the camera, it works only where the screen reaches It at its https address or is the machine It runs on, so it is for a page that wants It's own view of the camera; a file input works anywhere. It is refused while the camera or the microphone is live to the page: take your own picture from `cam.onframe` then, by drawing it on a canvas and using `canvas.toBlob`.

## Hearing the microphone live

For a call to another screen, live captions, a level meter, a voice note or anything that answers a voice, the page can hear the microphone as it happens. Call `It.microphone()` from a click or a key in the page. It's bar says "Mic live" with a Stop button for as long as it is open.

```js
talk.onclick = async () => {
  const mic = await It.microphone() // asks the user first, the first time on each screen
  mic.onsound = (samples, sampleRate) => meter(samples) // each piece: a Float32Array of one channel, from -1 to 1
  mic.onchange = (state, why) => {} // 'live', 'paused' or 'ended', with why it ended
  // mic.stream is a MediaStream: record it, or send its track with RTCPeerConnection
  const parts = []
  const recorder = new MediaRecorder(mic.stream)
  recorder.ondataavailable = (e) => parts.push(e.data)
  recorder.onstop = () => {
    const type = (parts[0]?.type ?? '').split(';')[0] // audio/webm, audio/ogg in Firefox, audio/mp4 in Safari
    const name = `take.${type.endsWith('ogg') ? 'ogg' : type.endsWith('mp4') ? 'm4a' : 'webm'}`
    It.action('take', { take: new File(parts, name, { type }) })
  }
  recorder.start(1000) // and recorder.stop() when the user is done, then mic.stop()
}
```

- **Call it from a click or a key in the page.** A browser starts sound for a page only once the user has done something in it. Called at any other time, `It.microphone` rejects with a sentence that says so, and the user is asked nothing.
- **The page never gets the microphone itself.** It sends the page the sound in pieces of a fiftieth of a second, of one channel, at `mic.sampleRate` samples a second, which is usually 48,000, and `mic.stream` is made in the page from them, about 60 milliseconds behind the microphone. `mic.onsound` is given each piece, for a meter or for captions made from the samples. A page that falls behind is sent less sound and never a backlog, so return from `onsound` quickly.
- **Settings are the page's to say.** `It.microphone({ echoCancellation: false, noiseSuppression: false, autoGainControl: false })` turns off what a browser does to a voice, as for music. It takes nothing else, and no page can name a device.
- **A recording is a file like any other.** Record `mic.stream` as above, and send the file with `It.action`: it is held to the same limits as any file, 1 GB at most, and the agent saves what arrives with `it save <id> <file>`. Each browser records its own kind, `audio/webm`, `audio/ogg` in Firefox or `audio/mp4` in Safari, so name the file by the type of what was recorded, `parts[0].type`, as above. Do not read `recorder.mimeType` once it has stopped: Firefox empties it then.
- **Do not play `mic.stream` on the same screen.** Put in an `<audio>` there, the user hears themselves late, and the microphone hears it again. It is for a meter, a recorder, or a call to somewhere else.
- **One of each at a time.** The microphone and the camera can be live together, each with its own Stop in It's bar: open one, wait for it, then open the other. A second `It.microphone()` is refused until the first is stopped.

## Seeing the camera live

For a call to another screen, reading a QR code, a filter or a live preview, the page can see the camera's picture as it happens. Call `It.camera()`. It asks once in its bar for that page on that screen, and the browser asks the first time; a page allowed the camera, for a photo too, opens it live without being asked again. It's bar says "Camera live" with a Stop button for as long as it is open.

```js
const cam = await It.camera({ facing: 'environment', width: 1280 }) // asks the user first, the first time on each screen
video.srcObject = cam.stream // a MediaStream: show it, or send its tracks with RTCPeerConnection
cam.onframe = (picture) => ctx.drawImage(picture, 0, 0) // each picture, an ImageBitmap, closed when this returns
cam.onchange = (state, why) => {} // 'live', 'paused' or 'ended', with why it ended
await cam.stop()
```

- **The page never gets the camera itself.** It sends the page each picture, and `cam.stream` is made in the page from them. The next picture comes only once the page has drawn the last, so a slow `onframe` gets fewer pictures and never a backlog. Read or draw the picture inside `onframe`. `cam.width` and `cam.height` are the last picture's size, at most 1920 pixels on its longer side, and at most 30 pictures come in a second, whatever you ask for.
- **`It.camera({ audio: true })` adds the user's voice.** `cam.stream` then has a sound track as well, so a call made from it carries the person's voice, and a `MediaRecorder` on it records picture and sound together. `audio` may be the same settings `It.microphone` takes. Call it from a click or a key in the page, as `It.microphone`. It asks for the microphone and the camera in one question, It's bar says "Camera and mic live", and its one Stop ends both. Keep the `<video>` that shows it `muted`. It is refused while `It.microphone()` is open, and `It.microphone()` while it is: one of them has the microphone at a time.

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

## Large state

A single argument on a command line has a limit, about 128 KB on Linux and under 32 KB on Windows, so state larger than that cannot be given as one argument on that system. Write it with your own file tool to a file in the temporary folder, so as to leave nothing in the user's project, and give its path instead: `it patch board --file /tmp/board.json`, `it set board order --file /tmp/order.json` for one value, or `--state-file <path>` on `it create`.

## On Windows

Run It as `it.exe` on Windows, as in `it.exe state board`, and never as a bare `it`. Windows PowerShell 5.1 carries Pester, a test framework with a command of its own called `It`, and a bare `it` runs that command and fails with "The It command may only be used inside a Describe block" wherever It's folder is not on the PATH yet, as in the conversation that installed It, and wherever Pester has been loaded, even with It's folder on the PATH. `it.exe` is always It's program. Where it is not found ("is not recognized"), run It by its full path with forward slashes, as in `C:/Users/ana/.it/bin/it.exe state board` in PowerShell or Git Bash. In PowerShell put `&` before a path in quotes, as in `& "C:/Users/Ana Lee/.it/bin/it.exe" state board`, and in cmd write it in quotes with backslashes, as in `"C:\Users\Ana Lee\.it\bin\it.exe" state board`.

Windows PowerShell 5.1 also takes the double quotes out of an argument it hands to a program, so `it.exe patch board '{"order":["c1"]}'` reaches It as `{order:[c1]}` and is refused. Writing the quotes as `\"` works only while no value has a space in it. On Windows, write the JSON with your own file tool to a file in the temporary folder, so as to leave nothing in the user's project, and give its path in double quotes and with forward slashes, which every shell passes as it is: `it.exe patch board --file "C:/Users/ana/AppData/Local/Temp/board.json"`, `it.exe set board order --file "<path>"` for one value, or `--state-file "<path>"` on `it.exe create`. A file reads the same in every shell, PowerShell 7, cmd and Git Bash among them. A value with no double quote in it is safe on the command line, as in `it.exe set board status "Deploying 3 of 7"`, unless it begins and ends with brackets or braces, as `[beta]` does: `it set` refuses such a value on every system, since it cannot tell it from JSON a shell has changed, so give it as a JSON string in a file. Do not pipe JSON into It from Windows PowerShell 5.1, which sends what it pipes in ASCII, so that every letter outside ASCII arrives as a question mark.

## Changing state that something else may have changed

A page can change its own state while you work, and so can another conversation. Where a change of yours must not overwrite one you have not seen, read the state with `it state deploy-plan`, which prints its `revision` beside it, and give that number back: `it patch deploy-plan '{"total":42}' --if-revision 7`. The change is made only while the state is still at that revision. If it has moved on, the command is refused with the code `conflict`: read the state again and decide anew.

## Going fullscreen

It's bar has a fullscreen button above every page, so a page needs none of its own. Where one helps, as on a slideshow, call `It.fullscreen()` from a click, and `It.exitFullscreen()` to leave. It is It that goes fullscreen, with its bar still above the page, and the page has the rest of the screen. `It.isFullscreen` says whether It is fullscreen, and the page hears `fullscreenchange` whenever that changes, whether by its own button, by It's or by Escape.

A page's own `requestFullscreen()`, on its document or on any element, is given It's fullscreen in the same way, so code written for any web page works, in Safari too. An element other than the document or the body, such as a `<video>` or a player, is made to fill the page's area below the bar, and goes back as it was when fullscreen ends. While it fills it, It holds its position and size in its own `style`: what the page writes there of those takes effect once fullscreen ends, and anything else the page writes stays. Write them with `style.setProperty()` or the style's own properties: a declaration of one of them added to `style.cssText` without `!important` may be dropped while the element is fullscreen. It puts them back once in each frame, so animating them, or writing the whole style again, does not end fullscreen; a page that writes them back whenever It holds them, as from a `MutationObserver` on the element's style, only keeps the element from filling the area. It goes on filling the area when the page moves it, unless it is a popover of the page's own, which the move closes. Removing it from the page ends fullscreen for it, as in any browser. When It lets an element go, It stays fullscreen with the page's document where It went fullscreen from the bar or for the document, and otherwise leaves fullscreen. `document.fullscreenElement` and `document.exitFullscreen()` speak of It's fullscreen, and a request for another element while It is fullscreen moves fullscreen to that element. What the browser makes fullscreen in the page by itself, as a video's own controls can, is left at once and given It's fullscreen in the same way, so that nothing of a page stays over the bar.

**Style fullscreen with `[data-it-fullscreen]`, never `:fullscreen`.** The browser's `:fullscreen`, and `::backdrop`, never match inside the page. While It is fullscreen, whatever the page reads as fullscreen carries the attribute `data-it-fullscreen`: the `<html>` element when It went fullscreen from the bar or `It.fullscreen()`, and otherwise the element the page asked for. So write `html[data-it-fullscreen] .slide { font-size: 4vw }`, or set a class from `fullscreenchange`.

It goes fullscreen only on the person's own click or key in the page, and not in the few seconds after a click on It's bar or just after fullscreen ended, so ask from a click handler and never from `fullscreenchange` or a timer. The promise rejects where It would not go fullscreen: when it was not asked from such a click, and where the browser has no fullscreen, as on an iPhone. Catch it and leave the page usable without fullscreen.

## How much a page may hold and send

A command that goes past one of these is refused with the code `limit`, and one that comes too fast with `rate_limited`: wait a moment and run it again. Sizes are in units of 1,024.

- **A page is at most 500 files and 4 GB, with no file over 2 GB.** A file's path is at most 300 bytes. A film can be one of a page's files and shown with `<video src="film.mp4">`: the browser asks for the part it plays, so it starts at once and plays from wherever the user skips to. Ten versions of a page are kept, and It holds 500 pages and 100 GB of their files in all, unless the user set It up to keep another amount, so publish under the same id to make a new version, and `it delete <id>` a page nobody needs. It always leaves some of its disk free, 2 GB unless the user said otherwise, and a page that would take more is refused, saying so.
- **State is at most 512 KB of JSON,** with what the page stored with `It.store` counted in, and a page keeps at most 5,000 values with `It.store`. A change of yours stores your part of the state again whole and sends it to every display that shows the page, so it is counted by the size of that part: one page may write 8 MB of it at once, and then 2 MB a minute. Keep your part small if you change it often. What the page stores is written and sent value by value, and counted by the values that changed.
- **An action carries at most 32 KB of data, and beside it up to 10 files, each at most 1 GB and 2 GB together.** It holds 20 GB of files sent from pages in all, unless the user set It up to keep another amount, each kept as long as its action. Its name is 1 to 64 letters, digits, dots, colons, dashes or underscores. A value kept with `It.store` is at most 32 KB too, under a key of 1 to 64 letters, digits, dashes or underscores.
- **A page that asks for its own files too often is refused.** The files of one showing may be asked for 3,000 times in a minute. A page that fetches its own files in a loop is answered 429 past that, until the minute is over.
- **A page that sends too many actions at once is refused.** The site takes 60 actions from a page at once, and then fifteen a second, and It takes 120 actions from one page before it slows that page to one a second. What It slows down waits in the browser and is sent in turn, so its promise resolves late, until 100 actions from the page are waiting. The promise that `It.action` and `It.commit` return rejects when what was sent was refused, for being too large or for coming too fast, and it was then not taken. Catch that, and say so on the page, so that the user can press again. In one rare case it rejects with a message that It cannot tell whether the action was done, after the page lost its channel to It with the action on its way: show that message, and do not send the action again by itself.
- **`It.store.set` waits rather than fail for coming too fast.** It sends no more than twenty writes a second from one display, and a page that sets values faster than It takes them has them held and sent together a moment later. Its promise resolves once the value is kept, and rejects only for a value It will not take, such as one over 32 KB, or a page whose state is full.
- **At most 500 actions wait on one page.** An action waits until an agent takes it, and past 500 the page's next one is refused. If you read actions with `it actions`, run `it ack` for each one you have dealt with.

`it delete <id>` requests deletion and waits briefly for confirmation. Only a result with `deleted` confirms completion. A `pending` or `retrying` result means It is still working; check with `it delete <id> --status`, which never deletes another page. The site lists unfinished deletions too. Existing file addresses may still answer until the content service has heard of the deletion.
## Publishing and ownership

An explicit `--agent <name>` on `create` or `update` changes the label when this conversation owns the page. Omitting it keeps the label. Updating another conversation's page does not change its label unless you take it with `--take`. Automatic continuation under an earlier local conversation id succeeds only while the page still has the owner that was checked.

`it open` checks the display and changes the page's owner in the same operation that shows it. If no requested display can show it, the owner stays as it was. A publication has thirty minutes, including retries. An identical command already running is reported as `busy`; wait for it to end before retrying. If its answer cannot be confirmed, run the identical command again when It can be reached. It recovers that publication's result before making another version.
