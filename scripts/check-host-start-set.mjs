import { readFileSync, writeFileSync } from "node:fs"
import { chainTo, hostGraph, packagesLoadedBy, staticallyLoaded } from "./lib/host-graph.mjs"

/**
 * What the host loads before it can answer: every file reached from
 * electron/main.ts by static imports, and the packages they import, including
 * those other packages pull in.
 *
 * The `mako/heavy-packages` lint rule keeps Mako's own modules from importing
 * a heavy package, or an adapter built on one, except through its lazy
 * declaration. This check covers what that rule can't see from one file: a
 * light package that imports a heavy one, and the path as a whole. Packages
 * other than heavy ones are held to host-start-packages.json, so one joining
 * the path is a reviewed change to that list, never a side effect of an
 * import. `--write` records the path's packages as they are.
 */
const recorded = "scripts/host-start-packages.json"
const heavy = JSON.parse(readFileSync("scripts/heavy-packages.json", "utf8")).packages
/** A name ending in `/` stands for every package of that scope. */
const isHeavy = (name) => heavy.some((rule) => rule.endsWith("/") ? name.startsWith(rule) : rule === name)

const inputs = await hostGraph()
const parent = staticallyLoaded(inputs)
const packages = new Map()
for (const file of parent.keys())
  if (!file.includes("node_modules/") && inputs[file]?.imports.some((item) => item.external && !/^(\.|node:)/.test(item.path)))
    for (const name of packagesLoadedBy(file)) if (!packages.has(name)) packages.set(name, file)

let failed = false
for (const [name, file] of packages)
  if (isHeavy(name)) {
    failed = true
    console.error(`${name} loads with the host, through ${chainTo(parent, file)}. Load it where it's used through its declaration in electron/heavy-packages.ts; if a package on that path imports it, declare that package in scripts/heavy-packages.json and load it the same way.`)
  }
const light = [...packages.keys()].filter((name) => !isHeavy(name)).sort()
if (process.argv.includes("--write")) {
  if (failed) process.exit(1)
  writeFileSync(recorded, JSON.stringify(light, null, 2) + "\n")
  console.log(`host start set: recorded ${light.length} packages over ${parent.size} files`)
  process.exit(0)
}
const allowed = new Set(JSON.parse(readFileSync(recorded, "utf8")))
for (const name of light.filter((name) => !allowed.has(name))) {
  failed = true
  console.error(`${name} joined what the host loads at start, through ${chainTo(parent, packages.get(name))}. Load it where it's used, through a declaration in electron/heavy-packages.ts if it's heavy; if the host can't answer without it, record it with \`node scripts/check-host-start-set.mjs --write\`.`)
}
for (const name of [...allowed].filter((name) => !light.includes(name))) {
  failed = true
  console.error(`${name} no longer loads with the host. Run \`node scripts/check-host-start-set.mjs --write\` to record the shorter list.`)
}
if (failed) process.exit(1)
console.log(`host start set: ${parent.size} files, ${light.length} packages, no heavy package`)
