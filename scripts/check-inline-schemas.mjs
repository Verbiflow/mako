// A zod schema built inside a function and parsed there is compiled again on every call (zod compiles each new schema),
// on whatever thread runs it: a live batch read that way built two schemas a batch on the host's loop.
// `anti-slop/no-inline-schema-parse` finds them; this holds each file to the count in `scripts/inline-schemas-baseline.json`,
// so none is added and the ones there go as their files are touched.
//   node scripts/check-inline-schemas.mjs            check
//   node scripts/check-inline-schemas.mjs --update   lower the baseline to the counts as they stand; it never raises one
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BASELINE = "scripts/inline-schemas-baseline.json"
const PATHS = ["src", "electron", "browser-extension", "packages/sessions/src", "packages/git/src", "packages/protocol/src", "packages/control/src", "packages/lazy/src", "packages/control-runtime/src", "packages/host/src", "packages/client/src", "scripts"]
const CONFIG = "oxlint.inline-schemas.config.ts"

function hits(paths) {
  let out
  try {
    out = execFileSync("npx", ["oxlint", "--config", CONFIG, "--format", "json", ...paths], { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] })
  } catch (error) {
    // oxlint exits 1 when it reports anything: its JSON is still on stdout.
    out = error.stdout
  }
  const counts = new Map()
  for (const diagnostic of JSON.parse(out).diagnostics) counts.set(diagnostic.filename, (counts.get(diagnostic.filename) ?? 0) + 1)
  return counts
}

// The rule itself: a schema built in a function is found, one made once at module scope isn't.
const fixtures = mkdtempSync(join(tmpdir(), "inline-schemas-"))
try {
  // Each of these builds a schema in a function and parses with it: in place, through a local, under zod's own name.
  writeFileSync(join(fixtures, "inline.ts"), `import { z } from "zod"\nexport function read(value: string) {\n  return z.object({ a: z.string() }).loose().safeParse(JSON.parse(value))\n}\n`)
  writeFileSync(join(fixtures, "local.ts"), `import { z } from "zod"\nexport function read(value: string) {\n  const Read = z.object({ a: z.string() })\n  return Read.parse(JSON.parse(value))\n}\n`)
  writeFileSync(join(fixtures, "namespace.ts"), `import * as zod from "zod"\nexport const read = (value: unknown) => zod.string().safeParse(value)\n`)
  // None of these does: made once at module scope, or something else with a parse method.
  writeFileSync(join(fixtures, "once.ts"), `import { z } from "zod"\nconst Read = z.object({ a: z.string() }).loose()\nexport const parsed = z.object({ a: z.string() }).parse({ a: "" })\nexport function read(value: string) {\n  const json = JSON\n  return Read.safeParse(json.parse(value))\n}\nexport function lines(texts: string[]) {\n  const Line = z.object({ a: z.string() })\n  return texts.map((text) => Line.parse(JSON.parse(text)))\n}\n`)
  const found = hits([fixtures])
  const expected = { "inline.ts": 1, "local.ts": 1, "namespace.ts": 1 }
  if (Object.entries(expected).some(([file, count]) => found.get(join(fixtures, file)) !== count) || found.has(join(fixtures, "once.ts"))) {
    console.error(`check-inline-schemas: the rule misread its fixtures (${JSON.stringify([...found])})`)
    process.exit(1)
  }
} finally {
  rmSync(fixtures, { recursive: true, force: true })
}

const counts = hits(PATHS)
const baseline = new Map(Object.entries(JSON.parse(readFileSync(BASELINE, "utf8"))))
const over = [...counts].filter(([file, count]) => count > (baseline.get(file) ?? 0))
if (process.argv.includes("--update")) {
  // The baseline only goes down: a file over its count, or a new one, is to be fixed, never written in.
  if (over.length) {
    for (const [file, count] of over) console.error(`${file}: ${count}, baseline ${baseline.get(file) ?? 0}; --update only lowers counts. Make the schema once at module scope.`)
    process.exit(1)
  }
  const lowered = Object.fromEntries([...baseline].flatMap(([file, count]) => {
    const now = Math.min(count, counts.get(file) ?? 0)
    return now ? [[file, now]] : []
  }).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(BASELINE, `${JSON.stringify(lowered, null, 2)}\n`)
  console.log(`inline schemas: baseline lowered to ${Object.values(lowered).reduce((sum, count) => sum + count, 0)} in ${Object.keys(lowered).length} files`)
  process.exit(0)
}
const under = [...baseline].filter(([file, count]) => (counts.get(file) ?? 0) < count)
if (over.length) {
  for (const [file, count] of over) console.error(`${file}: ${count} zod schemas built inside a function and parsed there, baseline ${baseline.get(file) ?? 0}. Make each once at module scope.`)
  process.exit(1)
}
const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
console.log(`inline schemas: ${total}, none over the baseline${under.length ? `; ${under.length} files under it (lower it: node scripts/check-inline-schemas.mjs --update)` : ""}`)
