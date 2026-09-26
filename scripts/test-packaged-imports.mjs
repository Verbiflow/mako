import assert from "node:assert/strict"
import { posix, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { listPackage, extractFile } from "@electron/asar"
import ts from "typescript"

function importedNames(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause
    const names = clause?.name ? ["default"] : []
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
      names.push(
        ...clause.namedBindings.elements.map(
          (entry) => (entry.propertyName ?? entry.name).text
        )
      )
    return names
  }
  if (
    ts.isExportDeclaration(node) &&
    node.exportClause &&
    ts.isNamedExports(node.exportClause)
  )
    return node.exportClause.elements.map(
      (entry) => (entry.propertyName ?? entry.name).text
    )
  return []
}

export function assertPackagedImports(app) {
  const archive = join(app, "Contents/Resources/app.asar")
  const files = new Set(
    listPackage(archive).map((path) => path.replace(/^\//, ""))
  )
  let checked = 0
  const sources = new Map()
  const imports = []
  for (const file of files) {
    if (!file.startsWith("dist-electron/") || (!file.endsWith(".js") && !file.endsWith(".mjs"))) continue
    const bytes = extractFile(archive, file)
    assert.ok(
      bytes.length <= 2 * 1024 * 1024,
      `Host module exceeds the package check budget: ${file}`
    )
    const source = ts.createSourceFile(
      `/${file}`,
      bytes.toString("utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    )
    sources.set(`/${file}`, source)
    function check(node) {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) &&
              node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined
      if (
        specifier &&
        ts.isStringLiteralLike(specifier) &&
        specifier.text.startsWith(".")
      ) {
        const target = posix.normalize(
          posix.join(posix.dirname(file), specifier.text)
        )
        assert.ok(
          files.has(target),
          `Packaged import missing: ${file} -> ${specifier.text}`
        )
        imports.push({ file, target: `/${target}`, names: importedNames(node) })
        checked++
      }
      ts.forEachChild(node, check)
    }
    check(source)
  }
  const options = {
    allowJs: true,
    checkJs: false,
    noResolve: true,
    noLib: true,
    module: ts.ModuleKind.ESNext,
  }
  const host = {
    ...ts.createCompilerHost(options),
    getCurrentDirectory: () => "/",
    getSourceFile: (file) => sources.get(file),
    fileExists: (file) => sources.has(file),
    readFile: (file) => sources.get(file)?.text,
  }
  const program = ts.createProgram([...sources.keys()], options, host)
  const checker = program.getTypeChecker()
  for (const item of imports) {
    const source = sources.get(item.target)
    if (
      !source ||
      !ts.isExternalModule(source) ||
      source.statements.some(
        (node) => ts.isExportDeclaration(node) && !node.exportClause
      )
    )
      continue
    const symbol = checker.getSymbolAtLocation(source)
    assert.ok(symbol, `Packaged exports could not be inspected: ${item.target}`)
    const names = new Set(
      checker.getExportsOfModule(symbol).map((entry) => entry.getName())
    )
    for (const name of item.names)
      assert.ok(
        names.has(name),
        `Packaged export missing: ${item.file} -> ${item.target}: ${name}`
      )
  }
  assert.ok(checked > 0, "The package contains no host imports")
  return checked
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.ok(process.argv[2], "Provide a built Mako.app path")
  console.log(
    `Verified ${assertPackagedImports(resolve(process.argv[2]))} relative imports in the packaged host`
  )
}
