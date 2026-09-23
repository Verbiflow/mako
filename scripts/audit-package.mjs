import assert from "node:assert/strict"
import { readdir, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { extractFile, listPackage } from "@electron/asar"

/** Check the actual distributable, not node_modules or compressed estimates. */
export async function auditPackage(app, target, output) {
  assert.match(target, /^(darwin|linux|win32)-(arm64|x64)$/)
  const resources = join(app, target.startsWith("darwin-") ? "Contents/Resources" : "resources")
  const archive = join(resources, "app.asar")
  const files = listPackage(archive).map((path) => path.replace(/^\//, ""))
  const roots = new Set(["dist", "dist-electron", "dist-browser-extension", "mako-icons", "node_modules", "package.json"])
  assert.deepEqual(files.filter((path) => !roots.has(path.split("/")[0])), [], "Unexpected repository files in app archive")
  const unwanted = files.filter((path) =>
    /(^|\/)(__pycache__|\.git)(\/|$)|\.py[co]$|\.map$/.test(path) ||
    path.startsWith("node_modules/@trycua/") ||
    /node_modules\/@(?:anthropic-ai\/claude-agent-sdk|cursor\/sdk|esbuild|img\/sharp(?:-libvips)?)-?(?:\/)?(?:darwin|linux|win32)-/.test(path) &&
      !path.includes(target)
  )
  assert.deepEqual(unwanted, [], "Package contains stale, development, or wrong-target files")
  const pkg = JSON.parse(extractFile(archive, "package.json"))
  assert.ok(!pkg.dependencies?.["@trycua/cua-driver"], "Obsolete in-process driver dependency")
  const entries = []
  async function walk(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(relative, entry.name)
      if (entry.isDirectory()) await walk(join(directory, entry.name), path)
      else if (entry.isFile()) entries.push({ path, bytes: (await stat(join(directory, entry.name))).size })
    }
  }
  await walk(app)
  const generated = entries.filter(({ path }) => /(^|\/)(__pycache__|\.git)(\/|$)|\.py[co]$/.test(path))
  assert.deepEqual(generated, [], "Generated development files leaked into the bundle")
  for (const name of ["ffmpeg", "ffprobe"]) {
    const binary = join(resources, "control-media", target, name)
    assert.ok((await stat(binary)).isFile(), `Missing recording executable for ${target}: ${name}`)
  }
  const report = { target, app, bytes: entries.reduce((sum, file) => sum + file.bytes, 0), files: entries.length, largest: entries.sort((a, b) => b.bytes - a.bytes).slice(0, 25) }
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + "\n")
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2] && process.argv[3], "Usage: node scripts/audit-package.mjs <app> <platform-arch> [report.json]")
  console.log(JSON.stringify(await auditPackage(resolve(process.argv[2]), process.argv[3], process.argv[4]), null, 2))
}
