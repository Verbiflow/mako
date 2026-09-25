// No image builds/pulls or credential mounts. Uses explicitly staged upstream
// artifacts in an ignored cache; media/input never reaches the user's desktop.
import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const execute = promisify(execFile)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const cache = resolve(process.env.MAKO_STREAMING_CACHE ?? join(repo, "node_modules/.cache/mako-streaming-prototype"))
const mode = process.argv[2], output = resolve(process.argv[3] ?? "")
assert.ok(["capture420", "capture444", "websockets", "webrtc"].includes(mode))
assert.ok(process.argv[3], "Supply an empty evidence directory")
await mkdir(output, { recursive: false })
const wheel = join(cache, "pixelflux-2.1.0-cp311-cp311-manylinux_2_28_aarch64.whl")
const sha = createHash("sha256").update(await readFile(wheel)).digest("hex")
assert.equal(sha, "a09a3b590c7317c2f96e9a945058f888761b4cf83a9611b5e3e436089a5e67d0")
const image = process.env.MAKO_STREAMING_IMAGE ?? "mako-control-runtime:node-package-acceptance"
const metadata = JSON.parse((await execute("docker", ["image", "inspect", image])).stdout)[0]
assert.equal(metadata.Architecture, "arm64", "This staged wheel is ARM64, not x64 acceptance")
const mounts = {
  [join(cache, "python")]: "/opt/prototype",
  [join(cache, "dependencies/python")]: "/opt/dependencies",
  [join(cache, "selkies-source/selkies-3a46db7d58e4bddf2dd1f031ee9577720545e8ab")]: "/selkies",
  [join(cache, "web")]: "/web",
  [join(cache, "cairo/cairo")]: "/usr/lib/python3/dist-packages/cairo",
  [join(cache, "cairo/gi/_gi_cairo.cpython-311-aarch64-linux-gnu.so")]: "/usr/lib/python3/dist-packages/gi/_gi_cairo.cpython-311-aarch64-linux-gnu.so",
  [join(repo, "scripts/linux-control")]: "/probe",
  [join(repo, "scripts/linux-control/streaming-viewer.mjs")]: "/opt/mako-control/streaming-viewer.mjs",
  [join(repo, "packages/control-runtime/dist")]: "/opt/mako-control/node_modules/@mako/control-runtime/dist",
  [join(repo, "packages/control/dist")]: "/opt/mako-control/node_modules/@mako/control/dist",
}
const name = `mako-streaming-${randomUUID()}`
const args = ["run", "--name", name, "--rm", "--init", "--pull=never", "--network=none", "--read-only",
  "--cap-drop=ALL", "--security-opt=no-new-privileges", "--cpus=4", "--memory=2g", "--pids-limit=512",
  "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
  "-e", `MAKO_STREAMING_SECONDS=${process.env.MAKO_STREAMING_SECONDS ?? 60}`,
  ...Object.entries(mounts).flatMap(([src, dst]) => ["--mount", `type=bind,src=${src},dst=${dst},readonly`]),
  "--mount", `type=bind,src=${output},dst=/output`, "--entrypoint", "/bin/sh", metadata.Id,
  "/probe/start-streaming-probe.sh",
  ...(mode.startsWith("capture") ? ["--output", "/output", "--seconds", "60", ...(mode === "capture444" ? ["--fullcolor"] : [])] : ["selkies", mode]),
]
await writeFile(join(output, "provenance.json"), JSON.stringify({ mode, image: metadata.Id,
  architecture: metadata.Architecture, wheelSha256: sha, pixelflux: "40a9d46ba9b8c137b9812825041c68977ddf615f",
  selkies: "3a46db7d58e4bddf2dd1f031ee9577720545e8ab", cpus: 4, memoryBytes: 2*1024**3, network: "none" }, null, 2))
const child = spawn("docker", args, { stdio: "inherit" })
const stop = () => { void execute("docker", ["stop", "--time=5", name]).catch(() => {}) }
process.once("SIGINT", stop)
process.once("SIGTERM", stop)
const deadline = setTimeout(stop, 150000)
try {
  process.exitCode = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", (code) => done(code ?? 1)) })
} finally {
  clearTimeout(deadline)
  process.off("SIGINT", stop)
  process.off("SIGTERM", stop)
}
