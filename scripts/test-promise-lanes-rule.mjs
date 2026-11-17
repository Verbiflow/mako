import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"

/**
 * The `mako/no-bare-promise-lanes` lint rule against a small repository of its own: a pool of lanes under Promise.all,
 * named or written in place, is refused; parallel calls that pull no shared work, and the one helper, pass.
 */
const root = resolve(import.meta.dirname, "..")
const scratch = await mkdtemp(join(tmpdir(), "mako-promise-lanes-"))
const files = {
  "packages/a/src/pools.ts": [
    "const items = [1, 2, 3]",
    "let next = 0",
    "const lane = async () => { while (next < items.length) await work(items[next++]!) }",
    "await Promise.all(Array.from({ length: Math.min(4, items.length) }, lane))",
    "await Promise.all(Array.from({ length: 4 }, async () => { for (const item of items.values()) await work(item) }))",
    "await Promise.allSettled(Array.from({ length: 2 }, async function () { do { await work(1) } while (next++ < 3) }))",
    "const times = await Promise.all(Array.from({ length: 30 }, (_, index) => work(index)))",
    "await Promise.all(Array.from({ length: 3 }, async () => { const each = [1].map(async (n) => { for (;;) return n }); await Promise.all(each) }))",
    "await Promise.all(items.map(work))",
    "await Promise.all(Array.from({ length: 3 }, async (_, slot) => { for (let round = 0; round < 3; round++) await work(slot) }))",
    "async function work(value: number) { return value }",
    "export { times }",
  ].join("\n"),
  "packages/protocol/src/map-limit.ts": [
    "export async function mapLimit(values: number[], limit: number) {",
    "  const worker = async () => { while (values.length) values.pop() }",
    "  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))",
    "}",
  ].join("\n"),
  ".oxlintrc.json": JSON.stringify({
    jsPlugins: [{ name: "mako", specifier: join(root, "tools/oxlint/mako/index.ts") }],
    rules: { "mako/no-bare-promise-lanes": "error" },
  }),
}
try {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(scratch, path)), { recursive: true })
    await writeFile(join(scratch, path), contents)
  }
  const { stdout } = await promisify(execFile)(join(root, "node_modules/.bin/oxlint"), ["--config", ".oxlintrc.json", "--format", "json", "packages"], { cwd: scratch }).catch((error) => error)
  const found = JSON.parse(stdout).diagnostics
    .filter((diagnostic) => diagnostic.code === "mako(no-bare-promise-lanes)")
    .map((diagnostic) => `${diagnostic.filename}:${diagnostic.labels[0].span.line}`)
    .sort()
  assert.deepEqual(found, ["packages/a/src/pools.ts:4", "packages/a/src/pools.ts:5", "packages/a/src/pools.ts:6"])
  console.log(`PASS: mako/no-bare-promise-lanes refuses ${found.length} hand-written lane pools and allows parallel calls and mapLimit itself`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
