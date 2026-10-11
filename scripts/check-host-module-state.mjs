import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import ts from "typescript"
import { entry, hostGraph } from "./lib/host-graph.mjs"

/**
 * A host keeps what it holds in what `createHost` builds, not in its modules,
 * so two hosts can run in one process and a test builds the one it needs.
 *
 * This lists, for every source file the host loads, the module-level bindings
 * that hold mutable state: a top-level `let` or `var`, and a top-level `const`
 * made with `new` (an empty Map or Set, a class's one instance), by a
 * `create…` factory (whatever it closes over is held for the process), or as
 * an empty `[]` or `{}` its type doesn't make readonly; a collection made from
 * its contents is a lookup table, not state. A WeakMap or WeakSet isn't
 * either: each entry is a field of the object it is keyed by, lives as long
 * as that object, and is reached only through it, so it belongs to whichever
 * host holds the key. The entry is exempt: it makes the one host its process
 * runs. It holds them to host-module-state.json: a
 * binding may leave the list, never join it.
 *
 * `--write` records the current list after state moves into a host. A file
 * Git sees as moved since the last commit keeps the bindings recorded under its
 * old path, so moving a module carries its state without adding to the list.
 */
const recorded = "scripts/host-module-state.json"
/** Made with `new`, but never changed after: these hold no state. */
const IMMUTABLE = new Set(["RegExp", "URL", "TextEncoder", "TextDecoder", "Intl.Collator", "Intl.NumberFormat", "Intl.DateTimeFormat", "Intl.RelativeTimeFormat", "Intl.Segmenter", "Intl.ListFormat", "Intl.PluralRules", "Error", "TypeError"])
const COLLECTIONS = new Set(["Map", "Set"])
/** Hold fields of the objects they are keyed by, not state of their own. */
const WEAK = new Set(["WeakMap", "WeakSet"])
/** Hold nothing themselves: each async context carries its own value, so hosts in one process never see each other's. */
const CONTEXTUAL = new Set(["AsyncLocalStorage"])

/** `readonly T[]`, `ReadonlyArray<T>`, `Readonly<T>`, `ReadonlyMap`, `ReadonlySet`: the compiler refuses every change. */
function readonlyType(type) {
  if (!type) return false
  if (ts.isTypeOperatorNode(type)) return type.operator === ts.SyntaxKind.ReadonlyKeyword
  return ts.isTypeReferenceNode(type) && /^Readonly(Array|Map|Set)?$/.test(type.typeName.getText())
}

function stateHeld(declaration) {
  let value = declaration.initializer
  if (!value) return false
  while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value) || ts.isAwaitExpression(value)) value = value.expression
  if (ts.isCallExpression(value)) return /^create[A-Z]/.test(value.expression.getText().split(".").pop()) && value.expression.getText() !== "createRequire"
  if (ts.isNewExpression(value)) {
    const made = value.expression.getText()
    // A collection made from its contents is a lookup table; one made empty is filled as the host runs.
    if (COLLECTIONS.has(made)) return !value.arguments?.length
    return !IMMUTABLE.has(made) && !CONTEXTUAL.has(made) && !WEAK.has(made)
  }
  if (readonlyType(declaration.type)) return false
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
      if (mutable || stateHeld(declaration)) names.push(declaration.name.getText(source))
    }
  }
  return names.sort()
}

const inputs = await hostGraph()
const found = Object.fromEntries(
  Object.keys(inputs)
    .filter((file) => file !== entry && !file.includes("node_modules/") && /\.[cm]?tsx?$/.test(file))
    .sort()
    .map((file) => [file, moduleState(file)])
    .filter(([, names]) => names.length > 0)
)

/** Each file moved since the last commit, by its new path, to its old. */
function moves() {
  const status = execFileSync("git", ["diff", "--name-status", "-M", "HEAD"], { encoding: "utf8" })
  return new Map(status.split("\n").filter((line) => line.startsWith("R")).map((line) => {
    const [, from, to] = line.split("\t")
    return [to, from]
  }))
}

const write = process.argv.includes("--write")
const allowed = JSON.parse(readFileSync(recorded, "utf8"))
if (write) for (const [to, from] of moves()) if (allowed[from]) allowed[to] = allowed[from]
const joined = Object.entries(found).flatMap(([file, names]) =>
  names.filter((name) => !allowed[file]?.includes(name)).map((name) => `${file}: ${name}`))
const left = Object.entries(allowed).flatMap(([file, names]) =>
  names.filter((name) => !found[file]?.includes(name)).map((name) => `${file}: ${name}`))
for (const binding of joined)
  console.error(`${binding} is module-level state. Make it in the domain's factory and pass it to what needs it; createHost builds each domain once per host.`)
if (write) {
  if (joined.length) process.exit(1)
  writeFileSync(recorded, JSON.stringify(found, null, 2) + "\n")
  console.log(`host module state: recorded ${Object.values(found).flat().length} bindings in ${Object.keys(found).length} files`)
  process.exit(0)
}
for (const binding of left)
  console.error(`${binding} is no longer module-level state, or the host no longer loads its file. Run \`node scripts/check-host-module-state.mjs --write\` to record the shorter list.`)
if (joined.length || left.length) process.exit(1)
console.log(`host module state: ${Object.values(found).flat().length} bindings in ${Object.keys(found).length} files, none new`)
