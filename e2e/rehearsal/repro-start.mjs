// Tries starting programs as `itrehearsal` without waiting, as the task watcher does, and says how each went.
import { startAs, userEnv } from './asuser.mjs'

for (const [exe, args, cwd] of [
  ['C:\\Windows\\System32\\cmd.exe', ['/d', '/c', 'echo hi'], 'C:\\Users\\itrehearsal'],
  ['C:\\Windows\\System32\\cmd.exe', ['/d', '/c', 'echo hi'], 'C:\\Windows'],
  ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-Command', 'exit 0'], 'C:\\Users\\itrehearsal'],
]) {
  try {
    const r = await startAs({ user: 'itrehearsal', exe, args, cwd, env: userEnv('itrehearsal') })
    console.log('started', exe, cwd, r.pid)
  } catch (e) {
    console.log('FAILED', exe, cwd, e.message)
  }
}
