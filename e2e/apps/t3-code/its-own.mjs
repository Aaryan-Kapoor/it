// It's own code for T3 Code (packages/cli/src/t3.ts), built from the source as it is and loaded
// here, so that the run asks the real T3 Code server with exactly what the connector asks it with.
// It is built with the esbuild that builds the `it` program, into a folder of the run's own.
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from '../../lib.mjs'

/** Builds packages/cli/src/t3.ts into `folder` and loads it. */
export async function itsOwnT3(folder) {
  const esbuild = createRequire(path.join(root, 'packages/cli/package.json'))('esbuild')
  const out = path.join(folder, 't3.mjs')
  await esbuild.build({
    entryPoints: [path.join(root, 'packages/cli/src/t3.ts')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'error',
    // What the bundle needs of Node's own modules is loaded as Node loads it
    banner: { js: "import { createRequire as __itRequire } from 'node:module'; const require = __itRequire(import.meta.url);" },
  })
  return import(pathToFileURL(out).href)
}
