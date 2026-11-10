// The word usage reporting sends for why a click could not be handed over, made from the
// refusal this program says. Where the code that says a refusal can be asked for it without
// starting anything, it is asked; the others are written here as that code writes them.
import { describe, expect, test } from 'vitest'
import { codexQueue } from './src/connector'
import { profileEnvironment } from './src/profiles'
import { ALLOWED } from './src/usage'
import { carrying } from './src/wake'
import { WAKE_WHY, wakeWhy } from './src/wake-why'

const has = { itHome: '/home/someone/.it', codex: null, start: null }

describe('the word for why a hand-over did not happen', () => {
  test('is made from what reopening a conversation says where it cannot even begin', () => {
    expect(wakeWhy(carrying('claude-code', 'not a uuid', 'x', has) as string)).toBe('bad_id')
    expect(wakeWhy(carrying('claude-code', '0b7f6a52-5c0e-4e0b-9d1c-2f1f3f0a8d11', 'x', has) as string)).toBe('not_found')
    expect(wakeWhy(carrying('codex', 'thread-1', 'x', has) as string)).toBe('not_found')
    expect(wakeWhy(carrying('openclaw', 'any', 'x', has) as string)).toBe('unsupported')
    expect(wakeWhy(profileEnvironment('claude-code', { version: 99 }, {}) as string)).toBe('profile')
  })

  test('is made from what Codex’s queue says where it is refused before it starts', async () => {
    expect(wakeWhy((await codexQueue('not a thread id!', 'x')) as string)).toBe('bad_id')
    expect(wakeWhy((await codexQueue('thread-1', 'x', { PATH: '' })) as string)).toBe('not_found')
  })

  test.each([
    ['an open app cannot confirm which idle conversations it holds; send a message in the conversation to start listening', 'unconfirmed'],
    ['the folder its conversation was held in is not known on this machine, or is gone', 'no_folder'],
    ['its recorded app profile is gone; restore that profile or open the conversation and publish its page again', 'profile'],
    ['it is being reopened already', 'reopening'],
    [
      'It could not read its own note of which conversations were running when it last stopped, so it reopens none until that is seen to: check that no agent It started is still running on this machine, and then run `it runs clear` there',
      'runs_unread',
    ],
    ['a turn of it from before may still be running on its machine, and could not be checked on or ended.', 'unsettled'],
    ['It could not be told that the conversation was being reopened, so it was not', 'untold'],
    ['Claude Code could not be started: Windows would not start its program', 'not_started'],
    ['Claude Code could not be started', 'not_started'],
    ['Codex could not be started with that message', 'not_started'],
    ['Claude Code had not finished in fifteen minutes', 'timeout'],
    ['Codex did not answer in thirty seconds', 'timeout'],
    ['Claude Code was not found', 'not_found'],
    ['Claude Code exited with 1', 'exited'],
    ['Codex exited with SIGTERM', 'exited'],
    ['Pi was started and could not be noted down, so it was ended before it was given anything to do', 'unnoted'],
    ['T3 Code could not be reached', 't3_unreachable'],
    ['T3 Code closed the connection before it answered', 't3_unreachable'],
    ['T3 Code did not answer in time', 't3_unreachable'],
    ['T3 Code refused the message', 't3_refused'],
    ['T3 Code failed at the message', 't3_refused'],
    ['T3 Code did not let It in', 't3_refused'],
  ])('“%s” is %s', (refusal, word) => {
    expect(wakeWhy(refusal)).toBe(word)
  })

  test('is `other` for a refusal it does not know, and never any of the refusal’s own words', () => {
    expect(wakeWhy('something nobody wrote yet, with a path /home/someone/secret')).toBe('other')
    expect(wakeWhy('')).toBe('other')
  })

  test('is always one of the words usage reporting allows for agent.woken', () => {
    expect(ALLOWED['agent.woken'].why).toEqual(WAKE_WHY)
    for (const refusal of ['Claude Code exited with 1', 'T3 Code refused the message', 'anything']) expect(WAKE_WHY).toContain(wakeWhy(refusal))
  })
})
