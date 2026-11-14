import { relative, resolve, sep } from "node:path"
import ts from "typescript"

/**
 * A write to a child's stdin that the child is gone for fails with EPIPE, which the stream reports as an `'error'`
 * event, and an IPC send without a callback reports a closed channel as an `'error'` on the child. One nobody listens
 * for ends the process: the Cursor SDK's client took a host down so, as discovery had (#510).
 *
 * The host and the sessions daemon reach a child's stdin and IPC channel only through `@mako/sessions/child-input`,
 * which listens for the error and fails the write's own caller. This fails on any other use of a child's `stdin` but
 * reading its state or listening to it (a write, an end, a pipe into it, handing it on), on a destructured `stdin`, and
 * on a child's `send`. `@mako/git` and `@mako/control-runtime` can't import `@mako/sessions`, so there a child's stdin
 * may be written (a write, an end, a cork, handed to a call) where the same file listens for the `'error'` of the stdin
 * of a child by that name (`child.stdin.on("error", …)` for `this.child.stdin.write`), or hands it to `pipeline`,
 * which listens itself; and a `send` must pass its callback. That rule goes by name inside a file, so it's weaker
 * than the helper's: a file listening on one `child` covers another of the same name.
 *
 * What's a child's is the type checker's word: a `stdin` or `send` Node declares on `ChildProcess`, however the child
 * was typed (`Pick<ChildProcess, "stdin">` included), never a name.
 */

const root = resolve(".")
const HELPER = "packages/sessions/src/child-input.ts"
const STRICT = ["packages/host", "packages/sessions"]
const PAIRED = ["packages/git", "packages/control-runtime"]
/** What reads a stream's state or listens to it, and writes nothing. */
const READS = new Set(["destroyed", "writable", "writableEnded", "writableFinished", "writableLength", "writableNeedDrain", "closed", "errored", "on", "once", "off", "addListener", "removeListener", "removeAllListeners", "listenerCount", "destroy", "ref", "unref"])

const files = [...STRICT, ...PAIRED].flatMap((pkg) => {
  const config = ts.getParsedCommandLineOfConfigFile(`${pkg}/tsconfig.json`, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
  if (!config) throw new Error(`${pkg}/tsconfig.json doesn't parse`)
  return config.fileNames
})
const config = ts.getParsedCommandLineOfConfigFile("packages/host/tsconfig.json", {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
const program = ts.createProgram({ rootNames: files, options: { ...config.options, noEmit: true, composite: false, declaration: false, declarationMap: false } })
const checker = program.getTypeChecker()

/** Whether `name`'s symbol is one Node declares on a child process. */
function childMember(name) {
  const symbol = checker.getSymbolAtLocation(name)
  const declarations = symbol?.declarations ?? (symbol && checker.getAliasedSymbol?.(symbol)?.declarations) ?? []
  return declarations.some((declaration) => declaration.getSourceFile().fileName.split(sep).join("/").endsWith("@types/node/child_process.d.ts"))
}

function unwrap(node) {
  let current = node
  while (ts.isNonNullExpression(current.parent) || ts.isParenthesizedExpression(current.parent)) current = current.parent
  return current
}

/** The name of the child whose stdin `use` reads: `child` for `child.stdin` and `this.child.stdin`. */
function childName(use) {
  const owner = use.expression
  return ts.isPropertyAccessExpression(owner) ? owner.name.text : owner.getText().replace(/[!?]/g, "")
}

/** The children, by name, whose stdin's `'error'` something in `file` listens for. */
function listenedIn(file) {
  const names = new Set()
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["on", "once"].includes(node.expression.name.text)) {
      const [event] = node.arguments
      let stdin = node.expression.expression
      while (ts.isNonNullExpression(stdin) || ts.isParenthesizedExpression(stdin)) stdin = stdin.expression
      if (event && ts.isStringLiteral(event) && event.text === "error" && ts.isPropertyAccessExpression(stdin) && stdin.name.text === "stdin" && childMember(stdin.name))
        names.add(childName(stdin))
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return names
}

/** Whether `use`, a child's stdin, is written: a write, an end or a cork on it, or handed to a call. */
function written(use) {
  const parent = use.parent
  if (ts.isPropertyAccessExpression(parent) && parent.expression === use) return ["write", "end", "cork", "uncork", "pipe"].includes(parent.name.text)
  return ts.isCallExpression(parent) && parent.arguments.includes(use)
}

const problems = []
for (const file of program.getSourceFiles()) {
  const path = relative(root, file.fileName).split(sep).join("/")
  const strict = STRICT.some((pkg) => path.startsWith(`${pkg}/src/`))
  const paired = PAIRED.some((pkg) => path.startsWith(`${pkg}/src/`))
  if ((!strict && !paired) || path === HELPER) continue
  const listened = paired ? listenedIn(file) : new Set()
  const report = (node, what) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart())
    problems.push(`${path}:${line + 1}: ${what}`)
  }
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "stdin" && childMember(node.name)) {
      const use = unwrap(node)
      const parent = use.parent
      const reads = ts.isPropertyAccessExpression(parent) && parent.expression === use && READS.has(parent.name.text)
      if (strict && !reads) report(node, `a child's stdin used outside @mako/sessions/child-input (write it with writeChildInput or endChildInput, or hand on childInput(child))`)
      if (paired && written(use) && !listened.has(childName(node))) {
        const piped = ts.isCallExpression(parent) && parent.expression.getText() === "pipeline"
        if (!piped) report(node, `a child's stdin written where nothing in this file listens for the 'error' of ${childName(node)}.stdin`)
      }
    }
    if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText() === "stdin" && strict) {
      const name = node.propertyName ?? node.name
      if (ts.isIdentifier(name)) {
        const type = checker.getTypeAtLocation(node.parent)
        const property = type.getProperty("stdin")
        if (property?.declarations?.some((declaration) => declaration.getSourceFile().fileName.split(sep).join("/").endsWith("@types/node/child_process.d.ts")))
          report(node, "a child's stdin destructured outside @mako/sessions/child-input")
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "send" && childMember(node.expression.name)) {
      const last = node.arguments.at(-1)
      const called = node.arguments.length > 1 && last && (ts.isArrowFunction(last) || ts.isFunctionExpression(last))
      if (strict) report(node, "a child's IPC send outside @mako/sessions/child-input (use sendToChild)")
      else if (!called) report(node, "a child's IPC send without a callback, whose failure is an 'error' nobody may hear")
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}

if (problems.length) {
  console.error(`Writes to a child process that a gone child would turn into an unheard 'error':\n${problems.map((problem) => `  ${problem}`).join("\n")}`)
  process.exit(1)
}
console.log(`check-child-input: every child's stdin and IPC channel in ${STRICT.concat(PAIRED).join(", ")} is reached safely`)
