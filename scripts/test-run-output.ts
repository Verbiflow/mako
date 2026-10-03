import assert from "node:assert/strict"
import { OUTPUT_BUDGET, cleanOutput, presentOutput } from "../electron/run-output.ts"

// Colour codes, in-place redraws and back-to-back repeats go; every other line stays, in order.
assert.equal(
  cleanOutput("\u001b[32m✓ ok\u001b[39m\r\n 10%\r 55%\r100%\nwarn: x\nwarn: x\nwarn: x\n\n\n\nsrc/a.ts:3:1 error TS2322\u0007   \n"),
  "✓ ok\n100%\nwarn: x  [repeated 3 times]\n\nsrc/a.ts:3:1 error TS2322",
)
assert.equal(presentOutput("", "/tmp/run.log"), "(no output)")

// Output that fits is returned whole.
const short = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n")
assert.equal(presentOutput(short, "/tmp/run.log"), short)

// Longer output keeps every error with its surroundings and the run's end, marks each gap, and names the whole log.
const long = Array.from({ length: 10_000 }, (_, index) =>
  index === 1_234 ? "src/app.ts:12:5 - error TS2345: wrong type" : index === 5_000 ? "FAIL test/b.test.ts" : `passed case ${index}`,
).join("\n")
const shown = presentOutput(long, "/tmp/run.log")
const lines = shown.split("\n")
assert.match(lines[0]!, /^10000 lines of output; shown are every line naming an error .* All of it is in \/tmp\/run\.log\.$/)
assert.ok(shown.includes("passed case 1232\npassed case 1233\nsrc/app.ts:12:5 - error TS2345: wrong type\npassed case 1235\npassed case 1236"))
assert.ok(shown.includes("FAIL test/b.test.ts"))
assert.ok(shown.includes("[1232 lines with no error left out]"))
assert.ok(shown.endsWith("passed case 9999"))
assert.ok(lines.length < 300)

// More errors than a reply holds: the first ones, and how many more are in the log.
const errors = Array.from({ length: 50_000 }, (_, index) => `src/f${index}.ts:1:1 error TS1005`).join("\n")
const capped = presentOutput(errors, "/tmp/run.log")
assert.match(capped.split("\n")[0]!, /^50000 lines of output, more errors than fit in a reply: these are the first; \d+ more lines naming errors or the run's end are in \/tmp\/run\.log\.$/)
assert.ok(capped.length <= OUTPUT_BUDGET.chars + 400)

// A smaller budget, as when failed steps share one reply, holds to its share and still ends with the run's end.
const share = { lines: Math.floor(OUTPUT_BUDGET.lines / 3), chars: Math.floor(OUTPUT_BUDGET.chars / 3) }
const shared = presentOutput(long, "/tmp/step.log", share)
assert.ok(shared.split("\n").length <= share.lines + 2 && shared.length <= share.chars + 400, `${shared.split("\n").length} lines, ${shared.length} characters`)
assert.ok(shared.includes("src/app.ts:12:5 - error TS2345: wrong type") && shared.endsWith("passed case 9999"))

console.log("Run output: noise removed, whole output when it fits, errors and the end kept when it doesn't, with the log named, within a smaller share too")
