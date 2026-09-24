import { cp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** Freeze only built package files; a dev watcher must not change a live acceptance job. */
export async function snapshotControlRuntime(directory) {
  const root = join(directory, "control-runtime-snapshot")
  const repo = fileURLToPath(new URL("../../", import.meta.url))
  const dependencies = new Set()
  for (const name of ["control", "control-runtime"]) {
    const source = join(repo, "packages", name),
      target = join(root, "node_modules", "@mako", name)
    const manifest = JSON.parse(
      await readFile(join(source, "package.json"), "utf8")
    )
    await mkdir(target, { recursive: true, mode: 0o700 })
    await cp(join(source, "dist"), join(target, "dist"), { recursive: true })
    await writeFile(join(target, "package.json"), JSON.stringify(manifest))
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      if (!dependency.startsWith("@mako/")) dependencies.add(dependency)
  }
  for (const dependency of dependencies) {
    const target = join(root, "node_modules", dependency)
    await mkdir(dirname(target), { recursive: true })
    // Resolve from the repository's declared installation. Never copy credentials or profiles.
    const path = join(repo, "node_modules", dependency)
    if (!(await stat(path)).isDirectory())
      throw new Error(`Missing installed dependency: ${dependency}`)
    await symlink(path, target, "dir")
  }
  return import(
    pathToFileURL(
      join(root, "node_modules/@mako/control-runtime/dist/session.js")
    ).href
  )
}
