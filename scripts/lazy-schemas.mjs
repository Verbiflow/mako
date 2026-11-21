import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

/**
 * Exported composite schemas are built on first use: `export const X = z.lazy(() => z.object(…))`. A host builds every
 * schema its modules declare as it imports them, some 25,000, most never parsed while it idles; the lazy ones cost one
 * small schema each until something parses or converts them (2026-11-20: the idle heap 95 → 79 MB on arm64 Linux, the
 * JSON schemas, MCP tool lists and parse results unchanged).
 *
 * A composite is a top-level exported `const` whose value starts with `z.object`, `strictObject`, `looseObject`,
 * `discriminatedUnion`, `union`, `array`, `record`, `tuple` or `intersection`. One stays eager, and needs no word here,
 * when it's read for what a lazy schema doesn't have (`.shape`, `.extend`, `.options`, `.element`, `.unwrap`, its
 * `_zod`, an index and the like, anywhere in the repository) or its chain ends in `.describe` or `.meta`, whose
 * description a lazy schema wouldn't carry as its own. Any other that stays eager is named in `eager-schemas.json` with
 * why.
 *
 *   node scripts/lazy-schemas.mjs          check: exits 1 naming each eager composite that should be lazy
 *   node scripts/lazy-schemas.mjs --fix    wraps each of them in `z.lazy`
 */
const root = join(import.meta.dirname, "..")
const fix = process.argv.includes("--fix")
const PACKAGES = ["host", "sessions", "protocol", "control", "control-runtime", "git"]
/** Where a schema's structure may be read from: every package, the app, the desktop and the scripts. */
const READERS = ["packages", "src", "electron", "scripts", "browser-extension"]
const KINDS = /^z\s*\.\s*(object|strictObject|looseObject|discriminatedUnion|union|array|record|tuple|intersection)\s*\(/
const STRUCTURE = "shape|extend|safeExtend|merge|pick|omit|partial|required|keyof|strict|strip|passthrough|loose|catchall|options|element|unwrap|innerType|keySchema|valueSchema|items|rest|schema|in|out|def|_def|_zod|extract|exclude|enum|value|values|removeDefault|description|meta"
const allowlistFile = join(root, "scripts/eager-schemas.json")
/** `<file>#<name>` → why it stays eager. */
const allowlist = existsSync(allowlistFile) ? JSON.parse(readFileSync(allowlistFile, "utf8")) : {}

function files(folder, into = []) {
  if (!existsSync(folder)) return into
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue
    const path = join(folder, entry.name)
    if (entry.isDirectory()) files(path, into)
    else if (/\.(m?ts|tsx|m?js|cjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) into.push(path)
  }
  return into
}

const readers = READERS.flatMap((folder) => files(join(root, folder))).map((path) => readFileSync(path, "utf8")).join("\n")
const readForStructure = (name) => new RegExp(`\\b${name}\\s*(\\?\\.|\\.)\\s*(${STRUCTURE})\\b|\\b${name}\\s*\\[`).test(readers)

const shouldBeLazy = []
const eager = { structure: 0, described: 0, named: 0, lazy: 0 }
const used = new Set()
for (const path of PACKAGES.flatMap((name) => files(join(root, "packages", name, "src")))) {
  const text = readFileSync(path, "utf8")
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const file = relative(root, path)
  const edits = []
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) {
      const init = declaration.initializer
      if (!ts.isIdentifier(declaration.name) || !init || declaration.type || !ts.isCallExpression(init)) continue
      const value = init.getText(source)
      if (/^z\s*\.\s*lazy\s*\(/.test(value)) eager.lazy++
      if (!KINDS.test(value)) continue
      const name = declaration.name.text
      const last = ts.isPropertyAccessExpression(init.expression) ? init.expression.name.text : ""
      if (last === "describe" || last === "meta") {
        eager.described++
        continue
      }
      if (readForStructure(name)) {
        eager.structure++
        continue
      }
      const key = `${file}#${name}`
      if (key in allowlist) {
        used.add(key)
        eager.named++
        continue
      }
      shouldBeLazy.push(`${file}:${source.getLineAndCharacterOfPosition(init.getStart(source)).line + 1} ${name}`)
      edits.push([init.getStart(source), init.getEnd(), `z.lazy(() => ${value})`])
    }
  }
  if (fix && edits.length) {
    let out = text
    for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, start) + replacement + out.slice(end)
    writeFileSync(path, out)
  }
}

const stale = Object.keys(allowlist).filter((key) => !used.has(key))
if (fix) {
  console.log(`lazy schemas: ${shouldBeLazy.length} exported composites wrapped in z.lazy`)
} else if (shouldBeLazy.length || stale.length) {
  for (const where of shouldBeLazy)
    console.error(`${where}: an exported composite schema is built as its module loads. Build it on first use, \`z.lazy(() => …)\` (\`node scripts/lazy-schemas.mjs --fix\`), or name in scripts/eager-schemas.json why it stays eager.`)
  for (const key of stale) console.error(`scripts/eager-schemas.json names ${key}, which is no longer an eager exported composite: remove it.`)
  process.exit(1)
} else {
  console.log(`lazy schemas: ${eager.lazy} exported schemas built on first use; eager, ${eager.structure} read for their structure, ${eager.described} described, ${eager.named} named in scripts/eager-schemas.json`)
}
