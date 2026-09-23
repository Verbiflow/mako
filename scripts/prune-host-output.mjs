import { readdir, access, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// Incremental TypeScript compilation leaves outputs behind when source is
// deleted. Only prune compiler-owned .js files; preload.cjs is separately built.
async function prune(relative = "") {
  const output = join(root, "dist-electron", relative)
  const entries = await readdir(output, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  for (const entry of entries) {
    const path = join(relative, entry.name)
    if (entry.isDirectory()) await prune(path)
    else if (entry.isFile() && entry.name.endsWith(".js")) {
      const source = join(root, "electron", path.replace(/\.js$/, ".ts"))
      try { await access(source) }
      catch (error) {
        if (error.code !== "ENOENT") throw error
        await rm(join(root, "dist-electron", path))
        await rm(join(root, "dist-electron", `${path}.map`), { force: true })
        console.log(`Removed obsolete host output: ${path}`)
      }
    }
  }
}
await prune()
