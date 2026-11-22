import { readFileSync, readdirSync } from "node:fs"
import { join, sep } from "node:path"
import ts from "typescript"

/**
 * Mako runs on Windows and Linux as well as a Mac, and a sentence that says "this Mac" or "your Mac" there is wrong.
 * A sentence a person or an agent reads is written in the Mac's words and passed through `localWords`
 * (`@mako/protocol/computer-words`), which says "this computer" off a Mac and changes nothing on one.
 *
 * This fails on a string, a template or JSX text that says "this Mac" or "your Mac" outside a `localWords(…)` call.
 * It leaves alone: what is written to a log (one wording on every platform, for whoever reads it); the Mac's side of `onMac() ? … : …`; a sentence that
 * is about a Mac as a Mac (it names macOS, Xcode, a simulator, the Keychain, an Apple permission); and the files in
 * `MAC_ONLY` and `NOT_YET`, each with its reason.
 */
const ROOTS = ["src", "electron", "packages"]
const SAYS = /\b(this|your) Mac\b/i
const ABOUT_A_MAC = /macOS|Xcode|[Ss]imulator|Keychain|Screen Recording|Accessibility|Safari|Apple|Gatekeeper|Finder\b/
const LOGS = /^(hostLog|hostWarn|hostError|hostDebug|console\.\w+|this\.#log|this\.#options\.log|log|warn|debug|trace|this\.log|deps\.log|this\.deps\.log|options\.log)$/

/** About Macs: simulators run on one, and these modules say so. */
const MAC_ONLY = [
  "packages/host/src/control/simulators/",
  "packages/host/src/contracts/simulators.ts",
  "src/components/settings/simulators-section.tsx",
  "packages/protocol/src/borrow-words.ts",
]
/**
 * Still in the Mac's words, to be done: the phone and browser client names a computer somewhere else, one of several
 * and of any kind, so its words need each computer's platform from the account, not this page's; `setup.ts` words
 * are said there too.
 */
const NOT_YET = ["src/web-client/", "packages/protocol/src/setup.ts"]
/** Fixtures and checks for the window, which play a Mac's host. */
const FIXTURES = ["src/dev/"]

const exempt = (path) => [...MAC_ONLY, ...NOT_YET, ...FIXTURES].some((prefix) => path.startsWith(prefix))
const paths = ROOTS.flatMap((root) => readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name).split(sep).join("/")))
  .filter((path) => !/(^|\/)(node_modules|dist|dist-electron|test)\//.test(path) && (!path.startsWith("packages/") || /^packages\/[^/]+\/src\//.test(path)) && !exempt(path))

function reworded(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    // Said only on a Mac: the branch of a question about the platform.
    if (ts.isConditionalExpression(parent) && /\bonMac\(\)|"darwin"/.test(parent.condition.getText())) return true
    if (!ts.isCallExpression(parent) && !ts.isNewExpression(parent)) continue
    const callee = parent.expression.getText()
    if (callee === "localWords" || callee === "computerWords" || LOGS.test(callee)) return true
  }
  return false
}

let violations = 0
let read = 0
for (const path of paths) {
  const text = readFileSync(path, "utf8")
  if (!SAYS.test(text)) continue
  read += 1
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visit = (node) => {
    const words = ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      ? node.text
      : ts.isTemplateExpression(node)
        ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ")
        : undefined
    if (words !== undefined && SAYS.test(words) && !ABOUT_A_MAC.test(node.getText()) && !reworded(node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart())
      console.error(`${path}:${line + 1}: says "${SAYS.exec(words)?.[0]}" for the computer Mako runs on. Pass the sentence through localWords from @mako/protocol/computer-words, or name the file in scripts/check-computer-words.mjs if it is about Macs.`)
      violations += 1
    }
    if (words === undefined || ts.isTemplateExpression(node)) ts.forEachChild(node, visit)
  }
  visit(source)
}
if (violations) process.exit(1)
console.log(`computer words: every "this Mac" and "your Mac" in ${read} files that say one is passed through localWords, is written to a log, or is about a Mac`)
