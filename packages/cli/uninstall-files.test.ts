import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, test } from 'vitest'
import { INSTALLATION_FILE, markInstallation } from './src/installation'
import { RUN_ONCE, WINDOWS_CLEANUP, WINDOWS_PATH_MOST, windowsDeletionCommand } from './src/lib'
import { deleteAtSignIn, ROOT_FILES, ROOT_FOLDERS, ROOT_LOCKS, removeInstallationFiles, stepOutOf } from './src/uninstall-files'

const folders: string[] = []
function folder() {
  const at = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'it-clean-')))
  folders.push(at)
  return at
}
afterEach(() => {
  for (const at of folders.splice(0)) rmSync(at, { recursive: true, force: true })
})

test('uninstall removes whole owned subfolders and keeps unknown entries only at the top level', () => {
  const at = folder()
  markInstallation(at)
  for (const name of ['backend', 'content', 'content-data', 'logs', 'publication-pending', 'addons', 'bin']) {
    mkdirSync(path.join(at, name, 'unrecognised'), { recursive: true })
    writeFileSync(path.join(at, name, 'unrecognised', 'private'), 'private data')
  }
  writeFileSync(path.join(at, 'startup.json'), '{}')
  writeFileSync(path.join(at, 'notes'), 'mine')
  expect(removeInstallationFiles(at, false)).toEqual(['notes'])
  expect(readFileSync(path.join(at, 'notes'), 'utf8')).toBe('mine')
})

test('the protection page distinguishes whole subfolder removal from unknown top-level files', () => {
  const docs = readFileSync(path.join(import.meta.dirname, '../../docs/what-it-protects.md'), 'utf8')
  const removal = docs.split('\n').find((line) => line.startsWith('Uninstall requires'))!
  expect(removal).toMatch(/subfolders whole/)
  expect(removal).toMatch(/top level.*recognised files.*unknown files/)
})

test('a failed add-on removal keeps its whole folder and program while the data folders go', () => {
  const at = folder()
  markInstallation(at)
  for (const name of ['backend', 'content', 'content-data', 'logs', 'publication-pending', 'addons', 'bin']) {
    mkdirSync(path.join(at, name))
    writeFileSync(path.join(at, name, 'private'), 'kept for retry')
  }
  expect(removeInstallationFiles(at, true)).toEqual(['addons', 'bin', 'installation.json'])
  for (const name of ['addons', 'bin']) expect(readFileSync(path.join(at, name, 'private'), 'utf8')).toBe('kept for retry')
})

test('every name used with inHome in the CLI has an uninstall rule', () => {
  const src = path.join(import.meta.dirname, 'src')
  const files = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name))
  const program = ts.createProgram(files, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler })
  const checker = program.getTypeChecker()
  const calls: ts.CallExpression[] = []
  for (const file of files) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) calls.push(node)
      ts.forEachChild(node, visit)
    }
    visit(program.getSourceFile(file)!)
  }
  const strings = (node: ts.Expression): string[] => {
    const type = checker.getTypeAtLocation(node)
    const types = type.isUnion() ? type.types : [type]
    if (types.every((value) => value.isStringLiteral())) return types.map((value) => value.value)
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(strings)
    if (ts.isIdentifier(node)) {
      for (const declaration of checker.getSymbolAtLocation(node)?.declarations ?? []) {
        if (ts.isVariableDeclaration(declaration)) {
          if (declaration.initializer) return strings(declaration.initializer)
          const loop = declaration.parent.parent
          if (ts.isForOfStatement(loop)) return strings(loop.expression)
        }
        if (ts.isParameter(declaration) && ts.isArrowFunction(declaration.parent)) {
          const call = declaration.parent.parent
          if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'map')
            return strings(call.expression.expression)
        }
      }
    }
    // The lock helper builds a root filename from its callers' names. Follow its symbol,
    // including imports, so another caller must name a lock that cleanup knows about too.
    if (ts.isTemplateExpression(node) && node.head.text === '' && node.templateSpans.length === 1) {
      const span = node.templateSpans[0]!
      const declaration = checker.getSymbolAtLocation(span.expression)?.valueDeclaration
      if (declaration && ts.isParameter(declaration) && ts.isFunctionDeclaration(declaration.parent) && declaration.parent.name) {
        const owner = checker.getSymbolAtLocation(declaration.parent.name)
        const values = calls.flatMap((call) => {
          let symbol = checker.getSymbolAtLocation(call.expression)
          if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
          return symbol === owner ? strings(call.arguments[0]!).map((name) => name + span.literal.text) : []
        })
        if (values.length) return values
      }
    }
    throw new Error(`The uninstall test cannot check this home name: ${node.getSourceFile().fileName}: ${node.getText()}`)
  }
  const names = new Set(
    calls.filter((call) => ts.isIdentifier(call.expression) && call.expression.text === 'inHome').flatMap((call) => strings(call.arguments[0]!)),
  )
  for (const name of ['setup.lock', 'enrol.lock', 'addons/setup.lock']) expect(names).toContain(name)
  const recognised = [INSTALLATION_FILE, ...ROOT_FILES, ...ROOT_FOLDERS, ...ROOT_LOCKS]
  for (const name of names) expect(recognised, `${name} needs an uninstall rule`).toContain(name.split(/[\\/]/)[0]!)
})

/** What stands in for reg.exe: it notes what it was asked, and says yes where `yes` does. */
function registry(yes = (_args: string[]) => true) {
  const asked: string[][] = []
  return {
    asked,
    ask: (args: string[]) => {
      asked.push(args)
      return yes(args)
    },
  }
}

describe('the program stepping out of its folder, as uninstall does on Windows', () => {
  /** An It folder with a program in its bin, and a folder beside it for the program to go to, at the depth given. */
  function installed(...aside: string[]) {
    const at = folder()
    const bin = path.join(at, 'It', 'bin')
    mkdirSync(bin, { recursive: true })
    const program = path.join(bin, 'it.exe')
    writeFileSync(program, 'the program')
    const to = path.join(at, 'aside', ...aside)
    mkdirSync(to, { recursive: true })
    const moved = () => readdirSync(to).map((name) => path.join(to, name))
    return { folder: path.join(at, 'It'), program, to, moved }
  }

  test('moves out, and Windows is asked to delete it the next time the person signs in', () => {
    const it = installed()
    const { asked, ask } = registry()
    const stepped = stepOutOf(it.folder, { program: it.program, places: [it.to], ask })
    const [moved] = it.moved()
    expect(path.basename(moved!)).toMatch(/^it-removed-\d+-[0-9a-z]+\.exe$/)
    expect(existsSync(it.program)).toBe(false)
    expect(stepped).toEqual({
      said: `The program moved itself to ${moved} to do this, and Windows was asked to delete it from there the next time you sign in. If it remains, delete it yourself.`,
    })
    const file = path.join(realpathSync.native(it.to), path.basename(moved!))
    const entry = asked[0]![3]!
    expect(asked).toEqual([
      ['add', WINDOWS_CLEANUP, '/v', entry, '/t', 'REG_SZ', '/d', file, '/f'],
      ['add', RUN_ONCE, '/v', entry, '/t', 'REG_SZ', '/d', windowsDeletionCommand(entry, file), '/f'],
    ])
  })

  test('where the path it moved to is longer than Windows PowerShell can be counted on to delete, Windows is asked nothing and the person is told to delete it', () => {
    const it = installed('a'.repeat(100), 'b'.repeat(100), 'c'.repeat(60))
    const { asked, ask } = registry()
    const stepped = stepOutOf(it.folder, { program: it.program, places: [it.to], ask })
    const [moved] = it.moved()
    expect(moved!.length).toBeGreaterThan(WINDOWS_PATH_MOST)
    expect(stepped).toEqual({ left: `The program moved itself to ${moved} to do this. Delete it to finish.` })
    expect(asked).toEqual([])
  })

  test('where RunOnce will not take the line, the queue lets go of the path and the person is told to delete it', () => {
    const it = installed()
    const { asked, ask } = registry((args) => args[1] !== RUN_ONCE)
    const stepped = stepOutOf(it.folder, { program: it.program, places: [it.to], ask })
    const [moved] = it.moved()
    expect(stepped).toEqual({ left: `The program moved itself to ${moved} to do this. Delete it to finish.` })
    expect(asked.map((args) => args.slice(0, 2))).toEqual([
      ['add', WINDOWS_CLEANUP],
      ['add', RUN_ONCE],
      ['delete', WINDOWS_CLEANUP],
    ])
    expect(asked[2]![3]).toBe(asked[0]![3])
  })

  test('where the queue will not take the path, RunOnce is not asked and the person is told to delete it', () => {
    const it = installed()
    const { asked, ask } = registry(() => false)
    const stepped = stepOutOf(it.folder, { program: it.program, places: [it.to], ask })
    expect(stepped).toEqual({ left: `The program moved itself to ${it.moved()[0]} to do this. Delete it to finish.` })
    expect(asked.map((args) => args.slice(0, 2))).toEqual([['add', WINDOWS_CLEANUP]])
  })

  test('a program that is not in the folder stays where it is', () => {
    const it = installed()
    const { asked, ask } = registry()
    expect(stepOutOf(path.join(it.to, 'elsewhere'), { program: it.program, places: [it.to], ask })).toBeUndefined()
    expect(existsSync(it.program)).toBe(true)
    expect(asked).toEqual([])
  })
})

test('Windows is asked to delete a path as long as Windows PowerShell can be counted on to delete, and asked nothing for one longer', () => {
  const longest = `C:\\${'x'.repeat(WINDOWS_PATH_MOST - 3)}`
  const fits = registry()
  expect(deleteAtSignIn(longest, 'ItRemoved1-a', fits.ask)).toBe(true)
  expect(fits.asked).toHaveLength(2)
  const over = registry()
  expect(deleteAtSignIn(`${longest}x`, 'ItRemoved1-a', over.ask)).toBe(false)
  expect(over.asked).toEqual([])
})
