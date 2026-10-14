import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const directory = mkdtempSync(join(tmpdir(), "host pure import % # café-"))
const checker = readFileSync(join(project, "scripts/check-host-pure-import.mjs"), "utf8")
function write(path, content) {
  const target = join(directory, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}
function check() {
  const result = spawnSync(process.execPath, ["scripts/check-host-pure-import.mjs"], {
    cwd: directory, encoding: "utf8", timeout: 30_000,
  })
  assert.equal(result.error, undefined)
  return result
}
try {
  // Only the check and its helper are copied, with a synthetic host and package.
  write("scripts/check-host-pure-import.mjs", checker)
  write("scripts/lib/host-graph.mjs", readFileSync(join(project, "scripts/lib/host-graph.mjs"), "utf8"))
  symlinkSync(join(project, "node_modules"), join(directory, "node_modules"), "dir")
  write("package.json", '{"type":"module"}')
  const programs = [...checker.matchAll(/^\s+\["([^"]+)", "/gm)].map((match) => match[1])
  assert.ok(programs.length > 0, "The fixture must include the check's program entries")
  for (const program of programs) write(`packages/host/src/${program}`, "export {}\n")
  write("packages/probe/package.json", '{"exports":{".":"./dist/index.js"}}')
  write("packages/probe/src/index.ts", "export const value = 1\n")
  write("packages/host/src/probe.ts", 'import { value } from "@mako/probe"\nexport const result = value\n')
  const pure = check()
  assert.equal(pure.status, 0, pure.stderr)
  assert.match(pure.stdout, /host pure import: 1 modules import without/)

  // Loading/transpiling is allowed; the imported module's own read is not.
  const impure = 'import { readFileSync } from "node:fs"\nexport const value = readFileSync("package.json", "utf8")\n'
  write("packages/probe/src/index.ts", impure)
  const packageRead = check()
  assert.equal(packageRead.status, 1, packageRead.stderr)
  assert.match(packageRead.stderr, /packages\/probe\/src\/index\.ts.*makes a file \(readFileSync\) call/)
  assert.doesNotMatch(packageRead.stderr, /scripts\/.*makes a file/)

  write("packages/probe/src/index.ts", "export const value = 1\n")
  write("packages/host/src/probe.ts", impure)
  const hostRead = check()
  assert.equal(hostRead.status, 1, hostRead.stderr)
  assert.match(hostRead.stderr, /packages\/host\/src\/probe\.ts.*makes a file \(readFileSync\) call/)
  assert.doesNotMatch(hostRead.stderr, /scripts\/.*makes a file/)
  console.log("host pure import: encoded checkout paths allow loader reads and reject host/package side effects")
} finally {
  rmSync(directory, { recursive: true, force: true })
}
