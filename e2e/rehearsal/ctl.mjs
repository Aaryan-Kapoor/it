// One command to a run's control port (arun.mjs), for a test the tester drives step by step.
//   node e2e/rehearsal/ctl.mjs [--control 5697] screen [lines]   the terminal's last lines
//   node e2e/rehearsal/ctl.mjs type <text> | key <name> | goto <page> | click <selector> | pagetext
//   node e2e/rehearsal/ctl.mjs wait <regex> <seconds>             until the screen matches
//   node e2e/rehearsal/ctl.mjs note <name> <seen> | status | stop
// What it prints has the account's name masked.
import os from 'node:os'

const argv = process.argv.slice(2)
let control = 5697
if (argv[0] === '--control') {
  control = Number(argv[1])
  argv.splice(0, 2)
}
const [cmd, a, b] = argv
const send = async (q) => {
  const r = await fetch(`http://127.0.0.1:${control}/`, { method: 'POST', body: JSON.stringify(q) })
  return r.text()
}
const user = os.userInfo().username
const mask = (s) => String(s).split(user).join('<account>')
const lastLines = (s, n) => s.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n).join('\n')
let out
if (cmd === 'screen') out = lastLines(await send({ cmd }), Number(a ?? 25))
else if (cmd === 'type') out = await send({ cmd, text: a })
else if (cmd === 'key') out = await send({ cmd, name: a })
else if (cmd === 'goto') out = await send({ cmd, page: a })
else if (cmd === 'click') out = await send({ cmd, selector: a })
else if (cmd === 'note') out = await send({ cmd, name: a, seen: b ?? '' })
else if (cmd === 'wait') {
  const re = new RegExp(a, 'i')
  const end = Date.now() + Number(b ?? 60) * 1000
  let s = ''
  while (Date.now() < end) {
    s = await send({ cmd: 'screen' })
    if (re.test(s)) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  out = `${re.test(s) ? 'MATCHED' : 'TIMED OUT'}\n${lastLines(s, 18)}`
} else out = await send({ cmd })
console.log(mask(out).slice(0, 4000))
