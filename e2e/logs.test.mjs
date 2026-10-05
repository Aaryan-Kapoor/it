// The check that decides whether what a run wrote down may be kept. On a healthy run it finds
// nothing, so nothing else would show if it stopped being able to find anything.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(path.join(os.tmpdir(), 'it-logs-test-'))
const holds = path.join(dir, 'holds.jsonl')
const kept = path.join(dir, 'kept')
const token = 'c0ffee'.repeat(8)
// Each credential that only It has, as a log would hold it. Each is put together here, so that
// this file does not itself hold what the check looks for
const secrets = ['s'.repeat(43), 'S'.repeat(43), 'abcdefghij'.repeat(2), 'klmnopqrst'.repeat(2), 'd'.repeat(43), '0b'.repeat(37)]
const itsOwn = {
  'a showing’s address': `GET http://localhost:20001/s/${secrets[0]}/v/1/index.html 200`,
  'a browser’s session, in its cookie': `cookie: it_session_${'k57a0b1c'.repeat(4)}=${secrets[1]}`,
  'a code that pairs a browser, in an address': `open http://localhost:20000/pair#${secrets[2]}`,
  'a code that joins a machine, in its command': `it login --url http://192.168.1.20:20000 --code ${secrets[3]}`,
  'the door’s key': `x-it-door: ${secrets[4]}`,
  'a key written as a name, a bar and a secret': `authorization: Convex it-${'0a'.repeat(6)}|${secrets[5]}`,
}
// The secrets one installation makes for itself, each as the file It keeps it in writes it, and
// the connector's token as an add-on sends it. None has a shape of its own: each is told by
// the name it stands under.
const NAMED = 'a long value under a name that says it is a secret'
const itsNamed = {
  'the secret in It’s settings that its backend’s keys are made from': [`  "instance${'Secret'}": "${'0a'.repeat(32)}",`, NAMED],
  'the secret in It’s settings that the door’s key is made from': [`  "session${'Secret'}": "${'S'.repeat(43)}",`, NAMED],
  'a connector’s token, as its file keeps it': [`{"socket":"/tmp/it/connector.sock","to${'ken'}":"${'c0ffee'.repeat(8)}","pid":4242}`, NAMED],
  'the key notifications are signed with': [`{"publicKey":"B${'p'.repeat(86)}","private${'Key'}":"${'k'.repeat(43)}"}`, NAMED],
  'a connector’s token, as an add-on sends it': [
    `2026-10-04T12:00:00.000Z POST /clicks x-it-${'token'}: ${'c0ffee'.repeat(8)}`,
    'a connector’s token, in its header',
  ],
}
/** A text as a file keeps it at two bytes to the letter: with or without the mark it may begin with, and with either byte first. */
const twoBytes = (text, { mark, bigEnd }) => {
  const bytes = Buffer.from(`${mark ? '\ufeff' : ''}${text}`, 'utf16le')
  return bigEnd ? bytes.swap16() : bytes
}
/** CI's own step: another program, told only where the run noted what it held. */
const asCi = (folder, inventory = holds) => {
  try {
    execFileSync(process.execPath, [path.join(here, 'logs.mjs'), folder], { env: { ...process.env, IT_E2E_INVENTORY: inventory }, stdio: 'pipe' })
    return 0
  } catch (err) {
    return err.status
  }
}
let lib
let logs

beforeAll(async () => {
  process.env.IT_E2E_INVENTORY = holds
  lib = await import('./lib.mjs')
  logs = await import('./logs.mjs')
  // The run has begun, and has noted nothing yet
  writeFileSync(holds, '')
})
// Each test begins with what a run that wrote nothing it should not leaves behind, and with no
// find noted, whatever the test before it left there or failed in the middle of: the service's
// log, and what the CLI printed, which holds what a page sent. A folder that a system is slow
// to let go of is tried again.
beforeEach(() => {
  rmSync(kept, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  mkdirSync(path.join(kept, 'run'), { recursive: true })
  writeFileSync(path.join(kept, 'service.log'), '{"event":"session.issued","mount":"0f","port":20001}\n')
  writeFileSync(path.join(kept, 'run', 'cli.answers.txt'), '$ it state\n{"kept":"e2e-private-state"}\n')
  rmSync(`${holds}.found`, { force: true })
})
afterAll(() => {
  delete process.env.IT_E2E_INVENTORY
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('the check of what a run wrote down', () => {
  test('finds nothing in what holds nothing, and says how much it read', async () => {
    expect(readFileSync(path.join(kept, 'run', 'cli.answers.txt'), 'utf8')).toMatch(new RegExp(logs.PRIVATE_MARK))
    expect(await logs.leaks([kept])).toEqual({ found: [], read: 2 })
    expect(asCi(kept)).toBe(0)
    // Nothing to read is not a pass
    expect(asCi(path.join(dir, 'no-such-folder'))).toBe(1)
  })

  test('finds a credential by its shape, and what a page or a person sent, in any file whatever it is called and however long', async () => {
    const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(30)}`
    writeFileSync(path.join(kept, 'no-extension-at-all'), `${'filler\n'.repeat(200_000)}authorization: ${jwt}\n`)
    writeFileSync(path.join(kept, 'backend.log'), 'a line\npayload {"note":"e2e-private-nobody clicked"}\n')
    const { found } = await logs.leaks([kept])
    expect(found.map((f) => [path.basename(f.file), f.line, f.what])).toEqual([
      ['backend.log', 2, 'what a page or a person sent'],
      ['no-extension-at-all', 200_001, 'a signed token'],
    ])
    // It writes a file of 200,000 lines and reads it back, which a busy machine takes longer over than a test is given
  }, 30_000)

  test('finds, by its shape and whoever’s it is, each credential that only It has: the address a page is shown at, a browser’s session in its cookie, a code in the address that pairs a browser and in the command that joins a machine, the door’s key, and the backend’s admin key', async () => {
    const log = path.join(kept, 'service.log')
    const before = readFileSync(log, 'utf8')
    writeFileSync(log, `${before}${Object.values(itsOwn).join('\n')}\n`)
    const { found } = await logs.leaks([kept])
    expect(found.map((f) => [path.basename(f.file), f.line, f.what])).toEqual(Object.keys(itsOwn).map((what, n) => ['service.log', n + 2, what]))
    // And nothing of any of them is left in what is printed
    const said = logs.redact(Object.values(itsOwn).join(' and '))
    for (const secret of secrets) expect(said).not.toContain(secret)
    // A path too short to be a showing's, the cookie's name alone, a pairing address with no code, a command with no code, the header's name alone and a word that begins like the key are none of them
    writeFileSync(
      log,
      `${before}GET /s/short/v/1/index.html 404\nthe cookie it_session_${'k57a0b1c'.repeat(4)} was set\nopen http://localhost:20000/pair and type the code\nit login --url <address> --code <code>\nx-it-door was sent\nit-0a0a0a0a0a0a is its name\n`,
    )
    expect((await logs.leaks([kept])).found).toEqual([])
  })

  test('finds each secret an installation makes for itself by the name it stands under, with nothing noted of what the run held, in each way a log may be kept', async () => {
    const folder = path.join(dir, 'named')
    const nothingNoted = path.join(dir, 'named-holds.jsonl')
    writeFileSync(nothingNoted, '')
    const written = [
      (text) => Buffer.from(text),
      (text) => twoBytes(text, { mark: true, bigEnd: false }),
      (text) => twoBytes(text, { mark: true, bigEnd: true }),
    ]
    for (const [which, [line, what]] of Object.entries(itsNamed))
      for (const as of written) {
        rmSync(folder, { recursive: true, force: true })
        mkdirSync(folder)
        writeFileSync(path.join(folder, 'service.log'), as(`started\n${line}\nstopped\n`))
        const { found } = await logs.leaks([folder])
        expect(
          found.map((f) => [f.line, f.what]),
          which,
        ).toEqual([[2, what]])
        rmSync(`${holds}.found`, { force: true })
        // Another program, as CI's step is, told of nothing the run held
        expect(asCi(folder, nothingNoted), which).toBe(1)
        rmSync(`${nothingNoted}.found`, { force: true })
      }
    // And nothing of any of them is left in what is printed
    const said = logs.redact(
      Object.values(itsNamed)
        .map(([line]) => line)
        .join('\n'),
    )
    for (const secret of ['0a'.repeat(32), 'S'.repeat(43), 'c0ffee'.repeat(8), 'k'.repeat(43)]) expect(said).not.toContain(secret)
    expect(said).toContain(`[${NAMED}]`)
    // What It writes of such things, with no value beside the name, is none of them
    rmSync(folder, { recursive: true, force: true })
    mkdirSync(folder)
    writeFileSync(
      path.join(folder, 'service.log'),
      `connector: a request without its token\n{"event":"token.refused","reason":"proof"}\n{"event":"signout_token.refused","reason":"claims"}\nthe header x-it-token was not sent\n`,
    )
    expect((await logs.leaks([folder])).found).toEqual([])
  })

  test('reads a log kept at two bytes to the letter as that, whichever byte comes first and whether or not it begins with the mark that says so, and finds in it what it finds in any other', async () => {
    const folder = path.join(dir, 'two-bytes')
    const noted = path.join(dir, 'two-bytes-holds.jsonl')
    const held = 'feedc0de'.repeat(6)
    writeFileSync(noted, `${JSON.stringify({ what: 'a connector’s token', value: held })}\n`)
    const text = `started\n${Object.values(itsOwn).join('\n')}\nan add-on asked with ${held}\npayload {"note":"e2e-private-nobody clicked"}\n`
    const expected = [...Object.keys(itsOwn), 'a connector’s token (1)', 'what a page or a person sent'].map((what, n) => [n + 2, what])
    const ways = [
      { mark: true, bigEnd: false },
      { mark: false, bigEnd: false },
      { mark: true, bigEnd: true },
      { mark: false, bigEnd: true },
    ]
    for (const way of ways) {
      rmSync(folder, { recursive: true, force: true })
      mkdirSync(folder)
      writeFileSync(path.join(folder, 'service.log'), twoBytes(text, way))
      const { found, read } = await logs.leaks([folder], { 'a connector’s token (1)': held })
      expect(read).toBe(1)
      expect(
        found.map((f) => [f.line, f.what]),
        JSON.stringify(way),
      ).toEqual(expected)
      // Another program, as CI's step is, fails on it too: by the shapes alone, and by what the run noted alone
      expect(asCi(folder, noted), JSON.stringify(way)).toBe(1)
      rmSync(`${noted}.found`, { force: true })
      writeFileSync(path.join(folder, 'service.log'), twoBytes(`started\nan add-on asked with ${held}\n`, way))
      expect(asCi(folder, noted), JSON.stringify(way)).toBe(1)
      rmSync(`${noted}.found`, { force: true })
      // And one that holds nothing passes, read to its end
      writeFileSync(path.join(folder, 'service.log'), twoBytes(`${'started and stopped\n'.repeat(5000)}`, way))
      expect(asCi(folder, noted), JSON.stringify(way)).toBe(0)
    }
    // A letter of two full bytes right before a token: with the empty bytes only taken out, its
    // bytes read as two ordinary letters that the token would seem to be the end of a word after
    const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(30)}`
    writeFileSync(path.join(folder, 'service.log'), twoBytes(`\u4141${jwt}\n`, { mark: false, bigEnd: false }))
    expect((await logs.leaks([folder])).found.map((f) => [f.line, f.what])).toEqual([[1, 'a signed token']])
    // What one program began as plain text and another went on with at two bytes to the letter is read both ways
    writeFileSync(
      path.join(folder, 'service.log'),
      Buffer.concat([
        Buffer.from(`started\n${itsOwn['a showing’s address']}\n`),
        twoBytes(`${itsOwn['a browser’s session, in its cookie']}\n`, { mark: false, bigEnd: false }),
      ]),
    )
    const both = (await logs.leaks([folder])).found.map((f) => [f.line, f.what])
    expect(both).toContainEqual([2, 'a showing’s address'])
    expect(both).toContainEqual([3, 'a browser’s session, in its cookie'])
  })

  test('fails on a log that is no text, since what cannot be read cannot be vouched for', async () => {
    const folder = path.join(dir, 'no-text')
    const noted = path.join(dir, 'no-text-holds.jsonl')
    writeFileSync(noted, '')
    mkdirSync(folder)
    const file = path.join(folder, 'service.log')
    const noText = [
      // Empty bytes on both sides of their letters, and no mark
      Buffer.concat([Buffer.from('started\n'), Buffer.from([0, 1, 2, 0, 0, 3]), Buffer.from('\nstopped\n')]),
      // Four bytes to the letter, which begins as text at two bytes does
      Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), ...[...'started\nstopped\n'].map((c) => Buffer.from([c.charCodeAt(0), 0, 0, 0]))]),
    ]
    for (const bytes of noText) {
      writeFileSync(file, bytes)
      const { found } = await logs.leaks([folder])
      expect(found).toHaveLength(1)
      expect(found[0]).toMatchObject({ what: 'bytes that are no text, so that it cannot be read' })
      rmSync(`${noted}.found`, { force: true })
      expect(asCi(folder, noted)).toBe(1)
      rmSync(`${noted}.found`, { force: true })
    }
    // What is in it is looked for all the same
    writeFileSync(file, Buffer.concat([noText[0], Buffer.from(`${itsOwn['a showing’s address']}\n`)]))
    expect((await logs.leaks([folder])).found.map((f) => f.what)).toEqual(['bytes that are no text, so that it cannot be read', 'a showing’s address'])
    rmSync(`${noted}.found`, { force: true })
  })

  test('fails on a log whose bytes are not the text they are kept as, by the line that is not, and reads what is in it all the same', async () => {
    const folder = path.join(dir, 'not-sound')
    const noted = path.join(dir, 'not-sound-holds.jsonl')
    writeFileSync(noted, '')
    mkdirSync(folder)
    const file = path.join(folder, 'service.log')
    const NO_TEXT = 'bytes that are no text, so that it cannot be read'
    const notSound = [
      // Bytes that are no letter of plain text, with nothing empty among them
      [Buffer.concat([Buffer.from('started\n'), Buffer.from([0xff, 0xc3, 0x28, 0x80, 0x81, 0x82, 0x41, 0x42]), Buffer.from('\nstopped\n')]), 2],
      // One letter of another way of writing text, in the middle of plain text
      [Buffer.concat([Buffer.from('started\nstarted by Ren'), Buffer.from([0xe9]), Buffer.from('\nstopped\n')]), 2],
      // A letter of several bytes that the file ends in the middle of
      [Buffer.concat([Buffer.from('started\nstopped\n'), Buffer.from([0xe6, 0xbc])]), 3],
      // At two bytes to the letter: half of a pair that is never completed, and a byte too many at the end
      [
        Buffer.concat([
          twoBytes('started\n', { mark: true, bigEnd: false }),
          Buffer.from([0x00, 0xd8]),
          twoBytes('\nstopped\n', { mark: false, bigEnd: false }),
        ]),
        2,
      ],
      [Buffer.concat([twoBytes('started\nstopped\n', { mark: true, bigEnd: true }), Buffer.from([0x41])]), 3],
    ]
    for (const [n, [bytes, line]] of notSound.entries()) {
      writeFileSync(file, bytes)
      const { found } = await logs.leaks([folder])
      expect(
        found.map((f) => [f.line, f.what]),
        `case ${n}`,
      ).toEqual([[line, NO_TEXT]])
      rmSync(`${noted}.found`, { force: true })
      expect(asCi(folder, noted), `case ${n}`).toBe(1)
      rmSync(`${noted}.found`, { force: true })
    }
    // What is in such a file is looked for all the same
    writeFileSync(file, Buffer.concat([notSound[0][0], Buffer.from(`${itsOwn['a showing’s address']}\n`)]))
    expect((await logs.leaks([folder])).found.map((f) => [f.line, f.what])).toEqual([
      [2, NO_TEXT],
      [4, 'a showing’s address'],
    ])
    rmSync(`${noted}.found`, { force: true })
    // Text that is sound passes, whatever letters it is written in, and so does the mark a file of plain text may begin with
    for (const sound of [
      Buffer.from('started by René 漢字 🙂\nstopped\n'),
      Buffer.from('\ufeffstarted\nstopped\n'),
      twoBytes('started by René 漢字 🙂\nstopped\n', { mark: true, bigEnd: false }),
      twoBytes('started by René 漢字 🙂\nstopped\n', { mark: true, bigEnd: true }),
      Buffer.from(''),
    ]) {
      writeFileSync(file, sound)
      expect((await logs.leaks([folder])).found).toEqual([])
    }
    expect(asCi(folder, noted)).toBe(0)
  })

  test('what the CLI printed may hold what a page or a person sent, and may not hold a credential', async () => {
    const answers = path.join(kept, 'run', 'cli.answers.txt')
    const before = readFileSync(answers, 'utf8')
    writeFileSync(answers, `${before}$ it site\n{"url":"http://localhost:20000/pair#${'abcdefghij'.repeat(2)}"}\n`)
    const { found } = await logs.leaks([kept])
    expect(found.map((f) => [path.basename(f.file), f.what])).toEqual([['cli.answers.txt', 'a code that pairs a browser, in an address']])
  })

  test('what the CLI printed is told by the file’s own name, however the system it is on writes the folders before it', () => {
    for (const [file, way] of [
      ['/tmp/it-kept/run/cli.answers.txt', path.posix],
      ['/tmp/it-kept/cli.said.log', path.posix],
      ['cli.answers.txt', path.posix],
      ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\it-kept\\run\\cli.answers.txt', path.win32],
      ['D:\\a\\_temp\\it-kept\\cli.said.log', path.win32],
      ['D:/a/_temp/it-kept/run/cli.answers.txt', path.win32],
      ['cli.said.log', path.win32],
    ])
      expect(logs.printedByCli(file, way), file).toBe(true)
    // Another file is not one of them for being named like one, or for being in a folder named like one
    for (const [file, way] of [
      ['/tmp/it-kept/run/not-cli.answers.txt', path.posix],
      ['/tmp/it-kept/run/cli.answers.txt.old', path.posix],
      ['/tmp/it-kept/cli.answers.txt/service.log', path.posix],
      ['/tmp/it-kept/run/connector-1.log', path.posix],
      ['C:\\it-kept\\run\\not-cli.answers.txt', path.win32],
      ['C:\\it-kept\\cli.said.log\\service.log', path.win32],
      ['C:\\it-kept\\run\\service.log', path.win32],
    ])
      expect(logs.printedByCli(file, way), file).toBe(false)
    // And where nothing says how, it is this system's way: a file of this very folder is told as the scan tells it
    expect(logs.printedByCli(path.join(kept, 'run', 'cli.answers.txt'))).toBe(true)
    expect(logs.printedByCli(path.join(kept, 'service.log'))).toBe(false)
  })

  test('the stack’s own files are the ones beside its log, and not the folders there, which a run reads for itself', () => {
    expect(logs.stackLogs(kept).map((file) => path.basename(file))).toEqual(['service.log'])
    expect(logs.stackLogs(path.join(dir, 'no-such-folder'))).toEqual([])
  })

  test('finds what the run itself noted that it held, in this program and in another told only where it was noted', async () => {
    lib.noteSecret('a connector’s token', token)
    lib.noteSecret('a connector’s token', token)
    writeFileSync(path.join(kept, 'run', 'connector-1.log'), `started\nan add-on asked with ${token}\n`)
    const { found } = await logs.leaks([kept])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ line: 2, what: expect.stringContaining('a connector’s token') })
    // Another program, as CI's step is, finds it too, from the file alone
    rmSync(`${holds}.found`, { force: true })
    expect(asCi(kept)).toBe(1)
    // One that was told of other things the run held, and not of this, cannot: which is why the file is kept
    const another = path.join(dir, 'another.jsonl')
    writeFileSync(another, `${JSON.stringify({ what: 'something else', value: 'not-the-token-at-all' })}\n`)
    expect(asCi(kept, another)).toBe(0)
  })

  test('a credential that could not be written down for the later check is still known here, fails the noting, and is written at the next noting', () => {
    const late = 'another-token-0123456789'
    const nowhere = path.join(dir, 'no-such-folder', 'holds.jsonl')
    process.env.IT_E2E_INVENTORY = nowhere
    try {
      expect(() => lib.noteSecret('a connector’s token', late)).toThrow()
      // What this program prints is cleaned of it all the same
      expect(logs.redact(`asked with ${late}`)).not.toContain(late)
      // From where nothing can be stopped, the failure is kept for the run to fail on
      expect(lib.couldNotNote()).toEqual([])
      lib.noteWhenSeen('a showing’s session', 'a-session-0123456789abcdef')
      lib.noteWhenSeen('a showing’s session', 'a-session-0123456789abcdef')
      expect(lib.couldNotNote()).toEqual(['a showing’s session'])
    } finally {
      process.env.IT_E2E_INVENTORY = holds
    }
    expect(readFileSync(holds, 'utf8')).not.toContain(late)
    lib.noteSecret('a connector’s token', late)
    lib.noteSecret('a connector’s token', late)
    expect(readFileSync(holds, 'utf8').split(late)).toHaveLength(2)
  })

  test('a connector’s token is noted from its folder once it has written one down, and not before', () => {
    const home = path.join(dir, 'machine')
    mkdirSync(home)
    expect(lib.noteConnector(home)).toBe(false)
    writeFileSync(path.join(home, 'connector.json'), '{"socket":')
    expect(lib.noteConnector(home)).toBe(false)
    const its = 'feedface'.repeat(6)
    writeFileSync(path.join(home, 'connector.json'), JSON.stringify({ socket: path.join(home, 'connector.sock'), token: its }))
    expect(lib.noteConnector(home)).toBe(true)
    expect(logs.redact(`an add-on asked with ${its}`)).not.toContain(its)
    expect(readFileSync(holds, 'utf8')).toContain(its)
  })

  test('the later check fails when it was told where the run noted what it held and cannot read that, since it then knows nothing of it', () => {
    writeFileSync(path.join(kept, 'run', 'connector-2.log'), 'started\nstopped\n')
    expect(asCi(kept, path.join(dir, 'never-written.jsonl'))).toBe(1)
    const torn = path.join(dir, 'torn.jsonl')
    writeFileSync(torn, `${JSON.stringify({ what: 'a connector’s token', value: token })}\n{"what":"a conn`)
    expect(asCi(kept, torn)).toBe(1)
    const odd = path.join(dir, 'odd.jsonl')
    writeFileSync(odd, `${JSON.stringify({ what: 'a connector’s token' })}\n`)
    expect(asCi(kept, odd)).toBe(1)
    // It is the note that cannot be read which fails each of them: with one that can be, and that holds nothing, the same folder passes
    const nothing = path.join(dir, 'nothing-noted.jsonl')
    writeFileSync(nothing, '')
    expect(asCi(kept, nothing)).toBe(0)
  })

  test('a find by one check fails every later check of the same run, whatever the later one sees', async () => {
    lib.noteSecret('a connector’s token', token)
    writeFileSync(path.join(kept, 'run', 'connector-1.log'), `started\nan add-on asked with ${token}\n`)
    expect((await logs.leaks([kept])).found).toHaveLength(1)
    expect(existsSync(`${holds}.found`)).toBe(true)
    // The log that held it is gone by the time CI's own step looks
    rmSync(path.join(kept, 'run', 'connector-1.log'))
    expect((await logs.leaks([kept])).found).toEqual([])
    expect(asCi(kept)).toBe(1)
    rmSync(`${holds}.found`)
    expect(asCi(kept)).toBe(0)
  })

  test('names the note of a find beside the file the run notes what it holds in, and adds to what another check noted there', async () => {
    expect(logs.foundNote()).toBe(`${holds}.found`)
    delete process.env.IT_E2E_INVENTORY
    try {
      expect(logs.foundNote()).toBe(null)
    } finally {
      process.env.IT_E2E_INVENTORY = holds
    }
    // Another check of the same run noted a find of its own first, as the run does of what a browser's console held
    const folder = path.join(dir, 'noted-twice')
    mkdirSync(folder)
    writeFileSync(path.join(folder, 'service.log'), `started\n${itsOwn['a showing’s address']}\n`)
    writeFileSync(logs.foundNote(), 'a browser’s console held a showing’s address (1)\n')
    await logs.leaks([folder])
    expect(readFileSync(logs.foundNote(), 'utf8')).toBe(
      `a browser’s console held a showing’s address (1)\n${path.join(folder, 'service.log')}:2 a showing’s address\n`,
    )
    rmSync(logs.foundNote())
    rmSync(folder, { recursive: true })
  })

  test('what a failed check would print is cleaned of anything that is, or is shaped like, a credential', () => {
    const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(30)}`
    const said = logs.redact(`the CLI said: Bearer ${jwt} and ${token}, with it_session_${'k57a0b1c'.repeat(4)}=${'s'.repeat(43)}; and nothing else`)
    for (const secret of [jwt, token, 's'.repeat(43)]) expect(said).not.toContain(secret)
    expect(said).toContain('and nothing else')
    expect(logs.redact('nothing to hide here')).toBe('nothing to hide here')
  })

  test('a check’s line is cleaned whole: its name, which may quote what an error said, as well as what it found', () => {
    const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(30)}`
    const failed = logs.verdict(`the run finished (the backend said ${token} and ${jwt})`, false, `Error: ${token}\n    at somewhere`)
    for (const secret of [jwt, token]) expect(failed).not.toContain(secret)
    expect(failed).toMatch(/^ {2}FAIL the run finished \(the backend said \[a connector’s token \(1\)\] and \[a signed token\]\)\n {9}Error: \[a connector/)
    // What it found is cleaned before it is cut short: a credential that lies across the cut is not left in part
    const across = logs.verdict('a check', false, `${'x'.repeat(390)}${token}`, 400)
    expect(across).not.toContain(token.slice(0, 10))
    expect(logs.verdict(`passed with ${token}`, true, 'never shown')).toBe('  ok   passed with [a connector’s token (1)]')
  })

  test('what ends a script that nothing caught is cleaned too, however it ended', () => {
    const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(30)}`
    const ways = {
      thrown: `throw new Error('thrown with ${jwt} and ${token}')`,
      awaited: `await Promise.reject(new Error('rejected with ${jwt} and ${token}'))`,
      adrift: `void Promise.reject(new Error('adrift with ${jwt} and ${token}')); await new Promise((r) => setTimeout(r, 200))`,
    }
    for (const [how, ends] of Object.entries(ways)) {
      const script = `import { printCleanly } from ${JSON.stringify(pathToFileURL(path.join(here, 'logs.mjs')).href)}; printCleanly(); ${ends}; console.log('went on')`
      const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, IT_E2E_INVENTORY: holds }, encoding: 'utf8' })
      expect(ran.status, how).toBe(1)
      expect(ran.stdout, how).toBe('')
      for (const secret of [jwt, token]) expect(ran.stderr, how).not.toContain(secret)
      expect(ran.stderr, how).toMatch(/with \[a signed token\] and \[a connector’s token/)
    }
  })
})
