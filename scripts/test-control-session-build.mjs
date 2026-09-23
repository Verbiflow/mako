import assert from "node:assert/strict"
import { build } from "esbuild"
import { readFile, readdir } from "node:fs/promises"
import {
  controlSessionBuild,
} from "../packages/control-runtime/dist/control-session-protocol.js"
const packageRoot = "packages/control-runtime/"
const manifest = JSON.parse(await readFile(`${packageRoot}package.json`, "utf8"))
const graph = await build({
  entryPoints: [...Object.values(manifest.exports).map(path => packageRoot + path), `${packageRoot}dist/cloud-control-worker.js`],
  outdir: "/unused",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  write: false,
  metafile: true,
  logLevel: "silent",
})
const files = await readdir(`${packageRoot}dist`, {recursive:true})
for (const [path, entry] of Object.entries(graph.metafile.inputs)) {
  assert.ok(path.startsWith(`${packageRoot}dist/`), `Runtime escaped its package: ${path}`)
  assert.ok(files.includes(path.slice(`${packageRoot}dist/`.length)))
  for (const imported of entry.imports) {
    if (!imported.external || imported.path.startsWith("node:")) continue
    const name = imported.path.startsWith("@") ? imported.path.split("/").slice(0,2).join("/") : imported.path.split("/")[0]
    assert.ok(manifest.dependencies[name], `Undeclared runtime dependency: ${imported.path}`)
  }
}
assert.match(await controlSessionBuild(), /^[a-f0-9]{64}$/)
assert.equal(await controlSessionBuild(), await controlSessionBuild())
console.log(
  "Control session identity covers the complete runtime package and core worker; all public/worker imports stay inside declared boundaries"
)
