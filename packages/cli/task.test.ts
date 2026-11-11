import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'
import { alive, type Found, find, judge, type Launcher, watchTask } from './src/serve/task'

const b64 = (text: string) => Buffer.from(text).toString('base64')
/** A line of what Windows is asked for: number, parent's number, when it was started, program, command line. */
const proc = (pid: number, parent: number, started: number, name: string, line: string) => `${pid} ${parent} ${started} ${b64(name)} ${b64(line)}`
const me = proc(300, 200, 3000, 'it.exe', '"C:\\Users\\Ada\\.it\\bin\\it.exe" serve --supervised --log "C:\\Users\\Ada\\.it\\logs\\it.log"')
const shell = proc(200, 100, 2000, 'cmd.exe', 'cmd.exe /d /c .\\it-service.cmd')
const console_ = proc(100, 4, 1000, 'conhost.exe', '"conhost.exe" --headless cmd.exe /d /c .\\it-service.cmd')
const launcher: Launcher = { console: { pid: 100, started: 1000n }, shell: { pid: 200, started: 2000n } }

describe('what the service finds above it on Windows (#405)', () => {
  test('the launcher a scheduled task starts, conhost.exe --headless above cmd.exe running it-service.cmd, is found by number and start', () => {
    expect(judge([me, shell, console_].join('\r\n'), 300)).toEqual({ launcher })
  })

  test('a launcher or a console that has gone, or whose number another process has since been given, has ended', () => {
    expect(judge([me, '-', '-'].join('\n'), 300)).toEqual({ ended: 'the launcher that started it has gone' })
    expect(judge([me, proc(200, 7, 3500, 'notepad.exe', 'notepad'), '-'].join('\n'), 300)).toEqual({ ended: 'the launcher that started it has gone' })
    expect(judge([me, shell, '-'].join('\n'), 300)).toEqual({ ended: 'the scheduled task it runs under has ended' })
    expect(judge([me, shell, proc(100, 4, 2500, 'conhost.exe', 'conhost.exe --headless cmd.exe /d /c .\\it-service.cmd')].join('\n'), 300)).toEqual({
      ended: 'the scheduled task it runs under has ended',
    })
  })

  test('started any other way, as from a prompt a person opened, it has no task to watch', () => {
    expect('none' in judge([me, proc(200, 100, 2000, 'powershell.exe', 'powershell'), console_].join('\n'), 300)).toBe(true)
    expect('none' in judge([me, proc(200, 100, 2000, 'cmd.exe', 'cmd.exe /k'), console_].join('\n'), 300)).toBe(true)
    expect('none' in judge([me, proc(200, 100, 2000, 'cmd.exe', 'cmd.exe /c not-it-service.cmd'), console_].join('\n'), 300)).toBe(true)
    expect('none' in judge([me, shell, proc(100, 4, 1000, 'explorer.exe', 'explorer.exe')].join('\n'), 300)).toBe(true)
    expect('none' in judge([me, shell, proc(100, 4, 1000, 'conhost.exe', 'conhost.exe 0x4')].join('\n'), 300)).toBe(true)
  })

  test('an answer that cannot be read, or that does not know this program, is no answer', () => {
    expect('failed' in judge('', 300)).toBe(true)
    expect('failed' in judge([me, shell].join('\n'), 300)).toBe(true)
    expect('failed' in judge([me, shell, 'WARNING: something'].join('\n'), 300)).toBe(true)
    expect('failed' in judge(['-', '-', '-'].join('\n'), 300)).toBe(true)
    expect('failed' in judge([me, shell, console_].join('\n'), 301)).toBe(true)
  })
})

describe('watching the scheduled task (#405)', () => {
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  /** Watches with answers given in turn, the last of them for good, and processes that run while `running` has them. */
  const watching = (answers: Found[], running = new Set([100, 200])) => {
    const ended: string[] = []
    const said: string[] = []
    let asked = 0
    const stop = watchTask(
      (why) => ended.push(why),
      (line) => said.push(line),
      {
        find: async () => answers[Math.min(asked++, answers.length - 1)]!,
        alive: (pid) => running.has(pid),
        look: 5,
        again: 40,
        retry: 20,
      },
    )
    return { ended, said, running, stop, asked: () => asked }
  }

  test('once the task’s console has gone, it is told once that the task has ended', async () => {
    const w = watching([{ launcher }])
    await settle(30)
    expect(w.ended).toEqual([])
    expect(w.said).toEqual(['it runs under its scheduled task, and stops by itself once that has ended'])
    w.running.delete(100)
    await settle(30)
    expect(w.ended).toEqual(['the scheduled task it runs under has ended'])
    await settle(100)
    expect(w.ended).toHaveLength(1)
  })

  test('once its launcher has gone, it is told so', async () => {
    const w = watching([{ launcher }])
    await settle(20)
    w.running.delete(200)
    await settle(30)
    expect(w.ended).toEqual(['the launcher that started it has gone'])
  })

  test('a task that had ended before the service looked is said at once', async () => {
    const w = watching([{ ended: 'the scheduled task it runs under has ended' }])
    await settle(10)
    expect(w.ended).toEqual(['the scheduled task it runs under has ended'])
  })

  test('started by something else, it watches nothing and asks no more', async () => {
    const w = watching([{ none: 'it was not started by the launcher of a scheduled task' }], new Set())
    await settle(100)
    expect([w.ended, w.said, w.asked()]).toEqual([[], [], 1])
  })

  test('where Windows could not be asked, that is said once and it is asked again', async () => {
    const w = watching([{ failed: 'PowerShell ended with exit code 1, and printed nothing' }, { failed: 'again' }, { launcher }])
    await settle(80)
    expect(w.said).toEqual([
      'could not tell whether its scheduled task is running (PowerShell ended with exit code 1, and printed nothing); it asks again in 0 seconds',
      'it runs under its scheduled task, and stops by itself once that has ended',
    ])
    expect(w.ended).toEqual([])
    w.stop()
  })

  test('a console whose number another process has been given is found out when Windows is asked again', async () => {
    const w = watching([{ launcher }, { launcher: { ...launcher, console: { pid: 100, started: 5000n } } }])
    await settle(100)
    expect(w.ended).toEqual(['the scheduled task it runs under has ended'])
  })

  test('stopped, it says nothing more', async () => {
    const w = watching([{ launcher }])
    await settle(20)
    w.stop()
    w.running.clear()
    await settle(50)
    expect(w.ended).toEqual([])
  })
})

describe.skipIf(process.platform !== 'win32')('the scheduled task’s launcher on Windows itself (#405)', () => {
  test('a program a person started is under no launcher', async () => {
    const found = await find()
    expect(
      found,
      JSON.stringify(found, (_, v) => (typeof v === 'bigint' ? String(v) : v)),
    ).toHaveProperty('none')
  })

  test('ended as Task Scheduler ends a task, by its console alone, the program under the launcher stops by itself and ends well, and so does the launcher', async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'it-task-watch-'))
    const bin = path.join(folder, 'bin')
    mkdirSync(bin)
    const file = (name: string) => path.join(folder, name)
    const read = (name: string) => (existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '')
    writeFileSync(
      file('watched.mjs'),
      `import { appendFileSync, writeFileSync } from 'node:fs'
import { watchTask } from ${JSON.stringify(pathToFileURL(path.join(__dirname, 'src', 'serve', 'task.ts')).href)}
writeFileSync(${JSON.stringify(file('started'))}, JSON.stringify({ pid: process.pid, shell: process.ppid }))
const keep = setInterval(() => {}, 1000)
watchTask((why) => {
  writeFileSync(${JSON.stringify(file('ended'))}, why)
  clearInterval(keep)
  process.exitCode = 0
}, (line) => appendFileSync(${JSON.stringify(file('said'))}, line + '\\n'), { look: 200 })
`,
    )
    // The launcher as It writes it, in its shape: the program, and again after a failure
    writeFileSync(
      path.join(bin, 'it-service.cmd'),
      `@echo off\r\n:again\r\n"${process.execPath}" "${file('watched.mjs')}"\r\nif %errorlevel% equ 0 exit /b 0\r\nping -n 2 127.0.0.1 >nul 2>&1\r\ngoto again\r\n`,
    )
    const task = spawn('conhost.exe', ['--headless', 'cmd.exe', '/d', '/c', '.\\it-service.cmd'], { cwd: bin, windowsHide: true, stdio: 'ignore' })
    const until = async (what: () => boolean, ms: number) => {
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (what()) return true
      return false
    }
    try {
      expect(await until(() => read('said').includes('runs under its scheduled task'), 60_000), read('said')).toBe(true)
      const { pid, shell } = JSON.parse(read('started')) as { pid: number; shell: number }
      expect([alive(pid), alive(shell)]).toEqual([true, true])
      task.kill('SIGKILL')
      expect(await until(() => read('ended') !== '', 15_000), read('said')).toBe(true)
      expect(read('ended')).toBe('the scheduled task it runs under has ended')
      expect(await until(() => !alive(pid) && !alive(shell), 15_000)).toBe(true)
    } finally {
      task.kill('SIGKILL')
      for (const name of ['started']) {
        try {
          const { pid, shell } = JSON.parse(read(name)) as { pid: number; shell: number }
          for (const left of [pid, shell]) if (alive(left)) process.kill(left)
        } catch {}
      }
      rmSync(folder, { recursive: true, force: true })
    }
  }, 120_000)
})
