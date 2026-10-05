// The gate against a committed credential (scripts/secrets.mjs). On a healthy repository it
// finds nothing, so nothing else would show if it stopped being able to find anything.
//
// Every credential here is made up, and is put together from pieces as the test runs: written
// out whole, this file would itself hold what the gate looks for.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { credentialsIn, readingsOf, scan } from '../scripts/secrets.mjs'

const body = ['AbCdEf0123456789', 'AbCdEf0123456789'].join('')
const plainValue = ['abcdefghijklmnop', '0123456789'].join('')
const marked = ['sk', 'live', body].join('_')
const signed = ['eyJ', '.eyJ', '.'].map((start, i) => start + 'abc'[i].repeat(24)).join('')
const kinds = (text) => credentialsIn(text).map((f) => f.what)
const NAMED = 'a long value under a name that says it is a secret'
const MARKED = 'a key marked test or live'
const BARRED = 'a key written as a name, a bar and a secret'
// What only It has, each as it is written where it is a credential
const code = ['abcdefghij', 'klmnopqrst'].join('')
const random = ['AbCdEf0123456789_-AbCdEf', '0123456789_-AbCdEfG'].join('')
const adminKey = `${['it', '0123456789ab'].join('-')}|${'0123456789abcdef'.repeat(4)}`
// The name of one session's cookie: what every such name begins with, and then the session's id
const cookieName = ['it', 'session', 'k57a0b1c2d3e4f5g6h7j8k9m0n1p2q3r'].join('_')
const ITS_OWN = {
  'a code that pairs a browser, in an address': `http://localhost:4700/pair#${code}`,
  'a code that joins a machine, in its command': `it login --url http://192.168.1.20:4700 --code ${code}`,
  'a browser’s session, in its cookie': `cookie: ${cookieName}=${random}`,
  'a showing’s address': `http://localhost:4701/s/${random}/v/1/index.html`,
  'the door’s key': `${['x-it', 'door'].join('-')}: ${random}`,
  'a connector’s token, in its header': `POST /clicks ${['x-it', 'token'].join('-')}: ${'0123456789abcdef'.repeat(3)}`,
  [BARRED]: `authorization: Convex ${adminKey}`,
}

describe('what the gate takes for a credential', () => {
  test('a token GitHub gives out is one, of each kind', () => {
    for (const kind of ['ghp', 'gho', 'ghs', 'ghu', 'ghr'])
      expect(kinds(`remote = https://x:${[kind, `${body}0123`].join('_')}@github.com/`), kind).toEqual(['a GitHub token'])
    expect(kinds(['github', 'pat', `${body}_${body}`].join('_'))).toEqual(['a GitHub token'])
  })

  test('a key marked test with an underscore in it is one, and so is a bearer value of sixteen characters', () => {
    expect(kinds(['sk', 'test', 'AbCdEf', `${body}`].join('_'))).toEqual([MARKED])
    expect(kinds(['pk', 'live', body].join('_'))).toEqual([MARKED])
    expect(kinds(`Authorization: ${'Bearer'} abcdef0123456789`)).toEqual(['a bearer credential'])
    expect(kinds(`authorization: ${'bearer'} abcdef0123456789`)).toEqual(['a bearer credential'])
  })

  test('a long value under a name that says it is a secret is one, however the file writes it', () => {
    const written = [
      `pass${'word'}=${plainValue}`,
      `  client_${'secret'}: ${plainValue}`,
      `{"to${'ken'}": "${plainValue}"}`,
      `const apiTo${'ken'} = "${plainValue}"`,
      `  apiK${'ey'}: '${plainValue}',`,
      `export SERVICE_TO${'KEN'}=${plainValue}`,
      `SESSION_SEC${'RET'}_NEXT="${plainValue}"`,
    ]
    for (const line of written) expect(kinds(line), line).toEqual([NAMED])
  })

  test('a signed token, a key marked live, a webhook secret, a private key and a key written after the name of its backend are each one', () => {
    expect(kinds(`token ${signed}`)).toEqual(['a signed token'])
    expect(kinds(marked)).toEqual([MARKED])
    expect(kinds(['whsec', body].join('_'))).toEqual(['a webhook secret'])
    expect(kinds(`-----BEGIN ${'PRIVATE'} KEY-----`)).toEqual(['a private key'])
    expect(kinds(`${['dev', 'happy-animal-123'].join(':')}|${body}`)).toEqual([BARRED])
  })

  test('the key It runs its own backend with is one, and two words of code with a bar between them are not', () => {
    const hex = ['0123456789ab', 'cdef'].join('')
    expect(kinds(`${['it', hex.slice(0, 12)].join('-')}|${hex.repeat(4)}`)).toEqual([BARRED])
    expect(kinds(`{ "adminK${'ey'}": "${['it', hex.slice(0, 12)].join('-')}|${hex.repeat(4)}" }`)).toEqual([BARRED])
    for (const line of ['/a-file-named-only-here|only-in-this-query/.test(text)', `/test-only|${hex}/`]) expect(kinds(line), line).toEqual([])
  })

  test('each credential that only It has is one, by its shape: a code in the address that pairs a browser and in the command that joins a machine, a session in its cookie, the address a page is shown at, the door’s key, a connector’s token in the header an add-on sends it by, and the key It runs its backend with', () => {
    for (const [what, line] of Object.entries(ITS_OWN)) expect(kinds(line), what).toEqual([what])
    // In the other ways each is written: a code in capitals, a command with a sign before the
    // code, the door's key as the setting the backend is given it by, an address that ends at its token
    expect(kinds(`http://localhost:4700/pair#${code.toUpperCase()}`)).toEqual(['a code that pairs a browser, in an address'])
    expect(kinds(`it login --code=${code} --url http://192.168.1.20:4700`)).toEqual(['a code that joins a machine, in its command'])
    expect(kinds(`it login --url http://192.168.1.20:4700 --code "${code.match(/.{4}/g).join(' ')}"`)).toEqual(['a code that joins a machine, in its command'])
    expect(kinds(`{ "name": "IT_DOOR_KEY", "value": "…" } IT_DOOR_KEY=${random}`)).toEqual(['the door’s key'])
    expect(kinds(`{"${['x-it', 'door'].join('-')}":"${random}"}`)).toEqual(['the door’s key'])
    expect(kinds(`GET /s/${random}`)).toEqual(['a showing’s address'])
  })

  test('what only has the beginning of one of It’s shapes is not one', () => {
    const not = [
      // An address with no code, one with a code too short, and one that goes on past twenty characters
      'open http://localhost:4700/pair and type the code',
      `http://localhost:4700/pair#${code.slice(0, 19)}`,
      `http://localhost:4700/pair#${code}abc`,
      'it login --url <address> --code <code>',
      // In fours as a code is shown, and one group short
      `it login --url http://192.168.1.20:4700 --code "${code.match(/.{4}/g).slice(0, 4).join(' ')}"`,
      // A cookie's name alone, a cookie with nothing after the name they all begin with, and the header's name alone
      `the cookie ${cookieName} was set`,
      `cookie: ${['it', 'session'].join('_')}=${random}`,
      `${['x-it', 'door'].join('-')}: [the door’s key]`,
      `the header ${['x-it', 'token'].join('-')} was not sent`,
      `${['x-it', 'token'].join('-')}: too-short`,
      // A path too short to be a showing's, and one too long
      'GET /s/short/v/1/index.html 404',
      `GET /s/${random}0/v/1/index.html`,
      // A name written as the backend's is, with no key after it
      `${['it', '0123456789ab'].join('-')} is its name`,
    ]
    for (const line of not) expect(kinds(line), line).toEqual([])
  })

  test('a comment beside a value, or a word inside it, excuses nothing', () => {
    expect(kinds(`SERVICE_TO${'KEN'}=${plainValue} # test-only`)).toEqual([NAMED])
    expect(kinds(`SERVICE_TO${'KEN'}=test-only-${plainValue}`)).toEqual([NAMED])
    expect(kinds(`${marked} // made up for a test`)).toEqual([MARKED])
  })

  test('a value that a test made up is found as any other is: none is passed over for being known', () => {
    for (const madeUp of [['0123456789', 'abcdef'].join(''), ['a-sign-out', 'token'].join('-'), ['a-token', 'of-a-machine'].join('-')]) {
      expect(kinds(`TO${'KEN'} = "${madeUp}"`), madeUp).toEqual([NAMED])
      expect(kinds(`SERVICE_TO${'KEN'}=${madeUp}`), madeUp).toEqual([NAMED])
    }
    expect(kinds(`authorization: ${'Bearer'} ${['a-token', 'of-a-machine'].join('-')}`)).toEqual(['a bearer credential'])
    expect(kinds(`authorization: ${'Bearer'} ${['a', 'machines', 'token'].join('.')}`)).toEqual(['a bearer credential'])
    expect(kinds(`authorization: ${'Bearer'} ${['secret', 'token'].join('-')}`)).toEqual(['a bearer credential'])
  })

  test('a value in quotes is found whatever marks are in it', () => {
    const marked = ['Str0ng!', 'Word-Here-', '2026'].join('')
    expect(kinds(`{"pass${'word'}":"${marked}"}`)).toEqual([NAMED])
    expect(kinds(`pass${'word'}: '${['p@ss#w0rd', '%with^marks&*'].join('')}'`)).toEqual([NAMED])
    expect(kinds(`const apiTo${'ken'} = \`${marked}\``)).toEqual([NAMED])
  })

  test('a setting written with no quotes is a value, though it reads like a path of names', () => {
    const dotted = ['correct', 'horse', 'battery', 'staple'].join('.')
    // Written as a shell and a file of settings write one, with nothing on either side of the sign
    expect(kinds(`pass${'word'}=${dotted}`)).toEqual([NAMED])
    // And however it is written, in a file that is no program
    expect(credentialsIn(`pass${'word'}: ${dotted}`, 'config/app.yml').map((f) => f.what)).toEqual([NAMED])
    expect(credentialsIn(`pass${'word'} = ${dotted}`, 'etc/settings.ini').map((f) => f.what)).toEqual([NAMED])
    // In a program, a path of names set to a name is code that reads a value
    expect(credentialsIn(`pass${'word'} = ${dotted}`, 'src/settings.ts')).toEqual([])
    expect(credentialsIn(`  pass${'word'}: ${dotted}`, 'src/settings.py')).toEqual([])
  })

  test('code that reads a value, an address and ordinary words are not credentials', () => {
    const dollar = '$'
    const ordinary = [
      'accessToken = body.access_token',
      "const tokenFile = 'packages/cli/dist/token-file.json'",
      `headers: { authorization: \`Bearer ${dollar}{accessToken}\` },`,
      'a bearer credential, as the header’s own standard calls it',
      'Bearer authentication is what the header is for, and bearer authorisation is another word for it',
      "token_endpoint: 'https://example.invalid/where/a/token/is/asked/for'",
      "  token: 'https://example.invalid/a/long/address/to/ask',",
      `SIGNING_SECRET_KEY: ${dollar}{{ secrets.SIGNING_SECRET_KEY }}`,
      'const password = (email) =>',
    ]
    for (const line of ordinary) expect(kinds(line), line).toEqual([])
  })

  test('a credential is said by the line it is on, and each kind of thing on a line once', () => {
    expect(credentialsIn(`nothing here\n\n${marked} and again ${marked}\n`)).toEqual([{ line: 3, what: MARKED }])
  })
})

describe('what the gate reads', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'it-secrets-test-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  let made = 0
  /** A repository of its own, with one harmless file committed. */
  const repository = () => {
    const root = path.join(dir, `repo-${++made}`)
    mkdirSync(root)
    const git = (...args) =>
      execFileSync('git', ['-c', 'user.name=It', '-c', 'user.email=it@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
        cwd: root,
        stdio: 'pipe',
      })
    const write = (name, data) => {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
      writeFileSync(path.join(root, name), data)
    }
    git('init', '-q')
    write('README.md', 'nothing to see\n')
    git('add', '.')
    git('commit', '-q', '-m', 'Begin')
    return { root, git, write }
  }
  const said = (result) => result.lines.join('\n')

  test('a repository that holds nothing passes, and says how much was read', () => {
    const { root } = repository()
    expect(scan({ root })).toEqual({ ok: true, lines: ['1 committed file read, none holds a credential'] })
    expect(scan({ root, history: true })).toEqual({ ok: true, lines: ['1 file from 1 commit read, with every commit’s message, none holds a credential'] })
  })

  test('what is committed is read, whatever the working file says now, and the working file too', () => {
    const { root, git, write } = repository()
    write('settings.txt', `key ${marked}\n`)
    git('add', '.')
    write('settings.txt', 'key removed before anyone looked\n')
    const staged = scan({ root })
    expect(staged.ok).toBe(false)
    expect(said(staged)).toContain(`settings.txt:1  holds ${MARKED}`)
    git('commit', '-q', '-m', 'Add settings')
    write('README.md', `nothing to see\nexcept ${marked}\n`)
    const edited = scan({ root })
    expect(edited.ok).toBe(false)
    expect(said(edited)).toContain(`README.md:2  (as it is in the working folder) holds ${MARKED}`)
    for (const result of [staged, edited]) expect(said(result)).not.toContain(marked)
  })

  test('a credential that was committed once and then removed is found in the history, and only there', () => {
    const { root, git, write } = repository()
    write('notes/old.txt', `first\n${marked}\n`)
    git('add', '.')
    git('commit', '-q', '-m', 'Add notes')
    git('rm', '-q', 'notes/old.txt')
    git('commit', '-q', '-m', 'Remove notes')
    expect(scan({ root }).ok).toBe(true)
    const history = scan({ root, history: true })
    expect(history.ok).toBe(false)
    expect(said(history)).toMatch(/notes\/old\.txt:2 {2}\(as it once was, git object [0-9a-f]{7}\) holds a key marked test or live/)
    expect(said(history)).not.toContain(marked)
  })

  test('a credential in a commit’s message is found in the history', () => {
    const { root, git } = repository()
    git('commit', '-q', '--allow-empty', '-m', `Use ${marked}`)
    expect(scan({ root }).ok).toBe(true)
    const history = scan({ root, history: true })
    expect(history.ok).toBe(false)
    expect(said(history)).toMatch(/the message of commit [0-9a-f]{7}:1 {2}holds a key marked test or live/)
  })

  test('a credential that is a file’s name is found, now and in the history, and is not printed', () => {
    const { root, git, write } = repository()
    const github = ['ghp', `${body}0123`].join('_')
    write(`notes/${github}.txt`, 'nothing to see\n')
    git('add', '.')
    git('commit', '-q', '-m', 'Add notes')
    const now = scan({ root })
    expect(now.ok).toBe(false)
    expect(said(now)).toContain('notes/[a GitHub token].txt  is named with a GitHub token')
    git('rm', '-q', '-r', 'notes')
    git('commit', '-q', '-m', 'Remove notes')
    expect(scan({ root }).ok).toBe(true)
    const once = scan({ root, history: true })
    expect(once.ok).toBe(false)
    expect(said(once)).toContain('notes/[a GitHub token].txt  was once committed, and is named with a GitHub token')
    for (const result of [now, once]) expect(said(result)).not.toContain(github)
  })

  test('a file’s name is cleaned of a credential wherever it is printed', () => {
    const { root, git, write } = repository()
    const github = ['ghp', `${body}0123`].join('_')
    write(`${github}.txt`, `key ${marked}\n`)
    git('add', '.')
    git('commit', '-q', '-m', 'Add a file')
    const result = scan({ root, history: true })
    expect(result.ok).toBe(false)
    expect(said(result)).toContain(`[a GitHub token].txt:1  holds ${MARKED}`)
    expect(said(result)).not.toContain(github)
    const large = scan({ root, limit: 4 })
    expect(large.ok).toBe(false)
    expect(said(large)).toContain('[a GitHub token].txt  could not be read')
    expect(said(large)).not.toContain(github)
  })

  test('a long file is read to its end, and a file that is not plain text is read as well', () => {
    const { root, git, write } = repository()
    write('long.txt', `${'filler\n'.repeat(700_000)}${signed}\n`)
    write('with-nothing-bytes.bin', Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`${marked}\n`)]))
    git('add', '.')
    const result = scan({ root })
    expect(result.ok).toBe(false)
    expect(said(result)).toContain('long.txt:700001  holds a signed token')
    expect(said(result)).toContain(`with-nothing-bytes.bin:1  holds ${MARKED}`)
    // It stages a file of 700,000 lines and reads it back, which a busy machine takes longer over than a test is given
  }, 60_000)

  test('a committed file that holds one of the credentials only It has is found, each by its kind', () => {
    const { root, git, write } = repository()
    const planted = Object.entries(ITS_OWN)
    for (const [n, [, line]] of planted.entries()) write(`kept/captured-${n}.log`, `started\n${line}\n`)
    git('add', '.')
    const result = scan({ root })
    expect(result.ok).toBe(false)
    for (const [n, [what]] of planted.entries()) expect(said(result)).toContain(`kept/captured-${n}.log:2  holds ${what}`)
    expect(result.lines).toHaveLength(planted.length + 1)
    for (const secret of [code, random, adminKey]) expect(said(result)).not.toContain(secret)
  })

  test('a file kept at two bytes to the letter is read as that, whichever byte comes first and whether or not it begins with the mark that says so', () => {
    const { root, git, write } = repository()
    const text = `first line\n${marked}\n${Object.values(ITS_OWN).join('\n')}\n`
    const twoBytes = (string, { mark, bigEnd }) => {
      const bytes = Buffer.from(`${mark ? '\ufeff' : ''}${string}`, 'utf16le')
      return bigEnd ? bytes.swap16() : bytes
    }
    const ways = [
      { mark: true, bigEnd: false },
      { mark: false, bigEnd: false },
      { mark: true, bigEnd: true },
      { mark: false, bigEnd: true },
    ]
    for (const [n, way] of ways.entries()) write(`two-bytes-${n}.txt`, twoBytes(text, way))
    // A letter of two full bytes right before a key: with the empty bytes only taken out, its
    // bytes read as two ordinary letters that the key would seem to be the end of a word after
    write('after-a-letter.txt', twoBytes(`\u4141${marked}\n`, { mark: false, bigEnd: false }))
    // What one program began as plain text and another went on with at two bytes to the letter
    write(
      'begun-plain.log',
      Buffer.concat([Buffer.from(`started\n${marked}\n`), twoBytes(`${ITS_OWN['a showing’s address']}\n`, { mark: false, bigEnd: false })]),
    )
    git('add', '.')
    const result = scan({ root })
    expect(result.ok).toBe(false)
    for (const n of ways.keys()) {
      expect(said(result), ways[n]).toContain(`two-bytes-${n}.txt:2  holds ${MARKED}`)
      for (const [at, what] of Object.keys(ITS_OWN).entries()) expect(said(result), what).toContain(`two-bytes-${n}.txt:${at + 3}  holds ${what}`)
    }
    expect(said(result)).toContain(`after-a-letter.txt:1  holds ${MARKED}`)
    expect(said(result)).toContain(`begun-plain.log:2  holds ${MARKED}`)
    expect(said(result)).toContain('begun-plain.log:3  holds a showing’s address')
    // The text itself, as it was written
    for (const way of ways)
      expect(
        readingsOf(twoBytes(text, way))
          .at(-1)
          .replace(/^\ufeff/, ''),
      ).toBe(text)
    expect(readingsOf(Buffer.from(text))).toEqual([text])
  })

  test('a file too large to read fails the check by name, and is not passed over', () => {
    const { root, git, write } = repository()
    write('large.txt', 'filler\n'.repeat(4000))
    git('add', '.')
    git('commit', '-q', '-m', 'Add a large file')
    for (const history of [false, true]) {
      const result = scan({ root, history, limit: 16_000 })
      expect(result.ok).toBe(false)
      expect(said(result)).toContain('large.txt  could not be read: it is larger than')
      expect(said(result)).toMatch(/1 file could not be read/)
    }
    expect(scan({ root }).ok).toBe(true)
  })

  test('a file of one machine’s settings is never to be committed, now or once, whatever is in it', () => {
    const { root, git, write } = repository()
    // A file of environment variables, and each file It keeps a secret in, in its own folder
    const kept = ['web/.env.local', 'home/service.json', 'home/push.json', 'home/machine.json', 'home/token.json', 'home/connector.json']
    for (const name of kept) write(name, '{}\n')
    // A file that only ends as one of them is another file
    write('home/customer-service.json', '{}\n')
    git('add', '.')
    git('commit', '-q', '-m', 'Add settings')
    const now = scan({ root })
    expect(now.ok).toBe(false)
    for (const name of kept) expect(said(now)).toContain(`${name}  is a file of one machine’s settings, and is committed`)
    expect(now.lines).toHaveLength(kept.length + 1)
    git('rm', '-q', ...kept)
    git('commit', '-q', '-m', 'Remove settings')
    expect(scan({ root }).ok).toBe(true)
    const history = scan({ root, history: true })
    expect(history.ok).toBe(false)
    for (const name of kept) expect(said(history)).toContain(`${name}  is a file of one machine’s settings, and was once committed`)
    expect(history.lines).toHaveLength(kept.length + 1)
  })

  test('a checkout that holds only the newest commits cannot vouch for the history, and says so', () => {
    const { root, git } = repository()
    git('commit', '-q', '--allow-empty', '-m', 'Second')
    const shallow = path.join(dir, 'shallow')
    execFileSync('git', ['clone', '-q', '--depth', '1', pathToFileURL(root).href, shallow], { stdio: 'pipe' })
    expect(scan({ root: shallow }).ok).toBe(true)
    const history = scan({ root: shallow, history: true })
    expect(history.ok).toBe(false)
    expect(said(history)).toMatch(/only the newest commits/)
  })

  test('a folder that is no git checkout fails, in a sentence', () => {
    const nowhere = path.join(dir, 'not-a-repository')
    mkdirSync(nowhere)
    const result = scan({ root: nowhere })
    expect(result.ok).toBe(false)
    expect(said(result)).toMatch(/git/)
  })
})
