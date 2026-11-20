import assert from "node:assert/strict"
import { lstatSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * What the host's production install carries that no process ever loads,
 * taken out of it in the image's own layer: type declarations and their maps,
 * source maps (the host runs without --enable-source-maps), TypeScript sources
 * (Node refuses to strip types under node_modules, so none of them can run;
 * the workspace packages carry only what they compiled) and incremental build
 * info. Everything that can execute stays, licences and
 * notices with it. Walks real folders only: the workspace links under
 * node_modules/@mako lead into packages/, which is walked once as itself.
 *
 *   node prune-install.mjs <install root>
 */
const [root] = process.argv.slice(2)
assert.ok(root, "Pass the install root, the folder holding node_modules")
/** TypeScript (declarations included), a script's, stylesheet's or declaration's source map, and build info: never a data file that happens to end in `.map`. */
const unused = /\.(?:[cm]?ts|(?:[cm]?js|css|d\.[cm]?ts)\.map|tsbuildinfo)$/
let files = 0
let bytes = 0

function prune(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) prune(path)
    else if (entry.isFile() && unused.test(entry.name)) {
      bytes += lstatSync(path).size
      rmSync(path)
      files++
    }
  }
}

for (const folder of ["node_modules", "packages"]) prune(resolve(root, folder))
console.log(`prune-install: removed ${files} files, ${(bytes / 2 ** 20).toFixed(1)} MB, that nothing loads`)
