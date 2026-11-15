// Runs repro-list2.cjs as `itrehearsal`.
import { copyFileSync } from 'node:fs'
import path from 'node:path'
import { psAs, userEnv } from './asuser.mjs'
import { here, WORK } from './lib.mjs'

const to = path.join(WORK, 'user-bin', 'repro-list2.cjs')
copyFileSync(path.join(here, 'repro-list2.cjs'), to)
const r = await psAs('itrehearsal', `& 'C:\\Program Files\\nodejs\\node.exe' '${to}' 2>&1`, userEnv('itrehearsal'))
console.log(r.output)
