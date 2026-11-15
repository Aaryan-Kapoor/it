// Sets the agent app's model and effort in ana's own settings, keeping everything else there,
// such as what `it setup` wrote to turn It's add-on on.
//   node settings.mjs claude <model> <effort> | codex <model> <effort>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const [app, model, effort] = process.argv.slice(2)
const home = process.env.HOME
if (app === 'claude') {
  const f = `${home}/.claude/settings.json`
  mkdirSync(`${home}/.claude`, { recursive: true })
  const s = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}
  Object.assign(s, { model, effortLevel: effort })
  writeFileSync(f, `${JSON.stringify(s, null, 2)}\n`)
} else {
  const f = `${home}/.codex/config.toml`
  mkdirSync(`${home}/.codex`, { recursive: true })
  let lines = existsSync(f) ? readFileSync(f, 'utf8').split('\n') : []
  // Top-level keys come before the first table
  const first = lines.findIndex((l) => /^\s*\[/.test(l))
  const head = (first === -1 ? lines : lines.slice(0, first)).filter((l) => !/^\s*(model|model_reasoning_effort)\s*=/.test(l))
  let rest = first === -1 ? [] : lines.slice(first)
  const feat = rest.findIndex((l) => /^\s*\[features\]\s*$/.test(l))
  if (feat === -1) rest.push('', '[features]', 'apps = false')
  else {
    let end = rest.findIndex((l, i) => i > feat && /^\s*\[/.test(l))
    if (end === -1) end = rest.length
    const body = rest.slice(feat + 1, end).filter((l) => !/^\s*apps\s*=/.test(l))
    rest = [...rest.slice(0, feat + 1), 'apps = false', ...body, ...rest.slice(end)]
  }
  lines = [`model = "${model}"`, `model_reasoning_effort = "${effort}"`, ...head, ...rest]
  writeFileSync(f, `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`)
}
