// How the stand-in for Claude Code's model reads a turn: the newest user message's own text,
// with Claude Code's reminders taken out and nothing else, its tool results, and the id Claude
// Code gives the conversation.
import { describe, expect, test } from 'vitest'
import { readTurn } from './model.mjs'

const asUser = (content) => ({
  messages: [
    { role: 'user', content: 'earlier' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content },
  ],
})

describe('a turn, as the stand-in for the model reads it', () => {
  test('takes out a reminder of Claude Code’s and keeps every other word of the message', () => {
    const turn = readTurn(
      asUser([
        { type: 'text', text: '<system-reminder>Some context.</system-reminder>' },
        { type: 'text', text: '[It] "One button" (one-button): press [action abc]' },
      ]),
      {},
    )
    expect(turn.text).toBe('[It] "One button" (one-button): press [action abc]')
  })

  test('keeps text that follows a reminder in the same block, so that a message with more after it is not read as one that ends with the action', () => {
    const turn = readTurn(
      asUser([
        { type: 'text', text: '[It] "One button" (one-button): press [action abc]' },
        { type: 'text', text: '<system-reminder>Some context.</system-reminder>\nand something else' },
      ]),
      {},
    )
    expect(turn.text.endsWith('[action abc]')).toBe(false)
    expect(turn.text).toContain('and something else')
  })

  test('reads a message given as a string, and its tool results apart from its text', () => {
    expect(readTurn(asUser('Make a page.'), {}).text).toBe('Make a page.')
    const turn = readTurn(asUser([{ type: 'tool_result', tool_use_id: 't', content: 'done' }]), {})
    expect(turn.text).toBe('')
    expect(turn.results).toHaveLength(1)
  })

  test('takes the conversation’s id from Claude Code’s header, or from the request’s metadata', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
    expect(readTurn(asUser('x'), { 'x-claude-code-session-id': id }).session).toBe(id)
    expect(readTurn({ ...asUser('x'), metadata: { user_id: `user_abc_account__session_${id}` } }, {}).session).toBe(id)
    expect(readTurn({ ...asUser('x'), metadata: { user_id: JSON.stringify({ session_id: id }) } }, {}).session).toBe(id)
    expect(readTurn(asUser('x'), {}).session).toBeNull()
  })
})
