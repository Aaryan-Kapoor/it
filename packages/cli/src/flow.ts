// What a person sees when they set It up at a terminal: a few steps, each a line that says what
// is being done and then that it is done, and where there is something to choose, a list to
// choose from with the arrow keys. Everything here writes to the terminal's second stream, so
// that what a command prints for a program to read is never mixed with it.
import qrcode from 'qrcode-generator'

const out = process.stderr
/** Whether there is a person at a terminal to draw for: nothing is redrawn in place, and no key is read, where there is not. */
export const live = (): boolean => out.isTTY === true && process.stdin.isTTY === true && process.env.TERM !== 'dumb'
const coloured = (): boolean => out.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb'
const paint = (code: string) => (text: string) => (coloured() ? `\x1b[${code}m${text}\x1b[0m` : text)
export const bold = paint('1')
export const dim = paint('2')
export const green = paint('32')
export const red = paint('31')
export const yellow = paint('33')
const write = (text: string) => void out.write(text)

/** The name as it is drawn everywhere: the two letters, and the green dot after them. */
export const mark = (): string => `${bold('it')}${green('.')}`

/** The first lines of a flow: the name, and what is about to happen. */
export function banner(what: string): void {
  write(`\n  ${mark()}  ${dim(what)}\n\n`)
}
/** One line, set in from the edge as everything of a flow is. */
export function line(text = ''): void {
  write(text ? `  ${text}\n` : '\n')
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
/** How wide the name of a step is set, so that what is said of each lines up under the last. */
const NAME = 20
const named = (name: string, said = '') => (said ? `${name.padEnd(NAME)} ${dim(said)}` : name)

export interface Step {
  /** Says how far it has got, in place of the last thing said. */
  say(said: string): void
  /** It is done. */
  done(said?: string): void
  /** It is done, with something left for the person to do, or something they should know. */
  warn(said: string): void
  /** It could not be done. */
  fail(said: string): void
}
/**
 * One step: a line that turns while the step is at work, and is written once more, with a mark,
 * when it has ended. Where nothing can be redrawn the line is written once, at the end.
 */
export function step(name: string, said = ''): Step {
  let now = said
  let frame = 0
  let ended = false
  const redrawn = live()
  const draw = () => write(`\r\x1b[2K  ${dim(FRAMES[frame++ % FRAMES.length]!)} ${named(name, now)}`)
  const timer = redrawn ? setInterval(draw, 80) : undefined
  if (redrawn) draw()
  const end = (sign: string, last: string | undefined) => {
    if (ended) return
    ended = true
    clearInterval(timer)
    write(`${redrawn ? '\r\x1b[2K' : ''}  ${sign} ${named(name, last ?? now)}\n`)
  }
  return {
    say(next) {
      now = next
    },
    done: (last) => end(green('✓'), last),
    warn: (last) => end(yellow('!'), last),
    fail: (last) => end(red('✗'), last),
  }
}

/** A bar that fills as something arrives, for what is said of a step that fetches. */
export function bar(got: number, of: number | undefined): string {
  const mb = (n: number) => `${(n / 1_048_576).toFixed(0)} MB`
  if (!of) return mb(got)
  const width = 18
  const filled = Math.min(width, Math.round((got / of) * width))
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${mb(got)} of ${mb(of)}`
}

// ---------- choosing ----------

type Key = 'up' | 'down' | 'space' | 'enter' | 'all' | 'stop' | { digit: number } | undefined
function keyOf(bytes: string): Key {
  if (bytes === '\x1b[A' || bytes === '\x1bOA' || bytes === 'k') return 'up'
  if (bytes === '\x1b[B' || bytes === '\x1bOB' || bytes === 'j' || bytes === '\t') return 'down'
  if (bytes === ' ') return 'space'
  if (bytes === '\r' || bytes === '\n') return 'enter'
  if (bytes === 'a') return 'all'
  if (bytes === '\x03' || bytes === '\x04') return 'stop'
  if (/^[1-9]$/.test(bytes)) return { digit: Number(bytes) }
  return undefined
}

/**
 * Reads keys, one at a time, until `on` says it has what it wanted. The terminal is given back
 * as it was however this ends, and Ctrl-C ends the program as it does everywhere else.
 */
function keys<T>(on: (key: Key) => T | undefined): Promise<T> {
  const input = process.stdin
  return new Promise<T>((resolve) => {
    const was = input.isRaw === true
    input.setRawMode(true)
    input.resume()
    const finish = () => {
      input.off('data', heard)
      input.setRawMode(was)
      input.pause()
    }
    const heard = (data: Buffer) => {
      const key = keyOf(data.toString('utf8'))
      if (key === 'stop') {
        finish()
        write('\x1b[?25h\n')
        process.exit(130)
      }
      const got = on(key)
      if (got !== undefined) {
        finish()
        resolve(got)
      }
    }
    input.on('data', heard)
  })
}

export interface Option<T> {
  value: T
  label: string
  /** Said after the label, quietly. */
  hint?: string
  /** Why it cannot be chosen, which is said in place of the hint. */
  no?: string
}

/** Draws a list in place of the one drawn before it. */
function listed(rows: string[], drawn: number): number {
  if (drawn) write(`\x1b[${drawn}A`)
  for (const row of rows) write(`\r\x1b[2K${row}\n`)
  return rows.length
}

/**
 * Asks for one of several. The arrow keys move, a digit goes straight to that one, and Enter
 * takes it. One that cannot be chosen is listed with why, and passed over. The question and its
 * list are then taken away again, for whoever asked to say in a line what was chosen.
 */
export async function pick<T>(question: string, options: Option<T>[], first = 0): Promise<T> {
  const can = options.map((o) => o.no === undefined)
  let at = can[first] ? first : Math.max(0, can.indexOf(true))
  const move = (by: number) => {
    do at = (at + by + options.length) % options.length
    while (!can[at])
  }
  write(`  ${bold(question)}\n`)
  const rows = () =>
    options.map((o, i) => {
      const said = o.no ?? o.hint
      return `  ${i === at ? green('❯') : ' '} ${i === at ? o.label : dim(o.label)}${said ? `  ${dim(said)}` : ''}`
    })
  write('\x1b[?25l')
  let drawn = listed(rows(), 0)
  const chosen = await keys<number>((key) => {
    if (key === 'up') move(-1)
    else if (key === 'down') move(1)
    else if (typeof key === 'object' && key.digit <= options.length && can[key.digit - 1]) at = key.digit - 1
    else if (key === 'enter') return at
    drawn = listed(rows(), drawn)
    return undefined
  })
  write(`\x1b[${drawn + 1}A\x1b[0J\x1b[?25h`)
  return options[chosen]!.value
}

/**
 * Asks for any of several. Space ticks and unticks the one the mark is at, `a` ticks all or
 * none, and Enter takes what is ticked. What cannot be chosen is listed with why, and passed over.
 */
export async function pickMany<T>(question: string, options: (Option<T> & { on: boolean })[]): Promise<T[]> {
  const can = options.map((o) => o.no === undefined)
  const on = options.map((o, i) => can[i]! && o.on)
  let at = Math.max(0, can.indexOf(true))
  const move = (by: number) => {
    if (!can.includes(true)) return
    do at = (at + by + options.length) % options.length
    while (!can[at])
  }
  write(`  ${bold(question)}  ${dim('space to choose, enter to go on')}\n`)
  const rows = () =>
    options.map((o, i) => {
      const box = !can[i] ? dim('–') : on[i] ? green('●') : dim('○')
      const said = o.no ?? o.hint
      return `  ${i === at && can[i] ? green('❯') : ' '} ${box} ${can[i] ? o.label : dim(o.label)}${said ? `  ${dim(said)}` : ''}`
    })
  write('\x1b[?25l')
  let drawn = listed(rows(), 0)
  await keys<true>((key) => {
    if (key === 'up') move(-1)
    else if (key === 'down') move(1)
    else if (key === 'space' && can[at]) on[at] = !on[at]
    else if (key === 'all') {
      const every = on.every((x, i) => x || !can[i])
      for (let i = 0; i < on.length; i++) on[i] = can[i]! && !every
    } else if (key === 'enter') return true
    drawn = listed(rows(), drawn)
    return undefined
  })
  write(`\x1b[${drawn + 1}A\x1b[0J\x1b[?25h`)
  return options.filter((_, i) => on[i]).map((o) => o.value)
}

/** Waits for something, or for the person to press Enter, whichever comes first. Null where Enter came first. */
export async function unlessEnter<T>(waited: Promise<T>): Promise<T | null> {
  if (!live()) return waited
  let done = false
  const input = process.stdin
  const was = input.isRaw === true
  const pressed = new Promise<null>((resolve) => {
    const heard = (data: Buffer) => {
      const key = keyOf(data.toString('utf8'))
      if (key === 'stop') {
        input.setRawMode(was)
        write('\n')
        process.exit(130)
      }
      if (key === 'enter' && !done) resolve(null)
    }
    input.setRawMode(true)
    input.resume()
    input.on('data', heard)
    void waited.finally(() => input.off('data', heard)).catch(() => {})
  })
  try {
    return await Promise.race([waited, pressed])
  } finally {
    done = true
    input.setRawMode(was)
    input.pause()
  }
}

// ---------- a code a camera reads ----------

/**
 * An address as a QR code, in lines of text: two rows of the code to each line, drawn dark on
 * white whatever the terminal's own colours are, since that is what a camera reads.
 */
export function qr(text: string): string[] {
  const code = qrcode(0, 'L')
  code.addData(text)
  code.make()
  const size = code.getModuleCount()
  // The empty margin a reader needs around the code to find it
  const edge = 2
  const dark = (row: number, col: number) => row >= 0 && col >= 0 && row < size && col < size && code.isDark(row, col)
  const lines: string[] = []
  for (let row = -edge; row < size + edge; row += 2) {
    let drawn = ''
    for (let col = -edge; col < size + edge; col++) {
      const top = dark(row, col)
      const bottom = dark(row + 1, col)
      // White is the ink: a square of the code that is dark is left as the black behind it
      drawn += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█'
    }
    lines.push(coloured() ? `\x1b[97;40m${drawn}\x1b[0m` : drawn)
  }
  return lines
}
