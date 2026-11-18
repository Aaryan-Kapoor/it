// The background service on a Mac, as launchd has it: registered where launchd holds the agent
// or will read its definition at the next login, and not where it refused the definition or
// the label is switched off. Nothing here asks a real launchd anything. What stands in for
// `launchctl` and `plutil` answers in the words and with the codes that macOS 15.7 and macOS
// 26.7 were seen to give on GitHub's runners, and is put first on the PATH, so that on a Mac
// too the real ones are never reached.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  command,
  definedFor,
  environment,
  install,
  installedHere,
  kept,
  LaunchdRefused,
  launchdDisabled,
  launchdHas,
  launchdPlist,
  status as serviceStatus,
  startsByItself,
  uninstall,
} from './src/service'

/** What `launchctl print-disabled gui/501` printed on macOS 15.7, 15.8 and 26.7, with It's label as it stood after `launchctl disable`. */
const DISABLED_LIST = (it: string) =>
  `\n\tdisabled services = {\n\t\t"com.apple.Siri.agent" => disabled\n\t\t"com.apple.FolderActionsDispatcher" => disabled\n\t\t"com.apple.ScriptMenuApp" => disabled\n${it}\t}\n`

describe('which labels launchd has switched off, read from what `launchctl print-disabled` prints', () => {
  test('a label is switched off where its line says disabled, and not where it says enabled or there is no line for it', () => {
    expect(launchdDisabled(DISABLED_LIST('\t\t"dev.it" => disabled\n'))).toBe(true)
    // `launchctl enable` leaves a line that says so, and takes none away
    expect(launchdDisabled(DISABLED_LIST('\t\t"dev.it" => enabled\n'))).toBe(false)
    expect(launchdDisabled(DISABLED_LIST(''))).toBe(false)
    // Another label's line says nothing of this one, though its name begins or ends as this one's does
    expect(launchdDisabled(DISABLED_LIST('\t\t"dev.it.probe" => disabled\n\t\t"com.dev.it" => disabled\n'))).toBe(false)
    expect(launchdDisabled(DISABLED_LIST('\t\t"dev.it.probe" => disabled\n'), 'dev.it.probe')).toBe(true)
  })

  test('the words earlier releases used are read too', () => {
    expect(launchdDisabled('disabled services = {\n\t"dev.it" => true\n\t"com.apple.ftpd" => false\n}\n')).toBe(true)
    expect(launchdDisabled('disabled services = {\n\t"dev.it" => false\n}\n')).toBe(false)
    expect(launchdDisabled('disabled services = {\n\t"dev.it" => true;\n};\n'.replace('};', '}'))).toBe(true)
  })

  test('a list that follows the first is not read as part of it', () => {
    const more = `${DISABLED_LIST('')}\tlogin item associations = {\n\t\t"dev.it" => disabled\n\t}\n`
    expect(launchdDisabled(more)).toBe(false)
  })

  test('a label with two lines is believed where they agree, as the system’s own list has some', () => {
    expect(launchdDisabled(DISABLED_LIST('\t\t"dev.it" => disabled\n\t\t"dev.it" => disabled\n'))).toBe(true)
    expect(launchdDisabled(DISABLED_LIST('\t\t"dev.it" => disabled\n\t\t"dev.it" => enabled\n'))).toBeUndefined()
  })

  test('what is not known is not read as anything: no list, a list that does not end, a word that is neither', () => {
    for (const printed of [
      '',
      'Could not print cache: 125: Domain does not support specified action',
      '\tdisabled services = {\n\t\t"dev.it" => disabled\n',
      '{"dev.it": "disabled"}',
      DISABLED_LIST('\t\t"dev.it" => sometimes\n'),
    ])
      expect([printed, launchdDisabled(printed)]).toEqual([printed, undefined])
  })
})

/** A Mac of this test's own: a person's folder, It's folder in it, and what stands in for launchd. */
interface Mac {
  user: string
  definition: string
  /** Sets how launchd stands: each is a word the stand-in looks for. */
  set(word: Standing, on?: boolean): void
  has(word: Standing): boolean
  /** Every subcommand `launchctl` was given, in order. */
  asked(): string[]
  target: string
}
type Standing =
  /** launchd holds the agent. */
  | 'loaded'
  /** The label is switched off, as `launchctl disable` or Login Items leaves it. */
  | 'disabled'
  /** The person has no login at the Mac's own screen, as over SSH: there is no domain to load into. */
  | 'no-login'
  /** launchd refuses every definition, and nothing says why. */
  | 'refuses'
  /** launchd refuses the definition this version writes, and takes one that names `/an/earlier/path`. */
  | 'refuses-the-new-one'
  /** The definition is not a property list, as launchd and `plutil` both find. */
  | 'invalid'
  /** `plutil` answers as macOS 15 does, with no brackets round what is wrong. */
  | 'plutil-of-15'
  /** The definition cannot be read by the person once launchd has been given it. */
  | 'unreadable'
  /** `launchctl` ends with a code that says nothing, whatever it is asked. */
  | 'answers-nothing'

const REFUSED = 'Bootstrap failed: 5: Input/output error\nTry re-running the command as root for richer errors.'

function onAMac(run: (mac: Mac) => void): void {
  const user = mkdtempSync(path.join(os.tmpdir(), 'it-launchd-'))
  const before = { home: process.env.IT_HOME, PATH: process.env.PATH, platform: Object.getOwnPropertyDescriptor(process, 'platform')! }
  const homedir = vi.spyOn(os, 'homedir').mockReturnValue(user)
  const [commands, standing, asked] = [path.join(user, 'commands'), path.join(user, 'launchd'), path.join(user, 'launchctl-was-asked')]
  const definition = path.join(user, 'Library', 'LaunchAgents', 'dev.it.plist')
  const uid = process.getuid?.() ?? 501
  try {
    mkdirSync(commands)
    mkdirSync(standing)
    const is = (word: Standing) => `[ -f '${path.join(standing, word)}' ]`
    writeFileSync(
      path.join(commands, 'launchctl'),
      `#!/bin/sh
echo "$1" >> '${asked}'
if ${is('answers-nothing')}; then exit 1; fi
if ${is('no-login')}; then
  case "$1" in
    print|print-disabled) echo 'Bad request.'; echo 'Could not find domain for user gui: ${uid}'; exit 112 ;;
    enable|disable) echo "Could not $1 service: 125: Domain does not support specified action"; exit 125 ;;
    *) echo 'Could not find domain for user gui: ${uid}'; exit 112 ;;
  esac
fi
case "$1" in
  print)
    if ${is('loaded')}; then
      printf 'gui/${uid}/dev.it = {\\n\\tactive count = 1\\n\\tpath = %s\\n\\ttype = LaunchAgent\\n\\tstate = running\\n}\\n' '${definition}'
    else
      echo 'Bad request.'; echo 'Could not find service "dev.it" in domain for user gui: ${uid}'; exit 113
    fi ;;
  print-disabled)
    printf '\\n\\tdisabled services = {\\n\\t\\t"com.apple.Siri.agent" => disabled\\n'
    if ${is('disabled')}; then printf '\\t\\t"dev.it" => disabled\\n'; fi
    printf '\\t}\\n' ;;
  bootout)
    if ${is('loaded')}; then rm -f '${path.join(standing, 'loaded')}'; else echo 'Boot-out failed: 3: No such process'; exit 3; fi ;;
  bootstrap)
    refuse=
    if ${is('loaded')} || ${is('disabled')} || ${is('refuses')} || ${is('invalid')}; then refuse=1; fi
    if ${is('refuses-the-new-one')} && ! grep -q '/an/earlier/path' "$3"; then refuse=1; fi
    if ${is('unreadable')}; then chmod 000 "$3"; refuse=1; fi
    if [ -n "$refuse" ]; then echo 'Bootstrap failed: 5: Input/output error'; echo 'Try re-running the command as root for richer errors.'; exit 5; fi
    : > '${path.join(standing, 'loaded')}' ;;
  enable) rm -f '${path.join(standing, 'disabled')}' ;;
  disable) : > '${path.join(standing, 'disabled')}' ;;
esac
`,
      { mode: 0o755 },
    )
    writeFileSync(
      path.join(commands, 'plutil'),
      `#!/bin/sh
if ! ${is('invalid')}; then echo "$2: OK"; exit 0; fi
if ${is('plutil-of-15')}; then echo "$2: Unexpected character t at line 1"; else echo "$2: (Unexpected character t at line 1)"; fi
exit 1
`,
      { mode: 0o755 },
    )
    process.env.IT_HOME = path.join(user, '.it')
    process.env.PATH = `${commands}:/usr/bin:/bin`
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    run({
      user,
      definition,
      set: (word, on = true) => (on ? writeFileSync(path.join(standing, word), '') : rmSync(path.join(standing, word), { force: true })),
      has: (word) => existsSync(path.join(standing, word)),
      asked: () => (existsSync(asked) ? readFileSync(asked, 'utf8').trim().split('\n') : []),
      target: `gui/${uid}/dev.it`,
    })
  } finally {
    try {
      chmodSync(definition, 0o644)
    } catch {}
    homedir.mockRestore()
    Object.defineProperty(process, 'platform', before.platform)
    process.env.PATH = before.PATH
    if (before.home === undefined) delete process.env.IT_HOME
    else process.env.IT_HOME = before.home
    rmSync(user, { recursive: true, force: true })
  }
}

/** What `install` threw, or nothing where it registered the service. */
const refusal = (): Error | undefined => {
  try {
    install()
  } catch (err) {
    return err as Error
  }
  return undefined
}
/** How the three that say whether the service is registered stand, with whose the definition is. */
const stands = () => ({ installed: installedHere(), registered: serviceStatus().registered, state: serviceStatus().state, defined: definedFor() })

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('the background service on a Mac, as launchd has it', () => {
  test('a definition that launchd loads is a registration: launchd holds the agent', () =>
    onAMac((mac) => {
      expect(stands()).toEqual({ installed: false, registered: false, state: 'not loaded', defined: 'none' })
      const before = mac.asked().length
      expect(install()).toMatchObject({ registered: true, state: 'running', where: mac.definition })
      expect(mac.asked().slice(before, before + 3)).toEqual(['bootout', 'print', 'bootstrap'])
      expect(stands()).toEqual({ installed: true, registered: true, state: 'running', defined: 'this folder' })
      expect(launchdHas()).toEqual({ has: 'loaded', state: 'running' })
      // Taken away, there is neither agent nor definition
      uninstall()
      expect([existsSync(mac.definition), stands()]).toEqual([false, { installed: false, registered: false, state: 'not loaded', defined: 'none' }])
    }))

  test('with the label switched off and no definition from before, the load is refused: said with what turns it on, the definition kept, and nothing registered', () =>
    onAMac((mac) => {
      mac.set('disabled')
      const err = refusal()
      expect(err).toBeInstanceOf(LaunchdRefused)
      expect((err as LaunchdRefused).why).toBe('disabled')
      expect(err!.message).toBe(
        `macOS has It’s background service switched off for your account, so launchd would not load it. Turn it on again in System Settings, under General and then Login Items, or with \`launchctl enable ${mac.target}\`, and run \`it setup\` again. If another tool manages what starts on this Mac, It has to be allowed there.`,
      )
      // What `launchctl` printed for it says none of that, and is not what is passed on
      expect(err!.message).not.toContain('Input/output error')
      // The definition is what the person turns on again, so it stays, and is this folder's to take away
      expect(readFileSync(mac.definition, 'utf8')).toBe(launchdPlist(command(), environment()))
      expect(stands()).toEqual({ installed: false, registered: false, state: 'disabled', defined: 'this folder' })
      expect(launchdHas()).toEqual({ has: 'disabled' })
      // What the definition gives the service is still read from it, for the setup that registers it again
      expect(kept()).toMatchObject({ IT_HOME: path.join(mac.user, '.it') })
      // Turned on again, the same setup registers it
      mac.set('disabled', false)
      expect(install()).toMatchObject({ registered: true, state: 'running' })
      expect(stands()).toEqual({ installed: true, registered: true, state: 'running', defined: 'this folder' })
    }))

  test.each([
    ['26', 'Unexpected character t at line 1'],
    ['15', 'Unexpected character t at line 1'],
  ])('with a definition that is not a property list, the load is refused and that is said, as macOS %s words it', (release, wrong) =>
    onAMac((mac) => {
      mac.set('invalid')
      if (release === '15') mac.set('plutil-of-15')
      const err = refusal()
      expect(err).toBeInstanceOf(LaunchdRefused)
      expect((err as LaunchdRefused).why).toBe('invalid')
      expect(err!.message).toBe(
        `launchd would not load its definition, ${mac.definition}, which is not a valid property list (${wrong}). \`plutil -lint\` on the file says where it is wrong. \`it setup\` writes the file from the settings of the terminal it is run in, its PATH among them, so the fault is in one of those: put it right and run \`it setup\` again.`,
      )
      expect(stands()).toEqual({ installed: false, registered: false, state: 'not loaded', defined: 'this folder' })
    }),
  )

  test('with a definition the person cannot read, the load is refused and that is said', () =>
    onAMac((mac) => {
      mac.set('unreadable')
      const err = refusal()
      expect(err).toBeInstanceOf(LaunchdRefused)
      expect((err as LaunchdRefused).why).toBe('unreadable')
      expect(err!.message).toBe(
        `launchd would not load its definition, ${mac.definition}, and It cannot read that file itself (EACCES). Make the file yours to read, or move it away, and run \`it setup\` again.`,
      )
      // A definition that cannot be read names no folder, so it is nobody's registration
      expect([installedHere(), serviceStatus().registered]).toEqual([false, false])
    }))

  test('with a cause that launchd does not give, what `launchctl` printed is kept, and nothing is registered', () =>
    onAMac((mac) => {
      mac.set('refuses')
      const err = refusal()
      expect(err).toBeInstanceOf(LaunchdRefused)
      expect((err as LaunchdRefused).why).toBe('unknown')
      expect(err!.message).toBe(`loading the agent failed: ${REFUSED}`)
      // launchd and the definition were both asked before that was settled for
      expect(mac.asked()).toEqual(['bootout', 'print', 'bootstrap', 'print-disabled'])
      expect(existsSync(mac.definition)).toBe(true)
      expect(stands()).toEqual({ installed: false, registered: false, state: 'not loaded', defined: 'this folder' })
      expect(launchdHas()).toEqual({ has: 'not loaded' })
    }))

  test('with a definition from before, a refused one gives way to it, and launchd holding that one again is a registration', () =>
    onAMac((mac) => {
      const earlier = launchdPlist(command(), { PATH: '/an/earlier/path' })
      mkdirSync(path.dirname(mac.definition), { recursive: true })
      writeFileSync(mac.definition, earlier)
      mac.set('loaded')
      mac.set('refuses-the-new-one')
      const err = refusal()
      expect(err).toBeInstanceOf(LaunchdRefused)
      expect(err!.message).toBe(`loading the agent failed: ${REFUSED}`)
      expect(readFileSync(mac.definition, 'utf8')).toBe(earlier)
      expect(mac.asked().filter((word) => word !== 'print-disabled')).toEqual(['bootout', 'print', 'bootstrap', 'bootstrap'])
      // The service registered before is what launchd holds, so It does start by itself
      expect(stands()).toEqual({ installed: true, registered: true, state: 'running', defined: 'this folder' })
    }))

  test('with a definition from before and the label switched off, neither is loaded: both failures are said, the earlier definition stays, and nothing is registered', () =>
    onAMac((mac) => {
      const earlier = launchdPlist(command(), { PATH: '/an/earlier/path', IT_PORT: '4800' })
      mkdirSync(path.dirname(mac.definition), { recursive: true })
      writeFileSync(mac.definition, earlier)
      mac.set('loaded')
      mac.set('disabled')
      const err = refusal()
      expect(err).toBeInstanceOf(LaunchdRefused)
      expect((err as LaunchdRefused).why).toBe('disabled')
      expect(err!.message).toMatch(
        /^macOS has It’s background service switched off for your account, .* It has to be allowed there\. And restoring the earlier agent failed: Bootstrap failed: 5/,
      )
      expect(readFileSync(mac.definition, 'utf8')).toBe(earlier)
      expect(stands()).toEqual({ installed: false, registered: false, state: 'disabled', defined: 'this folder' })
      // What that definition gave the service is kept for the setup that registers it again, though nothing is registered now
      expect(kept()).toEqual({ IT_PORT: '4800' })
    }))

  test('with no login at the Mac’s own screen, as over SSH, nothing can be loaded: the definition is kept for the next login, and is a registration', () =>
    onAMac((mac) => {
      mac.set('no-login')
      const err = refusal()
      // No refusal of launchd's: there was nothing to ask, and what is said is what was said before
      expect(err).not.toBeInstanceOf(LaunchdRefused)
      expect(err!.message).toBe('launchd could not confirm that the earlier agent has unloaded. Its definition was kept. Run `it service install` again.')
      expect(mac.asked()).toEqual(['bootout', 'print'])
      expect(existsSync(mac.definition)).toBe(true)
      expect(launchdHas()).toEqual({ has: 'no login' })
      expect(stands()).toEqual({ installed: true, registered: true, state: 'not loaded', defined: 'this folder' })
      expect(startsByItself()).toBe(true)
    }))

  test('an agent that was taken out of launchd by hand is not registered, and one that launchd cannot be asked about is gone by its definition', () =>
    onAMac((mac) => {
      install()
      mac.set('loaded', false)
      expect(stands()).toEqual({ installed: false, registered: false, state: 'not loaded', defined: 'this folder' })
      // A question that failed is not an answer: with nothing known of launchd, the definition is what there is
      mac.set('answers-nothing')
      expect(launchdHas()).toEqual({ has: 'unknown' })
      expect(stands()).toEqual({ installed: true, registered: true, state: 'not loaded', defined: 'this folder' })
      // And so where there is no `launchctl` to ask at all
      process.env.PATH = path.join(mac.user, 'no-commands-here')
      expect(launchdHas()).toEqual({ has: 'unknown' })
      expect(installedHere()).toBe(true)
    }))

  test('a definition that is another folder’s is not this one’s, whatever launchd holds', () =>
    onAMac((mac) => {
      install()
      process.env.IT_HOME = path.join(mac.user, 'another')
      expect(stands()).toEqual({ installed: false, registered: false, state: 'not installed', defined: 'another folder' })
      expect(startsByItself()).toBe(false)
    }))

  test('the running service asks launchd once a minute whether it starts by itself, and again whenever the definition is another', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      onAMac((mac) => {
        install()
        const questions = () => mac.asked().filter((word) => word === 'print').length
        expect(startsByItself()).toBe(true)
        const once = questions()
        for (let n = 0; n < 50; n++) expect(startsByItself()).toBe(true)
        expect(questions()).toBe(once)
        // Switched off by the person's own hand, and taken out: said within the minute
        mac.set('disabled')
        mac.set('loaded', false)
        expect(startsByItself()).toBe(true)
        vi.advanceTimersByTime(61_000)
        expect(startsByItself()).toBe(false)
        // Registered anew, by whatever wrote the definition: said at once
        mac.set('disabled', false)
        mac.set('loaded')
        writeFileSync(mac.definition, `${readFileSync(mac.definition, 'utf8')}\n`)
        expect(startsByItself()).toBe(true)
        // With the definition gone, nothing is asked at all
        rmSync(mac.definition)
        const then = mac.asked().length
        expect([startsByItself(), mac.asked().length]).toEqual([false, then])
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
