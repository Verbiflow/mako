import { readFileSync, writeFileSync } from "node:fs"
import ts from "typescript"
import { hostGraph } from "./lib/host-graph.mjs"

/**
 * A host keeps what it holds in what `createHost` builds, not in its modules,
 * so two hosts can run in one process and a test builds the one it needs.
 *
 * This lists, for every source file the host loads, the module-level bindings
 * that hold mutable state: a top-level `let` or `var`, and a top-level `const`
 * made with `new` (an empty Map or Set, a class's one instance) or as an empty
 * `[]` or `{}`; a collection made from its contents is a lookup table, not
 * state. It holds them to host-module-state.json: a binding may leave the
 * list, never join it.
 *
 * `--write` records the current list after state moves into a host.
 */
const recorded = "scripts/host-module-state.json"
/** Made with `new`, but never changed after: these hold no state. */
const IMMUTABLE = new Set(["RegExp", "URL", "TextEncoder", "TextDecoder", "Intl.Collator", "Intl.NumberFormat", "Intl.DateTimeFormat", "Intl.RelativeTimeFormat", "Intl.Segmenter", "Intl.ListFormat", "Intl.PluralRules", "Error", "TypeError"])
const COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet"])

function stateHeld(initializer) {
  if (!initializer) return false
  let value = initializer
  while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression
  if (ts.isNewExpression(value)) {
    const made = value.expression.getText()
    // A collection made from its contents is a lookup table; one made empty is filled as the host runs.
    if (COLLECTIONS.has(made)) return !value.arguments?.length
    return !IMMUTABLE.has(made)
  }
  if (ts.isArrayLiteralExpression(value)) return value.elements.length === 0
  if (ts.isObjectLiteralExpression(value)) return value.properties.length === 0
  return false
}

function moduleState(file) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  const names = []
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) continue
    const list = statement.declarationList
    const mutable = !(list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing))
    for (const declaration of list.declarations) {
      if (mutable || stateHeld(declaration.initializer)) names.push(declaration.name.getText(source))
    }
  }
  return names.sort()
}

const inputs = await hostGraph()
const found = Object.fromEntries(
  Object.keys(inputs)
    .filter((file) => !file.includes("node_modules/") && /\.[cm]?tsx?$/.test(file))
    .sort()
    .map((file) => [file, moduleState(file)])
    .filter(([, names]) => names.length > 0)
)

const allowed = JSON.parse(readFileSync(recorded, "utf8"))
const joined = Object.entries(found).flatMap(([file, names]) =>
  names.filter((name) => !allowed[file]?.includes(name)).map((name) => `${file}: ${name}`))
const left = Object.entries(allowed).flatMap(([file, names]) =>
  names.filter((name) => !found[file]?.includes(name)).map((name) => `${file}: ${name}`))
for (const binding of joined)
  console.error(`${binding} is module-level state. Make it in the domain's factory and pass it to what needs it; createHost builds each domain once per host.`)
if (process.argv.includes("--write")) {
  if (joined.length) process.exit(1)
  writeFileSync(recorded, JSON.stringify(found, null, 2) + "\n")
  console.log(`host module state: recorded ${Object.values(found).flat().length} bindings in ${Object.keys(found).length} files`)
  process.exit(0)
}
for (const binding of left)
  console.error(`${binding} is no longer module-level state, or the host no longer loads its file. Run \`node scripts/check-host-module-state.mjs --write\` to record the shorter list.`)
if (joined.length || left.length) process.exit(1)
console.log(`host module state: ${Object.values(found).flat().length} bindings in ${Object.keys(found).length} files, none new`)
