// How a reopened run on Windows went, as It is told it, under whichever runtime runs these tests.
// The keeper that holds a run in its job says whether its app was not there, would not be
// started, or could not be kept in a job, and otherwise what the app itself exited with. Bun,
// which the installed program runs on, hands on only the lowest byte of a child's exit code
// (0x49540002 arrives as 2, and 256 as 0), so none of that may be told by the keeper's code.
//
// Under vitest these run on Node, and once more with every exit code cut to its lowest byte as
// Bun cuts it. `bun test ./packages/cli/wake-windows.test.ts` runs them under Bun itself, as the
// standalone program does, and CI runs that on Windows.
import childProcess from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { carryOn, powershellExe } from './src/wake'

const underBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

/** Has every child's exit code reach whoever started it as its lowest byte alone, as Bun 1.3 on Windows has it. */
function asBunHandsItOn(): () => void {
  const spawn = childProcess.spawn
  childProcess.spawn = new Proxy(spawn, {
    apply(target, self, args) {
      const child = Reflect.apply(target, self, args) as ReturnType<typeof spawn>
      const emit = child.emit.bind(child)
      child.emit = ((event: string, ...rest: unknown[]) =>
        event === 'exit' && typeof rest[0] === 'number' ? emit(event, rest[0] & 0xff, ...rest.slice(1)) : emit(event, ...rest)) as typeof child.emit
      return child
    },
  })
  syncBuiltinESMExports()
  return () => {
    childProcess.spawn = spawn
    syncBuiltinESMExports()
  }
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'it-wake-windows-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A stand-in for an agent app that ends with this code. Windows PowerShell hands a code on whole, which some runtimes do not do for their own. */
const exiting = (code: number) => ({
  argv: [powershellExe(), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `exit ${code}`],
  input: 'x',
  app: 'Stand-in',
})

const runtimes: [string, (() => () => void) | null][] = underBun
  ? [['under Bun', null]]
  : [
      ['under Node', null],
      ['with exit codes cut to their lowest byte, as Bun cuts them', asBunHandsItOn],
    ]

describe.skipIf(process.platform !== 'win32')('a reopened run on Windows says how it went, whatever the runtime hands on of an exit code', () => {
  for (const [runtime, cut] of runtimes) {
    /** Runs the app as a reopened run is run, with its output and the keeper's word kept in a folder that is looked at after. */
    const run = async (how: ReturnType<typeof exiting>, env: NodeJS.ProcessEnv = process.env) => {
      const keepIn = path.join(scratch, randomUUID())
      mkdirSync(keepIn)
      const restore = cut?.()
      try {
        let brokeOff = 0
        const ended = await carryOn(how, scratch, { harness: 'pi', session: 's-1', run: randomUUID() }, { env, keepIn, brokeOff: () => brokeOff++ })
        // Nothing the run kept is left behind it
        expect(readdirSync(keepIn)).toEqual([])
        return { ended, brokeOff }
      } finally {
        restore?.()
      }
    }

    test(`${runtime}: a program that is not there is said to be not found, and is not taken for an app that broke off`, async () => {
      const missing = path.join(scratch, 'nowhere.exe')
      expect(existsSync(missing)).toBe(false)
      expect(await run({ argv: [missing, '--print'], input: 'x', app: 'Stand-in' })).toEqual({ ended: 'Stand-in was not found', brokeOff: 0 })
    }, 120_000)

    test(`${runtime}: a program Windows will not start says so`, async () => {
      const notAProgram = path.join(scratch, 'not-a-program.exe')
      writeFileSync(notAProgram, 'this is text, and no program Windows can run\n')
      expect(await run({ argv: [notAProgram, '--print'], input: 'x', app: 'Stand-in' })).toEqual({
        ended: 'Stand-in could not be started: Windows would not start its program',
        brokeOff: 0,
      })
    }, 120_000)

    test(`${runtime}: where the keeper cannot be made, the run says it could not be kept in a job`, async () => {
      // Windows PowerShell compiles the keeper in the folder TEMP names, and cannot where that is a file
      const nowhere = path.join(scratch, 'a-file-and-no-folder')
      writeFileSync(nowhere, '')
      const env = { ...process.env, TEMP: nowhere, TMP: nowhere }
      expect(await run(exiting(0), env)).toEqual({
        ended: 'Stand-in could not be started: Windows would not keep it in a job of its own, which It needs to be able to end it',
        brokeOff: 0,
      })
    }, 120_000)

    test(`${runtime}: an app's own code is told whole, and only 0 is a run that ended well`, async () => {
      expect(await run(exiting(0))).toEqual({ ended: null, brokeOff: 0 })
      for (const code of [1, 2, 3, 255, 256, 1060])
        expect(await run(exiting(code)), String(code)).toEqual({ ended: `Stand-in exited with ${code}`, brokeOff: 1 })
    }, 300_000)

    test(`${runtime}: a word that an earlier program left, and that cannot be taken away or written over, is not read as this run's`, async () => {
      const keepIn = path.join(scratch, randomUUID())
      mkdirSync(keepIn)
      // Each name a run of this program has given its word under so far, and many more: an earlier
      // program with this one's number left a run that ended well under each, and something holds
      // each open now and lets nobody write to it or take it away
      const left = Array.from({ length: 100 }, (_, k) => path.join(keepIn, `reopened-${process.pid}-${k + 1}.kept`))
      for (const file of left) writeFileSync(file, 'ran 0')
      const ready = path.join(scratch, `${randomUUID()}.ready`)
      const holder = childProcess.spawn(
        powershellExe(),
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$held = @(Get-ChildItem -LiteralPath '${keepIn}' -Filter *.kept | ForEach-Object { [IO.File]::Open($_.FullName, 'Open', 'Read', 'Read') }); Set-Content -LiteralPath '${ready}' -Value $held.Count; Start-Sleep -Seconds 300`,
        ],
        { stdio: 'ignore', windowsHide: true },
      )
      const restore = cut?.()
      try {
        for (const by = Date.now() + 60_000; !existsSync(ready); await new Promise((r) => setTimeout(r, 100)))
          if (Date.now() > by) throw new Error('the files were not held in time')
        let brokeOff = 0
        const ended = await carryOn(exiting(256), scratch, { harness: 'pi', session: 's-1', run: randomUUID() }, { keepIn, brokeOff: () => brokeOff++ })
        expect({ ended, brokeOff }).toEqual({ ended: 'Stand-in exited with 256', brokeOff: 1 })
      } finally {
        restore?.()
        const gone = new Promise((r) => holder.once('exit', r))
        holder.kill()
        await gone
      }
    }, 180_000)
  }
})
