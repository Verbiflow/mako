import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tsgo = resolve(root, "node_modules/@typescript/native-preview/bin/tsgo")
const config = JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf8"))
const references = config.references.map((reference) => reference.path)
// Emit workspace declarations before checking their consumers. Each compiler exits
// before the next starts, releasing its program graph rather than retaining it in -b.
const projects = [
  ...references.filter((path) => path.startsWith("./packages/")),
  ...references.filter((path) => !path.startsWith("./packages/")),
  "./browser-extension/tsconfig.json",
]
for (const project of projects) {
  console.log(`Typecheck ${project}`)
  const result = spawnSync(process.execPath, [tsgo, "--project", project], {
    cwd: root,
    stdio: "inherit",
    timeout: 120_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log("All TypeScript projects passed in separate bounded processes")
