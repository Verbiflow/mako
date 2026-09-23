import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tsgo = resolve(root, "node_modules/@typescript/native-preview/bin/tsgo")
const vite = resolve(root, "node_modules/vite/bin/vite.js")
const npm = process.platform === "win32" ? "npm.cmd" : "npm"

/**
 * The shared packages emit first because everything downstream reads their
 * declarations: tsgo -b builds independent projects concurrently, so the
 * electron host and the browser extension can otherwise be checked before
 * the package dist directories exist (TS2307 on a clean tree). Once that gate lands, the
 * remaining tsgo -b covers electron plus both noEmit projects, and vite, the
 * extension, kiri and the preload bundle run alongside it. Each lane prefixes
 * its output so interleaved logs stay attributable; every lane runs to
 * completion so one failure does not hide another's diagnostics.
 */
function lane(name, command, args) {
  return new Promise((resolveLane, reject) => {
    const child = spawn(command, args, { cwd: root })
    const tag = `[${name}]`
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk.toString().split("\n").join(`\n${tag} `))
    })
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk.toString().split("\n").join(`\n${tag} `))
    })
    child.on("error", reject)
    child.on("exit", (code) => (code === 0 ? resolveLane() : reject(new Error(`${name} exited ${code}`))))
  })
}

await lane("prune", process.execPath, ["scripts/prune-host-output.mjs"])

await lane("packages", process.execPath, [tsgo, "-b", "packages/sessions", "packages/relay", "packages/control"])

await lane("control-runtime", process.execPath, [tsgo, "-b", "packages/control-runtime"])

const lanes = await Promise.allSettled([
  lane("tsgo", process.execPath, [tsgo, "-b"]).then(() =>
    lane("native-observers", process.execPath, ["scripts/build-native-observers.mjs"])
  ),
  lane("kiri+preload", process.execPath, ["scripts/prepare-kiri.mjs"]).then(() =>
    lane("preload", process.execPath, ["scripts/build-preload.mjs"])
  ),
  lane("browser-ext", npm, ["run", "build:browser-extension"]),
  lane("vite", process.execPath, [vite, "build"]),
])

const failed = lanes.filter((result) => result.status === "rejected")
if (failed.length > 0) {
  for (const failure of failed) console.error(failure.reason.message)
  process.exit(1)
}
