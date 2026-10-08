// The signatures on the standalone programs for a Mac (scripts/unsign.mjs). Bun leaves on the
// program for an Intel Mac a signature that is not the program's, and a release takes it off.
// The program for a Mac with Apple silicon carries one that Bun made for it, and a release
// only reads that one.
//
// No Mach-O here is made up by hand. A program of one line is built for each kind of Mac, by
// the Bun the programs are built with, out of the runtime for that Mac which Bun keeps once it
// has fetched it: the build a release makes, of a smaller program. A test fetches nothing, so
// where that Bun or either runtime is not on the machine these are skipped, and that is said
// in a line.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { signature, unsign } from '../scripts/unsign.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pinned = /^\s*BUN_VERSION:\s*(\S+)\s*$/m.exec(readFileSync(path.join(root, '.github', 'workflows', 'it.yml'), 'utf8'))[1]
/** The Bun the programs are built with, where this machine has it: the one a shell finds, or the one in the folder Bun installs itself into. */
const bun = ['bun', path.join(os.homedir(), '.bun', 'bin', 'bun')].find((one) => {
  try {
    return execFileSync(one, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === pinned
  } catch {
    return false
  }
})
/** The folders Bun keeps what it has fetched in, in the order Bun itself looks for one. */
const caches = [
  process.env.BUN_INSTALL_CACHE_DIR,
  process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'install', 'cache'),
  process.env.XDG_CACHE_HOME && path.join(process.env.XDG_CACHE_HOME, '.bun', 'install', 'cache'),
  path.join(os.homedir(), '.bun', 'install', 'cache'),
].filter(Boolean)
/** Bun's own runtime for a kind of Mac, by the name Bun keeps it under, or undefined where Bun has not fetched it. */
const runtime = (kind) => caches.map((folder) => path.join(folder, `bun-darwin-${kind}-v${pinned}`)).find((file) => existsSync(file))
const RUNTIMES = { x64: runtime('x64'), arm64: runtime('aarch64') }
const why = !bun
  ? `Bun ${pinned}, which the programs are built with, is not on this machine`
  : !RUNTIMES.x64 || !RUNTIMES.arm64
    ? `Bun ${pinned} has not fetched its runtime for ${!RUNTIMES.x64 && !RUNTIMES.arm64 ? 'either kind of Mac' : !RUNTIMES.x64 ? 'an Intel Mac' : 'a Mac with Apple silicon'}, which it does the first time a program is built for one, and a test fetches nothing`
    : undefined
if (why) console.log(`  skip  the tests of the signatures on the programs for a Mac: ${why}`)

/** A Mach-O's load commands as its header gives them, read here apart from the code that is tested: where each is, its kind and its length. */
const commandsOf = (program) => {
  const commands = []
  let at = 32
  for (let i = 0; i < program.readUInt32LE(16); i++) {
    commands.push({ at, kind: program.readUInt32LE(at), length: program.readUInt32LE(at + 4) })
    at += program.readUInt32LE(at + 4)
  }
  return commands
}
const SEGMENT = 0x19
const SYMBOLS = 0x02
const SIGNATURE = 0x1d
/** Where the load command of the segment that the signature lies in is. */
const linkeditOf = (program) =>
  commandsOf(program).find((one) => one.kind === SEGMENT && program.toString('latin1', one.at + 8, one.at + 18) === '__LINKEDIT').at

describe.skipIf(Boolean(why))('the signatures on the programs Bun builds for a Mac', () => {
  let folder
  let intel
  let silicon
  /** A program of one line for a kind of Mac, built as a release builds It for one, and out of the runtime already on this machine, so that Bun fetches nothing. */
  const build = (target) => {
    const to = path.join(folder, `one-${target}`)
    execFileSync(
      bun,
      [
        'build',
        path.join(folder, 'one.js'),
        '--compile',
        '--minify',
        `--target=bun-darwin-${target}`,
        `--compile-executable-path=${RUNTIMES[target]}`,
        '--outfile',
        to,
      ],
      { cwd: folder, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    return readFileSync(to)
  }
  beforeAll(() => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'it-unsign-'))
    writeFileSync(path.join(folder, 'one.js'), "console.log('it')\n")
    intel = build('x64')
    silicon = build('arm64')
  }, 120_000)
  afterAll(() => {
    if (folder) rmSync(folder, { recursive: true, force: true })
  })

  test('the one for an Intel Mac carries the signature of Bun’s own runtime, whose hashes are no longer the program’s', () => {
    const said = signature(intel)
    // Signed by Bun's makers under Bun's name, and not by no one, which is how Bun itself signs
    expect(said).toMatchObject({ name: 'bun', adhoc: false })
    expect(said.pages).toBeGreaterThan(10_000)
    expect(said.wrong).toBeGreaterThan(0)
    // It is the runtime's signature byte for byte, and of the runtime every one of its hashes is right: they went wrong when Bun wrote the bundle in
    const upstream = readFileSync(RUNTIMES.x64)
    expect(signature(upstream)).toMatchObject({ name: 'bun', adhoc: false, size: said.size, pages: said.pages, wrong: 0, uncovered: 0 })
    expect(intel.subarray(intel.length - said.size).equals(upstream.subarray(upstream.length - said.size))).toBe(true)
  })

  test('without that signature it is the same program in every other byte, and the bytes it was made from are left as they were', () => {
    const { size } = signature(intel)
    const bare = unsign(intel)
    expect(intel.equals(readFileSync(path.join(folder, 'one-x64')))).toBe(true)
    expect(signature(bare)).toBe(null)
    // The signature was the end of the file, and that much is gone from the end
    expect(bare.length).toBe(intel.length - size)
    // The header counts one load command fewer, the last, and 16 bytes less of them, and there are zeros where that one was
    const before = commandsOf(intel)
    const last = before.at(-1)
    expect(last).toMatchObject({ kind: SIGNATURE, length: 16 })
    expect([bare.readUInt32LE(16), bare.readUInt32LE(20)]).toEqual([intel.readUInt32LE(16) - 1, intel.readUInt32LE(20) - 16])
    expect(commandsOf(bare)).toEqual(before.slice(0, -1))
    expect(bare.subarray(last.at, last.at + 16).equals(Buffer.alloc(16))).toBe(true)
    // The segment the signature lay at the end of holds that much less of the file, and ends where the file now ends
    const linkedit = linkeditOf(intel)
    expect(bare.readBigUInt64LE(linkedit + 48)).toBe(intel.readBigUInt64LE(linkedit + 48) - BigInt(size))
    expect(Number(bare.readBigUInt64LE(linkedit + 40) + bare.readBigUInt64LE(linkedit + 48))).toBe(bare.length)
    // And nothing else is changed: not the rest of the header, not any other load command, not the room the segment has in memory, not a byte of the program
    let from = 0
    for (const [start, end] of [
      [16, 24],
      [linkedit + 48, linkedit + 56],
      [last.at, last.at + 16],
      [bare.length, bare.length],
    ]) {
      expect(start).toBeGreaterThanOrEqual(from)
      expect(bare.subarray(from, start).equals(intel.subarray(from, start)), `bytes ${from} to ${start}`).toBe(true)
      from = end
    }
  })

  // An unsigned program for Apple silicon is one that no Mac of that kind runs, so it is refused and not handed back as it is: whoever asked for it took one program for another
  test('a signature is taken off no file that is not sure to come out a whole program for an Intel Mac, and each is refused with its reason', () => {
    expect(() => unsign(silicon)).toThrow('the file is not a program for an Intel Mac, and no other Mac runs a program that has no signature')
    expect(() => unsign(unsign(intel))).toThrow('the file carries no signature')
    expect(() => unsign(Buffer.concat([intel, Buffer.alloc(1)]))).toThrow('the signature does not end where the file ends')
    const commands = commandsOf(intel)
    // The command that names the signature, put before the one it follows, which is as long as it is
    const [other, named] = commands.slice(-2)
    expect([other.length, named.length]).toEqual([16, 16])
    const moved = Buffer.from(intel)
    intel.copy(moved, other.at, named.at, named.at + 16)
    intel.copy(moved, named.at, other.at, other.at + 16)
    expect(() => unsign(moved)).toThrow('the signature is not named by the last of the load commands')
    // The names of the symbols, said to run on into the signature
    const symbols = commands.findIndex((one) => one.kind === SYMBOLS)
    const reaching = Buffer.from(intel)
    reaching.writeUInt32LE(intel.readUInt32LE(commands[symbols].at + 20) + 8, commands[symbols].at + 20)
    expect(() => unsign(reaching)).toThrow(`load command ${symbols + 1} of ${commands.length} names bytes inside the signature`)
    // A file cut short, and one that is no Mach-O
    expect(() => unsign(intel.subarray(0, 1024))).toThrow('the load commands run past the end of the file')
    expect(() => unsign(readFileSync(path.join(folder, 'one.js')))).toThrow('the file is not a 64-bit Mach-O for one kind of machine')
    expect(() => signature(readFileSync(path.join(folder, 'one.js')))).toThrow('the file is not a 64-bit Mach-O for one kind of machine')
  })

  test('the one for Apple silicon carries a signature Bun made for it, which holds a hash of every page before it, each the page’s own', () => {
    const said = signature(silicon)
    expect(said).toMatchObject({ name: 'a.out', adhoc: true, wrong: 0, uncovered: 0 })
    const covered = silicon.length - said.size
    expect(said.pages).toBe(Math.ceil(covered / 4096))
    // The last page is a short one, which Bun hashes with zeros after it where Apple's codesign hashes it as it is
    expect(covered % 4096).toBeGreaterThan(0)
    expect(said.padded).toBe(true)
    // Apple's own way is read as well: the runtime this program was built from was signed with codesign
    expect(signature(readFileSync(RUNTIMES.arm64))).toMatchObject({ name: 'bun', adhoc: false, wrong: 0, uncovered: 0, padded: false })
  })

  // On a sound program nothing is found, so nothing else would show if the reading stopped being able to find anything
  test('a byte changed after it was signed is found, in the first page, in one further on and in the short last one', () => {
    const { size } = signature(silicon)
    const changed = Buffer.from(silicon)
    // The first is among the zeros between the load commands and the code, so that the file still reads as a Mach-O
    for (const [n, at] of [3000, 100 * 4096 + 7, silicon.length - size - 1].entries()) {
      changed[at] ^= 1
      expect(signature(changed).wrong, `after ${n + 1} changed`).toBe(n + 1)
    }
  })
})
