// The process listing of backend.ts, alone, as `itrehearsal` (an account never signed in at the
// screen, its programs started through Windows' secondary logon): the Bun-compiled copy in each
// variant, and the same source under Node. Registers nothing and changes nothing in that account.
//   node e2e/rehearsal/repro-list-as.mjs
import { psAs, userEnv } from './asuser.mjs'

const exe = "& 'D:\\it-rehearsal\\work\\repro\\repro-list-bun.exe'"
const node = "& 'C:\\Program Files\\nodejs\\node.exe' --experimental-strip-types --no-warnings 'D:\\it-rehearsal\\work\\repro\\repro-list-bun.ts'"
const env = userEnv('itrehearsal', { extra: { REPRO_TIMEOUT_MS: '45000' } })
const lines = []
for (const v of ['', 'progress', 'env', 'stdin-ignore', 'env progress stdin-ignore']) {
  lines.push(`"--- bun ${v || 'as released'}"`, `${exe} ${v}`)
}
lines.push('"--- node as released"', node, '"--- node progress"', `${node} progress`)
lines.push('"--- again, bun as released"', exe)
const r = await psAs('itrehearsal', lines.join('\n'), env)
console.log(r.output.replace(/<Objs[\s\S]*?<\/Objs>/g, '').replace(/#< CLIXML/g, ''))
