# What a page can and cannot do

A page is shown in a sandbox, as a document that shares nothing with the site, with another page, or with itself the last time it was open. Write it to these limits:

- **It has no cookies.** Reading or setting `document.cookie` throws.
- **`localStorage` and `sessionStorage` last only while the page is open.** They take what they are given and forget it when the page closes or is shown again. Anything the page must remember goes in `It.store`.
- **There is no IndexedDB, no `caches` and no service worker.** Each of them throws.
- **A worker starts only from a `blob:` address.** `new Worker('worker.js')` fails. Fetch the script and start the worker from a `Blob` of it.
- **It cannot frame its own files.** An `<iframe>`, `<embed>` or `<object>` that names another file of the page, a PDF included, stays empty. Link to the file, or draw what it holds in the page itself. Its scripts, styles, pictures, fonts and what it fetches from its own files all load as usual.
- **Whatever it opens is held to the same.** A window or a link it opens is sandboxed as the page is, and the page cannot move the tab it is shown in.
- **Its own address is not one to keep.** What a page's script reads as `location` is where the files of this one showing are, and it stops answering when the showing ends. Do not show it, send it or store it. The address to give the user is the `url` that `it create` printed.

## Keeping something with the page

`It.store.set(key, value)` and `It.store.get(key)` keep small things for the page itself. What is kept there is kept with the page, so it is there the next time the page is opened, on any display. It arrives with the page's state, which is empty until it arrives, a moment after the page opens. It is not there yet when the page's scripts first run: `It.store.get` waits for nothing and answers from what has arrived, so as the page starts it returns `undefined` even for something that was saved. Read what was saved in `It.onState`, as below.

A draft is put back once, when the state first arrives, and never again over what is being typed. It is saved a moment after the typing stops, and not at every letter, which would be more than a page may send:

```html
<textarea id="draft"></textarea>
<script>
  const box = document.getElementById('draft')
  let restored = false
  It.onState(() => {
    if (restored) return
    restored = true
    box.value = It.store.get('draft') ?? ''
  })
  let later
  box.addEventListener('input', () => {
    clearTimeout(later)
    later = setTimeout(() => It.store.set('draft', box.value).catch(() => {}), 800)
  })
</script>
```

## Changing state that something else may have changed

A page can change its own state while you work, and so can another conversation. Where a change of yours must not overwrite one you have not seen, read the state with `it state deploy-plan`, which prints its `revision` beside it, and give that number back: `it patch deploy-plan '{"total":42}' --if-revision 7`. The change is made only while the state is still at that revision. If it has moved on, the command is refused with the code `conflict`: read the state again and decide anew.

## How much a page may hold and send

A command that goes past one of these is refused with the code `limit`, and one that comes too fast with `rate_limited`: wait a moment and run it again. Sizes are in units of 1,024.

- **A page is at most 500 files and 100 MB, with no file over 25 MB.** A file's path is at most 300 bytes. Ten versions of a page are kept, and It holds 500 pages and 2 GB of their files in all, so publish under the same id to make a new version, and `it delete <id>` a page nobody needs.
- **State is at most 512 KB of JSON,** with what the page stored with `It.store` counted in. Every change stores the whole state again and sends it to every display that shows the page, so a change is counted by the size of the whole state: one page may write 8 MB of it at once, and then 2 MB a minute. Keep state small if you change it often.
- **An action carries at most 32 KB.** Its name is 1 to 64 letters, digits, dots, colons, dashes or underscores. A value kept with `It.store` is at most 32 KB too, under a key of 1 to 64 letters, digits, dashes or underscores.
- **A page that asks for its own files too often is refused.** The files of one showing may be asked for 3,000 times in a minute. A page that fetches its own files in a loop is answered 429 past that, until the minute is over.
- **A page that sends too much at once is refused.** The site takes 20 messages from a page at once, actions and stored values together, and then five a second, and It takes 30 actions from one page before it slows that page to one a second. The promise that `It.action`, `It.commit` and `It.store.set` return rejects when what was sent was refused, for being too large or for coming too fast, and it was then not taken. Catch that, and say so on the page, so that the user can press again.
- **At most 500 actions wait on one page.** An action waits until an agent takes it, and past 500 the page's next one is refused. If you read actions with `it actions`, run `it ack` for each one you have dealt with.

`it delete <id>` requests deletion and waits briefly for confirmation. Only a result with `deleted` confirms completion. A `pending` or `retrying` result means It is still working; check with `it delete <id> --status`, which never deletes another page. The site lists unfinished deletions too. Existing file addresses may still answer until the content service has heard of the deletion.
