import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

/**
 * A toast that offers an action (Retry, Refresh changes) must stay long
 * enough to read and act on, so it carries `ACTION_TOAST_MS` explicitly rather
 * than the Toaster's three-second receipt default. It must also leave: a
 * toast with `duration: Infinity` once sat in the corner for a whole session,
 * and the failure it reported lives on in the transcript or the panel anyway.
 */
const paths = readdirSync("src", { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name))
let violations = 0
for (const path of paths) {
  const text = readFileSync(path, "utf8")
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const target = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.expression
        : node.expression
      const options = node.arguments[1]
      if (
        ts.isIdentifier(target) &&
        target.text === "toast" &&
        options &&
        ts.isObjectLiteralExpression(options)
      ) {
        const properties = options.properties.filter(ts.isPropertyAssignment)
        const named = (name) =>
          properties.find(
            (property) =>
              (ts.isIdentifier(property.name) ||
                ts.isStringLiteral(property.name)) &&
              property.name.text === name
          )
        const duration = named("duration")
        const durationText = duration?.initializer.getText(source)
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        if (durationText === "Infinity") {
          violations++
          console.error(`${path}:${line}: no toast stays forever; use ACTION_TOAST_MS`)
        } else if (named("action") && durationText !== "ACTION_TOAST_MS") {
          violations++
          console.error(
            `${path}:${line}: actionable toasts must carry duration: ACTION_TOAST_MS`
          )
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
if (violations) process.exitCode = 1
else console.log("Actionable toasts stay long enough to act on, and none stays forever")
