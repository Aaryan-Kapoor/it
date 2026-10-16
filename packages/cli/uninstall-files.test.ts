import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { afterEach, expect, test } from 'vitest'
import { INSTALLATION_FILE, markInstallation } from './src/installation'
import { ROOT_FILES, ROOT_FOLDERS, ROOT_LOCKS, removeInstallationFiles } from './src/uninstall-files'

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
