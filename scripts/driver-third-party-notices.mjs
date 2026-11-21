// The notices of every crate the control driver links on one platform, as one text file to ship beside the driver.
//
//   node scripts/driver-third-party-notices.mjs <pinned source checkout> <output file> [--target=<triple>] [--features=<list>]
//
// `--target` is the Rust target the driver was built for (x86_64-pc-windows-msvc when not given) and `--features` the
// features it was built with, so the crates listed are the ones that build links. For each (the walk the Windows
// package's licence audit makes: normal dependencies, never build scripts or tests) it writes the crate's name,
// version, licence and home, then the licence, copyright and notice files its package carries, whole. A package that
// carries none gets the standard text of each licence it names, from vendor/spdx-licenses: the SPDX licence list's
// texts at a pinned release, kept in the repository so no build needs the network for them. Cua's own crates are
// covered by Cua's licence, which ships beside this file. Cargo fetches the crates' sources if they aren't here yet.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const [source, output, ...options] = process.argv.slice(2)
assert.ok(
  source && output && options.every((option) => /^--(?:target|features)=.+$/.test(option)),
  "Usage: node scripts/driver-third-party-notices.mjs <pinned source checkout> <output file> [--target=<triple>] [--features=<list>]"
)
const option = (name) => options.find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3)
const target = option("target") ?? "x86_64-pc-windows-msvc"
const features = option("features")
const rust = join(resolve(source), "libs/cua-driver/rust")
/** The standard texts: vendor/spdx-licenses, from the SPDX licence list at the release its README names. */
const texts = fileURLToPath(new URL("../vendor/spdx-licenses/", import.meta.url))
const NOTICE_FILE = /^(?:licen[sc]e|copying|copyright|notice|unlicense|patents)(?:[-_.].*)?$/i

const metadata = JSON.parse((await run("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", target, ...(features ? ["--features", features] : [])], { cwd: rust, maxBuffer: 64 * 1024 * 1024 })).stdout)
const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]))
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
const seen = new Set()
const queue = [metadata.packages.find((entry) => entry.name === "cua-driver").id]
while (queue.length) {
  const id = queue.pop()
  if (seen.has(id)) continue
  seen.add(id)
  for (const dep of nodes.get(id)?.deps ?? []) if (dep.dep_kinds.some((kind) => kind.kind === null)) queue.push(dep.pkg)
}
const linked = [...seen].map((id) => packages.get(id)).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))
const own = linked.filter((entry) => entry.source === null)
const third = linked.filter((entry) => entry.source !== null)

/** The licence identifiers an expression names: `MIT OR Apache-2.0`, the older `MIT/Apache-2.0`, `(A AND B) WITH x`. */
const identifiers = (expression) => [...new Set(expression.split(/\s+(?:OR|AND|WITH)\s+|[/()]/i).map((part) => part.trim()).filter(Boolean))]
async function standardText(id) {
  const text = await readFile(join(texts, `${id}.txt`), "utf8").catch(() => undefined)
  assert.ok(text, `No standard text for the licence ${id}: add vendor/spdx-licenses/${id}.txt from the SPDX licence list (see its README)`)
  return text.trimEnd()
}

const rule = "=".repeat(100)
const parts = [
  `Third-party notices for Mako's control driver (cua-driver, ${target})`,
  "",
  `Mako's control driver is Cua's driver (https://github.com/trycua/cua), built from source with Mako's patch. Cua's own`,
  `licence is LICENSE-Cua.md, beside this file; it covers ${own.map((entry) => entry.name).join(", ")}.`,
  `The executable also links the ${third.length} Rust crates below. Each is listed with its licence and the licence,`,
  "copyright and notice files its package carries; where a package carries none, the standard text of its licence follows.",
  "",
]
let carried = 0
const withoutFiles = []
for (const entry of third) {
  assert.ok(entry.license || entry.license_file, `${entry.name} ${entry.version} names no licence`)
  const folder = dirname(entry.manifest_path)
  const files = (await readdir(folder)).filter((name) => NOTICE_FILE.test(name)).sort()
  parts.push(rule, `${entry.name} ${entry.version}`, `Licence: ${entry.license ?? `see ${entry.license_file}`}`)
  if (entry.repository ?? entry.homepage) parts.push(`Home: ${entry.repository ?? entry.homepage}`)
  if (entry.authors?.length) parts.push(`Authors: ${entry.authors.join(", ")}`)
  parts.push(rule, "")
  for (const name of files) {
    parts.push(`--- ${name} ---`, "", (await readFile(join(folder, name), "utf8")).replaceAll("\r\n", "\n").trimEnd(), "")
    carried++
  }
  if (!files.length) {
    assert.ok(entry.license, `${entry.name} ${entry.version} carries no licence file and names no licence`)
    withoutFiles.push(`${entry.name} ${entry.version}`)
    for (const id of identifiers(entry.license)) parts.push(`--- ${id}, the licence's standard text ---`, "", await standardText(id), "")
  }
}
await writeFile(resolve(output), `${parts.join("\n")}\n`)
console.log(`third-party notices (${target}): ${third.length} crates, ${carried} files from their packages, ${withoutFiles.length} given their licence's standard text${withoutFiles.length ? ` (${withoutFiles.join(", ")})` : ""}`)
