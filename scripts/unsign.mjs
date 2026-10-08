// The signature on a standalone program for a Mac: read, and taken off, with no Mac at hand.
//
// A program for a Mac is a Mach-O file, and may carry a code signature, which holds a hash of
// each of the program's pages and which macOS holds the program to as it runs. Bun builds a
// program out of a copy of its own runtime for that system, and writes the bundle into it. The
// runtime for an Intel Mac comes signed by Bun's makers, and Bun 1.3.11 leaves that signature
// on the program although it has changed bytes the signature holds hashes of, so that an Intel
// Mac can be expected to end the program as it starts. Such a Mac does run a program that has
// no signature at all, and the release is built on Linux with no Mac to sign anything. So the
// signature is taken off here, which on a Mac is `codesign --remove-signature`.
//
// The program for a Mac with Apple silicon is the other way about. Such a Mac runs nothing
// unsigned, Bun signs that program itself once the bundle is in it, and its signature is only
// read here, to see that it is the program's own.
import { createHash } from 'node:crypto'

// What a Mach-O and its parts are told by. The file is little-endian, and the signature inside
// it is big-endian.
const MACHO = 0xfeedfacf // a 64-bit file for one kind of machine
const INTEL = 0x01000007
const SEGMENT = 0x19
const SIGNATURE = 0x1d
const EMBEDDED = 0xfade0cc0 // a signature as it lies in a file, which is a list of its parts
const DIRECTORY = 0xfade0c02 // the part that holds the hashes
const SHA256 = 2

// Where the load commands that keep something in the file say they keep it, so that nothing is
// cut off the end of a file that some other command still names. For each kind of command:
// where in it each place in the file is written, and how many bytes each thing kept at that
// place takes. How many of them there are is written straight after the place.
const LISTS = { 8: 1, 16: 1, 24: 1, 32: 1, 40: 1 }
const KEEPS = new Map([
  // The symbols, and then their names
  [0x02, { 8: 16, 16: 1 }],
  // The six tables of the dynamic symbols
  [0x0b, { 32: 8, 40: 56, 48: 4, 56: 4, 64: 8, 72: 8 }],
  // What the dynamic linker is told in its older form, which is five lists
  [0x22, LISTS],
  [0x80000022, LISTS],
  // Every command of the one shape that the signature's own has: the split of the segments,
  // where the functions start, the data among the code, the requirements of the libraries, the
  // linker's hints, the exported names and the chained fixups
  ...[0x1e, 0x26, 0x29, 0x2b, 0x2e, 0x80000033, 0x80000034].map((kind) => [kind, { 8: 1 }]),
])

/** A Mach-O's header and its load commands in order, each with where it is. Throws where the bytes are no such file. */
function read(program) {
  if (program.length < 32 || program.readUInt32LE(0) !== MACHO) throw new Error('the file is not a 64-bit Mach-O for one kind of machine')
  const count = program.readUInt32LE(16)
  const size = program.readUInt32LE(20)
  const end = 32 + size
  if (end > program.length) throw new Error('the load commands run past the end of the file')
  const commands = []
  let at = 32
  for (let i = 0; i < count; i++) {
    const length = at + 8 <= end ? program.readUInt32LE(at + 4) : 0
    if (length < 8 || length % 8 || at + length > end) throw new Error(`load command ${i + 1} of ${count} is not a whole one`)
    commands.push({ at, kind: program.readUInt32LE(at), length })
    at += length
  }
  if (at !== end) throw new Error('the load commands do not take the room the header says they take')
  return { machine: program.readUInt32LE(4), count, size, commands }
}

/** Where the signature that a Mach-O names lies in the file, with the command that names it, or undefined where it names none. */
function named(program, commands) {
  const all = commands.filter((one) => one.kind === SIGNATURE)
  if (all.length > 1) throw new Error('the file names more than one signature')
  const [command] = all
  if (!command) return undefined
  const from = program.readUInt32LE(command.at + 8)
  const length = program.readUInt32LE(command.at + 12)
  // A signature begins with what it is, how long it is and how many parts it has
  if (
    command.length !== 16 ||
    length < 12 ||
    from + length > program.length ||
    program.readUInt32BE(from) !== EMBEDDED ||
    program.readUInt32BE(from + 4) > length
  )
    throw new Error('what the file names as its signature is not one')
  return { command, from, length }
}

/** Each stretch of the file that a load command other than the signature's says it keeps something in: which command, and where the stretch ends. */
function kept(program, commands) {
  const stretches = []
  for (const [i, { at, kind, length }] of commands.entries()) {
    if (kind === SEGMENT) {
      if (length < 72) throw new Error(`load command ${i + 1} of ${commands.length} is shorter than its kind is`)
      const from = Number(program.readBigUInt64LE(at + 40))
      const size = Number(program.readBigUInt64LE(at + 48))
      stretches.push({ i, at, segment: program.toString('latin1', at + 8, at + 24).split('\0')[0], from, size, end: from + size })
    }
    for (const [place, each] of Object.entries(KEEPS.get(kind) ?? {})) {
      const written = at + Number(place)
      if (written + 8 > at + length) throw new Error(`load command ${i + 1} of ${commands.length} is shorter than its kind is`)
      const size = program.readUInt32LE(written + 4) * each
      if (size) stretches.push({ i, end: program.readUInt32LE(written) + size })
    }
  }
  return stretches
}

/** A reading of a program that says so plainly where it ran past the end of the bytes it was given. */
const within = (reading) => (program) => {
  try {
    return reading(program)
  } catch (e) {
    throw e instanceof RangeError ? new Error('the file says that something of its own lies past its end') : e
  }
}

/**
 * The bytes of a program for an Intel Mac without its signature. The load command that names
 * the signature is gone from the header, which counts one command fewer and 16 bytes less of
 * them, with zeros where it was. The signature itself is cut off the end of the file. And the
 * segment it lay at the end of, `__LINKEDIT`, holds that many bytes less of the file. The room
 * that segment is given in memory is left as it is: a segment may be given more room than it
 * holds of the file, and so nothing is laid out differently when the program is loaded. The
 * bytes given are not changed.
 *
 * It throws, saying why, for any file it is not sure of: one that is not a 64-bit Mach-O for
 * one kind of machine, one whose signature is not named by the last load command or does not
 * end where the file and its `__LINKEDIT` segment end, and one in which another load command
 * names bytes that would be cut. It throws for a program for Apple silicon too, and does not
 * hand it back as it is: no Mac of that kind runs a program without a signature, so whoever
 * asks for that has taken one program for another, and is told so.
 */
export const unsign = within((program) => {
  const { machine, count, size, commands } = read(program)
  if (machine !== INTEL) throw new Error('the file is not a program for an Intel Mac, and no other Mac runs a program that has no signature')
  const signed = named(program, commands)
  if (!signed) throw new Error('the file carries no signature')
  const { command, from, length } = signed
  if (command !== commands.at(-1)) throw new Error('the signature is not named by the last of the load commands')
  if (from + length !== program.length) throw new Error('the signature does not end where the file ends')
  const stretches = kept(program, commands)
  const linkedit = stretches.filter((one) => one.segment === '__LINKEDIT')
  if (linkedit.length !== 1 || linkedit[0].from > from || linkedit[0].end !== program.length)
    throw new Error('the signature is not at the end of the one __LINKEDIT segment')
  const reaching = stretches.find((one) => one !== linkedit[0] && one.end > from)
  if (reaching) throw new Error(`load command ${reaching.i + 1} of ${count} names bytes inside the signature`)
  const bare = Buffer.from(program.subarray(0, from))
  bare.writeUInt32LE(count - 1, 16)
  bare.writeUInt32LE(size - command.length, 20)
  bare.fill(0, command.at, command.at + command.length)
  bare.writeBigUInt64LE(BigInt(linkedit[0].size - length), linkedit[0].at + 48)
  // What is handed back is read again first, as any program is
  if (named(bare, read(bare).commands)) throw new Error('the signature is still named once it is cut')
  return bare
})

/**
 * What the signature a Mach-O carries says of the file, or null where it carries none.
 *   name       what the signature calls the program
 *   adhoc      whether it is signed by no one, which is how Bun signs
 *   size       how many bytes of the file the signature takes
 *   pages      how many pages it holds a hash of
 *   wrong      how many of those pages do not have the hash it holds for them
 *   uncovered  how many bytes before the signature it holds no hash of, which is none where
 *              the signature was made for this file
 *   padded     whether the last page, where it is a short one, was hashed with zeros after it
 *
 * The last page of what a signature covers is seldom a whole one. Apple's codesign hashes the
 * bytes there are, and Bun, where it signs a program itself, hashes them with zeros after them
 * to the length of a page. Both are a hash of every byte of the page, and neither is counted
 * as wrong. A program signed in Bun's way is one that a Mac with Apple silicon is seen to run.
 */
export const signature = within((program) => {
  const signed = named(program, read(program).commands)
  if (!signed) return null
  const { from, length } = signed
  const end = from + length
  // The first kind of part is the code directory, and a signature has one
  const parts = program.readUInt32BE(from + 8)
  let at
  for (let i = 0; i < parts && 20 + 8 * i <= length; i++)
    if (at === undefined && program.readUInt32BE(from + 12 + 8 * i) === 0) at = from + program.readUInt32BE(from + 16 + 8 * i)
  if (at === undefined || at + 44 > end || program.readUInt32BE(at) !== DIRECTORY)
    throw new Error('the signature has no code directory, which is where its hashes are')
  if (program[at + 37] !== SHA256 || program[at + 36] !== 32) throw new Error('the signature does not hash the pages with SHA-256')
  const flags = program.readUInt32BE(at + 12)
  const hashes = at + program.readUInt32BE(at + 16)
  const text = at + program.readUInt32BE(at + 20)
  const pages = program.readUInt32BE(at + 28)
  const covers = program.readUInt32BE(at + 32)
  const page = 2 ** program[at + 39]
  if (covers > from) throw new Error('the signature says it covers more of the file than comes before it')
  if (pages !== Math.ceil(covers / page) || hashes + 32 * pages > end) throw new Error('the signature does not hold one hash for each page of what it covers')
  const hash = (...of) => of.reduce((made, one) => made.update(one), createHash('sha256')).digest()
  let wrong = 0
  let padded = false
  for (let i = 0; i < pages; i++) {
    const held = program.subarray(hashes + 32 * i, hashes + 32 * (i + 1))
    const of = program.subarray(i * page, Math.min((i + 1) * page, covers))
    if (hash(of).equals(held)) continue
    if (of.length < page && hash(of, Buffer.alloc(page - of.length)).equals(held)) padded = true
    else wrong++
  }
  const name = program.toString('latin1', text, Math.max(text, program.indexOf(0, text)))
  return { name, adhoc: Boolean(flags & 2), size: length, pages, wrong, uncovered: from - covers, padded }
})
