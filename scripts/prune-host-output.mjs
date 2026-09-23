import { readdir, access, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// TypeScript retains outputs of deleted sources. Prune only compiler-owned
// artifacts; the separately built preload.cjs remains untouched.
async function prune(sourceRoot, outputRoot, relative = "") {
  const output = join(root, outputRoot, relative)
  const entries = await readdir(output, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return []
    throw error
  })
  for (const entry of entries) {
    const path = join(relative, entry.name)
    if (entry.isDirectory()) await prune(sourceRoot, outputRoot, path)
    else if (entry.isFile() && /(?:\.js|\.d\.ts)(?:\.map)?$/.test(entry.name)) {
      const source = join(root, sourceRoot, path.replace(/(?:\.js|\.d\.ts)(?:\.map)?$/, ".ts"))
      try { await access(source) }
      catch (error) {
        if (error.code !== "ENOENT") throw error
        await rm(join(root, outputRoot, path))
        console.log(`Removed obsolete compiler output: ${outputRoot}/${path}`)
      }
    }
  }
}
await prune("electron", "dist-electron")
for (const name of ["control", "control-runtime"])
  await prune(`packages/${name}/src`, `packages/${name}/dist`)
