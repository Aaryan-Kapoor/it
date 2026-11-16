// What the background service says in its log of what the person's shell gave the apps it
// reopens, with the shell's answer stood in for: a shell whose only addition is folders on the
// PATH has given something, and the line does not say that it gave nothing.
import path from 'node:path'
import { expect, test, vi } from 'vitest'

vi.mock('./src/shell-env', async (original) => ({
  ...(await original<typeof import('./src/shell-env')>()),
  shellEnv: vi.fn(async () => ({ ...process.env, PATH: [process.env.PATH, path.resolve('from-the-shell', 'bin')].join(path.delimiter) })),
}))

const { askShell } = await import('./src/lib')

test('a shell that adds only folders to the PATH is said to have given a setting, and not that the apps get only what the service has', async () => {
  const before = process.env.IT_SHELL_ENV
  delete process.env.IT_SHELL_ENV
  try {
    const said = await new Promise<string>((resolve) => askShell(resolve))
    expect(said).toBe('agent apps that It reopens are given 1 setting of your shell that the background service was started without')
  } finally {
    if (before !== undefined) process.env.IT_SHELL_ENV = before
  }
})
