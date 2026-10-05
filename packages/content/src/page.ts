// Putting It first in a page, before any of the page's own scripts.
//
// It goes inside the page's <html> or <head> when the page begins with one, as that element's
// first child; before the page's first element when it begins with anything else; and at the
// end of a page that has no element in it at all (plain words, or only a comment), since
// without it such a page could never say it has loaded, and the site would go on trying to
// show it for ever.
//
// The page is read a piece at a time and passed on as it is read. What comes before an element
// is told apart as a browser tells it: a doctype, a comment, a closing tag and plain text are
// none of them an element, and each ends where a browser ends it and nowhere else. Only a tag
// is held back, until it is known where it ends, and only so much of one.
//
// Two things a browser does at the end of a page matter here. A comment or a doctype that the
// page never finished is taken as finished, so It is put after it only once it has been closed
// with the few characters that close it; otherwise It would be read as part of it. And a tag
// that the page never finished is thrown away, so It is put before that tag, not after it.
//
// A browser reads a page as UTF-8, as it is told to, with one exception: a page that begins
// with the mark of UTF-16 is read as UTF-16 whatever it is told. Such a page is turned into
// UTF-8 before anything else is done with it, so that what is looked through here is what the
// browser reads, and It is written in the same letters as the page around it.

type State =
  | 'text'
  | 'opened' // "<" has been read, and what it begins is not yet known
  | 'declaration' // "<!"
  | 'declaration-dash' // "<!-"
  | 'comment'
  | 'until-close' // a doctype, or anything else that runs to the next ">"
  | 'closing' // "</"
  | 'name' // a tag's name, which runs to the next space, "/" or ">" whatever it holds
  | 'tag' // inside a tag, between its attributes
  | 'attribute'
  | 'after-attribute'
  | 'before-value'
  | 'double-quoted'
  | 'single-quoted'
  | 'unquoted'

const LT = 0x3c
const GT = 0x3e
const BANG = 0x21
const DASH = 0x2d
const SLASH = 0x2f
const QUESTION = 0x3f
const EQUALS = 0x3d
const DOUBLE = 0x22
const SINGLE = 0x27
const isSpace = (c: number) => c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20
const isLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))
/** Two runs of bytes as one. */
function joined(a: Uint8Array, b: Uint8Array): Uint8Array {
  const all = new Uint8Array(a.length + b.length)
  all.set(a)
  all.set(b, a.length)
  return all
}
/** How much of one tag is held back while it is not known where the tag ends. Past this, It goes before the tag. */
const HELD_MOST = 64 * 1024

/** The page as UTF-8: as it is, unless it begins with the mark of UTF-16, and then turned from that. */
function asUtf8(page: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = page.getReader()
  const encoder = new TextEncoder()
  /** What the page began with, until there is enough of it to tell. */
  let began: Uint8Array | null = new Uint8Array(0)
  let decoder: TextDecoder | null = null
  /** Whether each pair of bytes is the other way round from how the decoder takes them, and a byte left over from the piece before. */
  let swapped = false
  let left: number | null = null

  /** A piece of the page as UTF-8. */
  const turned = (piece: Uint8Array, last = false): Uint8Array => {
    if (!decoder) return piece
    let bytes = piece
    if (swapped) {
      const all = left === null ? piece : joined(Uint8Array.of(left), piece)
      const even = all.length - (all.length % 2)
      left = even < all.length ? all[even]! : null
      bytes = new Uint8Array(even)
      for (let i = 0; i < even; i += 2) {
        bytes[i] = all[i + 1]!
        bytes[i + 1] = all[i]!
      }
      // Half a letter at the very end is no letter, and is left for the decoder to say so
      if (last && left !== null) bytes = joined(bytes, Uint8Array.of(left))
    }
    return encoder.encode(decoder.decode(bytes, { stream: !last }))
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read()
        let out: Uint8Array
        if (began) {
          if (!done) {
            began = joined(began, value)
            if (began.length < 2) continue
          }
          const little = began[0] === 0xff && began[1] === 0xfe
          const big = began[0] === 0xfe && began[1] === 0xff
          // The decoder takes the mark off the front itself
          if (little || big) decoder = new TextDecoder('utf-16le')
          swapped = big
          out = turned(began, done)
          began = null
        } else out = turned(done ? new Uint8Array(0) : value, done)
        if (out.byteLength > 0) controller.enqueue(out)
        if (done) {
          controller.close()
          return
        }
        if (out.byteLength > 0) return
      }
    },
    cancel: (reason) => reader.cancel(reason),
  })
}

/** The page with `tags` put first in it, as UTF-8. */
export function withTags(page: ReadableStream<Uint8Array>, tags: Uint8Array): ReadableStream<Uint8Array> {
  let state: State = 'text'
  let placed = false
  /** Pieces held back: from the "<" that may open a tag, up to where this piece began, and how many bytes they come to. */
  let held: Uint8Array[] | null = null
  let heldBytes = 0
  /** Whether the tag being read is a closing one; the first element's name so far; and whether It goes inside that element. */
  let closing = false
  let name = ''
  let inside = false
  /** In a comment: how many dashes have just been read, whether they are still the ones that opened it, and whether "--!" has been. */
  let dashes = 0
  let opening = false
  let bang = false

  function read(piece: Uint8Array, out: (bytes: Uint8Array) => void): void {
    if (placed) {
      out(piece)
      return
    }
    /** Where in this piece what has not been passed on begins. */
    let from = 0
    const release = (to: number) => {
      for (const h of held ?? []) out(h)
      held = null
      heldBytes = 0
      if (to > from) out(piece.subarray(from, to))
      from = to
    }
    // The end of a tag. A closing tag is passed on: it is no element. With the first element's
    // tag, It is placed: after the tag when it opens the page's <html> or <head>, and before it
    // when it opens anything else.
    const endTag = (i: number): boolean => {
      state = 'text'
      if (closing) {
        release(i + 1)
        return false
      }
      if (inside) release(i + 1)
      out(tags)
      release(i + 1)
      placed = true
      out(piece.subarray(i + 1))
      return true
    }
    for (let i = 0; i < piece.length; i++) {
      const c = piece[i]!
      switch (state) {
        case 'text':
          if (c !== LT) break
          // What came before is certainly before It. From here on is held until it is known what this begins
          release(i)
          held = []
          state = 'opened'
          break
        case 'opened':
          if (isLetter(c)) {
            state = 'name'
            closing = false
            name = String.fromCharCode(c).toLowerCase()
            break
          }
          if (c === SLASH) {
            state = 'closing'
            break
          }
          // Not a tag, so nothing to hold back
          release(i)
          if (c === BANG) state = 'declaration'
          else if (c === QUESTION) state = 'until-close'
          else if (c === LT) {
            held = []
            state = 'opened'
          } else state = 'text'
          break
        case 'closing':
          if (isLetter(c)) {
            state = 'name'
            closing = true
            break
          }
          // "</>" is nothing at all, and "</" before anything else begins what runs to the next ">"
          release(i)
          state = c === GT ? 'text' : 'until-close'
          break
        case 'declaration':
          state = c === DASH ? 'declaration-dash' : c === GT ? 'text' : 'until-close'
          break
        case 'declaration-dash':
          if (c === DASH) {
            state = 'comment'
            dashes = 2
            opening = true
            bang = false
          } else state = c === GT ? 'text' : 'until-close'
          break
        case 'comment':
          if (bang) {
            bang = false
            if (c === GT) state = 'text'
            else dashes = c === DASH ? 1 : 0
          } else if (c === DASH) dashes += 1
          else if (c === GT && dashes >= 2) state = 'text'
          else if (c === BANG && dashes - (opening ? 2 : 0) >= 2) {
            bang = true
            dashes = 0
          } else {
            dashes = 0
            opening = false
          }
          break
        case 'until-close':
          if (c === GT) state = 'text'
          break
        case 'name':
          // A name is whatever comes before the next space, "/" or ">": a quote in it is a letter of it
          if (!isSpace(c) && c !== SLASH && c !== GT) {
            // Only as much of a name as it takes to know it is neither of the two
            if (!closing && name.length <= 4) name += String.fromCharCode(c).toLowerCase()
            break
          }
          inside = !closing && (name === 'html' || name === 'head')
          if (c === GT) {
            if (endTag(i)) return
          } else state = 'tag'
          break
        case 'tag':
          if (c === GT) {
            if (endTag(i)) return
          } else if (!isSpace(c) && c !== SLASH) state = 'attribute'
          break
        case 'attribute':
          if (c === GT) {
            if (endTag(i)) return
          } else if (isSpace(c)) state = 'after-attribute'
          else if (c === SLASH) state = 'tag'
          else if (c === EQUALS) state = 'before-value'
          break
        case 'after-attribute':
          if (c === GT) {
            if (endTag(i)) return
          } else if (c === EQUALS) state = 'before-value'
          else if (c === SLASH) state = 'tag'
          else if (!isSpace(c)) state = 'attribute'
          break
        case 'before-value':
          if (c === GT) {
            if (endTag(i)) return
          } else if (c === DOUBLE) state = 'double-quoted'
          else if (c === SINGLE) state = 'single-quoted'
          else if (!isSpace(c)) state = 'unquoted'
          break
        case 'double-quoted':
          if (c === DOUBLE) state = 'tag'
          break
        case 'single-quoted':
          if (c === SINGLE) state = 'tag'
          break
        case 'unquoted':
          if (c === GT) {
            if (endTag(i)) return
          } else if (isSpace(c)) state = 'tag'
          break
      }
    }
    // What is left of this piece is passed on, unless it is being held back
    if (!held) {
      if (from < piece.length) out(piece.subarray(from))
      return
    }
    held.push(piece.subarray(from))
    heldBytes += piece.length - from
    // A tag longer than a tag has any reason to be is not waited for: It goes before it
    if (heldBytes > HELD_MOST) {
      out(tags)
      placed = true
      for (const h of held) out(h)
      held = null
    }
  }

  /** What is passed on when the page ends before It has been placed. */
  function atTheEnd(out: (bytes: Uint8Array) => void): void {
    if (held) {
      // The page ended inside a tag, which a browser throws away: It goes before it
      out(tags)
      for (const h of held) out(h)
      return
    }
    // What the page left unfinished is finished, as a browser takes it to be, so that It is not read as part of it
    if (state === 'comment') out(ascii(bang || dashes >= 2 ? '>' : dashes === 1 ? '->' : '-->'))
    else if (state === 'until-close' || state === 'declaration' || state === 'declaration-dash') out(ascii('>'))
    out(tags)
  }

  const reader = asUtf8(page).getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // One piece of the page at a time, and on to the next until one of them gives something to pass on
      for (;;) {
        const { done, value } = await reader.read()
        const give = (bytes: Uint8Array) => {
          if (bytes.byteLength > 0) controller.enqueue(bytes)
        }
        if (done) {
          if (!placed) atTheEnd(give)
          controller.close()
          return
        }
        let gave = false
        read(value, (bytes) => {
          if (bytes.byteLength === 0) return
          controller.enqueue(bytes)
          gave = true
        })
        if (gave) return
      }
    },
    cancel: (reason) => reader.cancel(reason),
  })
}
