import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import ts from "typescript"

/**
 * How the parts of @mako/host may reach each other, so each can be read,
 * tested and loaded on its own:
 *
 *   - `contracts/` imports only itself: the wire, which every client reads.
 *   - `base/` imports itself and the contracts: what every domain stands on.
 *   - A domain, `<name>/`, imports itself, the base and the contracts, and
 *     another domain only through that domain's entry, `<other>/index.ts`.
 *   - Files directly in `src/` compose the host and may import any entry;
 *     nothing in the package imports them.
 *
 * Every import counts, type-only ones included, and the package reaches its
 * own files by relative path, never by its own name.
 */
const source = resolve("packages/host/src")
const area = (file) => {
  const path = relative(source, file).split(sep)
  return path.length === 1 ? "composition" : path[0]
}
const shared = { contracts: ["contracts"], base: ["base", "contracts"] }

const files = (await readdir(source, { recursive: true }))
  .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
  .map((name) => join(source, name))
const failures = []
for (const file of files) {
  const from = area(file)
  const shown = relative(".", file)
  const { importedFiles } = ts.preProcessFile(await readFile(file, "utf8"), true, true)
  for (const { fileName } of importedFiles) {
    if (fileName === "@mako/host" || fileName.startsWith("@mako/host/")) {
      failures.push(`${shown} imports ${fileName}. Inside @mako/host, import the file by its relative path.`)
      continue
    }
    if (!fileName.startsWith(".")) continue
    const target = resolve(dirname(file), fileName).replace(/\.js$/, ".ts")
    if (!target.startsWith(source + sep)) {
      failures.push(`${shown} imports ${fileName}, outside @mako/host. The package depends only on itself and on packages.`)
      continue
    }
    const to = area(target)
    if (to === from) continue
    if (to === "composition") {
      failures.push(`${shown} imports ${relative(".", target)}, which composes the host. Take what it needs as a dependency instead.`)
      continue
    }
    if (from === "composition") {
      if (to in shared || relative(source, target) === join(to, "index.ts")) continue
      failures.push(`${shown} imports ${relative(".", target)}. The host reaches a domain through its entry, ${to}/index.ts.`)
      continue
    }
    const allowed = shared[from] ?? ["base", "contracts"]
    if (allowed.includes(to)) continue
    if (from in shared)
      failures.push(`${shown} imports ${relative(".", target)}. ${from}/ imports only ${allowed.join(" and ")}: what every domain stands on reaches into none.`)
    else if (relative(source, target) !== join(to, "index.ts"))
      failures.push(`${shown} imports ${relative(".", target)}. A domain reaches another only through its entry, ${to}/index.ts; declare what ${from} needs from ${to} there.`)
  }
}
for (const failure of failures) console.error(failure)
if (failures.length) process.exit(1)
const areas = new Set(files.map(area))
console.log(`host boundaries: ${files.length} files in ${areas.size} parts (${[...areas].sort().join(", ")}), each reaching the others only as allowed`)
