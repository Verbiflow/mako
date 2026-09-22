import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const directory = join(project, "vendor", "kiri", `${process.platform}-${process.arch}`)
const filename = process.platform === "win32" ? "kiri-engine.exe" : "kiri-engine"
const destination = join(directory, filename)
const source = resolve(process.env.KIRI_SOURCE_DIR ?? join(project, "..", "kiri"))
const manifest = join(source, "Cargo.toml")
const localSource = await access(manifest).then(() => true, () => false)
const vendorManifest = join(directory, "manifest.json")
let sourceRevision
async function committedSource() {
  const options = { cwd: source, maxBuffer: 4 * 1024 * 1024 }
  const { stdout: changes } = await run("git", ["status", "--porcelain", "--untracked-files=normal"], options)
  if (changes.trim()) throw new Error("Kiri has uncommitted changes. Commit and validate them, then build from a clean worktree with KIRI_SOURCE_DIR.")
  return (await run("git", ["rev-parse", "HEAD"], options)).stdout.trim()
}
if (localSource) {
  sourceRevision = await committedSource()
  await run("cargo", ["build", "--locked", "--release", "--manifest-path", manifest, "-p", "kiri-service", "--bin", "kiri-engine"], { maxBuffer: 4 * 1024 * 1024 })
  if (await committedSource() !== sourceRevision) throw new Error("Kiri changed during compilation. Build again from the intended committed revision.")
} else {
  const previous = await readFile(vendorManifest, "utf8").then(JSON.parse, () => null)
  sourceRevision = previous?.sourceRevision
}
const candidate = localSource ? join(process.env.CARGO_TARGET_DIR ?? join(source, "target"), "release", filename) : destination
await access(candidate).catch(() => { throw new Error(`Kiri's ${process.platform}-${process.arch} engine is missing. Build with the Kiri checkout beside Mako, or supply KIRI_SOURCE_DIR to this build step.`) })
const { stdout } = await run(candidate, ["--schema"], { maxBuffer: 4 * 1024 * 1024 })
const protocol = JSON.parse(stdout)
const clientSchema = JSON.parse(await readFile(join(project, "node_modules", "@kiri", "client", "dist", "schema.json"), "utf8"))
if (protocol.version !== clientSchema.version || protocol.schema_hash !== clientSchema.schema_hash) throw new Error("Kiri's engine and Node client have different protocol versions. Update the SDK package before building Mako.")
if (localSource) {
  await mkdir(directory, { recursive: true })
  const pending = `${destination}.${process.pid}.new`
  await copyFile(candidate, pending)
  await chmod(pending, 0o755)
  await rename(pending, destination)
}
const sha256 = createHash("sha256").update(await readFile(destination)).digest("hex")
await writeFile(vendorManifest, JSON.stringify({ protocol: protocol.version, schema: protocol.schema_hash, platform: process.platform, arch: process.arch, filename, sha256, sourceRevision }))
