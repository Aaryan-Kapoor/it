// The tester's verdict on a run the model played, written into its result.json, and the report
// written again. node judge.mjs <run folder> <pass|fail|harness> <blame: it|model|harness|none> "<reason>"
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeReport } from './report.mjs'
const [dir, verdict, blame, reason, ...more] = process.argv.slice(2)
const file = join(dir, 'result.json')
const r = JSON.parse(readFileSync(file, 'utf8'))
r.ok = verdict === 'pass'
r.blame = verdict === 'harness' ? 'harness' : blame === 'none' ? null : blame
r.reason = reason
if (more.length) r.judged = more.join(' ')
r.judgedAt = new Date().toISOString()
writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 })
writeReport(dirname(dir))
console.log(`${verdict} ${dir}`)
