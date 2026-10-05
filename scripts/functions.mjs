// Writes the file of It's backend functions that is built into `it`: everything under convex/,
// bundled as the backend program takes it when functions are loaded into it. The `convex`
// package does the bundling. It is asked only to write down what it would send to a backend,
// and is told on its command line of an address where nothing listens and a key that is none.
// Told so, it reads nothing from the environment about where to send anything, and reaches nothing.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(path.join(os.tmpdir(), 'it-functions-'))
let request
try {
  // Nothing this shell says to the `convex` package is passed on either
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CONVEX_')))
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules/convex/bin/main.js'),
      'deploy',
      '--write-push-request',
      path.join(work, 'functions'),
      '--push-all-modules',
      '--typecheck',
      'disable',
      '--codegen',
      'disable',
      '--url',
      'http://127.0.0.1:9',
      '--admin-key',
      'none',
    ],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  request = JSON.parse(readFileSync(path.join(work, 'functions.json'), 'utf8'))
} catch (err) {
  // What the bundler said is all there is to go on, and it is said only when it failed
  console.error(`${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || String(err.message ?? err))
  console.error('the backend functions could not be bundled')
  process.exit(1)
} finally {
  rmSync(work, { recursive: true, force: true })
}
// The key is the service's own, and is put in when the functions are loaded
delete request.adminKey
const text = JSON.stringify(request)
/** What tells these functions from any others: a program that carries them carries this too. */
export const FUNCTIONS_HASH = createHash('sha256').update(text).digest('hex')
writeFileSync(
  path.join(root, 'packages/cli/src/functions.generated.ts'),
  `// Written by scripts/functions.mjs. Do not edit.\nexport const FUNCTIONS_HASH: string = ${JSON.stringify(FUNCTIONS_HASH)}\nexport const FUNCTIONS: string = ${JSON.stringify(text)}\n`,
)
console.log(`functions ${FUNCTIONS_HASH.slice(0, 12)}, ${request.appDefinition.changedModules.length} modules, ${text.length} bytes`)
