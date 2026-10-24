# What a page can and cannot do

A page is shown in a sandbox, as a document that shares nothing with the site, with another page, or with itself the last time it was open. Write it to these limits:

- **It has no cookies.** Reading or setting `document.cookie` throws.
- **`localStorage` and `sessionStorage` last only while the page is open.** They take what they are given and forget it when the page closes or is shown again. Anything the page must remember goes in `It.store`.
- **There is no IndexedDB, no `caches` and no service worker.** Each of them throws.
- **A worker starts only from a `blob:` address.** `new Worker('worker.js')` fails. Fetch the script and start the worker from a `Blob` of it.
- **It cannot frame its own files.** An `<iframe>`, `<embed>` or `<object>` that names another file of the page, a PDF included, stays empty. Link to the file, or draw what it holds in the page itself. Its scripts, styles, pictures, fonts and what it fetches from its own files all load as usual.
- **Whatever it opens is held to the same.** A window or a link it opens is sandboxed as the page is, and the page cannot move the tab it is shown in.
- **It limits how markup sends the showing's address.** That address holds what opens this showing's files. In the main document, a `<meta name="referrer">` or a `referrerpolicy` is put back to `no-referrer`, and links lose their `ping` attributes. This is a mitigation, not a guarantee: shadow roots and `srcdoc` documents are not watched, and page scripts can still send the address. Do not put policies that disclose the address or links with `ping` in embedded content.
- **Its own address is not one to keep.** What a page's script reads as `location` is where the files of this one showing are, and it stops answering when the showing ends. Do not show it, send it or store it. The address to give the user is the `url` that `it create` printed.

## Sending a photo or any other file

Put the file in what the action carries, wherever it fits: `It.action('receipt', { photo: input.files[0], table: 4 })`. A `File` from an `<input type="file">` or a drop, or a `Blob` from `canvas.toBlob`, goes with the action, beside what it carries, and the action is accepted only once It has every file whole. Never cut a file into pieces or write it into the data as text.

- **A photo is made smaller before it is sent**, to 1600 pixels on its longer side, as a JPEG, which is what you read a picture at, and what the camera wrote into it, such as where it was taken, does not go with it. A picture that is small already goes as it is, with whatever is written in it: one of at most 1600 pixels and 1 MB, and one of at most 1600 pixels that a JPEG would only make larger. Where the page needs the file as it is, pass `{ original: true }` as the third argument: `It.action('scan', { page: file }, { original: true })`, and `It.commit(name, extra, { original: true })` the same. Any other file, such as a PDF, a CSV or a recording, always goes as it is.
- **A phone that loses its connection keeps the action and its files**, in that browser, and sends them once it is back, even if the page was closed in between. The promise stays unanswered while there is no connection, so show on the page that the photo is on its way, and say so when the promise rejects.
- **`It.store` keeps no file.** To show a picture you were sent, on this page or on every screen, put it in the page's folder, publish again with `it update`, and refer to it by its path.

## Keeping something with the page

`It.store.set(key, value)` and `It.store.get(key)` keep small things for the page itself. What is kept there is kept with the page, so it is there the next time the page is opened, on any display. It arrives with the page's state, which is empty until it arrives, a moment after the page opens. It is not there yet when the page's scripts first run: `It.store.get` waits for nothing and answers from what has arrived, so as the page starts it returns `undefined` even for something that was saved. Read what was saved in `It.onState`, as below.

A draft is put back once, when the state first arrives, and never over what is being typed: not when the state changes later, and not when the user began typing before it arrived. It is saved a moment after the typing stops, and not at every letter, which would be more than a page may send. A failed save keeps the text and offers a retry. Keep the page open until it says "Saved." Closing it while changes are unsaved can lose them.

A text field or dropdown bound with `data-it-bind` follows changes to its value only while it holds no edit of the user's, including one made before the state arrived.

Only one save runs at a time. Each save remembers the draft revision it sent, so its answer cannot mark newer text as saved. This counter belongs to this open page, not to the backend's state revision. Two displays editing the same draft still overwrite each other's saved values.

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
  let later
  let revision = 0
  let savedRevision = 0
  let saving = false
  async function save() {
    clearTimeout(later)
    if (saving || revision === savedRevision) return
    const sentRevision = revision
    saving = true
    retry.hidden = true
    status.textContent = 'Saving...'
    try {
      await It.store.set('draft', box.value)
      savedRevision = sentRevision
      if (revision === sentRevision) status.textContent = 'Saved.'
    } catch {
      if (revision === sentRevision) {
        status.textContent = 'Not saved. Keep this page open and try again. If it keeps failing, check the connection or shorten the draft.'
        retry.hidden = false
      }
    } finally {
      saving = false
      if (revision !== sentRevision) {
        status.textContent = 'Changes not saved yet.'
        clearTimeout(later)
        later = setTimeout(save, 800)
      }
    }
  }
  retry.addEventListener('click', save)
  box.addEventListener('input', () => {
    settled = true
    revision++
    status.textContent = 'Changes not saved yet.'
    retry.hidden = true
    clearTimeout(later)
    later = setTimeout(save, 800)
  })
</script>
```

## Changing state that something else may have changed

A page can change its own state while you work, and so can another conversation. Where a change of yours must not overwrite one you have not seen, read the state with `it state deploy-plan`, which prints its `revision` beside it, and give that number back: `it patch deploy-plan '{"total":42}' --if-revision 7`. The change is made only while the state is still at that revision. If it has moved on, the command is refused with the code `conflict`: read the state again and decide anew.

## How much a page may hold and send

A command that goes past one of these is refused with the code `limit`, and one that comes too fast with `rate_limited`: wait a moment and run it again. Sizes are in units of 1,024.

- **A page is at most 500 files and 100 MB, with no file over 25 MB.** A file's path is at most 300 bytes. Ten versions of a page are kept, and It holds 500 pages and 2 GB of their files in all, so publish under the same id to make a new version, and `it delete <id>` a page nobody needs.
- **State is at most 512 KB of JSON,** with what the page stored with `It.store` counted in. Every change stores the whole state again and sends it to every display that shows the page, so a change is counted by the size of the whole state: one page may write 8 MB of it at once, and then 2 MB a minute. Keep state small if you change it often.
- **An action carries at most 32 KB of data, and beside it up to 10 files, each at most 25 MB and 50 MB together.** It holds 1 GB of files sent from pages in all, each kept as long as its action. Its name is 1 to 64 letters, digits, dots, colons, dashes or underscores. A value kept with `It.store` is at most 32 KB too, under a key of 1 to 64 letters, digits, dashes or underscores.
- **A page that asks for its own files too often is refused.** The files of one showing may be asked for 3,000 times in a minute. A page that fetches its own files in a loop is answered 429 past that, until the minute is over.
- **A page that sends too much at once is refused.** The site takes 20 messages from a page at once, actions and stored values together, and then five a second, and It takes 30 actions from one page before it slows that page to one a second. The promise that `It.action`, `It.commit` and `It.store.set` return rejects when what was sent was refused, for being too large or for coming too fast, and it was then not taken. Catch that, and say so on the page, so that the user can press again.
- **At most 500 actions wait on one page.** An action waits until an agent takes it, and past 500 the page's next one is refused. If you read actions with `it actions`, run `it ack` for each one you have dealt with.

`it delete <id>` requests deletion and waits briefly for confirmation. Only a result with `deleted` confirms completion. A `pending` or `retrying` result means It is still working; check with `it delete <id> --status`, which never deletes another page. The site lists unfinished deletions too. Existing file addresses may still answer until the content service has heard of the deletion.
## Publishing and ownership

An explicit `--agent <name>` on `create` or `update` changes the label when this conversation owns the page. Omitting it keeps the label. Updating another conversation's page does not change its label unless you take it with `--take`. Automatic continuation under an earlier local conversation id succeeds only while the page still has the owner that was checked.

`it open` checks the display and changes the page's owner in the same operation that shows it. If no requested display can show it, the owner stays as it was. A publication has thirty minutes, including retries. An identical command already running is reported as `busy`; wait for it to end before retrying. If its answer cannot be confirmed, run the identical command again when It can be reached. It recovers that publication's result before making another version.
